# -*- coding: utf-8 -*-
"""后端启动入口：Flask API 服务（默认 6006，与旧版端口保持一致）。"""
import os

from dotenv import load_dotenv

# 直接 python run_server.py 不经过 Flask CLI，不会自动加载 .env；
# 必须在导入 server（Config 于 import 时读取 os.environ）之前先加载
load_dotenv(override=False)

from server import create_app

app = create_app()

if __name__ == "__main__":
    # 默认仅回环监听：前端统一经 Next 代理访问 /api，避免局域网绕过代理直连后端；
    # 如需局域网直连后端，显式设置 HOST=0.0.0.0。
    app.run(
        host=os.environ.get("HOST", "127.0.0.1"),
        port=int(os.environ.get("PORT", "6006")),
        debug=os.environ.get("FLASK_DEBUG", "0") == "1",
        threaded=True,
    )
