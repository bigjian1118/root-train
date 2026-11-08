# -*- coding: utf-8 -*-
"""场景化心理测试接口：接收前端计分结果、AI 解读并归档 SCL-90 报告。"""
import json

from flask import Blueprint, current_app, jsonify, request, session
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError

from ..config import Config
from ..extensions import db
from ..llm import LLMError, chat
from ..models import AiAnalysisReport, Scl90TextReport, Student, now_ms
from ..prompt import CRISIS_HOTLINE_TEXT, REPORT_PROMPT, SCENARIOS
from ..scoring import apply_rf_severity, factor_averages, parse_item_answers
from ..security import make_business_id

bp = Blueprint("test_api", __name__)

_TOTAL_ITEMS = 90


def _reject_teacher():
    """教师不可用测评功能；文案沿用旧接口契约。"""
    user = session.get("user")
    if user and user.get("role") == "teacher":
        return jsonify({"error": "教师账号仅保留查看班级测试情况功能"}), 403
    return None


def _archive_ai_content(user: dict, ai_content: str,
                        text_report_id: str | None = None,
                        video_report_id: str | None = None) -> AiAnalysisReport | None:
    """AI 正文归档到 ai_analysis_report（补齐学生学号/手机号冗余）。"""
    if not user or not ai_content:
        return None
    uid = user.get("id", "")
    no_val, phone, clazz = None, None, user.get("class", "")
    if user.get("role") == "student":
        student = db.session.execute(
            select(Student).where(Student.student_id == uid)
        ).scalar_one_or_none()
        if student:
            no_val, phone = student.student_no, student.phone
            clazz = student.class_ or clazz
    row = AiAnalysisReport(
        student_name=user.get("name", "匿名用户"),
        student_class=clazz,
        student_no=no_val,
        phone=phone,
        text_report_id=text_report_id,
        video_report_id=video_report_id,
        ai_content=ai_content,
        create_timestamp=now_ms(),
    )
    db.session.add(row)
    return row


def _generate_report(scenario: str, result: dict) -> str:
    """AI 解读失败不阻塞测评提交，返回降级文案（与旧版一致）。"""
    if not Config.AI_ENABLED:
        return f"（{Config.AI_DISABLED_MESSAGE}，测评分数与因子结果不受影响）"
    prompt = REPORT_PROMPT.format(
        scenario_name=SCENARIOS[scenario]["name"],
        result_data=json.dumps(result, ensure_ascii=False, indent=2),
    )
    try:
        return chat(
            [{"role": "system", "content": SCENARIOS[scenario]["system_prompt"]},
             {"role": "user", "content": prompt}],
            temperature=0.5, max_tokens=1536,
        )
    except LLMError as exc:
        return f"（AI 报告生成失败：{exc}）"


def _archive_text_report(result: dict, crisis: dict, answers: dict | None,
                         report: str, crowd_tag: str) -> None:
    """写 scl90_text_report 并同步学生最新报告 id；归档失败只告警，不影响本次返回。"""
    user = session.get("user")
    if not user:
        return
    try:
        report_id = make_business_id()
        factor_cols = factor_averages(result)
        positive_count = result.get("阳性项目数") or 0
        max_avg = max(
            (value for value in factor_cols.values() if value is not None), default=None
        )
        row = Scl90TextReport(
            report_id=report_id,
            student_id=user.get("id", ""),
            student_name=user.get("name", "匿名用户"),
            student_class=user.get("class", ""),
            crowd_tag=crowd_tag,
            total_score=result.get("总分"),
            pos_item_count=positive_count,
            neg_item_count=_TOTAL_ITEMS - positive_count,
            risk_signal=1 if crisis else 0,
            max_factor_score=max_avg,
            gsi=result.get("总均分"),
            psdi=result.get("阳性症状均分"),
            submit_timestamp=now_ms(),
            item_answers=json.dumps(answers) if answers else None,
            **factor_cols,
        )
        db.session.add(row)
        _archive_ai_content(user, report, text_report_id=report_id)
        student = db.session.execute(
            select(Student).where(Student.student_id == user.get("id", ""))
        ).scalar_one_or_none()
        if student:
            student.latest_text_report_id = report_id
        db.session.commit()
    except SQLAlchemyError as exc:
        db.session.rollback()
        current_app.logger.warning(
            "[db] 文本测评报告归档失败（不影响本次结果返回）：%s", exc
        )


@bp.post("/api/test/submit")
def submit_test():
    err = _reject_teacher()
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

    report = _generate_report(scenario, result)
    _archive_text_report(
        result, crisis, answers, report, SCENARIOS[scenario]["name"]
    )

    return jsonify({
        "scores": result,
        "has_crisis": len(crisis) > 0,
        "crisis_message": (
            "⚠️ 测评中检测到你可能正处于比较痛苦的阶段，请务必寻求专业帮助：\n"
            + CRISIS_HOTLINE_TEXT
        ) if crisis else "",
        "report": report,
    })
