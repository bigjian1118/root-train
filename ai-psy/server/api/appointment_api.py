# -*- coding: utf-8 -*-
"""心理咨询预约接口：学生排约/取消，教师排时段/审批。

状态口径：库内 pending/accepted/rejected/canceled(+done)，
响应层映射回前端旧契约 confirmed/cancelled，入参筛选反向映射。
"""
from datetime import datetime

from flask import Blueprint, jsonify, request
from sqlalchemy import select, update

from ..extensions import db
from ..models import Appointment, CounselingSlot, now_ms
from ..security import make_business_id, require_login

bp = Blueprint("appointment", __name__)

_MS_PER_SECOND = 1000
_APPT_STATUS_TO_API = {"accepted": "confirmed", "canceled": "cancelled"}
_APPT_STATUS_FROM_API = {"confirmed": "accepted", "cancelled": "canceled"}
_APPT_STATUS_API_SET = {"pending", "confirmed", "rejected", "cancelled", "done"}
# 仍占用时段名额的状态（去重校验与台账同步共用）
_ACTIVE_STATUSES = ("pending", "accepted")
_DECISION_STATUS_MAP = {"confirm": "accepted", "reject": "rejected", "complete": "done"}


def _require_teacher_api(error_text: str):
    """登录 + 教师角色校验；403 文案按接口区分（沿用旧契约，前端依赖）。"""
    user, err = require_login()
    if err:
        return None, err
    if user.get("role") != "teacher":
        return None, (jsonify({"error": error_text}), 403)
    return user, None


def _appt_public(appointment: Appointment, teacher_view: bool = False) -> dict:
    """appointments 行 -> 前端契约 dict（状态映射 + 毫秒转秒）。"""
    data = {"id": appointment.id}
    if teacher_view:
        data["student_name"] = appointment.student_name
        data["student_class"] = appointment.student_class
    else:
        data["teacher_name"] = appointment.teacher_name
    data.update({
        "date": appointment.date,
        "time_slot": appointment.time_slot,
        "reason": appointment.reason,
        "status": _APPT_STATUS_TO_API.get(appointment.status, appointment.status),
        "reply": appointment.reply,
        "created_at": (
            appointment.created_at // _MS_PER_SECOND
            if appointment.created_at else appointment.created_at
        ),
    })
    if teacher_view:
        data["teacher_time"] = (
            appointment.teacher_time // _MS_PER_SECOND
            if appointment.teacher_time else appointment.teacher_time
        )
    return data


def _parse_slot_payload(data: dict):
    """解析并校验教师时段表单，返回 (payload, error_response)。"""
    date = str(data.get("date", "")).strip()
    start_time = str(data.get("start_time", "")).strip()
    end_time = str(data.get("end_time", "")).strip()
    note = str(data.get("note", "")).strip()
    try:
        max_capacity = int(data.get("max_capacity", 1) or 1)
    except (TypeError, ValueError):
        return None, (jsonify({"error": "最大预约人数必须是整数"}), 400)
    if max_capacity < 1:
        return None, (jsonify({"error": "最大预约人数至少为 1"}), 400)
    if not date or not start_time or not end_time:
        return None, (jsonify({"error": "日期与开始/结束时间不能为空"}), 400)
    if start_time >= end_time:
        return None, (jsonify({"error": "结束时间需晚于开始时间"}), 400)
    return {
        "date": date,
        "start_time": start_time,
        "end_time": end_time,
        "note": note,
        # 展示用时间段 "09:00-09:30"
        "time_slot": f"{start_time}-{end_time}",
        "max_capacity": max_capacity,
    }, None


# ---------- 学生端 ----------
@bp.get("/api/student/appointment/slots")
def student_list_slots():
    """学生查所有可约时段（含咨询师姓名与剩余名额）。"""
    _user, err = require_login()
    if err:
        return err
    today = datetime.now().strftime("%Y-%m-%d")
    slots = db.session.scalars(
        select(CounselingSlot)
        .where(CounselingSlot.date >= today)
        .order_by(CounselingSlot.date.asc(), CounselingSlot.time_slot.asc())
    ).all()
    return jsonify({"slots": [{
        "id": slot.id,
        "teacher_id": slot.teacher_id,
        "teacher_name": slot.teacher_name,
        "date": slot.date,
        "time_slot": slot.time_slot,
        "note": slot.note,
        "max_capacity": slot.max_capacity,
        "current_count": slot.current_count,
        "remaining": max(slot.max_capacity - slot.current_count, 0),
    } for slot in slots]})


@bp.post("/api/student/appointment")
def student_create_appointment():
    """学生提交预约：条件 UPDATE 原子占位，冲突返回 409。"""
    user, err = require_login()
    if err:
        return err
    if user.get("role") != "student":
        return jsonify({"error": "仅学生可发起心理咨询预约"}), 403

    data = request.get_json(silent=True) or {}
    slot_id = str(data.get("slot_id", "")).strip()
    reason = str(data.get("reason", "")).strip()
    if not slot_id:
        return jsonify({"error": "缺少时段 slot_id"}), 400

    slot = db.session.get(CounselingSlot, slot_id)
    if not slot:
        return jsonify({"error": "该时段不存在"}), 404
    # 同一学生同一教师同一日期同一时间段不允许重复预约（已取消/已拒绝除外）
    duplicate = db.session.scalar(
        select(Appointment.id).where(
            Appointment.student_id == user["id"],
            Appointment.teacher_id == slot.teacher_id,
            Appointment.date == slot.date,
            Appointment.time_slot == slot.time_slot,
            Appointment.status.in_(_ACTIVE_STATUSES),
        )
    )
    if duplicate:
        return jsonify({"error": "你已预约过该教师该时段的时段，请勿重复预约"}), 409

    appt_id = make_business_id()
    try:
        # 原子占位：仅未满员时 current_count + 1，避免并发超卖
        result = db.session.execute(
            update(CounselingSlot)
            .where(
                CounselingSlot.id == slot_id,
                CounselingSlot.current_count < CounselingSlot.max_capacity,
            )
            .values(current_count=CounselingSlot.current_count + 1)
        )
        if result.rowcount == 0:
            db.session.rollback()
            return jsonify({"error": "该时段名额已满，请选择其他时段"}), 409
        db.session.add(Appointment(
            id=appt_id,
            slot_id=slot_id,
            teacher_id=slot.teacher_id,
            teacher_name=slot.teacher_name,
            student_id=user["id"],
            student_name=user.get("name", ""),
            student_class=user.get("class", ""),
            date=slot.date,
            time_slot=slot.time_slot,
            reason=reason or None,
            status="pending",
            created_at=now_ms(),
        ))
        db.session.commit()
    except Exception as exc:
        db.session.rollback()
        return jsonify({"error": f"预约提交失败：{exc}"}), 500
    return jsonify({"ok": True, "appointment_id": appt_id})


@bp.get("/api/student/appointments")
def student_list_appointments():
    """学生查自己的预约列表，按创建时间倒序。"""
    user, err = require_login()
    if err:
        return err
    rows = db.session.scalars(
        select(Appointment)
        .where(Appointment.student_id == user["id"])
        .order_by(Appointment.created_at.desc())
    ).all()
    return jsonify({"appointments": [_appt_public(row) for row in rows]})


@bp.delete("/api/student/appointment/<appointment_id>")
def student_cancel_appointment(appointment_id: str):
    """学生取消预约：仅待审核可取消，取消后释放名额。"""
    user, err = require_login()
    if err:
        return err
    appointment = db.session.scalar(
        select(Appointment).where(
            Appointment.id == appointment_id, Appointment.student_id == user["id"]
        )
    )
    if not appointment:
        return jsonify({"error": "预约不存在或不属于你"}), 404
    if appointment.status != "pending":
        return jsonify({"error": "仅待审核状态的预约可取消"}), 400

    appointment.status = "canceled"
    # current_count >= 1 时才减，避免负数
    db.session.execute(
        update(CounselingSlot)
        .where(CounselingSlot.id == appointment.slot_id, CounselingSlot.current_count > 0)
        .values(current_count=CounselingSlot.current_count - 1)
    )
    db.session.commit()
    return jsonify({"ok": True})


# ---------- 教师端 ----------
@bp.post("/api/teacher/appointment/slots")
def teacher_create_slot():
    """教师创建自己的可约时段。"""
    user, err = _require_teacher_api("仅教师可排可约时段")
    if err:
        return err
    payload, error = _parse_slot_payload(request.get_json(silent=True) or {})
    if error:
        return error

    slot_id = make_business_id()
    db.session.add(CounselingSlot(
        id=slot_id,
        teacher_id=user["id"],
        teacher_name=user.get("name", ""),
        date=payload["date"],
        time_slot=payload["time_slot"],
        start_time=payload["start_time"],
        end_time=payload["end_time"],
        max_capacity=payload["max_capacity"],
        current_count=0,
        note=payload["note"] or None,
        status="open",
        created_at=now_ms(),
    ))
    db.session.commit()
    return jsonify({"ok": True, "slot_id": slot_id})


@bp.put("/api/teacher/appointment/slots/<slot_id>")
def teacher_update_slot(slot_id: str):
    """教师编辑自己的时段，并同步待审核/已通过预约的日期与时间段。"""
    user, err = _require_teacher_api("仅教师可编辑时段")
    if err:
        return err
    payload, error = _parse_slot_payload(request.get_json(silent=True) or {})
    if error:
        return error

    slot = db.session.scalar(
        select(CounselingSlot).where(
            CounselingSlot.id == slot_id, CounselingSlot.teacher_id == user["id"]
        )
    )
    if not slot:
        return jsonify({"error": "时段不存在或不属于你"}), 404
    if payload["max_capacity"] < slot.current_count:
        return jsonify({
            "error": f"新名额不能小于当前已约人数（{slot.current_count}）"
        }), 400

    slot.date = payload["date"]
    slot.time_slot = payload["time_slot"]
    slot.start_time = payload["start_time"]
    slot.end_time = payload["end_time"]
    slot.max_capacity = payload["max_capacity"]
    slot.note = payload["note"] or None
    # 同步台账，避免已约学生的日期/时间段与时段信息错位
    db.session.execute(
        update(Appointment)
        .where(Appointment.slot_id == slot_id, Appointment.status.in_(_ACTIVE_STATUSES))
        .values(date=payload["date"], time_slot=payload["time_slot"])
    )
    db.session.commit()
    return jsonify({"ok": True})


@bp.get("/api/teacher/appointment/slots")
def teacher_list_slots():
    """教师查自己排的所有时段（含名额信息）。"""
    user, err = _require_teacher_api("仅教师可查看排班")
    if err:
        return err
    slots = db.session.scalars(
        select(CounselingSlot)
        .where(CounselingSlot.teacher_id == user["id"])
        .order_by(CounselingSlot.date.desc(), CounselingSlot.time_slot.desc())
    ).all()
    return jsonify({"slots": [{
        "id": slot.id,
        "date": slot.date,
        "time_slot": slot.time_slot,
        "start_time": slot.start_time,
        "end_time": slot.end_time,
        "note": slot.note,
        "status": slot.status,
        "max_capacity": slot.max_capacity,
        "current_count": slot.current_count,
        # created_at 毫秒 -> 秒（前端 fmtTs 按秒消费）
        "created_at": slot.created_at // _MS_PER_SECOND if slot.created_at else slot.created_at,
    } for slot in slots]})


@bp.delete("/api/teacher/appointment/slots/<slot_id>")
def teacher_delete_slot(slot_id: str):
    """教师作废自己的时段：该时段下待审核/已确认预约一并取消。"""
    user, err = _require_teacher_api("仅教师可作废时段")
    if err:
        return err
    slot = db.session.scalar(
        select(CounselingSlot).where(
            CounselingSlot.id == slot_id, CounselingSlot.teacher_id == user["id"]
        )
    )
    if not slot:
        return jsonify({"error": "时段不存在或不属于你"}), 404

    db.session.execute(
        update(Appointment)
        .where(Appointment.slot_id == slot_id, Appointment.status.in_(_ACTIVE_STATUSES))
        .values(status="canceled")
    )
    db.session.delete(slot)
    db.session.commit()
    return jsonify({"ok": True})


@bp.get("/api/teacher/appointments")
def teacher_list_appointments():
    """教师查投递到自己时段的预约，可按 status 筛选（all/pending/confirmed/...）。"""
    user, err = _require_teacher_api("仅教师可查看预约")
    if err:
        return err
    filter_status = str(request.args.get("status", "all")).strip()
    if filter_status != "all" and filter_status not in _APPT_STATUS_API_SET:
        return jsonify({"error": "非法的筛选状态"}), 400

    query = select(Appointment).where(Appointment.teacher_id == user["id"])
    if filter_status != "all":
        db_status = _APPT_STATUS_FROM_API.get(filter_status, filter_status)
        query = query.where(Appointment.status == db_status)
    rows = db.session.scalars(query.order_by(Appointment.created_at.desc())).all()
    return jsonify({"appointments": [_appt_public(row, teacher_view=True) for row in rows]})


@bp.post("/api/teacher/appointment/<appointment_id>/decide")
def teacher_decide_appointment(appointment_id: str):
    """教师处理预约：confirm 通过 / reject 驳回 / complete 标记完成。"""
    user, err = _require_teacher_api("仅教师可处理预约")
    if err:
        return err
    data = request.get_json(silent=True) or {}
    action = data.get("action")
    reply = str(data.get("reply", "")).strip()
    if action not in _DECISION_STATUS_MAP:
        return jsonify({"error": "action 需为 confirm / reject / complete"}), 400
    # 驳回必须说明原因（学生端详情页展示）
    if action == "reject" and not reply:
        return jsonify({"error": "驳回预约必须填写驳回原因"}), 400

    appointment = db.session.scalar(
        select(Appointment).where(
            Appointment.id == appointment_id, Appointment.teacher_id == user["id"]
        )
    )
    if not appointment:
        return jsonify({"error": "预约不存在或不属于你"}), 404
    if action in ("confirm", "reject") and appointment.status != "pending":
        return jsonify({"error": "仅待审核状态的预约可处理"}), 400
    if action == "complete" and appointment.status != "accepted":
        return jsonify({"error": "仅已通过状态的预约可标记完成"}), 400

    # complete 保留原回复，不改写
    appointment.status = _DECISION_STATUS_MAP[action]
    appointment.reply = (reply if action != "complete" else appointment.reply) or None
    appointment.teacher_time = now_ms()
    if action == "reject":
        db.session.execute(
            update(CounselingSlot)
            .where(CounselingSlot.id == appointment.slot_id, CounselingSlot.current_count > 0)
            .values(current_count=CounselingSlot.current_count - 1)
        )
    db.session.commit()
    return jsonify({"ok": True})
