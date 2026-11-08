# -*- coding: utf-8 -*-
"""人脸视频分析接口：视频 -> 客观指标 -> 大模型报告，并归档检测结果。

隐私约定：无论成功/失败，报告流程结束立即删除暂存视频。
"""
import json
import os
import uuid

from flask import Blueprint, current_app, jsonify, request

from ..config import Config
from ..extensions import db
from ..llm import LLMError, chat
from ..models import AiAnalysisReport, Student, VideoFaceReport, now_ms
from ..prompt import FACE_REPORT_PROMPT
from ..security import get_session_user, make_business_id, reject_teacher
from ..services.face_service import FaceAnalysisError, analyze_video

bp = Blueprint("face", __name__)

# 报告生成参数（沿用旧版取值，保证输出风格一致）
_REPORT_TEMPERATURE = 0.5
_REPORT_MAX_TOKENS = 1024

# 应用启动时确保暂存目录存在；目录不可写时不要阻塞应用导入
try:
    os.makedirs(Config.UPLOAD_DIR, exist_ok=True)
except OSError:
    pass


def _generate_report(metrics: dict) -> str:
    """调大模型生成状态报告；报告失败不阻塞，仍返回客观指标。"""
    if not Config.AI_ENABLED:
        # 无卡模式：py-feat 网关 CPU 照常出指标，仅 AI 文本报告降级
        return f"（{Config.AI_DISABLED_MESSAGE}，客观指标不受影响）"
    prompt = FACE_REPORT_PROMPT.format(
        metrics_json=json.dumps(metrics, ensure_ascii=False, indent=2)
    )
    try:
        return chat(
            [{"role": "user", "content": prompt}],
            temperature=_REPORT_TEMPERATURE,
            max_tokens=_REPORT_MAX_TOKENS,
        )
    except LLMError as exc:
        return f"（AI 报告生成失败：{exc}）"


def _student_profile(user: dict) -> dict:
    """归档用的学生四件套；教师账号无学生档案，退回会话信息。"""
    profile = {
        "student_name": user.get("name", "匿名用户"),
        "student_class": user.get("class", ""),
        "student_no": None,
        "phone": None,
    }
    if user.get("role") == "student":
        student = db.session.get(Student, user.get("id", ""))
        if student:
            profile["student_no"] = student.student_no
            profile["phone"] = student.phone
            profile["student_class"] = student.class_ or profile["student_class"]
    return profile


def _archive_report(user: dict, metrics: dict, report: str) -> None:
    """归档视频指标 + AI 报告；归档失败只记 warning，不影响本次返回。"""
    report_id = make_business_id()
    timestamp = now_ms()
    au_json = json.dumps({
        "au": metrics.get("au") or {},
        "total_frames": metrics.get("total_frames"),
        "face_frames": metrics.get("face_frames"),
        "face_activity": metrics.get("face_activity"),
    }, ensure_ascii=False)
    emotion_json = json.dumps({
        "emotions": metrics.get("emotions") or {},
        "dominant_emotion": metrics.get("dominant_emotion", ""),
        "dominant_emotion_source": metrics.get("dominant_emotion_source", ""),
        "smile_detected": metrics.get("smile_detected", False),
    }, ensure_ascii=False)
    try:
        db.session.add(VideoFaceReport(
            video_report_id=report_id,
            student_id=user.get("id", ""),
            au_json=au_json,
            emotion_json=emotion_json,
            landmark_json=None,
            prominent_dimension=metrics.get("dominant_emotion", ""),
            create_timestamp=timestamp,
        ))
        db.session.add(AiAnalysisReport(
            **_student_profile(user),
            video_report_id=report_id,
            ai_content=report,
            create_timestamp=timestamp,
        ))
        # 学生表同步记录最新视频检测报告 id
        if user.get("role") == "student":
            student = db.session.get(Student, user["id"])
            if student:
                student.latest_video_report_id = report_id
        db.session.commit()
    except Exception as exc:
        db.session.rollback()
        current_app.logger.warning("[db] 视频检测报告归档失败（不影响本次结果返回）：%s", exc)


@bp.post("/api/face/analyze")
def analyze_face_video():
    """分析视频：multipart 字段 video（webm/mp4/mov，≤50MB），返回 {metrics, report}。"""
    err = reject_teacher()
    if err:
        return err
    video = request.files.get("video")
    if video is None or video.filename == "":
        return jsonify({"error": "未上传视频文件"}), 400

    # 仅按扩展名白名单落盘，文件名用 uuid 防路径穿越/覆盖
    ext = os.path.splitext(video.filename)[1].lower()
    if ext not in Config.UPLOAD_EXTENSIONS:
        return jsonify({"error": "仅支持 webm / mp4 / mov 视频"}), 400
    save_path = os.path.join(Config.UPLOAD_DIR, f"{uuid.uuid4().hex}{ext}")
    video.save(save_path)

    try:
        try:
            metrics = analyze_video(save_path)
        except FaceAnalysisError as exc:
            return jsonify({"error": f"视频分析失败：{exc}"}), 422
        except Exception as exc:
            return jsonify({"error": f"py-feat 运行异常：{exc}"}), 500

        report = _generate_report(metrics)
        user = get_session_user()
        if user:
            _archive_report(user, metrics, report)
        return jsonify({"metrics": metrics, "report": report})
    finally:
        # 隐私保护：立即删除暂存视频，避免磁盘堆积与人脸数据残留
        try:
            os.remove(save_path)
        except OSError:
            pass
