# -*- coding: utf-8 -*-
"""
vLLM 大模型客户端：封装 OpenAI 兼容 /v1/chat/completions 调用。

- 正常模式：requests 调用本机 8000 端口 vLLM 服务（qwen_env 启动）
- Mock 模式（config.MOCK_MODE=True，本地开发无 GPU 时）：返回固定占位文本
- 内置 think 标签裁剪兜底（参考 ai+psychology/main.py 的成熟实现）
"""
import re

import requests

import config

# 匹配任意孤立的 think 标签（开/闭标签，含竖线变体与普通尖括号变体）
_THINK_TAG_RE = re.compile(r"<\|?/?think\|?>")


class LLMError(Exception):
    """大模型调用失败异常"""


def strip_think(text: str) -> str:
    """裁剪模型输出中的 think 思考块，只保留正文（兜底处理）"""
    # 1. 优先：成对开/闭标签之间的内容整段删除（跨行，非贪婪）
    text = re.sub(r"<\|?think\|?>.*?<\|?/\s*think\|?>\s*", "", text, flags=re.DOTALL)
    # 2. 兜底：只剩开标签没有闭合（思考被 max_tokens 截断），丢弃开标签后全部内容
    m = re.search(r"<\|?think\|?>", text)
    if m:
        text = text[: m.start()]
    # 3. 兜底：仍残留孤立闭合标签时，取标签两侧的非空正文
    m = list(re.finditer(r"<\|?/\s*think\|?>", text))
    if m:
        after = text[m[-1].end():].strip()
        before = text[: m[0].start()].strip()
        text = after if after else before
    # 4. 清理任何残留的孤立标签
    text = _THINK_TAG_RE.sub("", text)
    return text.strip()


def build_messages(scenario_key: str, history: list, user_text: str) -> list:
    """
    组装完整 messages：场景 system prompt + 多轮历史 + 当前用户输入。

    Args:
        scenario_key: 场景键（primary_student / junior_student / college_student）
        history: 历史对话列表 [{"role": "user|assistant", "content": "..."}]
        user_text: 本轮用户输入
    Returns:
        可直接发给 vLLM 的 messages 列表
    """
    scenario = config.SCENARIOS.get(scenario_key)
    if scenario is None:
        raise LLMError(f"未知场景：{scenario_key}")
    messages = [{"role": "system", "content": scenario["system_prompt"]}]
    # 历史仅保留 user/assistant 角色，防止前端注入非法角色
    for msg in history:
        if msg.get("role") in ("user", "assistant") and str(msg.get("content", "")).strip():
            messages.append({"role": msg["role"], "content": msg["content"]})
    messages.append({"role": "user", "content": user_text})
    return messages


def _request_once(model_name: str, messages: list,
                  temperature: float, max_tokens: int) -> str:
    """向 vLLM 发送一次 chat/completions 请求，返回原始回复文本"""
    resp = requests.post(
        config.VLLM_API_URL,
        json={
            "model": model_name,   # 通用模型路径 或 LoRA 适配器注册名
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
        },
        timeout=config.LLM_TIMEOUT,
    )
    resp.raise_for_status()
    data = resp.json()
    return data["choices"][0]["message"]["content"]


def chat(messages: list, temperature: float = 0.7, max_tokens: int = 1024,
         use_chat_lora: bool = False) -> str:
    """
    调用大模型生成回复（聊天助手可路由到 ai_chat 通用聊天适配器）。

    Args:
        messages: 完整对话消息列表（含 system）
        temperature: 采样温度
        max_tokens: 最大生成 token 数
        use_chat_lora: True 且 config.LORA_ENABLED 开启时，请求体 model 用
                       ai_chat 聊天适配器注册名（config.CHAT_LORA_NAME），
                       使对话针对心理陪伴场景微调风格；报告生成等任务传
                       False 走通用模型（文本测评已不训练场景化 LoRA）
    Returns:
        模型回复文本（已裁剪 think 块）
    Raises:
        LLMError: 非 mock 模式下服务不可达 / 返回异常
    """
    if config.MOCK_MODE:
        # 本地开发占位回复：回显最后一条 user 内容，便于前端联调
        last_user = next(
            (m["content"] for m in reversed(messages) if m["role"] == "user"), ""
        )
        tag = ""
        if config.LORA_ENABLED and use_chat_lora:
            tag = f"（LoRA：{config.CHAT_LORA_NAME}）"
        return (
            f"【Mock 模式占位回复】{tag}已收到你的消息：「{last_user[:60]}」。\n"
            "当前未连接 vLLM 大模型服务，正式部署时请确认 8000 端口服务已启动。"
        )

    # 聊天适配器名（未启用 LoRA 时为 None）
    lora_name = None
    if config.LORA_ENABLED and use_chat_lora:
        lora_name = config.CHAT_LORA_NAME

    try:
        if lora_name:
            try:
                # 优先走 ai_chat 微调后的 LoRA 适配器
                reply = _request_once(lora_name, messages, temperature, max_tokens)
            except Exception:
                # LoRA 服务异常时回退通用模型，保证功能可用
                reply = _request_once(config.MODEL_PATH, messages,
                                      temperature, max_tokens)
        else:
            reply = _request_once(config.MODEL_PATH, messages,
                                  temperature, max_tokens)
    except Exception as e:
        raise LLMError(f"调用大模型服务失败：{e}") from e

    return strip_think(reply)
