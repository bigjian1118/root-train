# -*- coding: utf-8 -*-
"""OpenAI 兼容大模型客户端：vLLM 为主，远程 API 为备选，mock 兜底。

区别：这里只负责「文本生成」，嵌入由 embedding.py 独立调用 BGE-M3，两者不混用。
"""
import json
import re

import requests

from .config import Config

# 匹配任意孤立的 think 标签（含竖线变体）
_THINK_TAG_RE = re.compile(r"<\|?/?think\|?>")


class LLMError(Exception):
    """大模型调用失败异常。"""


def strip_think(text: str) -> str:
    """裁剪模型输出中的 think 思考块，只保留正文。"""
    text = re.sub(r"<\|?think\|?>.*?<\|?/\s*think\|?>\s*", "", text, flags=re.DOTALL)
    match = re.search(r"<\|?think\|?>", text)
    if match:
        text = text[: match.start()]
    closes = list(re.finditer(r"<\|?/\s*think\|?>", text))
    if closes:
        after = text[closes[-1].end():].strip()
        before = text[: closes[0].start()].strip()
        text = after if after else before
    return _THINK_TAG_RE.sub("", text).strip()


def _provider() -> dict:
    """按 LLM_PROVIDER 选择连接参数（vllm / remote / mock）。"""
    if Config.LLM_PROVIDER == "remote":
        return {
            "base_url": Config.REMOTE_BASE_URL,
            "api_key": Config.REMOTE_API_KEY,
            "model": Config.REMOTE_MODEL,
        }
    return {
        "base_url": Config.VLLM_BASE_URL,
        "api_key": Config.VLLM_API_KEY,
        # vLLM 以 --lora-modules 注册适配器名，优先使用领域微调模型名
        "model": Config.LLM_LORA_NAME or Config.LLM_MODEL,
    }


def _headers() -> dict:
    return {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {_provider()['api_key']}",
    }


def _endpoint() -> str:
    return _provider()["base_url"].rstrip("/") + "/chat/completions"


def _mock_reply(messages: list) -> str:
    last_user = next((m["content"] for m in reversed(messages) if m.get("role") == "user"), "")
    return f"【Mock 模式】已收到：{last_user[:80]}。当前未连接大模型服务。"


def chat_non_stream(messages: list, tools: list | None = None,
                    temperature: float | None = None,
                    max_tokens: int | None = None,
                    model: str | None = None) -> dict:
    """非流式调用，返回 message dict（可能包含 tool_calls）。供 Agent 决策轮使用。"""
    if Config.LLM_PROVIDER == "mock":
        return {"role": "assistant", "content": _mock_reply(messages)}

    payload = {
        "model": model or _provider()["model"],
        "messages": messages,
        "temperature": Config.LLM_TEMPERATURE if temperature is None else temperature,
        "max_tokens": max_tokens or Config.LLM_MAX_TOKENS,
    }
    if tools:
        payload["tools"] = tools
        payload["tool_choice"] = "auto"

    try:
        resp = requests.post(_endpoint(), headers=_headers(), json=payload,
                             timeout=Config.LLM_TIMEOUT)
        resp.raise_for_status()
        message = resp.json()["choices"][0]["message"]
    except Exception as exc:
        raise LLMError(f"调用大模型服务失败：{exc}") from exc
    message["content"] = strip_think(message.get("content") or "")
    return message


def chat(messages: list, temperature: float | None = None,
         max_tokens: int | None = None, model: str | None = None) -> str:
    """普通一次性生成（报告解读、干预建议等）。"""
    return chat_non_stream(messages, temperature=temperature,
                           max_tokens=max_tokens, model=model).get("content", "")


def chat_stream(messages: list, temperature: float | None = None,
                max_tokens: int | None = None, model: str | None = None):
    """流式生成：逐段 yield 文本增量（SSE 打字机效果）。"""
    if Config.LLM_PROVIDER == "mock":
        for char in _mock_reply(messages):
            yield char
        return

    payload = {
        "model": model or _provider()["model"],
        "messages": messages,
        "temperature": Config.LLM_TEMPERATURE if temperature is None else temperature,
        "max_tokens": max_tokens or Config.LLM_MAX_TOKENS,
        "stream": True,
    }
    try:
        with requests.post(_endpoint(), headers=_headers(), json=payload,
                           timeout=Config.LLM_TIMEOUT, stream=True) as resp:
            resp.raise_for_status()
            for raw in resp.iter_lines(decode_unicode=True):
                if not raw or not raw.startswith("data:"):
                    continue
                data = raw[5:].strip()
                if data == "[DONE]":
                    break
                try:
                    delta = json.loads(data)["choices"][0]["delta"].get("content") or ""
                except (ValueError, KeyError, IndexError):
                    continue
                if delta:
                    yield delta
    except Exception as exc:
        raise LLMError(f"流式调用大模型失败：{exc}") from exc
