# -*- coding: utf-8 -*-
"""心理科普文章接口：学生只读（内置 + 教师发布），教师管理增删改查。"""
import html

from flask import Blueprint, current_app, jsonify, request
from sqlalchemy import delete, func, select

from ..extensions import db
from ..models import Article, now_ms
from ..security import require_login, require_teacher
from ..services.article_seed import ARTICLE_SOURCE

bp = Blueprint("article", __name__)

_MS_PER_SECOND = 1000
_DEFAULT_PAGE = 1
_DEFAULT_PAGE_SIZE = 6
_DEFAULT_TEACHER_PAGE_SIZE = 10
_MAX_PAGE_SIZE = 50
_SEED_ID_PREFIX = "seed-"


def _plain_text_to_html(text: str) -> str:
    """教师纯文本正文 -> 分段 HTML（先转义再包 <p>），已含标签则原样返回。

    内置 seed 文章本身是 h2/p 结构化 HTML，学生端详情页沿用 .detail-content 排版，
    因此只对纯文本做转换，前端无需区分来源。
    """
    if "<" in text and ">" in text:
        return text
    paras = [p.strip() for p in text.replace("\r\n", "\n").split("\n") if p.strip()]
    return "".join(f"<p>{html.escape(p)}</p>" for p in paras)


def _to_seconds(timestamp_ms: int | None) -> int | None:
    """库内毫秒 -> 响应秒（前端 fmtDate 按秒消费）。"""
    return timestamp_ms // _MS_PER_SECOND if timestamp_ms else timestamp_ms


def _article_public_dict(article: Article) -> dict:
    return {
        "id": article.id,
        "cover": article.cover or "",
        "title": article.title,
        "summary": article.summary or "",
        "content": _plain_text_to_html(article.content or ""),
        "created_at": _to_seconds(article.created_at),
        # source 为空的是内置 seed 文章，用默认权威来源标注
        "source": article.source or ARTICLE_SOURCE,
    }


def _article_teacher_dict(article: Article) -> dict:
    """教师管理列表用字典：正文返回库内原始内容（编辑弹窗直接回填）。"""
    return {
        "id": article.id,
        "title": article.title,
        "summary": article.summary or "",
        "content": article.content or "",
        "source": article.source or "",
        "author": article.author or "",
        "is_active": article.is_active,
        "created_at": _to_seconds(article.created_at),
        "updated_at": _to_seconds(article.updated_at),
    }


def _safe_index_article(article_id: str) -> None:
    """RAG 索引钩子：索引服务不可用/未就绪时只记 warning，不能影响文章接口。"""
    try:
        from ..services.rag_service import index_article

        index_article(article_id)
    except Exception as exc:  # 索引属增强能力，失败可后续 reindex 重建
        current_app.logger.warning("[rag] 文章索引失败 %s：%s", article_id, exc)


def _safe_remove_article(article_id: str) -> None:
    try:
        from ..services.rag_service import remove_article

        remove_article(article_id)
    except Exception as exc:
        current_app.logger.warning("[rag] 文章索引清理失败 %s：%s", article_id, exc)


# ---------- 学生端：阅读 ----------
@bp.get("/api/articles")
def list_articles():
    """学生端文章列表（仅上架），支持 page/page_size 分页。"""
    _user, err = require_login()
    if err:
        return err
    try:
        page = max(_DEFAULT_PAGE, int(request.args.get("page", _DEFAULT_PAGE)))
        page_size = min(_MAX_PAGE_SIZE, max(1, int(request.args.get("page_size", _DEFAULT_PAGE_SIZE))))
    except (TypeError, ValueError):
        return jsonify({"error": "分页参数不合法"}), 400

    where = Article.is_active == 1
    total = db.session.scalar(select(func.count()).select_from(Article).where(where)) or 0
    rows = db.session.scalars(
        select(Article)
        .where(where)
        .order_by(Article.created_at.desc())
        .limit(page_size)
        .offset((page - 1) * page_size)
    ).all()
    return jsonify({
        "articles": [_article_public_dict(row) for row in rows],
        "total": total,
        "page": page,
        "page_size": page_size,
    })


@bp.get("/api/articles/<article_id>")
def get_article(article_id: str):
    """学生端文章详情：仅上架文章可见。"""
    _user, err = require_login()
    if err:
        return err
    article = db.session.scalar(
        select(Article).where(Article.id == article_id, Article.is_active == 1)
    )
    if not article:
        return jsonify({"error": "文章不存在"}), 404
    return jsonify({"article": _article_public_dict(article)})


# ---------- 教师端：管理 ----------
@bp.get("/api/teacher/articles")
def teacher_list_articles():
    """教师端文章列表（含下架），按发布时间倒序分页。"""
    _user, err = require_teacher()
    if err:
        return err
    page = max(_DEFAULT_PAGE, request.args.get("page", _DEFAULT_PAGE, type=int))
    page_size = min(
        _MAX_PAGE_SIZE, max(1, request.args.get("page_size", _DEFAULT_TEACHER_PAGE_SIZE, type=int))
    )
    total = db.session.scalar(select(func.count()).select_from(Article)) or 0
    rows = db.session.scalars(
        select(Article)
        .order_by(Article.created_at.desc())
        .limit(page_size)
        .offset((page - 1) * page_size)
    ).all()
    return jsonify({
        "articles": [_article_teacher_dict(row) for row in rows],
        "total": total,
        "page": page,
        "page_size": page_size,
    })


@bp.post("/api/teacher/articles")
def create_article():
    """教师新增文章：title/content 必填，source 留空用默认来源。"""
    user, err = require_teacher()
    if err:
        return err
    data = request.get_json(silent=True) or {}
    title = (data.get("title") or "").strip()
    content = (data.get("content") or "").strip()
    summary = (data.get("summary") or "").strip()
    source = (data.get("source") or "").strip()
    if not title:
        return jsonify({"error": "文章标题不能为空"}), 400
    if not content:
        return jsonify({"error": "文章正文不能为空"}), 400

    timestamp = now_ms()
    article = Article(
        id=f"art-{timestamp}",
        cover=None,
        title=title,
        summary=summary,
        content=content,
        source=source or None,
        author=user.get("name"),
        is_active=1,
        created_at=timestamp,
        updated_at=timestamp,
    )
    db.session.add(article)
    db.session.commit()
    _safe_index_article(article.id)
    return jsonify({"ok": True, "id": article.id}), 201


@bp.put("/api/teacher/articles/<article_id>")
def update_article(article_id: str):
    """教师编辑文章；内置 seed 文章只读。"""
    _user, err = require_teacher()
    if err:
        return err
    if article_id.startswith(_SEED_ID_PREFIX):
        return jsonify({"error": "系统内置文章不可编辑"}), 403

    data = request.get_json(silent=True) or {}
    title = (data.get("title") or "").strip()
    content = (data.get("content") or "").strip()
    summary = (data.get("summary") or "").strip()
    source = (data.get("source") or "").strip()
    if not title:
        return jsonify({"error": "文章标题不能为空"}), 400
    if not content:
        return jsonify({"error": "文章正文不能为空"}), 400

    article = db.session.get(Article, article_id)
    if not article:
        return jsonify({"error": "文章不存在"}), 404
    article.title = title
    article.summary = summary
    article.content = content
    article.source = source or None
    article.updated_at = now_ms()
    db.session.commit()
    _safe_index_article(article_id)
    return jsonify({"ok": True})


@bp.delete("/api/teacher/articles/<article_id>")
def delete_article(article_id: str):
    """教师删除文章（物理删除）；内置 seed 文章不可删。"""
    _user, err = require_teacher()
    if err:
        return err
    if article_id.startswith(_SEED_ID_PREFIX):
        return jsonify({"error": "系统内置文章不可删除"}), 403

    result = db.session.execute(delete(Article).where(Article.id == article_id))
    db.session.commit()
    if result.rowcount == 0:
        return jsonify({"error": "文章不存在"}), 404
    _safe_remove_article(article_id)
    return jsonify({"ok": True})
