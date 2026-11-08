# -*- coding: utf-8 -*-
"""后端启动入口：Flask API 服务（默认 6006，与旧版端口保持一致）。"""
import os

from server import create_app

app = create_app()

if __name__ == "__main__":
    app.run(
        host=os.environ.get("HOST", "0.0.0.0"),
        port=int(os.environ.get("PORT", "6006")),
        debug=os.environ.get("FLASK_DEBUG", "0") == "1",
        threaded=True,
    )
