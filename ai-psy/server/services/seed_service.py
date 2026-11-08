# -*- coding: utf-8 -*-
"""启动初始化数据：内置科普文章幂等写入（替换旧 SQLite 版 seed_articles）。

设计：seed 文章 id 固定为 seed-001…，只同步标题/简介/正文，
保留首次写入的发布时间与上架状态；教师自建文章完全不受影响。
"""
from sqlalchemy import select

from ..config import Config
from ..extensions import db
from ..models import Article, now_ms
from .article_seed import BUILTIN_ARTICLES

_SEED_PREFIX = "seed"


def seed_builtin_articles() -> int:
    """幂等写入/刷新内置文章，返回本次写入 + 更新的条数。"""
    total = 0
    base_time = now_ms()
    for index, art in enumerate(BUILTIN_ARTICLES):
        article_id = f"{_SEED_PREFIX}-{index + 1:03d}"
        existing = db.session.get(Article, article_id)
        if existing is None:
            db.session.add(Article(
                id=article_id,
                title=art["title"],
                summary=art["summary"],
                content=art["content"],
                is_active=1,
                # 每条相差 1 秒，列表按发布时间倒序时呈现自然的新旧次序
                created_at=base_time - (len(BUILTIN_ARTICLES) - index) * 1000,
            ))
        elif existing.is_active == 1:
            existing.title = art["title"]
            existing.summary = art["summary"]
            existing.content = art["content"]
        total += 1
    db.session.commit()
    return total


def auto_index_rag() -> int:
    """启动后异步索引（失败不阻塞启动，返回 0 表示跳过）。"""
    if not Config.RAG_AUTO_INDEX:
        return 0
    if not Config.AI_ENABLED:
        # 无卡模式嵌入服务不可用，跳过索引避免长时间连接超时
        return 0
    from .rag_service import reindex_all

    try:
        return reindex_all()
    except Exception as exc:  # 嵌入服务未就绪时等人工执行 flask reindex-rag
        db.session.rollback()
        print(f"[rag] 自动索引跳过：{exc}")
        return 0
