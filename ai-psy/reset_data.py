# -*- coding: utf-8 -*-
"""一键清空业务数据，保留系统内置文章（id 以 seed- 开头）及其 RAG 切片。

适用场景：演示前重置环境、清理测试账号与测评数据；不删除表结构，不重建数据库。

用法（在 root/ai-psy 目录下执行）：
    python reset_data.py          # 交互确认后执行
    python reset_data.py --force  # 跳过确认，适合自动化一键执行

保留内容：
    - articles 表中 id 以 seed- 开头的系统内置文章
    - rag_chunk 表中内置文章切片（source_id 以 seed- 开头）与内置知识切片
      （source_type=knowledge）

清空内容：学生/教师账号、测评报告、预约、素材、AI 任务、倾诉会话、
注销流水、班级绑定与审计日志、教师自建文章、素材等非内置 RAG 切片。
"""
import argparse
import os
import sys

# 清库脚本不需要启动后台任务与建表迁移，避免附带副作用
os.environ.setdefault("MATERIAL_AI_WORKER", "0")
os.environ.setdefault("SKIP_DB_INIT", "1")

try:
    from sqlalchemy import delete, func, select

    from server import create_app
    from server.extensions import db
    from server.models import (
        AccountDeletionRequest, ActivityMaterial, AiAnalysisReport, Appointment, Article,
        Conversation, CounselingSlot, MaterialAiTask, Message, RagChunk, Scl90TextReport,
        Student, Teacher, TeacherClass, TeacherClassChangeLog, VideoFaceReport,
    )
except ModuleNotFoundError as exc:
    # 常见坑：服务器上直接 python reset_data.py 走的是系统解释器，缺少后端依赖
    print(
        f"[错误] 当前 Python 环境缺少依赖（{exc.name}）。\n"
        "请先激活后端环境后重试：\n"
        "  conda activate pyfeat_env && python reset_data.py\n"
        "或直接使用一键脚本（会自动定位 conda 环境）：\n"
        "  ./start_all.sh reset",
        file=sys.stderr,
    )
    sys.exit(3)

# 与 seed_service.py 保持一致：内置文章 id 固定为 seed-001、seed-002…
BUILTIN_ARTICLE_ID_PREFIX = "seed-"

# 需要全量清空的业务表；顺序从衍生数据到账号主体，便于阅读与排查
RESET_MODELS = (
    Message,
    Conversation,
    Appointment,
    CounselingSlot,
    MaterialAiTask,
    ActivityMaterial,
    Scl90TextReport,
    VideoFaceReport,
    AiAnalysisReport,
    AccountDeletionRequest,
    TeacherClassChangeLog,
    TeacherClass,
    Student,
    Teacher,
)


def _count_rows(model) -> int:
    """统计表当前行数，用于执行前后对照。"""
    return db.session.scalar(select(func.count()).select_from(model)) or 0


def _count_builtin_articles() -> int:
    """统计内置文章数量（id 以 seed- 开头）。"""
    return db.session.scalar(
        select(func.count()).where(Article.id.startswith(BUILTIN_ARTICLE_ID_PREFIX)
                                   ).select_from(Article)
    ) or 0


def _removable_chunk_condition():
    """可删除的 RAG 切片：除内置文章切片与内置知识切片之外的全部切片。"""
    builtin_mask = (RagChunk.source_type == "knowledge") | (
        (RagChunk.source_type == "article")
        & RagChunk.source_id.startswith(BUILTIN_ARTICLE_ID_PREFIX)
    )
    return ~builtin_mask


def _confirm() -> bool:
    """交互确认：必须输入 YES 才继续，避免误清生产数据。"""
    answer = input("确认清空以上数据？输入 YES 继续（其它任意输入取消）：").strip()
    return answer.upper() == "YES"


def _reset_data() -> None:
    """按表清空业务数据；内置文章与内置文章切片保留。"""
    deleted_total = 0
    for model in RESET_MODELS:
        result = db.session.execute(delete(model))
        deleted_total += result.rowcount or 0

    # 教师自建文章属于业务数据，只保留 seed- 开头的系统内置文章
    article_result = db.session.execute(
        delete(Article).where(~Article.id.startswith(BUILTIN_ARTICLE_ID_PREFIX))
    )
    deleted_total += article_result.rowcount or 0

    # 只清理引用非内置文章的切片，内置文章与内置知识切片保留
    chunk_result = db.session.execute(
        delete(RagChunk).where(_removable_chunk_condition())
    )
    deleted_total += chunk_result.rowcount or 0

    db.session.commit()
    print(f"[OK] 清空完成：共删除 {deleted_total} 行，"
          f"保留内置文章 {_count_builtin_articles()} 篇")


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="清空业务数据（保留系统内置文章）")
    parser.add_argument("--force", action="store_true", help="跳过交互确认")
    args = parser.parse_args(argv)

    app = create_app()
    with app.app_context():
        print("将清空以下数据（表名 → 当前行数）：")
        for model in RESET_MODELS:
            print(f"  {model.__tablename__} → {_count_rows(model)} 行")
        removable_articles = _count_rows(Article) - _count_builtin_articles()
        removable_chunks = db.session.scalar(
            select(func.count()).where(_removable_chunk_condition()
                                       ).select_from(RagChunk)
        ) or 0
        print(f"  articles（非内置）→ {removable_articles} 篇")
        print(f"  rag_chunk（非内置切片）→ {removable_chunks} 条")
        print(f"保留：内置文章 {_count_builtin_articles()} 篇及其 RAG 切片")

        if not args.force and not _confirm():
            print("已取消，未做任何修改。")
            return 1

        try:
            _reset_data()
        except Exception as exc:  # 任一表失败整体回滚，避免半清空状态
            db.session.rollback()
            print(f"[错误] 清空失败，已回滚：{exc}", file=sys.stderr)
            return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
