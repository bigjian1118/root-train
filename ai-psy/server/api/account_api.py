# -*- coding: utf-8 -*-
"""账号即时永久注销接口：准入校验 / 立即注销 + 教师端注销审计列表（只读）。

学生端与教师端共用同一套接口（角色由 session 判定）；
无冷静期/撤销/状态轮询接口——确认即执行，不可逆。
"""
from flask import Blueprint, jsonify, request
from sqlalchemy import select

from ..extensions import db
from ..models import AccountDeletionRequest, Student, Teacher
from ..security import require_login, require_teacher
from ..services import deletion_service

bp = Blueprint("account_deletion", __name__)


@bp.get("/api/account/deletion/eligibility")
def eligibility():
    """注销准入校验：返回是否允许及逐条阻断原因（含处理路径）。"""
    user, err = require_login()
    if err:
        return err
    allowed, blockers = deletion_service.check_eligibility(user)
    return jsonify({
        "allowed": allowed,
        "blockers": blockers,
        "confirm_text": deletion_service.CONFIRM_TEXT,
    })


@bp.post("/api/account/deletion/immediate")
def immediate():
    """即时永久注销：确认文案 + 密码双重校验，通过即执行，无任何撤销路径。"""
    user, err = require_login()
    if err:
        return err
    data = request.get_json(silent=True) or {}
    payload, error, status = deletion_service.immediate_deletion(
        user,
        str(data.get("password", "")),
        str(data.get("confirm_text", "")),
        str(data.get("reason", "")),
        request.remote_addr,
    )
    if error:
        body = {"error": error}
        if payload:
            body.update(payload)
        return jsonify(body), status
    # 注销成功立即销毁服务端会话（作废登录态）
    session_user = request.session.get("user")
    if session_user:
        request.session.pop("user", None)
    return jsonify(payload)


@bp.get("/api/teacher/account-deletions")
def teacher_deletion_list():
    """教师端只读注销审计列表（不支持代用户发起，仅查看）。"""
    _, err = require_teacher()
    if err:
        return err
    rows = db.session.execute(
        select(AccountDeletionRequest)
        .order_by(AccountDeletionRequest.requested_at.desc())
        .limit(200)
    ).scalars().all()

    items = []
    for record in rows:
        name, class_name = _lookup_user_brief(record)
        items.append({
            "user_id": record.user_id,
            "name": name,
            "class": class_name,
            "role": record.role,
            "status": record.status,
            "requested_at": record.requested_at,
            "completed_at": record.completed_at,
            "deletion_serial": record.deletion_serial,
            "ip": record.ip,
            "verify_method": record.verify_method,
        })
    return jsonify({"items": items})


def _lookup_user_brief(record: AccountDeletionRequest) -> tuple[str, str]:
    """列表展示用的用户基础信息；账号已注销时返回匿名化后的值（保留审计线索）。"""
    if record.role == "student":
        row = db.session.get(Student, record.user_id)
        return (row.name or "", row.class_ or "") if row else ("", "")
    row = db.session.get(Teacher, record.user_id)
    return (row.name or "", row.class_ or "") if row else ("", "")
