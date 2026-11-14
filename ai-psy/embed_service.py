# -*- coding: utf-8 -*-
"""本地 BGE-M3 向量服务（便携版专用，纯离线 CPU 推理）。

用 FlagEmbedding 的 BGEM3FlagModel 加载 models\\bge-m3 权重，对外提供
OpenAI 兼容的 POST /v1/embeddings 接口（监听 127.0.0.1:8001），供 Flask
后端的 RAG 检索与题库自动索引调用（EMBEDDING_BASE_URL 指向本服务）。
启动.bat 会先拉起本服务、探测 8001 端口就绪后再启动后端，故模型在
监听端口之前一次性加载常驻；首次加载约需 1-5 分钟属正常。

环境变量：
  EMBED_MODEL_PATH  模型目录，缺省为相对本文件的 ..\\models\\bge-m3。
"""
import os

# 必须在导入 FlagEmbedding / transformers 之前设置：模型只从本地目录读取，
# 任何情况下不得回源联网下载（便携版可能在无网电脑上运行）
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"

from flask import Flask, jsonify, request
from FlagEmbedding import BGEM3FlagModel

MODEL_PATH = os.path.normpath(
    os.environ.get(
        "EMBED_MODEL_PATH",
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "models", "bge-m3"),
    )
)
MODEL_NAME = os.environ.get("EMBEDDING_MODEL", "BGE-M3")
SERVICE_HOST = "127.0.0.1"
SERVICE_PORT = 8001

app = Flask(__name__)

print(f"[embed] loading BGE-M3 from {MODEL_PATH} (cpu) ...", flush=True)
_model = BGEM3FlagModel(MODEL_PATH, device="cpu")
print("[embed] model loaded, ready for requests", flush=True)


@app.route("/v1/embeddings", methods=["POST"])
def embeddings():
    """OpenAI 兼容嵌入接口：input 为 str 或 list[str]，返回 dense_vecs（1024 维）。"""
    payload = request.get_json(force=True, silent=True) or {}
    raw_input = payload.get("input")
    if isinstance(raw_input, str):
        texts = [raw_input]
    elif isinstance(raw_input, list) and all(isinstance(x, str) for x in raw_input):
        texts = raw_input
    else:
        texts = []
    if not texts:
        return jsonify({
            "error": {
                "message": "input must be a non-empty string or list of strings",
                "type": "invalid_request_error",
            }
        }), 400

    dense = _model.encode(texts, return_dense=True)["dense_vecs"]
    data = [
        {
            "object": "embedding",
            "index": i,
            "embedding": [float(v) for v in dense[i]],
        }
        for i in range(len(texts))
    ]
    return jsonify({
        "object": "list",
        "model": payload.get("model", MODEL_NAME),
        "data": data,
        "usage": {"prompt_tokens": 0, "total_tokens": 0},
    })


@app.route("/v1/models", methods=["GET"])
def models():
    """健康探测用：返回模型列表即可。"""
    return jsonify({
        "object": "list",
        "data": [{"id": MODEL_NAME, "object": "model", "owned_by": "local"}],
    })


if __name__ == "__main__":
    app.run(host=SERVICE_HOST, port=SERVICE_PORT, threaded=True)
