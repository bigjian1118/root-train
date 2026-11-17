# -*- coding: utf-8 -*-
"""人脸视频分析接口：上传即建档（processing），分析与报告由后台任务完成。

隐私约定：任务结束（成功/失败）立即删除暂存视频。
"""
import hashlib
import os
import time
import uuid

from flask import Blueprint, current_app, jsonify, request
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError

from ..config import Config
from ..extensions import db
from ..models import VideoFaceReport, now_ms
from ..security import make_business_id, reject_teacher, require_login
from ..services.report_tasks import enqueue_video_report, make_request_key

bp = Blueprint("face", __name__)

_CHUNK_BYTES = 1024 * 1024

# 应用启动时确保暂存目录存在；目录不可写时不要阻塞应用导入
try:
    os.makedirs(Config.UPLOAD_DIR, exist_ok=True)
except OSError:
    pass

# 暂存视频最长保留时间：正常流程在后台任务 finally 中删除，只有进程被强杀/断电才会残留
_STALE_UPLOAD_SECONDS = 3600


def _cleanup_stale_uploads() -> None:
    """清理上次运行遗留的暂存视频（隐私要求：人脸视频不得长期驻留磁盘）。"""
    deadline = time.time() - _STALE_UPLOAD_SECONDS
    try:
        entries = list(os.scandir(Config.UPLOAD_DIR))
    except OSError:
        return
    for entry in entries:
        try:
            if (entry.is_file()
                    and os.path.splitext(entry.name)[1].lower() in Config.UPLOAD_EXTENSIONS
                    and entry.stat().st_mtime < deadline):
                os.remove(entry.path)
        except OSError:
            continue


_cleanup_stale_uploads()


def _save_upload(video, save_path: str) -> str:
    """边落盘边算 sha256，作为幂等键；避免为了哈希再读一遍视频。"""
    hasher = hashlib.sha256()
    with open(save_path, "wb") as fh:
        while True:
            chunk = video.stream.read(_CHUNK_BYTES)
            if not chunk:
                break
            hasher.update(chunk)
            fh.write(chunk)
    return hasher.hexdigest()


def _find_existing(student_id: str, request_key: str) -> VideoFaceReport | None:
    return db.session.execute(
        select(VideoFaceReport).where(
            VideoFaceReport.student_id == student_id,
            VideoFaceReport.request_key == request_key,
        )
    ).scalar_one_or_none()


def _status_payload(row: VideoFaceReport):
    return jsonify({"report_id": row.video_report_id, "status": row.status or "processing"})


@bp.post("/api/face/analyze")
def analyze_face_video():
    """上传视频：multipart 字段 video（webm/mp4/mov），立即返回 {report_id, status}。"""
    err = reject_teacher()
    if err:
        return err
    user, err = require_login()
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
    try:
        video_hash = _save_upload(video, save_path)
    except Exception:
        # 浏览器中途断开（关页面/网络抖动/代理重连）会留下半截文件，必须立即删除
        try:
            os.remove(save_path)
        except OSError:
            pass
        return jsonify({"error": "视频上传中断，请重新提交"}), 400

    def _drop_file() -> None:
        try:
            os.remove(save_path)
        except OSError:
            pass

    request_key = make_request_key(user.get("id", ""), video_hash)
    existing = _find_existing(user.get("id", ""), request_key)
    if existing:
        # 同一学生重复上传同一段视频：直接复用已有任务，不重复消耗算力
        _drop_file()
        return _status_payload(existing)

    row = VideoFaceReport(
        video_report_id=make_business_id(),
        student_id=user.get("id", ""),
        create_timestamp=now_ms(),
        status="processing",
        request_key=request_key,
    )
    try:
        db.session.add(row)
        db.session.commit()
    except SQLAlchemyError as exc:
        db.session.rollback()
        existing = _find_existing(user.get("id", ""), request_key)
        _drop_file()
        if existing:
            return _status_payload(existing)
        current_app.logger.warning("[face] 视频报告建档失败：%s", exc)
        return jsonify({"error": "提交失败，请稍后重试"}), 500

    current_app.logger.info("[face] 已入队报告生成 %s（%.1fMB）",
                            row.video_report_id, os.path.getsize(save_path) / 1048576)
    enqueue_video_report(row.video_report_id, user, save_path)
    return _status_payload(row)
