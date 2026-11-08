# -*- coding: utf-8 -*-
"""SSE 输出封装：统一事件格式，便于前端按 event 区分工具调用与正文增量。"""
import json

from flask import Response


def sse_event(event: str, data) -> str:
    """构造单条 SSE 消息（data 自动 JSON 序列化，保证多行文本安全）。"""
    payload = data if isinstance(data, str) else json.dumps(data, ensure_ascii=False)
    return f"event: {event}\ndata: {payload}\n\n"


def sse_response(generator) -> Response:
    """包装为 text/event-stream 响应，关闭 Nginx 缓冲以便逐字下发。"""
    return Response(
        generator,
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )
