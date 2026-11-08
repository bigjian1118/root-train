# -*- coding: utf-8 -*-
"""AI 聊天接口：SSE 流式（GET/POST）与旧版一次性回复。

EventSource 只支持 GET，因此 GET /api/chat/stream 承载流式对话；
POST /api/chat/stream 供 fetch 流式客户端；POST /api/chat 保留旧契约。
"""
import json

from flask import Blueprint, jsonify, request, stream_with_context

from ..agent import run_agent
from ..ai_guard import ai_unavailable
from ..prompt import SCENARIOS
from ..security import get_session_user, reject_teacher
from ..sse import sse_event, sse_response

bp = Blueprint("chat", __name__)

_DEFAULT_SCENARIO = "college_student"
_HISTORY_ROLES = ("user", "assistant")


def _error(message: str, status: int = 400):
    return jsonify({"error": message}), status


def _resolve_scenario(raw) -> tuple[str, tuple | None]:
    """校验场景键；返回 (scenario, error_response)。"""
    scenario = str(raw or _DEFAULT_SCENARIO).strip()
    if scenario not in SCENARIOS:
        return scenario, _error(f"未知场景：{scenario}")
    return scenario, None


def _valid_history(items) -> list[dict]:
    """只保留合法的 user/assistant 文本消息。"""
    if not isinstance(items, list):
        return []
    history = []
    for item in items:
        if not isinstance(item, dict):
            continue
        role = item.get("role")
        content = item.get("content")
        if role in _HISTORY_ROLES and isinstance(content, str) and content.strip():
            history.append({"role": role, "content": content})
    return history


def _parse_history_param(raw) -> list[dict]:
    """GET 查询参数 history（JSON 字符串）解析失败时静默忽略。"""
    if not raw:
        return []
    try:
        data = json.loads(raw)
    except (TypeError, ValueError):
        return []
    return _valid_history(data)


def _split_messages(messages) -> tuple[list[dict], str]:
    """messages -> (最后一条用户消息之前的历史, 本轮用户输入)。"""
    usable = _valid_history(messages)
    last_user_index = -1
    for index in range(len(usable) - 1, -1, -1):
        if usable[index]["role"] == "user":
            last_user_index = index
            break
    if last_user_index < 0:
        return [], ""
    return usable[:last_user_index], usable[last_user_index]["content"]


def _sse_stream(scenario: str, history: list[dict], user_text: str,
                user: dict | None):
    """把 Agent 事件流转换成 SSE；生成器内不访问 flask request 上下文。

    用 stream_with_context 保留应用上下文，保证生成阶段的 RAG / 工具 DB 查询可用；
    需要的请求参数已在调用本函数前取好。
    """
    def generate():
        for event, payload in run_agent(scenario, history, user_text, user):
            yield sse_event(event, payload)

    return sse_response(stream_with_context(generate()))


def _session_user_snapshot() -> dict | None:
    user = get_session_user()
    return dict(user) if user else None


@bp.get("/api/chat/stream")
def chat_stream_get():
    """EventSource 流式对话：scenario / content / history（可选 JSON）。"""
    err = ai_unavailable()
    if err:
        return err
    err = reject_teacher()
    if err:
        return err
    scenario, scenario_err = _resolve_scenario(request.args.get("scenario"))
    if scenario_err:
        return scenario_err
    user_text = (request.args.get("content") or "").strip()
    if not user_text:
        return _error("缺少用户消息")
    history = _parse_history_param(request.args.get("history"))
    return _sse_stream(scenario, history, user_text, _session_user_snapshot())


@bp.post("/api/chat/stream")
def chat_stream_post():
    """fetch 流式客户端：JSON {scenario, content 或 messages:[...]}。"""
    err = ai_unavailable()
    if err:
        return err
    err = reject_teacher()
    if err:
        return err
    data = request.get_json(silent=True) or {}
    scenario, scenario_err = _resolve_scenario(data.get("scenario"))
    if scenario_err:
        return scenario_err

    content = data.get("content")
    if isinstance(content, str) and content.strip():
        history = _valid_history(data.get("history"))
        user_text = content.strip()
    else:
        history, user_text = _split_messages(data.get("messages") or [])
        user_text = user_text.strip()
    if not user_text:
        return _error("缺少用户消息")
    return _sse_stream(scenario, history, user_text, _session_user_snapshot())


@bp.post("/api/chat")
def chat_compat():
    """旧版一次性接口：{scenario, messages:[{role,content}]} -> {reply}。"""
    err = ai_unavailable()
    if err:
        return err
    err = reject_teacher()
    if err:
        return err
    data = request.get_json(silent=True) or {}
    scenario, scenario_err = _resolve_scenario(data.get("scenario"))
    if scenario_err:
        return scenario_err

    history, user_text = _split_messages(data.get("messages") or [])
    user_text = user_text.strip()
    if not user_text:
        return _error("缺少用户消息")

    reply_parts = []
    for event, payload in run_agent(
        scenario, history, user_text, _session_user_snapshot()
    ):
        if event == "delta":
            reply_parts.append(str(payload.get("content") or ""))
        elif event == "error":
            return _error(payload.get("message") or "AI 服务异常", 502)
    return jsonify({"reply": "".join(reply_parts)})
