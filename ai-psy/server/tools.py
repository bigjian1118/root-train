# -*- coding: utf-8 -*-
"""Agent 工具定义与执行：知识库检索、历史报告读取、报告归档、SCL-90 计分。

TOOL_SCHEMAS 遵循 OpenAI function calling 规范，可直接发送给 vLLM；
execute_tool 统一捕获异常，工具失败不打断 Agent 主流程。
"""
import json

from sqlalchemy import or_, select

from .extensions import db
from .models import AiAnalysisReport, Scl90TextReport, Student, VideoFaceReport, now_ms
from .scoring import FACTOR_EN_MAP, apply_rf_severity, compute_scores, parse_item_answers
from .services.rag_service import search as search_knowledge

_DEFAULT_RAG_TOP_K = 3
_MAX_RAG_TOP_K = 10
_REPORT_TYPES = {"text_report", "video_report", "analysis"}
_AI_CONTENT_PREVIEW_CHARS = 800

_TOOL_DEFINITIONS = [
    {
        "name": "rag_search",
        "description": (
            "检索校园心理健康知识库（科普文章、调适方法、危机指引），返回最相关的若干片段。"
            "回答需要知识依据、具体方法或危机处置建议时先调用。"
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "检索关键词或自然语言问题"},
                "top_k": {
                    "type": "integer",
                    "description": "返回片段数量，默认 3",
                    "default": _DEFAULT_RAG_TOP_K,
                },
            },
            "required": ["query"],
        },
    },
    {
        "name": "get_user_report",
        "description": (
            "读取当前登录学生自己的历史测评摘要：最新 SCL-90 文本报告、最新视频面部分析、"
            "最近一条 AI 综合报告片段。无需参数；教师账号不可使用。"
        ),
        "parameters": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "save_report",
        "description": (
            "保存 AI 生成的报告正文到 ai_analysis_report 表。仅在用户明确要求生成并保存报告时调用。"
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "report_type": {
                    "type": "string",
                    "enum": ["text_report", "video_report", "analysis"],
                    "description": "报告类型：文本测评解读 / 视频解读 / 综合分析",
                },
                "content": {"type": "string", "description": "报告正文"},
                "text_report_id": {"type": "string", "description": "关联的 SCL-90 报告 ID，可选"},
                "video_report_id": {"type": "string", "description": "关联的视频报告 ID，可选"},
            },
            "required": ["report_type", "content"],
        },
    },
    {
        "name": "calculate_score",
        "description": (
            "按 SCL-90 规则计算总分、阳性项目数、10 个因子均分与严重程度，"
            "并叠加随机森林分级（模型可用时）。"
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "answers": {
                    "type": "object",
                    "description": "题号 -> 1-5 分的对象，例如 {\"1\": 2, \"2\": 3}",
                    "additionalProperties": {"type": "integer", "minimum": 1, "maximum": 5},
                },
            },
            "required": ["answers"],
        },
    },
]

# OpenAI tools 数组：每项为 {"type": "function", "function": {...}}
TOOL_SCHEMAS = [
    {"type": "function", "function": definition}
    for definition in _TOOL_DEFINITIONS
]


def to_openai_tools() -> list[dict]:
    """返回可直接发送给 vLLM 的 tools 列表（浅拷贝，避免调用方改动常量）。"""
    return [
        {"type": item["type"], "function": dict(item["function"])}
        for item in TOOL_SCHEMAS
    ]


def _optional_text(value) -> str | None:
    text = str(value).strip() if value is not None else ""
    return text or None


def _student_profile(user: dict) -> dict:
    """归档/查询用的学生四件套；非学生账号退回会话信息。"""
    profile = {
        "student_name": user.get("name") or "匿名用户",
        "student_class": user.get("class") or "",
        "student_no": None,
        "phone": None,
    }
    if user.get("role") == "student":
        student = db.session.get(Student, user.get("id", ""))
        if student:
            profile["student_name"] = student.name or profile["student_name"]
            profile["student_class"] = student.class_ or profile["student_class"]
            profile["student_no"] = student.student_no
            profile["phone"] = student.phone
    return profile


def _text_report_summary(row: Scl90TextReport) -> dict:
    return {
        "report_id": row.report_id,
        "total_score": row.total_score,
        "positive_item_count": row.pos_item_count,
        "risk_signal": row.risk_signal or 0,
        "factor_avgs": {
            cn_name: getattr(row, column)
            for cn_name, column in FACTOR_EN_MAP.items()
        },
        "submit_timestamp": row.submit_timestamp,
    }


def _video_report_summary(row: VideoFaceReport) -> dict:
    dominant = row.prominent_dimension or ""
    emotions = {}
    if row.emotion_json:
        try:
            payload = json.loads(row.emotion_json)
        except (TypeError, ValueError):
            payload = None
        if isinstance(payload, dict):
            dominant = payload.get("dominant_emotion") or dominant
            emotions = payload.get("emotions") or {}
    return {
        "report_id": row.video_report_id,
        "dominant_emotion": dominant,
        "emotions": emotions,
        "create_timestamp": row.create_timestamp,
    }


def _latest_ai_content(student: Student | None, text_report_id: str | None,
                       video_report_id: str | None) -> str:
    """按学号或报告关联 ID 取最近一条 AI 正文片段。"""
    conditions = []
    if student and student.student_no:
        conditions.append(AiAnalysisReport.student_no == student.student_no)
    if text_report_id:
        conditions.append(AiAnalysisReport.text_report_id == text_report_id)
    if video_report_id:
        conditions.append(AiAnalysisReport.video_report_id == video_report_id)
    if not conditions:
        return ""
    value = db.session.scalar(
        select(AiAnalysisReport.ai_content)
        .where(or_(*conditions))
        .order_by(AiAnalysisReport.create_timestamp.desc())
        .limit(1)
    )
    return (value or "")[:_AI_CONTENT_PREVIEW_CHARS]


def _rag_search(arguments: dict, _user: dict | None) -> dict:
    query = str(arguments.get("query") or "").strip()
    if not query:
        return {"error": "缺少检索关键词 query"}
    try:
        top_k = int(arguments.get("top_k") or _DEFAULT_RAG_TOP_K)
    except (TypeError, ValueError):
        top_k = _DEFAULT_RAG_TOP_K
    top_k = max(1, min(top_k, _MAX_RAG_TOP_K))
    try:
        results = search_knowledge(query, top_k=top_k)
    except Exception as exc:
        return {"error": f"知识库检索失败：{exc}"}
    return {"query": query, "results": results}


def _get_user_report(_arguments: dict, user: dict | None) -> dict:
    if not user:
        return {"error": "请先登录"}
    if user.get("role") == "teacher":
        return {"error": "教师账号不可查询学生个人报告"}
    student_id = user.get("id") or ""
    if not student_id:
        return {"error": "缺少登录用户信息"}

    text_row = db.session.scalar(
        select(Scl90TextReport)
        .where(Scl90TextReport.student_id == student_id)
        .order_by(Scl90TextReport.submit_timestamp.desc())
        .limit(1)
    )
    video_row = db.session.scalar(
        select(VideoFaceReport)
        .where(VideoFaceReport.student_id == student_id)
        .order_by(VideoFaceReport.create_timestamp.desc())
        .limit(1)
    )
    student = (
        db.session.get(Student, student_id)
        if user.get("role") == "student" else None
    )
    return {
        "student": {
            "name": user.get("name", ""),
            "class": user.get("class", ""),
            "student_no": student.student_no if student else "",
        },
        "text_report": _text_report_summary(text_row) if text_row else None,
        "video_report": _video_report_summary(video_row) if video_row else None,
        "latest_ai_content": _latest_ai_content(
            student,
            text_row.report_id if text_row else None,
            video_row.video_report_id if video_row else None,
        ),
    }


def _save_report(arguments: dict, user: dict | None) -> dict:
    if not user:
        return {"error": "请先登录"}
    report_type = str(arguments.get("report_type") or "").strip()
    if report_type not in _REPORT_TYPES:
        return {"error": f"report_type 非法：{report_type}"}
    content = str(arguments.get("content") or "").strip()
    if not content:
        return {"error": "缺少报告内容 content"}

    profile = _student_profile(user)
    row = AiAnalysisReport(
        student_name=profile["student_name"],
        student_class=profile["student_class"],
        student_no=profile["student_no"],
        phone=profile["phone"],
        text_report_id=_optional_text(arguments.get("text_report_id")),
        video_report_id=_optional_text(arguments.get("video_report_id")),
        ai_content=content,
        create_timestamp=now_ms(),
    )
    db.session.add(row)
    db.session.commit()
    return {"ok": True, "seq_id": row.seq_id}


def _calculate_score(arguments: dict, _user: dict | None) -> dict:
    answers = parse_item_answers(arguments.get("answers"))
    if answers is None:
        return {"error": "answers 非法：需为 {题号: 1-5 分} 的对象"}
    result = compute_scores(answers)
    apply_rf_severity(result.get("因子分") or {}, answers)
    return result


_TOOL_HANDLERS = {
    "rag_search": _rag_search,
    "get_user_report": _get_user_report,
    "save_report": _save_report,
    "calculate_score": _calculate_score,
}


def execute_tool(name: str, arguments: dict, user: dict | None) -> dict:
    """执行指定工具；任何异常都收敛为 {"error": ...}，不向上抛出。"""
    handler = _TOOL_HANDLERS.get(name)
    if handler is None:
        return {"error": f"未知工具：{name}"}
    if not isinstance(arguments, dict):
        arguments = {}
    try:
        return handler(arguments, user)
    except Exception as exc:
        return {"error": str(exc)}
