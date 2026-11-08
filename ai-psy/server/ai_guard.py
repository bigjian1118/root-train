# -*- coding: utf-8 -*-
"""无卡模式下 AI 功能的统一守卫：AI_ENABLED=0 时生成类接口返回 503。

只拦截「需要调用大模型/嵌入服务」的生成入口；历史 AI 内容的读取接口不受限。
"""
from flask import jsonify

from .config import Config


def ai_unavailable():
    """AI 不可用返回 (response, status)；可用返回 None。

    用法：err = ai_unavailable(); if err: return err
    """
    if Config.AI_ENABLED:
        return None
    return jsonify({"error": Config.AI_DISABLED_MESSAGE, "ai_disabled": True}), 503
