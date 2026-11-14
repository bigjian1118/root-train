# -*- coding: utf-8 -*-
"""Flask 应用工厂：只暴露 /api/* 接口，页面由 Next.js 前端提供。"""
import os

from flask import Flask, jsonify, request
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from .config import Config
from .extensions import db


def create_app(config_object: type[Config] = Config) -> Flask:
    app = Flask(__name__)
    app.config.from_object(config_object)
    app.json.ensure_ascii = False

    # 监测日志：默认级别只显示 WARNING 及以上，放开到 INFO 使 [face] 等
    # 分段耗时/失败原因日志能进入 api.log（便携版 启动.bat 重定向收集）
    import logging

    app.logger.setLevel(logging.INFO)

    db.init_app(app)

    _register_cors(app)
    _register_blueprints(app)
    _register_error_handlers(app)
    _register_cli(app)
    _init_database(app)
    _start_material_ai_worker(app)
    return app


def _start_material_ai_worker(app: Flask) -> None:
    """AI 方案生成：启动任务工作线程 + 存量素材异步补建向量索引。"""
    if os.environ.get("MATERIAL_AI_WORKER", "1") != "1":
        return
    import threading

    from .services.material_ai_service import start_material_ai_worker

    start_material_ai_worker(app)

    def backfill() -> None:
        # 嵌入服务可能晚于 Flask 就绪，失败时下一轮启动再补，不阻塞主进程
        if not Config.AI_ENABLED:
            # 无卡模式：嵌入服务未启动，跳过存量素材补建向量索引
            return
        from .services.material_parser import reindex_all_materials

        with app.app_context():
            try:
                count = reindex_all_materials()
                if count:
                    app.logger.info("[material-ai] 存量素材补索引 %s 个切片", count)
            except Exception as exc:
                app.logger.warning("[material-ai] 存量素材补索引跳过：%s", exc)

    threading.Thread(target=backfill, name="material-backfill", daemon=True).start()


def _register_blueprints(app: Flask) -> None:
    """按业务域注册蓝图（路由路径与旧 Flask 完全一致）。"""
    from .api import (
        account_api, appointment_api, article_api, auth, chat_api, config_api,
        face_api, material_api, material_ai_api, message_api,
        report_api, teacher_api, test_api,
    )

    for module in (auth, config_api, test_api, report_api, teacher_api, chat_api,
                   article_api, appointment_api, message_api, material_api, face_api,
                   account_api, material_ai_api):
        app.register_blueprint(module.bp)


def _register_cors(app: Flask) -> None:
    """允许 Next.js 开发端口跨域携带 Cookie（生产同源经反向代理，可不触发）。"""
    origins = {o.strip() for o in app.config["CORS_ORIGINS"] if o.strip()}

    @app.after_request
    def add_cors_headers(response):
        origin = request.headers.get("Origin")
        if origin in origins:
            response.headers["Access-Control-Allow-Origin"] = origin
            response.headers["Access-Control-Allow-Credentials"] = "true"
            response.headers["Access-Control-Allow-Headers"] = "Content-Type"
            response.headers["Access-Control-Allow-Methods"] = "GET,POST,PUT,DELETE,OPTIONS"
        return response

    @app.route("/api/<path:_any>", methods=["OPTIONS"])
    def cors_preflight(_any):
        return ("", 204)


def _register_error_handlers(app: Flask) -> None:
    @app.errorhandler(413)
    def too_large(_exc):
        return jsonify({"error": "上传文件超过 50MB 限制"}), 413

    @app.errorhandler(404)
    def not_found(_exc):
        return jsonify({"error": "接口不存在"}), 404

    @app.errorhandler(500)
    def server_error(exc):
        app.logger.exception("服务端异常：%s", exc)
        return jsonify({"error": "服务器内部错误"}), 500


def _init_database(app: Flask) -> None:
    """启动自愈：确保 pgvector 扩展与全部表存在（幂等）。"""
    if os.environ.get("SKIP_DB_INIT", "0") == "1":
        return
    with app.app_context():
        try:
            db.session.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
            db.session.commit()
            db.create_all()
            # create_all 不会给存量表补列：账号注销/素材 AI 新增字段需显式幂等迁移
            for table in ("student", "teacher"):
                db.session.execute(text(
                    f"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS "
                    "account_status TEXT NOT NULL DEFAULT 'active'"))
                db.session.execute(text(
                    f"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS deleted_at BIGINT"))
                db.session.execute(text(
                    f"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS delete_reason TEXT"))
                db.session.execute(text(
                    f"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS delete_serial TEXT"))
            db.session.execute(text(
                "ALTER TABLE account_deletion_request ADD COLUMN IF NOT EXISTS ip VARCHAR(64)"))
            db.session.execute(text(
                "ALTER TABLE account_deletion_request "
                "ADD COLUMN IF NOT EXISTS verify_method VARCHAR(16)"))
            db.session.execute(text(
                "ALTER TABLE activity_material ADD COLUMN IF NOT EXISTS "
                "source TEXT NOT NULL DEFAULT 'upload'"))
            db.session.execute(text(
                "ALTER TABLE activity_material ADD COLUMN IF NOT EXISTS tags TEXT"))
            db.session.commit()

            # 手机号是登录凭据：学生/教师各自唯一；用部分唯一索引兼容存量 NULL。
            # 存量存在重复非空手机号时索引会创建失败，这里只告警不阻塞启动，待人工清理后重试。
            for table in ("student", "teacher"):
                try:
                    db.session.execute(text(
                        f"CREATE UNIQUE INDEX IF NOT EXISTS uq_{table}_phone "
                        f"ON {table} (phone) WHERE phone IS NOT NULL"))
                    db.session.commit()
                except SQLAlchemyError:
                    db.session.rollback()
                    app.logger.warning(
                        "[db] %s 手机号唯一索引创建失败：存量存在重复手机号，请人工清理后重试",
                        table,
                    )

            from .services.seed_service import seed_builtin_articles

            seed_builtin_articles()
        except Exception as exc:  # 数据库暂不可用时不阻塞进程启动（待库就绪后重试）
            app.logger.warning("[db] 初始化跳过：%s", exc)


def _register_cli(app: Flask) -> None:
    @app.cli.command("init-db")
    def init_db_command():
        """建表（含 pgvector 扩展）。"""
        with app.app_context():
            db.session.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
            db.session.commit()
            db.create_all()
        print("[OK] 数据库表已就绪")

    @app.cli.command("reindex-rag")
    def reindex_rag_command():
        """重建 RAG 向量索引（文章 + 内置科普条目）。"""
        from .services.rag_service import reindex_all
        from .services.seed_service import seed_builtin_articles

        with app.app_context():
            seed_builtin_articles()
            count = reindex_all()
        print(f"[OK] 已索引 {count} 个切片")

    @app.get("/api/health")
    def health():
        """健康检查：前端与编排探活。"""
        return jsonify({"ok": True, "service": "ai-psy-server"})
