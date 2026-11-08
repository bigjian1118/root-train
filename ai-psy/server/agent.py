# -*- coding: utf-8 -*-
"""手写简易工具调用 Agent 循环（不依赖 LangGraph 等框架）。

输出事件协议（供 SSE 与前端消费）：
  meta        {"scenario", "scenario_name"}
  tool_call   {"name", "arguments"}
  tool_result {"name", "result"}   result 为 JSON 字符串，超长截断到 2000 字符
  delta       {"content"}
  done        {"citations": [{"title", "source_id"}]}
  error       {"message"}
"""
import json

from .config import Config
from .llm import chat_non_stream, chat_stream
from .prompt import AGENT_SYSTEM_SUFFIX, SCENARIOS
from .tools import execute_tool, to_openai_tools

_TOOL_RESULT_MAX_CHARS = 2000
_SIMULATED_DELTA_CHARS = 40
_HISTORY_ROLES = ("user", "assistant")


def _build_messages(scenario: str, history: list[dict], user_text: str) -> list[dict]:
    """system prompt + 历史 user/assistant 消息 + 本轮用户输入。"""
    max_rounds = Config.AGENT_MAX_TOOL_ROUNDS
    system = SCENARIOS[scenario]["system_prompt"] + AGENT_SYSTEM_SUFFIX.format(
        max_rounds=max_rounds
    )
    messages = [{"role": "system", "content": system}]
    for item in history or []:
        if not isinstance(item, dict) or item.get("role") not in _HISTORY_ROLES:
            continue
        content = item.get("content")
        if not content:
            continue
        messages.append({"role": item["role"], "content": str(content)})
    messages.append({"role": "user", "content": user_text})
    return messages


def _parse_tool_arguments(raw) -> dict:
    """工具参数可能是 JSON 字符串或已解析 dict，非法时退回空参数。"""
    if isinstance(raw, dict):
        return raw
    if not raw:
        return {}
    try:
        value = json.loads(raw)
    except (TypeError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def _tool_result_text(result: dict) -> str:
    text = json.dumps(result, ensure_ascii=False, default=str)
    return text[:_TOOL_RESULT_MAX_CHARS]


def _collect_citations(result: dict, bucket: list[dict], seen: set) -> None:
    """汇总 rag_search 命中的来源，去重后按首次出现顺序保留。"""
    if not isinstance(result, dict):
        return
    for item in result.get("results") or []:
        if not isinstance(item, dict):
            continue
        title = item.get("title") or ""
        source_id = item.get("source_id") or ""
        if not title and not source_id:
            continue
        key = (title, source_id)
        if key in seen:
            continue
        seen.add(key)
        bucket.append({"title": title, "source_id": source_id})


def run_agent(scenario: str, history: list[dict], user_text: str,
              user: dict | None):
    """执行一轮 Agent 对话，逐条 yield (event, payload)。"""
    try:
        scenario_config = SCENARIOS.get(scenario)
        if not scenario_config:
            yield "error", {"message": f"未知场景：{scenario}"}
            return

        messages = _build_messages(scenario, history, user_text)
        tools = to_openai_tools()
        citations: list[dict] = []
        seen = set()
        final_content = ""

        yield "meta", {
            "scenario": scenario,
            "scenario_name": scenario_config["name"],
        }

        # 工具决策轮：有 tool_calls 就执行并回填，直到模型给出最终回答或达到上限
        for _ in range(Config.AGENT_MAX_TOOL_ROUNDS):
            message = chat_non_stream(messages, tools=tools)
            tool_calls = message.get("tool_calls") or []
            if not tool_calls:
                final_content = (message.get("content") or "").strip()
                break

            messages.append({
                "role": "assistant",
                "content": message.get("content") or "",
                "tool_calls": tool_calls,
            })
            for call in tool_calls:
                function = call.get("function") or {}
                name = function.get("name") or ""
                arguments = _parse_tool_arguments(function.get("arguments"))
                yield "tool_call", {"name": name, "arguments": arguments}

                result = execute_tool(name, arguments, user)
                if name == "rag_search":
                    _collect_citations(result, citations, seen)
                result_text = _tool_result_text(result)
                yield "tool_result", {"name": name, "result": result_text}

                messages.append({
                    "role": "tool",
                    "tool_call_id": call.get("id") or name,
                    "content": result_text,
                })

        if final_content:
            # 决策轮已产出完整回答：按 40 字一段模拟流式，保证前端体验一致
            for start in range(0, len(final_content), _SIMULATED_DELTA_CHARS):
                yield "delta", {
                    "content": final_content[start:start + _SIMULATED_DELTA_CHARS]
                }
        else:
            for piece in chat_stream(messages):
                if piece:
                    yield "delta", {"content": piece}

        yield "done", {"citations": citations}
    except Exception as exc:  # Agent 异常不能打断 SSE / 旧接口响应
        yield "error", {"message": str(exc)}
