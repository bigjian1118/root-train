# -*- coding: utf-8 -*-
"""教师端接口：班级报告、AI 综合分析、AI 干预建议。"""
import json
import time

from flask import Blueprint, jsonify, request
from sqlalchemy import or_, select

from ..ai_guard import ai_unavailable
from ..extensions import db
from ..llm import LLMError, chat
from ..models import (
    AiAnalysisReport, Scl90TextReport, Student, TeacherClass, VideoFaceReport, now_ms,
)
from ..prompt import (
    ANALYSIS_PROMPT, INTERVENTION_PROMPT, crowd_tag_to_scenario, scenario_display_name,
)
from ..scoring import FACTOR_EN_MAP, scores_from_report_row
from ..security import require_login, require_teacher

bp = Blueprint("teacher", __name__)


def _teacher_classes(teacher_id: str) -> list[str]:
    rows = db.session.execute(
        select(TeacherClass.class_id)
        .where(TeacherClass.teacher_id == teacher_id)
        .order_by(TeacherClass.create_timestamp.asc())
    ).scalars().all()
    return list(rows)


def _scl90_row_public(row: Scl90TextReport) -> dict:
    """报告行 -> 前端契约列表项（字段名与旧 text_reports 一致）。"""
    factor_avgs = {cn: getattr(row, col) for cn, col in FACTOR_EN_MAP.items()}
    top_factor, best = "", None
    for cn, value in factor_avgs.items():
        if value is not None and (best is None or value > best):
            top_factor, best = cn, value
    return {
        "id": row.report_id,
        "student_id": row.student_id,
        "student_name": row.student_name,
        "class": row.student_class,
        "scenario": crowd_tag_to_scenario(row.crowd_tag),
        "total_score": row.total_score,
        "positive_count": row.pos_item_count,
        "crisis": row.risk_signal or 0,
        "top_factor": top_factor,
        "factor_avgs": factor_avgs,
        "created_at": (row.submit_timestamp // 1000) if row.submit_timestamp else None,
    }


def _load_ai_content(text_report_id: str | None = None,
                     video_report_id: str | None = None) -> str:
    if text_report_id:
        stmt = select(AiAnalysisReport.ai_content).where(
            AiAnalysisReport.text_report_id == text_report_id
        )
    elif video_report_id:
        stmt = select(AiAnalysisReport.ai_content).where(
            AiAnalysisReport.video_report_id == video_report_id
        )
    else:
        return ""
    value = db.session.execute(
        stmt.order_by(AiAnalysisReport.create_timestamp.desc()).limit(1)
    ).scalar_one_or_none()
    return value or ""


def _save_ai_content(user: dict, ai_content: str,
                     text_report_id: str | None = None,
                     video_report_id: str | None = None) -> AiAnalysisReport | None:
    """AI 正文归档：学生场景补齐学号/手机号冗余，教师替学生生成时 owner 为学生。"""
    if not user or not ai_content:
        return None
    no_val, phone, clazz = None, None, user.get("class", "")
    if user.get("role") == "student":
        student = db.session.execute(
            select(Student).where(Student.student_id == user.get("id", ""))
        ).scalar_one_or_none()
        if student:
            no_val, phone, clazz = student.student_no, student.phone, student.class_ or clazz
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


def _analysis_public(row: AiAnalysisReport) -> dict:
    """综合分析行 -> 对外 JSON（不泄露学号/手机号）。"""
    return {
        "id": row.seq_id,
        "student_name": row.student_name,
        "class": row.student_class or "",
        "text_report_id": row.text_report_id or "",
        "video_report_id": row.video_report_id or "",
        "ai_content": row.ai_content or "",
        "created_at": (row.create_timestamp // 1000) if row.create_timestamp else None,
    }


def _find_student(student_id: str) -> Student | None:
    return db.session.execute(
        select(Student).where(Student.student_id == student_id)
    ).scalar_one_or_none()


def _latest_reports(student_id: str) -> tuple[Scl90TextReport | None, VideoFaceReport | None]:
    text_row = db.session.execute(
        select(Scl90TextReport)
        .where(Scl90TextReport.student_id == student_id)
        .order_by(Scl90TextReport.submit_timestamp.desc()).limit(1)
    ).scalar_one_or_none()
    video_row = db.session.execute(
        select(VideoFaceReport)
        .where(VideoFaceReport.student_id == student_id)
        .order_by(VideoFaceReport.create_timestamp.desc()).limit(1)
    ).scalar_one_or_none()
    return text_row, video_row


def _video_metrics(video_row: VideoFaceReport) -> dict:
    metrics = {}
    for raw in (video_row.au_json, video_row.emotion_json):
        if not raw:
            continue
        try:
            metrics.update(json.loads(raw))
        except (ValueError, TypeError):
            pass
    return metrics


def _prompt_inputs(text_row: Scl90TextReport | None,
                   video_row: VideoFaceReport | None) -> tuple[str, str]:
    scl90_json = (
        json.dumps(scores_from_report_row(text_row), ensure_ascii=False, indent=2)
        if text_row else "（无 SCL-90 测评数据）"
    )
    face_json = (
        json.dumps(_video_metrics(video_row), ensure_ascii=False, indent=2)
        if video_row else "（无视频表情分析数据）"
    )
    return scl90_json, face_json


def _analyses_for_student(student: Student) -> list[AiAnalysisReport]:
    """按学生查综合分析历史（表无 student_id：学号优先，缺学号回退姓名+班级）。"""
    if student.student_no:
        stmt = select(AiAnalysisReport).where(
            AiAnalysisReport.student_no == student.student_no
        )
    else:
        stmt = select(AiAnalysisReport).where(
            or_(AiAnalysisReport.student_no.is_(None), AiAnalysisReport.student_no == ""),
            AiAnalysisReport.student_name == student.name,
            AiAnalysisReport.student_class == student.class_,
        )
    return db.session.execute(
        stmt.order_by(AiAnalysisReport.create_timestamp.desc())
    ).scalars().all()


def _split_intervention(text: str) -> tuple[str, str]:
    """按【状态分析】/【干预方案】固定标记拆两段；缺标记时整体归入方案段。"""
    status_mark, plan_mark = "【状态分析】", "【干预方案】"
    status_index, plan_index = text.find(status_mark), text.find(plan_mark)
    if status_index != -1 and plan_index != -1 and plan_index > status_index:
        return (
            text[status_index + len(status_mark):plan_index].strip(),
            text[plan_index + len(plan_mark):].strip(),
        )
    return "", text.strip()


@bp.get("/api/teacher/classes")
def teacher_classes():
    user, err = require_teacher()
    if err:
        return err
    return jsonify({"classes": _teacher_classes(user["id"])})


@bp.get("/api/teacher/reports")
def teacher_reports():
    user, err = require_teacher()
    if err:
        return err
    authorized = _teacher_classes(user["id"])
    if not authorized:
        return jsonify({"class": "", "classes": [], "reports": []})

    selected = (request.args.get("class") or "").strip()
    if selected:
        if selected not in authorized:
            return jsonify({"error": "无权查看该班级数据"}), 403
        target_classes = [selected]
    else:
        target_classes = authorized

    rows = db.session.execute(
        select(Scl90TextReport)
        .where(Scl90TextReport.student_class.in_(target_classes))
        .order_by(Scl90TextReport.submit_timestamp.desc())
    ).scalars().all()
    return jsonify({
        "class": selected or ", ".join(target_classes),
        "classes": target_classes,
        "reports": [_scl90_row_public(row) for row in rows],
    })


@bp.get("/api/teacher/report/<report_id>")
def teacher_report_detail(report_id: str):
    """教师可查看全部班级的报告（与旧版一致，不做班级归属校验）。"""
    user, err = require_teacher()
    if err:
        return err
    row = db.session.execute(
        select(Scl90TextReport).where(Scl90TextReport.report_id == report_id)
    ).scalar_one_or_none()
    if not row:
        return jsonify({"error": "报告不存在"}), 404
    scenario = crowd_tag_to_scenario(row.crowd_tag)
    return jsonify({
        "id": row.report_id,
        "student_name": row.student_name,
        "class": row.student_class,
        "scenario": scenario,
        "scenario_name": scenario_display_name(scenario),
        "scores": scores_from_report_row(row),
        "report": _load_ai_content(text_report_id=row.report_id),
        "submitted_at": row.submit_timestamp,
    })


@bp.post("/api/ai/analysis")
def create_analysis():
    """取该生最新 SCL-90 + 最新视频报告联合生成综合分析。"""
    err = ai_unavailable()
    if err:
        return err
    user, err = require_login()
    if err:
        return err
    data = request.get_json(silent=True) or {}
    role = user.get("role")
    target_sid = user["id"]
    if role == "teacher":
        target_sid = str(data.get("student_id", "")).strip()
        if not target_sid:
            return jsonify({"error": "请指定学生 student_id"}), 400

    student = _find_student(target_sid)
    if not student:
        return jsonify({"error": "学生不存在"}), 404
    if role == "teacher" and student.class_ not in _teacher_classes(user["id"]):
        return jsonify({"error": "无权为该学生生成综合分析"}), 403

    text_row, video_row = _latest_reports(target_sid)
    if not text_row and not video_row:
        return jsonify(
            {"error": "该学生还没有任何测评数据，请先完成 SCL-90 测评或视频检测"}
        ), 400
    scl90_json, face_json = _prompt_inputs(text_row, video_row)
    prompt = ANALYSIS_PROMPT.format(
        student_name=student.name, scl90_json=scl90_json, face_json=face_json
    )
    try:
        content = chat(
            [{"role": "system", "content": "你是一位温暖专业的心理健康顾问。"},
             {"role": "user", "content": prompt}],
            temperature=0.5, max_tokens=1536,
        )
    except LLMError as exc:
        return jsonify({"error": f"AI 综合分析生成失败：{exc}"}), 502

    owner = {"id": target_sid, "name": student.name,
             "class": student.class_, "role": "student"}
    row = _save_ai_content(
        owner, content,
        text_report_id=text_row.report_id if text_row else None,
        video_report_id=video_row.video_report_id if video_row else None,
    )
    db.session.commit()
    return jsonify({"ok": True, "analysis": _analysis_public(row)})


@bp.get("/api/ai/analyses")
def list_analyses():
    user, err = require_login()
    if err:
        return err
    if user.get("role") == "student":
        student = _find_student(user["id"])
        if not student:
            return jsonify({"analyses": []})
        rows = _analyses_for_student(student)
    else:
        authorized = _teacher_classes(user["id"])
        if not authorized:
            return jsonify({"analyses": []})
        sid = (request.args.get("student_id") or "").strip()
        if sid:
            student = _find_student(sid)
            if not student or student.class_ not in authorized:
                return jsonify({"error": "无权查看该学生的综合分析"}), 403
            rows = _analyses_for_student(student)
        else:
            rows = db.session.execute(
                select(AiAnalysisReport)
                .where(AiAnalysisReport.student_class.in_(authorized))
                .order_by(AiAnalysisReport.create_timestamp.desc())
            ).scalars().all()
    return jsonify({"analyses": [_analysis_public(row) for row in rows]})


@bp.post("/api/ai/intervention")
def create_intervention():
    """教师端干预建议：只读最新两类报告生成，不写归档表。"""
    err = ai_unavailable()
    if err:
        return err
    user, err = require_login()
    if err:
        return err
    if user.get("role") != "teacher":
        return jsonify({"error": "仅教师账号可使用 AI 干预建议"}), 403
    data = request.get_json(silent=True) or {}
    target_sid = str(data.get("student_id", "")).strip()
    if not target_sid:
        return jsonify({"error": "请指定学生 student_id"}), 400

    student = _find_student(target_sid)
    if not student:
        return jsonify({"error": "学生不存在"}), 404
    if student.class_ not in _teacher_classes(user["id"]):
        return jsonify({"error": "无权为该学生生成干预建议"}), 403

    text_row, video_row = _latest_reports(target_sid)
    if not text_row and not video_row:
        return jsonify({"error": "该学生还没有任何测评数据，无法生成干预建议"}), 400
    scl90_json, face_json = _prompt_inputs(text_row, video_row)
    prompt = INTERVENTION_PROMPT.format(
        student_name=student.name, scl90_json=scl90_json, face_json=face_json
    )
    try:
        content = chat(
            [{"role": "system",
              "content": "你是资深学校心理健康教育指导教师，为班主任提供客观研判与可落地的干预建议。"},
             {"role": "user", "content": prompt}],
            temperature=0.5, max_tokens=1536,
        )
    except LLMError as exc:
        return jsonify({"error": f"AI 干预建议生成失败：{exc}"}), 502

    status_text, plan_text = _split_intervention(content)
    return jsonify({
        "ok": True,
        "student_name": student.name,
        "class": student.class_ or "",
        "status": status_text,
        "plan": plan_text,
        "generated_at": int(time.time()),
    })


@bp.get("/api/teacher/class-options")
def class_options():
    """系统内全部有效班级（任教班级自主修改的选项源）。

    无班级主表：有效班级 = 学生在读班级 ∪ 历史教师绑定班级；
    按名称年级前缀（如「初一(2)班」→ 初一）尽力分组，识别不了的归入「其他」。
    max_classes 为可选上限（0 表示不限制），与后端保存校验同源。
    """
    _, err = require_teacher()
    if err:
        return err
    from ..security import MAX_TEACHER_CLASSES
    from ..services.class_group import grouped_valid_classes

    payload = grouped_valid_classes()
    payload["max_classes"] = MAX_TEACHER_CLASSES
    return jsonify(payload)
