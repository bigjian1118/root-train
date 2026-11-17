# -*- coding: utf-8 -*-
"""服务端配置：全部通过环境变量注入，直接读取 ai-psy/.env 或系统环境。

说明：模型权重常驻宿主机磁盘，服务通过 vLLM 端口访问，进程本身不加载大权重。
"""
import os
import secrets

# 视为「已公开」的历史默认值：便携版整包分发，任何硬编码密钥都可被用来伪造 session
_INSECURE_SECRET_KEYS = {
    "",
    "xinqing-dev-secret-key-change-in-prod",
    "xinqing-portable-secret-change-me",
    "change-me",
}


def _load_secret_key() -> str:
    """SECRET_KEY 取值：环境变量（非弱值） > 本地密钥文件 > 生成随机密钥并落盘。

    落盘位置默认 <项目根>/data/.secret_key，保证同一部署重启后登录态不失效；
    首次升级到本策略时旧 session 会失效，用户重新登录一次即可。
    """
    env_key = os.environ.get("SECRET_KEY", "").strip()
    if env_key and env_key not in _INSECURE_SECRET_KEYS:
        return env_key

    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    key_path = os.environ.get("SECRET_KEY_FILE") or os.path.join(root, "data", ".secret_key")
    try:
        with open(key_path, encoding="utf-8") as fh:
            saved = fh.read().strip()
        if len(saved) >= 32:
            return saved
    except OSError:
        pass

    key = secrets.token_hex(32)
    try:
        os.makedirs(os.path.dirname(key_path), exist_ok=True)
        with open(key_path, "w", encoding="utf-8") as fh:
            fh.write(key)
        os.chmod(key_path, 0o600)
    except OSError:
        # 只读介质无法落盘时退化为进程内随机密钥：重启需重新登录，但安全强度不降低
        pass
    return key


class Config:
    """Flask 配置基类。"""

    # ---------- 基础 ----------
    SECRET_KEY = _load_secret_key()
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

    # ---------- 无卡模式（无卡开机：GPU 模型服务不可用） ----------
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

    # ---------- 生成扩展参数（DeepSeek 官方示例 extra_body 字段，默认空不注入） ----------
    # LLM_THINKING=enabled 开启思考模式；LLM_REASONING_EFFORT=high 指定推理强度。
    # 仅对支持的远程模型生效，vLLM 本地通道保持原有 payload。
    LLM_THINKING = os.environ.get("LLM_THINKING", "")
    LLM_REASONING_EFFORT = os.environ.get("LLM_REASONING_EFFORT", "")

    # ---------- 嵌入模型 BGE-M3（独立模型，不与 LLM 混用） ----------
    # 优先独立嵌入服务（vLLM embedding / TEI / FastAPI 均可，OpenAI 兼容 /v1/embeddings）
    EMBEDDING_BASE_URL = os.environ.get("EMBEDDING_BASE_URL", "http://127.0.0.1:8001/v1")
    EMBEDDING_API_KEY = os.environ.get("EMBEDDING_API_KEY", "EMPTY")
    EMBEDDING_MODEL = os.environ.get("EMBEDDING_MODEL", "BGE-M3")
    EMBEDDING_TIMEOUT = int(os.environ.get("EMBEDDING_TIMEOUT", "60"))

    # ---------- py-feat 视频分析网关 ----------
    PYFEAT_GATEWAY_URL = os.environ.get("PYFEAT_GATEWAY_URL", "http://127.0.0.1:8002")
    # 网关为纯内网服务：绑定回环 + 共享密钥双重校验，默认值需与 pyfeat_gateway.py 保持一致
    PYFEAT_GATEWAY_TOKEN = os.environ.get(
        "PYFEAT_TOKEN", "xinqing-pyfeat-internal"
    )
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
