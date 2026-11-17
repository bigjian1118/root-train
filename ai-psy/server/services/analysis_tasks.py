# -*- coding: utf-8 -*-
"""AI 综合报告异步生成：文本 + 视频双报告均完成后自动触发。

与页面/会话完全解耦：任务在独立线程 + 独立 app_context/session 中执行，
关闭页面、切换功能、退出登录都不影响。便携版为单进程 Flask，进程内线程池即可。

幂等：同一学生 + 同一文本报告 + 同一视频报告只生成一条综合报告，
request_key 上的部分唯一索引兜底并发重复触发。
"""
import hashlib
import json
import logging
import os
from concurrent.futures import ThreadPoolExecutor

from flask import Flask
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from ..config import Config
from ..extensions import db
from ..llm import LLMError, chat
from ..models import (
    AiAnalysisReport, Scl90TextReport, Student, TeacherClass, VideoFaceReport, now_ms,
)
from ..prompt import COMPOSITE_PROMPT
from ..scoring import scores_from_report_row

logger = logging.getLogger("xinqing.analysis")

# 综合报告生成参数：需要同时覆盖学生版与教师版，token 上限高于单份报告
_COMPOSITE_TEMPERATURE = 0.4
_COMPOSITE_MAX_TOKENS = 2048
# 状态接口的粗略剩余时长（秒），仅用于前端文案
ETA_SECONDS = 90

_MAX_WORKERS = int(os.environ.get("ANALYSIS_TASK_WORKERS", "2"))

_executor = ThreadPoolExecutor(max_workers=_MAX_WORKERS, thread_name_prefix="analysis-task")
_app: Flask | None = None


class CompositeAnalysisError(RuntimeError):
    """综合报告生成失败：异常信息会写入 error_message 供前端展示。"""


def init_analysis_worker(app: Flask) -> None:
    """应用启动时注入 Flask app；任务线程靠它创建 app_context。"""
    global _app
    _app = app


def make_composite_key(student_id: str, text_report_id: str,
                       video_report_id: str) -> str:
    """幂等键：同一学生同一文本+视频组合只允许生成一次。"""
    joined = "\x1f".join(["composite", student_id, text_report_id, video_report_id])
    return hashlib.sha256(joined.encode("utf-8")).hexdigest()


def maybe_enqueue_composite(student_id: str) -> int | None:
    """双报告均完成后创建综合报告任务；未齐、已存在或并发冲突时静默跳过。

    返回综合报告 seq_id（已存在时返回原任务），调用方无需关心结果。
    """
    if not student_id:
        return None
    student = db.session.get(Student, student_id)
    if student is None:
        return None

    text_row = db.session.execute(
        select(Scl90TextReport)
        .where(
            Scl90TextReport.student_id == student_id,
            Scl90TextReport.status == "completed",
        )
        .order_by(Scl90TextReport.submit_timestamp.desc())
        .limit(1)
    ).scalar_one_or_none()
    video_row = db.session.execute(
        select(VideoFaceReport)
        .where(
            VideoFaceReport.student_id == student_id,
            VideoFaceReport.status == "completed",
        )
        .order_by(VideoFaceReport.create_timestamp.desc())
        .limit(1)
    ).scalar_one_or_none()
    # 任意一份未完成都不触发，等后完成的那份再触发
    if text_row is None or video_row is None:
        return None

    request_key = make_composite_key(
        student_id, text_row.report_id, video_row.video_report_id,
    )
    existing = db.session.execute(
        select(AiAnalysisReport.seq_id)
        .where(AiAnalysisReport.request_key == request_key)
    ).scalar_one_or_none()
    if existing:
        return existing

    # 归属教师：取该班首个班主任，供教师端按任教关系直查
    teacher_id = db.session.execute(
        select(TeacherClass.teacher_id)
        .where(TeacherClass.class_id == (student.class_ or ""))
        .order_by(TeacherClass.create_timestamp.asc())
        .limit(1)
    ).scalar_one_or_none()

    row = AiAnalysisReport(
        student_name=student.name or "匿名用户",
        student_class=student.class_ or "",
        student_no=student.student_no,
        phone=student.phone,
        student_id=student.student_id,
        teacher_id=teacher_id,
        text_report_id=text_row.report_id,
        video_report_id=video_row.video_report_id,
        ai_content=None,
        create_timestamp=now_ms(),
        status="processing",
        request_key=request_key,
        teacher_read=0,
    )
    db.session.add(row)
    try:
        db.session.commit()
    except IntegrityError:
        # 并发触发时唯一索引兜底：另一线程已建同组合任务，直接复用
        db.session.rollback()
        logger.info("[analysis] 综合报告已存在，跳过重复创建 student=%s", student_id)
        return None

    seq_id = row.seq_id
    _executor.submit(_run_composite, seq_id)
    logger.info("[analysis] 已创建 AI 综合报告任务 #%s student=%s", seq_id, student_id)
    return seq_id


def retry_composite(seq_id: int) -> bool:
    """失败重跑：重置状态后重新入队，复用同一条归档行，不产生脏数据。"""
    row = db.session.get(AiAnalysisReport, seq_id)
    if row is None:
        return False
    if row.status == "processing":
        return True
    row.status = "processing"
    row.error_message = None
    row.finished_at = None
    db.session.commit()
    _executor.submit(_run_composite, seq_id)
    logger.info("[analysis] AI 综合报告重新入队 #%s", seq_id)
    return True


def _run_composite(seq_id: int) -> None:
    with _app.app_context():
        try:
            row = db.session.get(AiAnalysisReport, seq_id)
            if row is None:
                return
            content = _generate_composite(row)
            row.ai_content = content
            row.status = "completed"
            row.error_message = None
            row.teacher_read = 0  # 新报告重新点亮教师端红点
            row.finished_at = now_ms()
            db.session.commit()
            logger.info("[analysis] AI 综合报告生成完成 #%s", seq_id)
        except CompositeAnalysisError as exc:
            logger.warning("[analysis] AI 综合报告生成失败 #%s：%s", seq_id, exc)
            _mark_failed(seq_id, str(exc))
        except Exception as exc:
            logger.exception("[analysis] AI 综合报告生成异常 #%s：%s", seq_id, exc)
            _mark_failed(seq_id, "AI 综合报告生成异常，请稍后重试")


def _mark_failed(seq_id: int, message: str) -> None:
    """失败兜底：保留 request_key，避免自动触发逻辑重复创建同组合任务。"""
    db.session.rollback()
    try:
        row = db.session.get(AiAnalysisReport, seq_id)
        if row is None:
            return
        row.status = "failed"
        row.error_message = message[:500]
        row.finished_at = now_ms()
        db.session.commit()
    except Exception as exc:
        db.session.rollback()
        logger.warning("[analysis] 标记失败状态未写入 #%s：%s", seq_id, exc)


def _generate_composite(row: AiAnalysisReport) -> str:
    """基于两份报告全量数据生成双模态综合结论（一份正文含学生版/教师版）。"""
    if not Config.AI_ENABLED:
        raise CompositeAnalysisError(f"{Config.AI_DISABLED_MESSAGE}，AI 综合报告暂不可用")

    text_row = db.session.execute(
        select(Scl90TextReport)
        .where(Scl90TextReport.report_id == row.text_report_id)
    ).scalar_one_or_none()
    video_row = db.session.execute(
        select(VideoFaceReport)
        .where(VideoFaceReport.video_report_id == row.video_report_id)
    ).scalar_one_or_none()
    if text_row is None or video_row is None:
        raise CompositeAnalysisError("关联的文本或视频报告不存在，无法生成综合报告")

    scl90_json = json.dumps(
        scores_from_report_row(text_row), ensure_ascii=False, indent=2,
    )
    face_json = json.dumps(_video_metrics(video_row), ensure_ascii=False, indent=2)
    prompt = COMPOSITE_PROMPT.format(
        student_name=row.student_name,
        scl90_json=scl90_json,
        face_json=face_json,
    )
    try:
        return chat(
            [{"role": "system", "content": "你是一位温暖专业的心理健康顾问。"},
             {"role": "user", "content": prompt}],
            temperature=_COMPOSITE_TEMPERATURE,
            max_tokens=_COMPOSITE_MAX_TOKENS,
        )
    except LLMError as exc:
        raise CompositeAnalysisError(f"AI 综合报告生成失败：{exc}") from exc


def _video_metrics(video_row: VideoFaceReport) -> dict:
    """合并 AU 与情绪两段 JSON，保持与教师端 AI 分析一致的输入口径。"""
    metrics: dict = {}
    for raw in (video_row.au_json, video_row.emotion_json):
        if not raw:
            continue
        try:
            metrics.update(json.loads(raw))
        except (ValueError, TypeError):
            continue
    return metrics
