# -*- coding: utf-8 -*-
"""全局配置接口：三人群场景列表（前端场景切换按钮数据源）。"""
from flask import Blueprint, jsonify

from ..config import Config
from ..prompt import SCENARIOS

bp = Blueprint("config_api", __name__)


@bp.get("/api/config")
def api_config():
    scenarios = [
        {"key": key, "name": scenario["name"], "desc": scenario["desc"]}
        for key, scenario in SCENARIOS.items()
    ]
    # 旧版 mock 开关为本地演示标记；新栈以 LLM_PROVIDER=mock 等价表示
    # ai_enabled：无卡模式（AI_ENABLED=0）时前端据此提示并禁用 AI 入口
    return jsonify({
        "scenarios": scenarios,
        "mock": Config.LLM_PROVIDER == "mock",
        "ai_enabled": Config.AI_ENABLED,
    })
