# -*- coding: utf-8 -*-
"""BGE-M3 文本嵌入客户端（独立模型，不与大模型混用）。

调用方式：OpenAI 兼容 /v1/embeddings（vLLM embedding / TEI / 自定义网关均可）。
mock 模式用确定性哈希向量，保证本地无模型时 RAG 链路可跑通。
"""
import hashlib
import math

import requests

from .config import Config


class EmbeddingError(Exception):
    """嵌入服务调用失败。"""


def _mock_vector(text: str, dim: int) -> list[float]:
    """确定性伪向量：同文本 -> 同向量，仅用于本地联调。"""
    digest = hashlib.sha256(text.encode("utf-8")).digest()
    raw = [(digest[i % len(digest)] - 127.5) / 127.5 for i in range(dim)]
    norm = math.sqrt(sum(v * v for v in raw)) or 1.0
    return [v / norm for v in raw]


def embed_texts(texts: list[str]) -> list[list[float]]:
    """批量文本向量化，返回与输入等长的向量列表。"""
    if not texts:
        return []
    if Config.LLM_PROVIDER == "mock":
        return [_mock_vector(text, Config.EMBEDDING_DIM) for text in texts]

    url = Config.EMBEDDING_BASE_URL.rstrip("/") + "/embeddings"
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {Config.EMBEDDING_API_KEY}",
    }
    try:
        resp = requests.post(
            url,
            headers=headers,
            json={"model": Config.EMBEDDING_MODEL, "input": texts},
            timeout=Config.EMBEDDING_TIMEOUT,
        )
        resp.raise_for_status()
        data = resp.json().get("data", [])
    except Exception as exc:
        raise EmbeddingError(f"调用 BGE-M3 嵌入服务失败：{exc}") from exc

    vectors = [item["embedding"] for item in sorted(data, key=lambda x: x.get("index", 0))]
    if len(vectors) != len(texts):
        raise EmbeddingError("嵌入服务返回数量与输入不一致")
    return vectors


def embed_query(text: str) -> list[float]:
    """单条查询向量化。"""
    return embed_texts([text])[0]
