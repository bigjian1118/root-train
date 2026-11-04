# 芯心向荣——AI 心理健康辅助平台

## 项目简介

芯心向荣是一个面向学生和教师的 AI 心理健康辅助 Web 应用，结合 SCL-90 心理测评、面部视频情绪分析与大语言模型，提供心理状态辅助分析、AI 聊天陪伴及心理咨询预约等功能。

## 已有核心功能

- 学生注册与登录
- SCL-90 心理测评及历史报告
- 视频面部情绪分析
- AI 心理陪伴聊天
- 教师端测评管理与风险提示
- 心理咨询预约和心理科普

## 技术架构

当前版本：Python、Flask、HTML、CSS、JavaScript、SQLite。

AI 技术：Qwen2.5-7B、LoRA、py-feat、随机森林。

计划升级：Next.js、TypeScript、RAG、AI Agent 等。

## 本地运行

进入 `ai-psy` 目录，使用 Python 3.11 创建虚拟环境并安装依赖。

```powershell
py -3.11 -m venv .venv
.\.venv\Scripts\python.exe -X utf8 -m pip install -r requirements.txt numpy Pillow
.\.venv\Scripts\python.exe app.py --mock
```

打开 `http://127.0.0.1:6006/login`。

注意：Mock 模式仅用于本地演示，不执行真实大模型推理。
  