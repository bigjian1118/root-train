# -*- coding: utf-8 -*-
"""师生一对一私密留言接口（会话列表/创建/详情/发消息/已读/未读数）。"""
from flask import Blueprint, jsonify, request
from sqlalchemy import func, select, update

from ..extensions import db
from ..models import Conversation, Message, Student, Teacher, TeacherClass, now_ms
from ..security import make_business_id, require_login, require_teacher

bp = Blueprint("message", __name__)

_MS_PER_SECOND = 1000
_MAX_MESSAGE_LENGTH = 2000


def _require_student():
    """学生守卫：403 文案沿用旧契约（与通用 require_student 不同）。"""
    user, err = require_login()
    if err:
        return None, err
    if user.get("role") != "student":
        return None, (jsonify({"error": "仅学生账号可使用倾诉留言功能"}), 403)
    return user, None


def _message_dict(message: Message) -> dict:
    """消息行 -> 前端 JSON（库内毫秒 -> 响应秒）。"""
    return {
        "id": message.id,
        "conversation_id": message.conversation_id,
        "sender_id": message.sender_id,
        "sender_role": message.sender_role,
        "content": message.content,
        "is_read": bool(message.is_read),
        "created_at": message.create_timestamp // _MS_PER_SECOND,
    }


def _last_message(conversation_id: str) -> Message | None:
    return db.session.scalar(
        select(Message)
        .where(Message.conversation_id == conversation_id)
        .order_by(Message.create_timestamp.desc())
        .limit(1)
    )


def _unread_count(conversation_id: str, incoming_role: str) -> int:
    """未读口径：只统计对方发来的未读消息。"""
    return db.session.scalar(
        select(func.count())
        .select_from(Message)
        .where(
            Message.conversation_id == conversation_id,
            Message.sender_role == incoming_role,
            Message.is_read == 0,
        )
    ) or 0


def _student_class_map(student_ids: list[str]) -> dict[str, str]:
    """按学生 id 批量取班级。"""
    if not student_ids:
        return {}
    rows = db.session.execute(
        select(Student.student_id, Student.class_).where(Student.student_id.in_(student_ids))
    ).all()
    return {student_id: clazz for student_id, clazz in rows}


# ---------- 学生端 ----------
@bp.get("/api/student/msg/teachers")
def student_list_teachers():
    """学生可选的心理老师列表（含所带班级）。"""
    _user, err = _require_student()
    if err:
        return err
    teachers = db.session.scalars(select(Teacher).order_by(Teacher.name)).all()
    class_rows = db.session.execute(
        select(TeacherClass.teacher_id, TeacherClass.class_id)
    ).all()
    class_map: dict[str, list[str]] = {}
    for teacher_id, class_id in class_rows:
        class_map.setdefault(teacher_id, []).append(class_id)

    result = []
    for teacher in teachers:
        classes = class_map.get(teacher.teacher_id, [])
        result.append({
            "id": teacher.teacher_id,
            "name": teacher.name,
            "class": ", ".join(classes),
            "classes": classes,
            "class_count": len(classes),
        })
    return jsonify({"teachers": result})


@bp.get("/api/student/msg/conversations")
def student_list_conversations():
    """学生自己的会话列表：按最新消息倒序，含未读数与最后一条预览。"""
    user, err = _require_student()
    if err:
        return err
    rows = db.session.scalars(
        select(Conversation)
        .where(Conversation.student_id == user["id"])
        .order_by(Conversation.updated_timestamp.desc())
    ).all()

    conversations = []
    for conv in rows:
        last = _last_message(conv.id)
        conversations.append({
            "id": conv.id,
            "teacher_id": conv.teacher_id,
            "teacher_name": conv.teacher_name,
            "last_message": last.content if last else "",
            "last_time": (
                last.create_timestamp if last else conv.create_timestamp
            ) // _MS_PER_SECOND,
            "unread": _unread_count(conv.id, "teacher"),
        })
    return jsonify({"conversations": conversations})


@bp.post("/api/student/msg/conversation")
def student_create_conversation():
    """学生向指定教师发起会话：已存在则直接打开（一对一唯一）。"""
    user, err = _require_student()
    if err:
        return err
    data = request.get_json(silent=True) or {}
    teacher_id = (data.get("teacher_id") or "").strip()
    if not teacher_id:
        return jsonify({"error": "请选择要倾诉的老师"}), 400

    teacher = db.session.get(Teacher, teacher_id)
    if not teacher:
        return jsonify({"error": "所选老师不存在"}), 404

    conv = db.session.scalar(
        select(Conversation).where(
            Conversation.student_id == user["id"], Conversation.teacher_id == teacher_id
        )
    )
    created = False
    if not conv:
        timestamp = now_ms()
        conv = Conversation(
            id=make_business_id(),
            student_id=user["id"],
            teacher_id=teacher_id,
            student_name=user["name"],
            teacher_name=teacher.name,
            updated_timestamp=timestamp,
            create_timestamp=timestamp,
        )
        db.session.add(conv)
        db.session.commit()
        created = True
    return jsonify({"conversation": {
        "id": conv.id,
        "teacher_id": conv.teacher_id,
        "teacher_name": conv.teacher_name,
        "created": created,
    }})


# ---------- 会话详情（归属校验，他人不可见） ----------
@bp.get("/api/student/msg/conversation/<conversation_id>")
def student_conversation_detail(conversation_id: str):
    """学生查看与某教师的完整聊天记录（仅本人会话）。"""
    user, err = _require_student()
    if err:
        return err
    conv = db.session.get(Conversation, conversation_id)
    if not conv or conv.student_id != user["id"]:
        return jsonify({"error": "会话不存在"}), 404

    messages = db.session.scalars(
        select(Message)
        .where(Message.conversation_id == conversation_id)
        .order_by(Message.create_timestamp.asc())
    ).all()
    return jsonify({
        "conversation": {
            "id": conv.id,
            "teacher_id": conv.teacher_id,
            "teacher_name": conv.teacher_name,
            "student_name": conv.student_name,
        },
        "messages": [_message_dict(message) for message in messages],
    })


@bp.get("/api/teacher/msg/conversation/<conversation_id>")
def teacher_conversation_detail(conversation_id: str):
    """教师查看与某学生的完整聊天记录（仅本人会话，附带学生班级）。"""
    user, err = require_teacher()
    if err:
        return err
    conv = db.session.get(Conversation, conversation_id)
    if not conv or conv.teacher_id != user["id"]:
        return jsonify({"error": "会话不存在"}), 404

    student = db.session.get(Student, conv.student_id)
    student_class = student.class_ if student else ""
    messages = db.session.scalars(
        select(Message)
        .where(Message.conversation_id == conversation_id)
        .order_by(Message.create_timestamp.asc())
    ).all()
    return jsonify({
        "conversation": {
            "id": conv.id,
            "student_id": conv.student_id,
            "student_name": conv.student_name,
            "student_class": student_class,
            "teacher_name": conv.teacher_name,
        },
        "messages": [_message_dict(message) for message in messages],
    })


# ---------- 发送消息 ----------
def _send_message(conversation_id: str, user: dict, sender_role: str, ownership_check) -> tuple:
    """发送消息共用逻辑：校验归属 -> 插入消息 -> 更新时间戳。"""
    data = request.get_json(silent=True) or {}
    content = (data.get("content") or "").strip()
    if not content:
        return jsonify({"error": "消息内容不能为空"}), 400
    if len(content) > _MAX_MESSAGE_LENGTH:
        return jsonify({"error": f"消息内容过长（限 {_MAX_MESSAGE_LENGTH} 字）"}), 400

    conv = db.session.get(Conversation, conversation_id)
    if not conv or not ownership_check(conv):
        return jsonify({"error": "会话不存在"}), 404
    timestamp = now_ms()
    message = Message(
        id=make_business_id(),
        conversation_id=conversation_id,
        sender_id=user["id"],
        sender_role=sender_role,
        content=content,
        is_read=0,
        create_timestamp=timestamp,
    )
    db.session.add(message)
    conv.updated_timestamp = timestamp
    db.session.commit()
    return jsonify({
        "ok": True,
        "message": _message_dict(message),
        "updated_at": timestamp // _MS_PER_SECOND,
    })


@bp.post("/api/student/msg/conversation/<conversation_id>/messages")
def student_send_message(conversation_id: str):
    """学生发送倾诉消息。"""
    user, err = _require_student()
    if err:
        return err
    return _send_message(
        conversation_id, user, "student",
        lambda conv: conv.student_id == user["id"])


@bp.post("/api/teacher/msg/conversation/<conversation_id>/messages")
def teacher_send_message(conversation_id: str):
    """教师回复消息。"""
    user, err = require_teacher()
    if err:
        return err
    return _send_message(
        conversation_id, user, "teacher",
        lambda conv: conv.teacher_id == user["id"])


# ---------- 标记已读 ----------
def _mark_read(conversation_id: str, incoming_role: str, ownership_check) -> tuple:
    """把会话内来自对方的未读消息标记为已读。"""
    conv = db.session.get(Conversation, conversation_id)
    if not conv or not ownership_check(conv):
        return jsonify({"error": "会话不存在"}), 404
    result = db.session.execute(
        update(Message)
        .where(
            Message.conversation_id == conversation_id,
            Message.sender_role == incoming_role,
            Message.is_read == 0,
        )
        .values(is_read=1)
    )
    db.session.commit()
    return jsonify({"ok": True, "updated": result.rowcount})


@bp.post("/api/student/msg/conversation/<conversation_id>/read")
def student_mark_read(conversation_id: str):
    """学生打开会话后将老师的消息标记为已读。"""
    user, err = _require_student()
    if err:
        return err
    return _mark_read(conversation_id, "teacher",
                      lambda conv: conv.student_id == user["id"])


@bp.post("/api/teacher/msg/conversation/<conversation_id>/read")
def teacher_mark_read(conversation_id: str):
    """教师打开会话后将学生的消息标记为已读。"""
    user, err = require_teacher()
    if err:
        return err
    return _mark_read(conversation_id, "student",
                      lambda conv: conv.teacher_id == user["id"])


# ---------- 教师端会话列表 + 全局未读数 ----------
@bp.get("/api/teacher/msg/conversations")
def teacher_list_conversations():
    """教师收到的所有学生会话：按最新消息倒序，含未读数与学生班级。"""
    user, err = require_teacher()
    if err:
        return err
    rows = db.session.scalars(
        select(Conversation)
        .where(Conversation.teacher_id == user["id"])
        .order_by(Conversation.updated_timestamp.desc())
    ).all()
    class_map = _student_class_map([conv.student_id for conv in rows])

    conversations = []
    for conv in rows:
        last = _last_message(conv.id)
        conversations.append({
            "id": conv.id,
            "student_id": conv.student_id,
            "student_name": conv.student_name,
            "student_class": class_map.get(conv.student_id, ""),
            "last_message": last.content if last else "",
            "last_time": (
                last.create_timestamp if last else conv.create_timestamp
            ) // _MS_PER_SECOND,
            "unread": _unread_count(conv.id, "student"),
        })
    return jsonify({"conversations": conversations})


@bp.get("/api/msg/unread")
def get_unread_total():
    """首页/个人中心红点：当前角色收到的未读消息总数。"""
    user, err = require_login()
    if err:
        return err
    role = user.get("role")
    if role not in ("student", "teacher"):
        return jsonify({"role": role, "total": 0})

    incoming = "teacher" if role == "student" else "student"
    owner_column = Conversation.student_id if role == "student" else Conversation.teacher_id
    total = db.session.scalar(
        select(func.count())
        .select_from(Message)
        .join(Conversation, Conversation.id == Message.conversation_id)
        .where(
            owner_column == user["id"],
            Message.sender_role == incoming,
            Message.is_read == 0,
        )
    ) or 0
    return jsonify({"role": role, "total": total})
