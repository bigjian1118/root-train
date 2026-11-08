# -*- coding: utf-8 -*-
"""RAG 服务：文章/内置知识切条、向量化入库与余弦检索。

设计：所有切片统一存 rag_chunk 表，source_type + source_id 标识来源，
检索用 pgvector 余弦距离；向量由独立的 BGE-M3 服务生成（见 embedding.py）。
"""
import html as html_module
import re

from sqlalchemy import delete, select

from ..config import Config
from ..embedding import embed_query, embed_texts
from ..extensions import db
from ..models import Article, RagChunk, now_ms
from .knowledge_seed import KNOWLEDGE_ITEMS

# 先把段落/换行类标签转成换行，再统一去掉其余标签，保留可读的分段边界
_HTML_BLOCK_TAG_RE = re.compile(r"(?i)<(?:br|/p|/h[1-6]|/li|/div|/section)[^>]*>")
_HTML_TAG_RE = re.compile(r"<[^>]+>")
_MIN_CHUNK_SIZE = 1


def chunk_text(text: str, size: int = Config.RAG_CHUNK_SIZE,
               overlap: int = Config.RAG_CHUNK_OVERLAP) -> list[str]:
    """按段落优先、超长段落按长度切条；空块自动丢弃。"""
    size = max(_MIN_CHUNK_SIZE, int(size))
    overlap = max(0, min(int(overlap), size - 1))
    normalized = (text or "").replace("\r\n", "\n").replace("\r", "\n")
    paragraphs = [para.strip() for para in normalized.split("\n") if para.strip()]

    chunks: list[str] = []
    current = ""
    for paragraph in paragraphs:
        if len(paragraph) > size:
            if current:
                chunks.append(current)
                current = ""
            chunks.extend(_split_long_text(paragraph, size, overlap))
            continue
        if not current:
            current = paragraph
        elif len(current) + 1 + len(paragraph) <= size:
            current = f"{current}\n{paragraph}"
        else:
            chunks.append(current)
            current = paragraph
    if current:
        chunks.append(current)
    return [chunk for chunk in chunks if chunk.strip()]


def _split_long_text(text: str, size: int, overlap: int) -> list[str]:
    """超长段落按 size 滑动切分，相邻片段保留 overlap 个字符。"""
    step = max(size - overlap, 1)
    pieces = []
    start = 0
    while start < len(text):
        pieces.append(text[start:start + size])
        if start + size >= len(text):
            break
        start += step
    return [piece.strip() for piece in pieces if piece.strip()]


def _article_plain_text(article: Article) -> str:
    """文章标题 + 摘要 + 去标签正文，作为索引文本。"""
    raw = article.content or ""
    raw = _HTML_BLOCK_TAG_RE.sub("\n", raw)
    raw = _HTML_TAG_RE.sub("", raw)
    raw = html_module.unescape(raw)
    parts = [article.title or "", article.summary or "", raw]
    return "\n".join(part.strip() for part in parts if part and part.strip())


def index_document(source_type: str, source_id: str, title: str, text: str) -> int:
    """重建单个来源的全部切片：删旧 -> 切条 -> 向量化 -> 批量写入，返回切片数。"""
    source_type = str(source_type)
    source_id = str(source_id)
    try:
        db.session.execute(
            delete(RagChunk).where(
                RagChunk.source_type == source_type,
                RagChunk.source_id == source_id,
            )
        )
        chunks = chunk_text(text)
        if not chunks:
            db.session.commit()
            return 0

        vectors = embed_texts(chunks)
        created_at = now_ms()
        db.session.add_all([
            RagChunk(
                source_type=source_type,
                source_id=source_id,
                title=title or source_id,
                chunk_index=index,
                content=chunk,
                embedding=vector,
                created_at=created_at,
            )
            for index, (chunk, vector) in enumerate(zip(chunks, vectors))
        ])
        db.session.commit()
    except Exception:
        db.session.rollback()
        raise
    return len(chunks)


def index_article(article_id: str) -> int:
    """索引一篇上架文章；不存在或已下架时清理旧切片并返回 0。"""
    article = db.session.get(Article, article_id)
    if not article:
        return 0
    if article.is_active != 1:
        remove_article(article_id)
        return 0
    return index_document("article", article.id, article.title, _article_plain_text(article))


def remove_article(article_id: str) -> None:
    """删除文章对应的全部切片。"""
    db.session.execute(
        delete(RagChunk).where(
            RagChunk.source_type == "article",
            RagChunk.source_id == str(article_id),
        )
    )
    db.session.commit()


def search(query: str, top_k: int = Config.RAG_TOP_K) -> list[dict]:
    """向量检索：余弦距离升序取 top_k，score = 1 - distance。

    嵌入服务不可用时直接抛 EmbeddingError，由上层决定降级策略。
    """
    query = (query or "").strip()
    if not query:
        return []
    limit = max(1, int(top_k))
    vector = embed_query(query)
    distance = RagChunk.embedding.cosine_distance(vector)
    rows = db.session.execute(
        select(
            RagChunk.title,
            RagChunk.content,
            RagChunk.source_type,
            RagChunk.source_id,
            distance.label("distance"),
        )
        .order_by(distance)
        .limit(limit)
    ).all()
    return [
        {
            "title": row.title,
            "content": row.content,
            "source_type": row.source_type,
            "source_id": row.source_id,
            "score": round(1 - float(row.distance), 4),
        }
        for row in rows
    ]


def reindex_all() -> int:
    """清空切片后重建：全部上架文章 + 内置知识条目 + 全部素材，返回总切片数。

    素材切片与文章共用本表，全清重建必须一并恢复素材，否则 AI 方案生成召回会空转。
    """
    db.session.execute(delete(RagChunk))
    db.session.commit()

    total = 0
    articles = db.session.scalars(
        select(Article).where(Article.is_active == 1)
    ).all()
    for article in articles:
        total += index_document(
            "article", article.id, article.title, _article_plain_text(article)
        )
    for item in KNOWLEDGE_ITEMS:
        total += index_document(
            "knowledge", item["id"], item["title"], item["content"]
        )
    # 延迟导入避免循环依赖（material_parser 依赖 rag_service.index_document）
    from .material_parser import reindex_all_materials

    total += reindex_all_materials()
    return total
