# -*- coding: utf-8 -*-
"""服务端配置：全部通过环境变量注入，直接读取 ai-psy/.env 或系统环境。

说明：模型权重常驻宿主机磁盘，服务通过 vLLM 端口访问，进程本身不加载大权重。
"""
import os


class Config:
    """Flask 配置基类。"""

    # ---------- 基础 ----------
    SECRET_KEY = os.environ.get("SECRET_KEY", "xinqing-dev-secret-key-change-in-prod")
    MAX_CONTENT_LENGTH = 50 * 1024 * 1024
    JSON_AS_ASCII = False
    SESSION_COOKIE_SAMESITE = "Lax"

    # ---------- 数据库（PostgreSQL + pgvector） ----------
    # psycopg3 驱动；默认连本机 PostgreSQL，远程库改 DATABASE_URL 即可
    SQLALCHEMY_DATABASE_URI = os.environ.get(
        "DATABASE_URL",
        "postgresql+psycopg://psy:psy@127.0.0.1:5432/psy",
    )
    SQLALCHEMY_TRACK_MODIFICATIONS = False
    SQLALCHEMY_ENGINE_OPTIONS = {"pool_pre_ping": True, "pool_recycle": 1800}
    # pgvector 向量维度，必须与嵌入模型输出一致（BGE-M3=1024）
    EMBEDDING_DIM = int(os.environ.get("EMBEDDING_DIM", "1024"))

    # ---------- vLLM / OpenAI 兼容主模型 ----------
    VLLM_BASE_URL = os.environ.get("VLLM_BASE_URL", "http://127.0.0.1:8000/v1")
    VLLM_API_KEY = os.environ.get("VLLM_API_KEY", "EMPTY")
    LLM_MODEL = os.environ.get("LLM_MODEL", "Qwen2.5-7B-Instruct")
    # 领域微调 LoRA 适配器名（vLLM --lora-modules 注册名），空串表示不启用
    LLM_LORA_NAME = os.environ.get("LLM_LORA_NAME", "psych-chat")
    LLM_TEMPERATURE = float(os.environ.get("LLM_TEMPERATURE", "0.5"))
    LLM_MAX_TOKENS = int(os.environ.get("LLM_MAX_TOKENS", "2048"))
    LLM_TIMEOUT = int(os.environ.get("LLM_TIMEOUT", "120"))

    # ---------- 无卡模式（AutoDL 无卡开机：GPU 模型服务不可用） ----------
    # AI_ENABLED=0 时禁用全部大模型/嵌入生成功能，其余业务功能照常可用；
    # start_all.sh 的无卡探测会自动注入该变量，也可手动覆盖。
    AI_ENABLED = os.environ.get("AI_ENABLED", "1") == "1"
    AI_DISABLED_MESSAGE = os.environ.get(
        "AI_DISABLED_MESSAGE", "当前为无卡模式，AI 功能不可用"
    )

    # ---------- 远程 OpenAI 兼容备选（演示时切流） ----------
    # 设置 LLM_PROVIDER=remote 即整体切到远程 API，vLLM 不可用时也可作为兜底
    LLM_PROVIDER = os.environ.get("LLM_PROVIDER", "vllm")  # vllm | remote | mock
    REMOTE_BASE_URL = os.environ.get("REMOTE_BASE_URL", "https://api.openai.com/v1")
    REMOTE_API_KEY = os.environ.get("REMOTE_API_KEY", "")
    REMOTE_MODEL = os.environ.get("REMOTE_MODEL", "gpt-4o-mini")

    # ---------- 嵌入模型 BGE-M3（独立模型，不与 LLM 混用） ----------
    # 优先独立嵌入服务（vLLM embedding / TEI / FastAPI 均可，OpenAI 兼容 /v1/embeddings）
    EMBEDDING_BASE_URL = os.environ.get("EMBEDDING_BASE_URL", "http://127.0.0.1:8001/v1")
    EMBEDDING_API_KEY = os.environ.get("EMBEDDING_API_KEY", "EMPTY")
    EMBEDDING_MODEL = os.environ.get("EMBEDDING_MODEL", "BGE-M3")
    EMBEDDING_TIMEOUT = int(os.environ.get("EMBEDDING_TIMEOUT", "60"))

    # ---------- py-feat 视频分析网关 ----------
    PYFEAT_GATEWAY_URL = os.environ.get("PYFEAT_GATEWAY_URL", "http://127.0.0.1:8002")
    UPLOAD_DIR = os.environ.get("UPLOAD_DIR", "/data/uploads")
    UPLOAD_EXTENSIONS = (".webm", ".mp4", ".mov")

    # ---------- RAG ----------
    RAG_TOP_K = int(os.environ.get("RAG_TOP_K", "3"))
    RAG_CHUNK_SIZE = int(os.environ.get("RAG_CHUNK_SIZE", "400"))
    RAG_CHUNK_OVERLAP = int(os.environ.get("RAG_CHUNK_OVERLAP", "60"))
    # 启动时自动索引文章（需嵌入服务可用）
    RAG_AUTO_INDEX = os.environ.get("RAG_AUTO_INDEX", "1") == "1"

    # ---------- Agent ----------
    AGENT_MAX_TOOL_ROUNDS = int(os.environ.get("AGENT_MAX_TOOL_ROUNDS", "4"))

    # ---------- 跨域（前端与后端分端口时） ----------
    CORS_ORIGINS = os.environ.get(
        "CORS_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000"
    ).split(",")
