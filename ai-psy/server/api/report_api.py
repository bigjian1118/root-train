# -*- coding: utf-8 -*-
"""学生个人报告与视频检测报告接口：列表 / 详情 / 删除 / 教师查看本班视频报告。"""
import json

from flask import Blueprint, jsonify
from sqlalchemy import select

from ..extensions import db
from ..models import (
    AiAnalysisReport, Scl90TextReport, Student, TeacherClass, VideoFaceReport,
)
from ..prompt import crowd_tag_to_scenario, scenario_display_name
from ..scoring import FACTOR_EN_MAP, scores_from_report_row
from ..security import require_login, require_teacher

bp = Blueprint("report", __name__)


def _teacher_classes(teacher_id: str) -> list[str]:
    rows = db.session.execute(
        select(TeacherClass.class_id)
        .where(TeacherClass.teacher_id == teacher_id)
        .order_by(TeacherClass.create_timestamp.asc())
    ).scalars().all()
    return list(rows)


def _require_student_reports():
    """学生个人报告权限：文案沿用旧接口契约（与 security.require_student 不同）。"""
    user, err = require_login()
    if err:
        return None, err
    if user.get("role") != "student":
        return None, (jsonify({"error": "仅学生账号可查看个人报告"}), 403)
    return user, None


def _scl90_row_public(row: Scl90TextReport) -> dict:
    """报告行 -> 前端列表项（字段名与旧 text_reports 保持一致）。"""
    factor_avgs = {
        cn: getattr(row, col) for cn, col in FACTOR_EN_MAP.items()
    }
    top_factor = ""
    best = None
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
    """读取某份报告最新的 AI 正文（无则空串）。"""
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


def _video_metrics(video: VideoFaceReport) -> dict:
    """au_json / emotion_json 两列合并还原 metrics 结构（解析失败跳过）。"""
    metrics = {}
    for raw in (video.au_json, video.emotion_json):
        if not raw:
            continue
        try:
            metrics.update(json.loads(raw))
        except (ValueError, TypeError):
            pass
    return metrics


def _video_row_public(video: VideoFaceReport, user_name: str | None,
                      ai_content: str = "", with_metrics: bool = False) -> dict:
    """视频报告行 -> 前端契约（保留旧字段，并补 student_id/au 等直取字段）。"""
    metrics = _video_metrics(video)
    item = {
        "id": video.video_report_id,
        "student_id": video.student_id,
        "user_name": user_name,
        "top_factor": video.prominent_dimension,
        "prominent_dimension": video.prominent_dimension,
        "au": metrics.get("au") or {},
        "emotions": metrics.get("emotions") or {},
        "dominant_emotion": metrics.get("dominant_emotion", ""),
        "created_at": (
            video.create_timestamp // 1000
        ) if video.create_timestamp else None,
    }
    if with_metrics:
        item["metrics"] = metrics
        item["report"] = ai_content or ""
        item["submitted_at"] = video.create_timestamp  # 毫秒，与前端 toLocaleString 一致
    return item


@bp.get("/api/student/reports")
def student_reports():
    user, err = _require_student_reports()
    if err:
        return err
    rows = db.session.execute(
        select(Scl90TextReport)
        .where(Scl90TextReport.student_id == user["id"])
        .order_by(Scl90TextReport.submit_timestamp.desc())
    ).scalars().all()
    return jsonify({"reports": [_scl90_row_public(row) for row in rows]})


@bp.get("/api/student/report/<report_id>")
def student_report_detail(report_id: str):
    user, err = _require_student_reports()
    if err:
        return err
    row = db.session.execute(
        select(Scl90TextReport).where(
            Scl90TextReport.report_id == report_id,
            Scl90TextReport.student_id == user["id"],
        )
    ).scalar_one_or_none()
    if not row:
        return jsonify({"error": "报告不存在或不属于你"}), 404
    scenario = crowd_tag_to_scenario(row.crowd_tag)
    return jsonify({
        "id": row.report_id,
        "scenario": scenario,
        "scenario_name": scenario_display_name(scenario),
        "scores": scores_from_report_row(row),
        "report": _load_ai_content(text_report_id=row.report_id),
        "submitted_at": row.submit_timestamp,
    })


@bp.delete("/api/student/report/<report_id>")
def student_report_delete(report_id: str):
    user, err = require_login()
    if err:
        return err
    if user.get("role") != "student":
        return jsonify({"error": "仅学生本人可删除自己的报告（教师无删除权限）"}), 403
    row = db.session.execute(
        select(Scl90TextReport).where(
            Scl90TextReport.report_id == report_id,
            Scl90TextReport.student_id == user["id"],
        )
    ).scalar_one_or_none()
    if not row:
        return jsonify({"error": "报告不存在或不属于你"}), 404
    db.session.delete(row)
    db.session.commit()
    return jsonify({"ok": True})


@bp.get("/api/face/reports")
def face_reports():
    user, err = require_login()
    if err:
        return err
    rows = db.session.execute(
        select(VideoFaceReport, Student.name)
        .join(Student, Student.student_id == VideoFaceReport.student_id, isouter=True)
        .where(VideoFaceReport.student_id == user["id"])
        .order_by(VideoFaceReport.create_timestamp.desc())
    ).all()
    return jsonify({
        "reports": [
            _video_row_public(video, user_name)
            for video, user_name in rows
        ]
    })


@bp.get("/api/face/report/<report_id>")
def face_report_detail(report_id: str):
    user, err = require_login()
    if err:
        return err
    row = db.session.execute(
        select(VideoFaceReport, Student.name)
        .join(Student, Student.student_id == VideoFaceReport.student_id, isouter=True)
        .where(
            VideoFaceReport.video_report_id == report_id,
            VideoFaceReport.student_id == user["id"],
        )
    ).first()
    if not row:
        return jsonify({"error": "报告不存在或不属于你"}), 404
    video, user_name = row
    return jsonify(_video_row_public(
        video, user_name, _load_ai_content(video_report_id=video.video_report_id),
        with_metrics=True,
    ))


@bp.get("/api/teacher/student/<sid>/face-reports")
def teacher_student_face_reports(sid: str):
    user, err = require_teacher()
    if err:
        return err
    student = db.session.execute(
        select(Student).where(Student.student_id == sid)
    ).scalar_one_or_none()
    if not student:
        return jsonify({"error": "学生不存在"}), 404
    if student.class_ not in _teacher_classes(user["id"]):
        return jsonify({"error": "无权查看该学生的视频报告"}), 403
    rows = db.session.execute(
        select(VideoFaceReport, Student.name)
        .join(Student, Student.student_id == VideoFaceReport.student_id, isouter=True)
        .where(VideoFaceReport.student_id == sid)
        .order_by(VideoFaceReport.create_timestamp.desc())
    ).all()
    return jsonify({
        "reports": [
            _video_row_public(
                video, user_name,
                _load_ai_content(video_report_id=video.video_report_id),
                with_metrics=True,
            )
            for video, user_name in rows
        ]
    })


@bp.delete("/api/face/report/<report_id>")
def face_report_delete(report_id: str):
    user, err = require_login()
    if err:
        return err
    row = db.session.execute(
        select(VideoFaceReport).where(
            VideoFaceReport.video_report_id == report_id,
            VideoFaceReport.student_id == user["id"],
        )
    ).scalar_one_or_none()
    if not row:
        return jsonify({"error": "报告不存在或不属于你"}), 404
    db.session.delete(row)
    db.session.commit()
    return jsonify({"ok": True})
