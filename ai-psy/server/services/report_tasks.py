# -*- coding: utf-8 -*-
"""报告异步生成任务：与前端页面/会话完全解耦。

用户关闭页面、切换功能、退出登录都不影响任务；任务在独立线程 + 独立 app_context/session 中
执行，互不干扰。便携版是单进程 Flask，进程内线程池即可；若改为多 worker 部署，需要替换为
持久化队列（任务只存在于当前进程内）。
"""
import hashlib
import json
import logging
import os
from concurrent.futures import ThreadPoolExecutor

from flask import Flask
from sqlalchemy import select

from ..config import Config
from ..extensions import db
from ..llm import LLMError, chat
from ..models import AiAnalysisReport, Scl90TextReport, Student, VideoFaceReport, now_ms
from ..prompt import FACE_REPORT_PROMPT, REPORT_PROMPT, SCENARIOS
from ..scoring import factor_averages
from .face_service import FaceAnalysisError, analyze_video

logger = logging.getLogger("xinqing.report")

_TOTAL_ITEMS = 90
# 报告生成参数（沿用旧同步逻辑取值，保证生成结果完全一致）
_TEXT_TEMPERATURE = 0.5
_TEXT_MAX_TOKENS = 1536
_FACE_TEMPERATURE = 0.5
_FACE_MAX_TOKENS = 1024
# 状态接口的粗略剩余时长（秒），仅用于前端文案，不影响任务本身
ETA_SECONDS = {"text": 30, "video": 180}

_MAX_WORKERS = int(os.environ.get("REPORT_TASK_WORKERS", "3"))

_executor = ThreadPoolExecutor(max_workers=_MAX_WORKERS, thread_name_prefix="report-task")
_app: Flask | None = None


def init_report_worker(app: Flask) -> None:
    """应用启动时注入 Flask app；任务线程靠它创建 app_context。"""
    global _app
    _app = app


def make_request_key(*parts: str) -> str:
    """幂等键：同学生 + 同场景 + 同答案（或同视频字节）只允许生成一次。"""
    joined = "\x1f".join(str(part) for part in parts)
    return hashlib.sha256(joined.encode("utf-8")).hexdigest()


def enqueue_text_report(report_id: str, user: dict, scenario: str,
                        result: dict, crisis: dict, answers: dict | None) -> None:
    """文本测评报告入队（调用方已完成计分与落库，这里只做 AI 解读与回填）。"""
    _executor.submit(_run_text_report, report_id, dict(user), scenario,
                     result, crisis, answers)


def enqueue_video_report(report_id: str, user: dict, video_path: str) -> None:
    """视频测评报告入队（视频已落盘，任务结束时会删除暂存文件）。"""
    _executor.submit(_run_video_report, report_id, dict(user), video_path)


def _run_text_report(report_id: str, user: dict, scenario: str,
                     result: dict, crisis: dict, answers: dict | None) -> None:
    with _app.app_context():
        try:
            row = _get_by_report_id(Scl90TextReport, Scl90TextReport.report_id, report_id)
            if row is None:
                return
            report = _generate_text_report(scenario, result)
            _fill_text_row(row, result, crisis, answers)
            _archive_ai_content(user, report, text_report_id=report_id)
            _touch_latest_report(user, "latest_text_report_id", report_id)
            row.status = "completed"
            row.error_message = None
            row.finished_at = now_ms()
            db.session.commit()
            logger.info("[report] 文本报告生成完成 %s", report_id)
            # 文本报告完成后再检查一次：若视频报告也已就绪，自动触发 AI 综合报告
            _trigger_composite(row.student_id)
        except Exception as exc:
            logger.exception("[report] 文本报告生成失败 %s：%s", report_id, exc)
            _mark_failed(Scl90TextReport, Scl90TextReport.report_id, report_id,
                         f"报告生成失败：{exc}")


def _run_video_report(report_id: str, user: dict, video_path: str) -> None:
    with _app.app_context():
        try:
            metrics = analyze_video(video_path)
            report = _generate_face_report(metrics)
            row = _get_by_report_id(VideoFaceReport, VideoFaceReport.video_report_id, report_id)
            if row is None:
                return
            _fill_video_row(row, metrics)
            _archive_ai_content(user, report, video_report_id=report_id)
            _touch_latest_report(user, "latest_video_report_id", report_id)
            row.status = "completed"
            row.error_message = None
            row.finished_at = now_ms()
            db.session.commit()
            logger.info("[report] 视频报告生成完成 %s", report_id)
            # 视频报告完成后再检查一次：若文本报告也已就绪，自动触发 AI 综合报告
            _trigger_composite(row.student_id)
        except FaceAnalysisError as exc:
            logger.warning("[report] 视频分析失败 %s：%s", report_id, exc)
            _mark_failed(VideoFaceReport, VideoFaceReport.video_report_id, report_id,
                         f"视频分析失败：{exc}")
        except Exception as exc:
            logger.exception("[report] 视频报告生成异常 %s：%s", report_id, exc)
            _mark_failed(VideoFaceReport, VideoFaceReport.video_report_id, report_id,
                         "视频分析服务异常，请重新生成")
        finally:
            # 隐私约定：无论成功/失败，任务结束立即删除暂存视频
            try:
                os.remove(video_path)
            except OSError:
                pass


def _get_by_report_id(model, id_column, report_id: str):
    return db.session.execute(
        select(model).where(id_column == report_id)
    ).scalar_one_or_none()


def _trigger_composite(student_id: str | None) -> None:
    """双报告联动：任一报告完成后尝试创建 AI 综合报告任务。

    综合报告失败绝不能影响文本/视频报告本身的完成状态，因此这里吞掉全部异常。
    """
    if not student_id:
        return
    try:
        from .analysis_tasks import maybe_enqueue_composite

        maybe_enqueue_composite(student_id)
    except Exception as exc:
        logger.warning("[report] 触发 AI 综合报告失败 student=%s：%s", student_id, exc)


def _mark_failed(model, id_column, report_id: str, message: str) -> None:
    """失败兜底：清空幂等键以便用户重新提交，不留下半成品数据。"""
    db.session.rollback()
    try:
        row = _get_by_report_id(model, id_column, report_id)
        if row is None:
            return
        row.status = "failed"
        row.error_message = message[:500]
        row.request_key = None
        row.finished_at = now_ms()
        db.session.commit()
    except Exception as exc:
        db.session.rollback()
        logger.warning("[report] 标记失败状态未写入 %s：%s", report_id, exc)


def _fill_text_row(row: Scl90TextReport, result: dict, crisis: dict,
                   answers: dict | None) -> None:
    """报告完整内容一次性写入（与旧同步归档字段完全一致）。"""
    factor_cols = factor_averages(result)
    positive_count = result.get("阳性项目数") or 0
    max_avg = max(
        (value for value in factor_cols.values() if value is not None), default=None
    )
    row.total_score = result.get("总分")
    row.pos_item_count = positive_count
    row.neg_item_count = _TOTAL_ITEMS - positive_count
    row.risk_signal = 1 if crisis else 0
    row.max_factor_score = max_avg
    row.gsi = result.get("总均分")
    row.psdi = result.get("阳性症状均分")
    row.item_answers = json.dumps(answers) if answers else None
    for column, value in factor_cols.items():
        setattr(row, column, value)


def _fill_video_row(row: VideoFaceReport, metrics: dict) -> None:
    row.au_json = json.dumps({
        "au": metrics.get("au") or {},
        "total_frames": metrics.get("total_frames"),
        "face_frames": metrics.get("face_frames"),
        "face_activity": metrics.get("face_activity"),
    }, ensure_ascii=False)
    row.emotion_json = json.dumps({
        "emotions": metrics.get("emotions") or {},
        "dominant_emotion": metrics.get("dominant_emotion", ""),
        "dominant_emotion_source": metrics.get("dominant_emotion_source", ""),
        "smile_detected": metrics.get("smile_detected", False),
    }, ensure_ascii=False)
    row.prominent_dimension = metrics.get("dominant_emotion", "")


def _archive_ai_content(user: dict, ai_content: str,
                        text_report_id: str | None = None,
                        video_report_id: str | None = None) -> None:
    """AI 正文归档到 ai_analysis_report（补齐学生学号/手机号冗余）。"""
    if not user or not ai_content:
        return
    profile = _student_profile(user)
    db.session.add(AiAnalysisReport(
        student_name=profile["student_name"],
        student_class=profile["student_class"],
        student_no=profile["student_no"],
        phone=profile["phone"],
        text_report_id=text_report_id,
        video_report_id=video_report_id,
        ai_content=ai_content,
        create_timestamp=now_ms(),
    ))


def _student_profile(user: dict) -> dict:
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


def _touch_latest_report(user: dict, field: str, report_id: str) -> None:
    if user.get("role") != "student":
        return
    student = db.session.get(Student, user.get("id", ""))
    if student:
        setattr(student, field, report_id)


def _generate_text_report(scenario: str, result: dict) -> str:
    """AI 解读失败不阻塞报告完成，返回降级文案（与旧同步逻辑一致）。"""
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
            temperature=_TEXT_TEMPERATURE, max_tokens=_TEXT_MAX_TOKENS,
        )
    except LLMError as exc:
        return f"（AI 报告生成失败：{exc}）"


def _generate_face_report(metrics: dict) -> str:
    if not Config.AI_ENABLED:
        # 无卡模式：py-feat 网关 CPU 照常出指标，仅 AI 文本报告降级
        return f"（{Config.AI_DISABLED_MESSAGE}，客观指标不受影响）"
    prompt = FACE_REPORT_PROMPT.format(
        metrics_json=json.dumps(metrics, ensure_ascii=False, indent=2)
    )
    try:
        return chat(
            [{"role": "user", "content": prompt}],
            temperature=_FACE_TEMPERATURE, max_tokens=_FACE_MAX_TOKENS,
        )
    except LLMError as exc:
        logger.warning("[report] 视频 AI 报告生成失败（指标不受影响）：%s", exc)
        return f"（AI 报告生成失败：{exc}）"
