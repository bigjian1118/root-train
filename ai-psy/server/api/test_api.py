# -*- coding: utf-8 -*-
"""场景化心理测试接口：提交即建档（processing），报告由后台任务生成。"""
import json

from flask import Blueprint, current_app, jsonify, request, session
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError

from ..extensions import db
from ..models import Scl90TextReport, now_ms
from ..prompt import CRISIS_HOTLINE_TEXT, SCENARIOS
from ..scoring import apply_rf_severity, parse_item_answers
from ..security import make_business_id, require_login
from ..services.report_tasks import enqueue_text_report, make_request_key

bp = Blueprint("test_api", __name__)


def _reject_teacher():
    """教师不可用测评功能；文案沿用旧接口契约。"""
    user = session.get("user")
    if user and user.get("role") == "teacher":
        return jsonify({"error": "教师账号仅保留查看班级测试情况功能"}), 403
    return None


def _find_existing(student_id: str, request_key: str) -> Scl90TextReport | None:
    """幂等：同一学生、同一场景、同一份答案只保留一条生成任务。"""
    return db.session.execute(
        select(Scl90TextReport).where(
            Scl90TextReport.student_id == student_id,
            Scl90TextReport.request_key == request_key,
        )
    ).scalar_one_or_none()


def _submit_response(row: Scl90TextReport, result: dict, crisis: dict):
    """提交/重复提交统一返回：报告状态 + 即时分数（报告正文由状态接口获取）。"""
    return jsonify({
        "report_id": row.report_id,
        "status": row.status or "processing",
        "scores": result,
        "has_crisis": len(crisis) > 0,
        "crisis_message": (
            "⚠️ 测评中检测到你可能正处于比较痛苦的阶段，请务必寻求专业帮助：\n"
            + CRISIS_HOTLINE_TEXT
        ) if crisis else "",
    })


@bp.post("/api/test/submit")
def submit_test():
    """提交测评：立即返回 processing，后台任务继续生成 AI 解读并入库。"""
    err = _reject_teacher()
    if err:
        return err
    user, err = require_login()
    if err:
        return err
    data = request.get_json(silent=True) or {}
    scenario = data.get("scenario", "college_student")
    if scenario not in SCENARIOS:
        return jsonify({"error": f"未知场景：{scenario}"}), 400

    result = data.get("result")
    if (not isinstance(result, dict)
            or "总分" not in result
            or not isinstance(result.get("因子分"), dict)
            or not result["因子分"]):
        return jsonify({"error": "计分结果缺失或格式非法，请完成全部 90 题后再提交"}), 400
    crisis = result.get("危机信号")
    if not isinstance(crisis, dict):
        crisis = {}

    answers = parse_item_answers(data.get("answers"))
    apply_rf_severity(result.get("因子分") or {}, answers)

    request_key = make_request_key(
        user.get("id", ""), scenario,
        json.dumps(answers or {}, sort_keys=True, ensure_ascii=False),
    )
    existing = _find_existing(user.get("id", ""), request_key)
    if existing:
        return _submit_response(existing, result, crisis)

    row = Scl90TextReport(
        report_id=make_business_id(),
        student_id=user.get("id", ""),
        student_name=user.get("name", "匿名用户"),
        student_class=user.get("class", ""),
        crowd_tag=SCENARIOS[scenario]["name"],
        submit_timestamp=now_ms(),
        status="processing",
        request_key=request_key,
    )
    try:
        db.session.add(row)
        db.session.commit()
    except SQLAlchemyError as exc:
        # 并发重复提交会撞幂等唯一索引：回查后返回同一条记录
        db.session.rollback()
        existing = _find_existing(user.get("id", ""), request_key)
        if existing:
            return _submit_response(existing, result, crisis)
        current_app.logger.warning("[test] 报告建档失败：%s", exc)
        return jsonify({"error": "提交失败，请稍后重试"}), 500

    enqueue_text_report(row.report_id, user, scenario, result, crisis, answers)
    return _submit_response(row, result, crisis)
