# -*- coding: utf-8 -*-
"""教师端接口：班级报告、AI 综合分析、AI 干预建议。"""
import json
import time

from flask import Blueprint, jsonify, request
from sqlalchemy import and_, func, or_, select

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
from ..services.analysis_tasks import ETA_SECONDS as ANALYSIS_ETA_SECONDS, retry_composite

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
        # 仅取纯文本报告的解读（video_report_id 为空），避免命中综合分析
        stmt = select(AiAnalysisReport.ai_content).where(
            AiAnalysisReport.text_report_id == text_report_id,
            AiAnalysisReport.video_report_id.is_(None),
        )
    elif video_report_id:
        # 仅取纯视频报告的解读（text_report_id 为空），避免命中综合分析
        stmt = select(AiAnalysisReport.ai_content).where(
            AiAnalysisReport.video_report_id == video_report_id,
            AiAnalysisReport.text_report_id.is_(None),
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
        student_id=user.get("id") or None,
        text_report_id=text_report_id,
        video_report_id=video_report_id,
        ai_content=ai_content,
        create_timestamp=now_ms(),
        status="completed",
    )
    db.session.add(row)
    return row


# 综合报告同一份正文内含学生版 / 教师版两段，学生端只返回学生版，避免专业指标透传
_STUDENT_SECTION = "## 学生版"
_TEACHER_SECTION = "## 教师版"


def _split_dual_content(content: str) -> tuple[str, str]:
    """把综合报告正文拆成（学生版, 教师版）。缺少标记时视为同一份内容。"""
    if not content:
        return "", ""
    student_idx = content.find(_STUDENT_SECTION)
    teacher_idx = content.find(_TEACHER_SECTION)
    if student_idx < 0 and teacher_idx < 0:
        return content, content
    if student_idx >= 0 and teacher_idx > student_idx:
        student_part = content[student_idx + len(_STUDENT_SECTION):teacher_idx].strip()
        teacher_part = content[teacher_idx + len(_TEACHER_SECTION):].strip()
        return student_part, teacher_part
    if student_idx >= 0:
        return content[student_idx + len(_STUDENT_SECTION):].strip(), content.strip()
    return content[teacher_idx + len(_TEACHER_SECTION):].strip(), content.strip()


def _content_for_role(content: str, role: str) -> str:
    """学生只下发通俗版正文；教师下发完整正文。"""
    if role != "student":
        return content or ""
    student_part, _ = _split_dual_content(content or "")
    return student_part


def _analysis_public(row: AiAnalysisReport, viewer_role: str = "teacher") -> dict:
    """综合分析行 -> 对外 JSON（不泄露学号/手机号）。"""
    return {
        "id": row.seq_id,
        "student_id": row.student_id or "",
        "student_name": row.student_name,
        "class": row.student_class or "",
        "text_report_id": row.text_report_id or "",
        "video_report_id": row.video_report_id or "",
        "ai_content": _content_for_role(row.ai_content or "", viewer_role),
        "status": row.status or "completed",
        "error_message": row.error_message or "",
        "created_at": (row.create_timestamp // 1000) if row.create_timestamp else None,
        "finished_at": (row.finished_at // 1000) if row.finished_at else None,
        "teacher_read": int(row.teacher_read or 0),
    }


def _analysis_status_public(row: AiAnalysisReport) -> dict:
    """状态轮询专用轻量结构：不含正文，降低轮询开销。"""
    return {
        "id": row.seq_id,
        "student_id": row.student_id or "",
        "student_name": row.student_name,
        "class": row.student_class or "",
        "text_report_id": row.text_report_id or "",
        "video_report_id": row.video_report_id or "",
        "status": row.status or "completed",
        "error_message": row.error_message or "",
        "created_at": (row.create_timestamp // 1000) if row.create_timestamp else None,
        "finished_at": (row.finished_at // 1000) if row.finished_at else None,
        "teacher_read": int(row.teacher_read or 0),
        "eta_seconds": ANALYSIS_ETA_SECONDS if (row.status or "") == "processing" else 0,
    }


def _student_scope_conditions(student: Student) -> list:
    """学生归属条件：优先显式 student_id，兼容存量仅写学号/姓名+班级的数据。"""
    conditions = [AiAnalysisReport.student_id == student.student_id]
    if student.student_no:
        conditions.append(AiAnalysisReport.student_no == student.student_no)
    else:
        conditions.append(and_(
            or_(AiAnalysisReport.student_no.is_(None), AiAnalysisReport.student_no == ""),
            AiAnalysisReport.student_name == student.name,
            AiAnalysisReport.student_class == student.class_,
        ))
    return conditions


def _owns_analysis(row: AiAnalysisReport, student: Student) -> bool:
    if row.student_id:
        return row.student_id == student.student_id
    if student.student_no:
        return row.student_no == student.student_no
    return (
        row.student_name == student.name
        and (row.student_class or "") == (student.class_ or "")
    )


def _teacher_scope_conditions(teacher_id: str, classes: list[str]) -> list:
    """教师可见范围：任教班级，或报告明确归属当前教师（学生转班后仍可见）。"""
    return [
        AiAnalysisReport.student_class.in_(classes),
        AiAnalysisReport.teacher_id == teacher_id,
    ]


def _teacher_can_access(row: AiAnalysisReport, teacher_id: str,
                        classes: list[str]) -> bool:
    return (row.student_class or "") in classes or row.teacher_id == teacher_id


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
    """按学生查综合分析历史：显式 student_id 优先，兼容存量学号/姓名+班级。"""
    return db.session.execute(
        select(AiAnalysisReport)
        .where(or_(*_student_scope_conditions(student)))
        .order_by(AiAnalysisReport.create_timestamp.desc())
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
    """教师查看报告详情：仅限本人任教班级，防止遍历 report_id 读取全校心理档案。"""
    user, err = require_teacher()
    if err:
        return err
    row = db.session.execute(
        select(Scl90TextReport).where(Scl90TextReport.report_id == report_id)
    ).scalar_one_or_none()
    if not row:
        return jsonify({"error": "报告不存在"}), 404
    if row.student_class not in _teacher_classes(user["id"]):
        return jsonify({"error": "无权查看该班级的报告"}), 403
    scenario = crowd_tag_to_scenario(row.crowd_tag)
    return jsonify({
        "id": row.report_id,
        "student_id": row.student_id,
        "student_name": row.student_name,
        "class": row.student_class,
        "scenario": scenario,
        "scenario_name": scenario_display_name(scenario),
        "scores": scores_from_report_row(row),
        "report": _load_ai_content(text_report_id=row.report_id),
        "submitted_at": row.submit_timestamp,
    })


@bp.get("/api/teacher/student/<sid>/reports")
def teacher_student_reports(sid: str):
    """返回该学生所有 SCL-90 报告列表（按时间降序），供教师端报告页左栏历史记录使用。"""
    user, err = require_teacher()
    if err:
        return err
    authorized = _teacher_classes(user["id"])
    student = db.session.get(Student, sid)
    if not student:
        return jsonify({"error": "学生不存在"}), 404
    if student.class_ not in authorized:
        return jsonify({"error": "无权查看该学生数据"}), 403

    rows = db.session.execute(
        select(Scl90TextReport)
        .where(Scl90TextReport.student_id == sid)
        .order_by(Scl90TextReport.submit_timestamp.desc())
    ).scalars().all()

    return jsonify({
        "student_id": sid,
        "student_name": student.name,
        "reports": [_scl90_row_public(row) for row in rows],
    })


@bp.get("/api/teacher/student/<sid>/factor-history")
def teacher_student_factor_history(sid: str):
    """返回该学生所有 SCL-90 报告的因子分（按时间升序），供折线图展示。"""
    user, err = require_teacher()
    if err:
        return err
    authorized = _teacher_classes(user["id"])
    student = db.session.get(Student, sid)
    if not student:
        return jsonify({"error": "学生不存在"}), 404
    if student.class_ not in authorized:
        return jsonify({"error": "无权查看该学生数据"}), 403

    rows = db.session.execute(
        select(Scl90TextReport)
        .where(Scl90TextReport.student_id == sid)
        .order_by(Scl90TextReport.submit_timestamp.asc())
    ).scalars().all()

    factor_cols = [
        ("躯体化", "somatization"),
        ("强迫症状", "ocd"),
        ("人际关系敏感", "interpersonal_sensitivity"),
        ("抑郁", "depression"),
        ("焦虑", "anxiety"),
        ("敌对", "hostility"),
        ("恐怖", "phobic_anxiety"),
        ("偏执", "paranoid_ideation"),
        ("精神病性", "psychoticism"),
        ("其他", "additional"),
    ]
    history = []
    for row in rows:
        item = {
            "submit_time": row.submit_timestamp,
            "total_score": row.total_score,
            "factors": {cn: getattr(row, col) for cn, col in factor_cols},
        }
        history.append(item)

    return jsonify({
        "student_id": sid,
        "student_name": student.name,
        "factor_names": [cn for cn, _ in factor_cols],
        "history": history,
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
    return jsonify({"ok": True, "analysis": _analysis_public(row, role)})


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
    role = user.get("role", "teacher")
    return jsonify({"analyses": [_analysis_public(row, role) for row in rows]})


def _risk_flags(text_report_ids: list[str]) -> dict[str, bool]:
    """批量取文本报告的危机标记，避免列表逐行查询。"""
    if not text_report_ids:
        return {}
    rows = db.session.execute(
        select(Scl90TextReport.report_id, Scl90TextReport.risk_signal)
        .where(Scl90TextReport.report_id.in_(text_report_ids))
    ).all()
    return {report_id: bool(flag) for report_id, flag in rows}


@bp.get("/api/ai/status")
def ai_analysis_status():
    """综合报告轻量状态查询：支持按报告ID / 学生ID 轮询，不含正文。"""
    user, err = require_login()
    if err:
        return err
    role = user.get("role")
    raw_id = (request.args.get("report_id") or "").strip()
    student_arg = (request.args.get("student_id") or "").strip()

    stmt = select(AiAnalysisReport).where(
        AiAnalysisReport.text_report_id.is_not(None),
        AiAnalysisReport.video_report_id.is_not(None),
    )
    if raw_id:
        try:
            seq_id = int(raw_id)
        except ValueError:
            return jsonify({"error": "report_id 不合法"}), 400
        stmt = stmt.where(AiAnalysisReport.seq_id == seq_id)

    if role == "student":
        student = _find_student(user["id"])
        if student is None:
            return jsonify({"items": []})
        stmt = stmt.where(or_(*_student_scope_conditions(student)))
    else:
        authorized = _teacher_classes(user["id"])
        if not authorized:
            return jsonify({"items": []})
        if student_arg:
            student = _find_student(student_arg)
            if student is None:
                return jsonify({"error": "学生不存在"}), 404
            if (student.class_ or "") not in authorized:
                return jsonify({"error": "无权查看该学生数据"}), 403
            stmt = stmt.where(or_(*_student_scope_conditions(student)))
        else:
            stmt = stmt.where(or_(*_teacher_scope_conditions(user["id"], authorized)))

    rows = db.session.execute(
        stmt.order_by(AiAnalysisReport.create_timestamp.desc()).limit(20)
    ).scalars().all()
    return jsonify({"items": [_analysis_status_public(row) for row in rows]})


@bp.get("/api/ai/analysis/<int:report_id>")
def get_analysis(report_id: int):
    """综合报告详情：学生仅本人、教师仅本班。"""
    user, err = require_login()
    if err:
        return err
    row = db.session.get(AiAnalysisReport, report_id)
    if row is None:
        return jsonify({"error": "综合报告不存在"}), 404

    role = user.get("role", "teacher")
    if role == "student":
        student = _find_student(user["id"])
        if student is None or not _owns_analysis(row, student):
            return jsonify({"error": "无权查看该报告"}), 403
    elif not _teacher_can_access(row, user["id"], _teacher_classes(user["id"])):
        return jsonify({"error": "无权查看该报告"}), 403
    return jsonify({"analysis": _analysis_public(row, role)})


@bp.post("/api/ai/analysis/retry")
def retry_analysis():
    """失败重跑：复用原归档行，不产生重复数据。"""
    user, err = require_login()
    if err:
        return err
    data = request.get_json(silent=True) or {}
    try:
        seq_id = int(data.get("report_id"))
    except (TypeError, ValueError):
        return jsonify({"error": "report_id 不合法"}), 400

    row = db.session.get(AiAnalysisReport, seq_id)
    if row is None:
        return jsonify({"error": "综合报告不存在"}), 404
    if not (row.text_report_id and row.video_report_id):
        return jsonify({"error": "仅综合报告支持重新生成"}), 400

    role = user.get("role", "teacher")
    if role == "student":
        student = _find_student(user["id"])
        if student is None or not _owns_analysis(row, student):
            return jsonify({"error": "无权操作该报告"}), 403
    elif not _teacher_can_access(row, user["id"], _teacher_classes(user["id"])):
        return jsonify({"error": "无权操作该报告"}), 403

    if row.status == "completed" and row.ai_content:
        return jsonify({"ok": True, "status": "completed", "id": seq_id})
    retry_composite(seq_id)
    return jsonify({"ok": True, "status": "processing", "id": seq_id})


@bp.get("/api/teacher/ai/composites")
def teacher_ai_composites():
    """教师端综合报告列表：仅本班，返回状态与未读数（不含正文）。"""
    user, err = require_teacher()
    if err:
        return err
    authorized = _teacher_classes(user["id"])
    if not authorized:
        return jsonify({"reports": [], "unread": 0})

    class_arg = (request.args.get("class") or "").strip()
    if class_arg and class_arg not in authorized:
        return jsonify({"error": "无权查看该班级"}), 403
    scope = [class_arg] if class_arg else authorized

    rows = db.session.execute(
        select(AiAnalysisReport)
        .where(
            or_(*_teacher_scope_conditions(user["id"], scope)),
            AiAnalysisReport.text_report_id.is_not(None),
            AiAnalysisReport.video_report_id.is_not(None),
        )
        .order_by(AiAnalysisReport.create_timestamp.desc())
        .limit(200)
    ).scalars().all()

    risk_map = _risk_flags([row.text_report_id for row in rows if row.text_report_id])
    items = []
    unread = 0
    for row in rows:
        item = _analysis_status_public(row)
        item["risk"] = bool(risk_map.get(row.text_report_id or ""))
        items.append(item)
        if item["status"] == "completed" and not item["teacher_read"]:
            unread += 1
    return jsonify({"reports": items, "unread": unread})


@bp.get("/api/teacher/ai/unread-count")
def teacher_ai_unread_count():
    """教师端红点计数：本班已完成且未读的综合报告数。"""
    user, err = require_teacher()
    if err:
        return err
    authorized = _teacher_classes(user["id"])
    if not authorized:
        return jsonify({"count": 0})
    count = db.session.execute(
        select(func.count()).select_from(AiAnalysisReport).where(
            or_(*_teacher_scope_conditions(user["id"], authorized)),
            AiAnalysisReport.text_report_id.is_not(None),
            AiAnalysisReport.video_report_id.is_not(None),
            AiAnalysisReport.status == "completed",
            AiAnalysisReport.teacher_read == 0,
        )
    ).scalar_one()
    return jsonify({"count": int(count or 0)})


@bp.post("/api/teacher/ai/read")
def teacher_ai_mark_read():
    """教师查看学生详情后清除红点：按报告ID或学生ID批量置为已读。"""
    user, err = require_teacher()
    if err:
        return err
    authorized = _teacher_classes(user["id"])
    if not authorized:
        return jsonify({"error": "无权操作"}), 403

    data = request.get_json(silent=True) or {}
    raw_id = data.get("report_id")
    student_id = str(data.get("student_id") or "").strip()

    stmt = select(AiAnalysisReport).where(
        or_(*_teacher_scope_conditions(user["id"], authorized)),
        AiAnalysisReport.text_report_id.is_not(None),
        AiAnalysisReport.video_report_id.is_not(None),
    )
    if raw_id is not None:
        try:
            stmt = stmt.where(AiAnalysisReport.seq_id == int(raw_id))
        except (TypeError, ValueError):
            return jsonify({"error": "report_id 不合法"}), 400
    elif student_id:
        stmt = stmt.where(AiAnalysisReport.student_id == student_id)
    else:
        return jsonify({"error": "请指定 report_id 或 student_id"}), 400

    rows = db.session.execute(stmt).scalars().all()
    for row in rows:
        row.teacher_read = 1
    db.session.commit()
    return jsonify({"ok": True, "updated": len(rows)})


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
