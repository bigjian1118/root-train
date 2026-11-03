# 芯心向荣 AIC · 校园 AI 心理健康测评系统

> **面向校园场景的 AI 心理测评系统** —— 融合文本量表与视频表情双通道分析，
> 覆盖「测评 → 智能分析 → 报告生成 → 分级预警 → 干预转介」全链路，包含学生测评端与教师管理端。

![版本](https://img.shields.io/badge/version-v3.1-informational)
![后端](https://img.shields.io/badge/Flask-6006-green)
![大模型](https://img.shields.io/badge/LLM-Qwen2.5--7B--Instruct%20%2B%20vLLM-blueviolet)
![算法](https://img.shields.io/badge/ML-RandomForest%20%2B%20py--feat-orange)

- **部署环境**：AutoDL 容器（RTX 4090 24GB），双 conda 环境隔离
  - **qwen_env**：Python 3.12，vLLM 0.7.0 + Qwen2.5-7B-Instruct 基座（bf16 原版），热挂载 `psych-chat` 聊天 LoRA 适配器，提供本机 OpenAI 兼容大模型 API（8000 端口）
  - **pyfeat_env**：Python 3.11，CPU 运行，Flask 后端 + py-feat 0.6.1 视频分析 + scikit-learn 随机森林，HTTP 调用本机 8000 端口大模型
- **历史详细版**：本文档为重构后的工程化主文档；原 1500+ 行逐节迭代记录（含每个功能的变更说明与部署细节）完整保留于 [README-归档-旧版全文.md](README-归档-旧版全文.md)

---

## 📌 项目简介

### 背景与痛点

校园心理健康工作长期存在三个瓶颈：**普查效率低**（纸质量表回收统计耗时）、**识别滞后**（隐性情绪问题难以通过问卷及时暴露）、**解读门槛高**（SCL-90 等专业量表结果教师难以快速转译为学生可执行的调适建议）。

### 解决方案

本系统以「双通道采集 + 双层智能分析」为核心思路：

1. **文本量表通道**：SCL-90（90 题症状自评）量表在线测评，程序完成全部标准化计分；
2. **视频表情通道**：学生录制一段面部视频，py-feat 提取面部动作单元（AU）与基本情绪指标，随机森林辅助判定主导情绪与严重程度；
3. **大模型层**：Qwen2.5-7B-Instruct（bf16）+ `psych-chat` 聊天 LoRA，负责心理陪伴对话与两类通道的自然语言报告生成；
4. **教师端**：班级测评管理、学生报告查看、危机信号预警、咨询预约与师生私密倾诉，形成干预闭环。

### 应用场景

- 学校心理健康普查与建档
- 班级日常心理状态监测与情绪预警
- 学生自助测评、心理科普与 AI 陪伴倾诉
- 心理咨询预约与转介管理

---

## ✨ 核心特性

| 维度 | 能力 |
|---|---|
| **双端用户体系** | 学生 / 教师分角色注册登录，全站登录守卫（auth.js），教师端页面级权限拦截（`_guard_teacher_page`），学生数据仅本人与所任教师可见 |
| **双通道测评** | SCL-90 文本量表（三人群场景化题库：小学生 / 中学生 / 大学生）与面部视频情绪分析并行，交叉印证 |
| **AI 智能分析** | 大模型生成个性化报告：弱化专业术语、强化四维度可落地建议（情绪表达 / 压力调节 / 人际互动 / 日常习惯）；心理陪伴多轮对话经 LoRA 微调风格 |
| **自动化报告** | 整合版专属测评报告页：文本模块 + 视频模块同页分模块呈现，历史检测记录一键同步切换 |
| **分级预警** | SCL-90 危机条目独立阈值判定（不依赖大模型），危机信号在报告顶部醒目提示并同步教师端；随机森林严重程度分级辅助 |
| **降级容错** | 大模型不可达 / 超时不阻塞主流程：测评计分、py-feat 客观指标、RF 分类、数据归档全部照常，仅 AI 正文显示降级提示 |
| **业务闭环** | 咨询预约（时段管理 + 约满控制）、心理科普文章、师生私密倾诉、教师活动素材库 |

---

## 🏗️ 系统架构

### 分层结构

```
┌─────────────────────────────────────────────────────────┐
│ 前端交互层  static/（原生 HTML + JS + CSS，无构建依赖）      │
│   登录守卫 auth.js ｜ 报告排版 md_render.js ｜ 各页独立脚本   │
└──────────────────────────┬──────────────────────────────┘
                           │ fetch /api/*
┌──────────────────────────▼──────────────────────────────┐
│ 业务服务层  app.py（Flask :6006，pyfeat_env）              │
│   量表计分引擎 ｜ 危机阈值判定 ｜ 权限守卫 ｜ 静态资源托管      │
│   py-feat 视频抽帧 + AU/情绪提取 ｜ 随机森林推理（rf/）      │
└──────────────────────────┬──────────────────────────────┘
                           │ requests（OpenAI 兼容协议）
┌──────────────────────────▼──────────────────────────────┐
│ AI 引擎层  llm_client.py → vLLM :8000（qwen_env）         │
│   Qwen2.5-7B-Instruct bf16 + psych-chat LoRA 热挂载       │
│   think 标签裁剪 ｜ LoRA 路由与运行时回退 ｜ mock 模式        │
└──────────────────────────┬──────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────┐
│ 数据层  SQLite 单库 psy.db（12 表，autodl-fs 持久盘）        │
│   用户 / 报告归档 / 预约 / 文章 / 素材 / 会话消息             │
│   随机森林模型 .joblib（autodl-fs/models/）｜ 题库 JSON      │
└─────────────────────────────────────────────────────────┘
```

### 核心业务链路

| 链路 | 流程 |
|---|---|
| 文本测评 | `/test` 三人群题库答题 → `POST /api/test/submit` → 后端完整性校验 + 总分/因子分/PSDI 计算 + 危机条目判定 + RF 严重程度辅助 → `REPORT_PROMPT` 调通用基座生成 AI 解读 → 归档 `scl90_text_report` → 跳转整合报告页 |
| 视频分析 | `/face` 录制上传 → `POST /api/face/analyze` → ffmpeg 解码 + py-feat 逐帧 AU/情绪提取 + 聚合统计 → RF 主导情绪与严重程度分类 → `FACE_REPORT_PROMPT` 生成通俗化视频报告 → 归档 `video_face_report` |
| AI 对话 | `/chat` 多轮消息 → 后端注入三人群 system prompt → `llm_client.chat(use_chat_lora=True)` 优先路由 psych-chat 适配器（异常自动回退基座）→ 裁剪 think 块返回 |
| 报告查看 | `/student/reports` 与 `/test/report` 统一渲染 `report.html`：进入即直显最新一期整合报告；左侧历史记录点击同步切换文本 + 视频模块 |
| 教师管理 | 班级学生列表 → 风险标记（危机信号 / 总分超阈值）→ 点入查看学生整合报告（教师专业视图）→ 预约审批 / 倾诉回复 / 素材发布 / 心理推文（科普文章）管理 |

---

## 🛠️ 技术栈

### 前端
- 原生 HTML / CSS / JavaScript（无框架、无构建），每页独立样式，`common.css` 通用组件；青色/浅绿校园风设计规范
- `auth.js` 全站登录守卫与角色入口控制；`md_render.js` AI 报告 Markdown → 正式文档排版

### 后端
- Python 3.11 + Flask（Werkzeug ≥2.3），端口 **6006**
- SQLite（标准库 sqlite3），单库 12 表；DDL 唯一权威来源 `create_db.py`（幂等，`--wipe` 重建）

### AI 算法层
- **py-feat 0.6.1**：人脸检测、面部动作单元（AU）激活强度、六类基本情绪概率提取（CPU 推理）
- **scikit-learn 随机森林**：SCL-90 十因子严重程度模型 + 视频主导情绪分类模型，「模型为主、规则兜底」
- **ffmpeg**：系统级安装，CPU 解码 mp4 视频帧

### 大模型层
- **基座**：Qwen2.5-7B-Instruct（bf16 原版，约 15GB）
- **适配器**：`psych-chat`（ai_chat 通用聊天 LoRA，QLoRA 4bit NF4 训练产物）
- **推理框架**：vLLM 0.7.0，OpenAI 兼容 API，端口 **8000**，`--enable-lora --max-loras 1` 热挂载
- **版本配套**：torch 2.5.1 (cu121) / torchvision 0.20.1 / **transformers 4.51.3（固定版本，禁止升到 4.52+）**（vLLM 0.7.0 支持 Python 3.9~3.12；**勿手动升级 torch**，会破坏二进制兼容）
  - transformers 4.52+ 与 vLLM 0.7.0 不兼容，导入即报 `TypeError: argument of type '_ModuleGlob' is not iterable`，故 qwen_env 必须锁 4.51.3

### 存储层
- `/root/autodl-fs`（文件持久盘）：`psydb/psy.db`、`models/*.joblib`、`dataset/`、`uploads/`
- `/root/autodl-tmp`（高速数据盘）：基座模型、LoRA 适配器目录

---

## 🚀 快速开始

### 前置要求

- AutoDL 容器 root 账号；有卡实例 RTX 4090（24GB 显存，bf16 推理 `--gpu-memory-utilization 0.9` 下约占 22GB）；无卡实例仅支持测评 + 视频分析 + 客观指标（AI 部分降级）
- 内存 ≥ 32GB；数据盘 `/root/autodl-tmp` 剩余 ≥ 30GB；miniconda（AutoDL 镜像默认自带）

### 第 1 步：创建双 conda 环境

```bash
# 窗口 1：qwen_env（大模型推理）
conda create -n qwen_env python=3.12 -y
conda activate qwen_env
pip install torch==2.5.1 torchvision==0.20.1 --index-url https://download.pytorch.org/whl/cu121
pip install vllm==0.7.0 safetensors "transformers==4.51.3"
python -c "import torch; print('cuda可用：', torch.cuda.is_available())"   # 预期 True

# 窗口 2：pyfeat_env（后端 + 视频分析）
conda create -n pyfeat_env python=3.11 -y
conda activate pyfeat_env
pip install torch==2.4.1 torchvision==0.19.1 --index-url https://download.pytorch.org/whl/cpu
pip install py-feat==0.6.1 scipy==1.10.1 flask scikit-learn joblib
apt update && apt install ffmpeg -y
python -c "import feat; print('py-feat导入成功')"
```

### 第 2 步：下载基座模型（bf16 原版）

```bash
export HF_ENDPOINT=https://hf-mirror.com
export HF_HUB_DISABLE_XET=1    # hf-mirror 不支持 Xet 协议，禁用后回退传统 HTTP 分片下载
cd /root/autodl-tmp
hf download Qwen/Qwen2.5-7B-Instruct --local-dir Qwen2.5-7B-Instruct
# 新版 hf CLI 无 --resume 参数，默认自动断点续传，中断后直接重跑即可
```

> 模型目录约定：`/root/autodl-tmp/Qwen2.5-7B-Instruct`（基座，`config.MODEL_PATH` 指向此路径）；
> `/root/autodl-tmp/qwen25-7b-lora-ai_chat`（聊天 LoRA 适配器，训练产物，缺失时聊天自动走通用基座）。

### 第 3 步：上传代码并安装 Web 依赖

```bash
# 本地上传（Windows PowerShell，端口与地址以 AutoDL 控制台为准）
scp -P <端口> -r ai-psy root@connect.<region>.autodl.com:~/

# 服务器
conda activate pyfeat_env
cd ~/ai-psy && pip install -r requirements.txt
```

### 第 4 步：初始化数据库与题库

```bash
conda activate pyfeat_env
cd ~/ai-psy
python create_db.py                       # 建 psy.db 12 表（幂等；--wipe 重建全新空库）
cd Qwen-train && python prepare_dataset.py && cd ..   # 生成 static/data/question_bank.json
python -m rf.train_text && python -m rf.train_video   # 训练随机森林（默认 20000 份模拟答卷）
```

### 第 5 步：启动服务（顺序：大模型推理 → 后端）

```bash
# 一键启动（推荐，自动检测 GPU：有卡同时拉起 vLLM + Flask）
bash ~/ai-psy/start_all.sh

# 或手动分步：
# 终端 A：vLLM（bf16 基座 + psych-chat LoRA，与 start_all.sh 等价）
conda activate qwen_env
vllm serve /root/autodl-tmp/Qwen2.5-7B-Instruct \
    --host 0.0.0.0 --port 8000 --gpu-memory-utilization 0.9 \
    --enable-lora --max-loras 1 \
    --lora-modules psych-chat=/root/autodl-tmp/qwen25-7b-lora-ai_chat

# 终端 B：Flask 后端
conda activate pyfeat_env && python app.py
```

### 第 6 步：启动验证

```bash
curl -s http://127.0.0.1:8000/v1/models | python3 -m json.tool | grep '"id"'
# 预期列出基座路径与 psych-chat

curl http://127.0.0.1:8000/v1/chat/completions -H "Content-Type: application/json" \
  -d '{"model": "/root/autodl-tmp/Qwen2.5-7B-Instruct",
       "messages": [{"role": "user", "content": "你好"}]}'
# 能返回回答 JSON 即大模型 API 正常

curl -s http://127.0.0.1:6006/api/config | python3 -m json.tool   # 后端存活
```

浏览器访问 AutoDL 公网映射地址的 6006 端口即可进入登录页。

### 本地无 GPU 开发（mock 模式）

```bash
python app.py --mock    # LLM 与视频分析返回占位数据，页面/计分/数据库全流程可跑
```

---

## 📱 功能模块详解

### 学生端

| 模块 | 页面/接口 | 说明 |
|---|---|---|
| 文本心理测评 | `/test` → `POST /api/test/submit` | 三人群场景化 SCL-90 题库（90 题、1~5 级计分），提交后程序完成总分（90–450）、总均分 GSI、阳性项目数、痛苦指数 PSI、十因子分及常模 Z 分数计算与危机条目阈值判定 |
| 视频面部情绪采集 | `/face` → `POST /api/face/analyze` | 摄像头录制上传，py-feat 输出 AU 激活、六类基本情绪概率、面部活跃度聚合指标与 RF 分类结果；摄像头未开启时画面中央显示占位配图（`/static/picture/face.png`）；报告生成后原始视频即时删除、不入库（详见「隐私保护说明」） |
| 个人报告 | `/student/reports` | 整合版专属测评报告页：文本模块（整体状态结论 + 状态简要说明与具体调整建议）+ 视频模块（面部状态与情绪结论 · 调整方向）同页分模块呈现；左侧历史记录点击同步切换，视频按「该期提交前最近一次检测」配对 |
| AI 聊天助手 | `/chat` → `POST /api/chat` | 多轮心理陪伴对话，psych-chat LoRA 微调风格 + 三人群 system prompt；不做疾病诊断与药物建议，高风险内容引导转介 |
| 咨询预约 | `/appointment` | 查看教师可约时段、提交预约、取消；约满自动拦截 |
| 心理科普 | `/articles` | 系统内置 seed 文章 + 教师发布文章统一按发布时间倒序展示；列表卡片与详情页展示文章来源标签，教师端增删改后刷新即自动同步 |
| 师生倾诉 | `/messages` | 与教师的一对一私密留言会话；本人消息居右带头像、对方消息居左带头像（学生蓝色头像 / 教师绿色头像，圆形，与气泡垂直居中），两端视角一致 |

### 教师端

| 模块 | 说明 |
|---|---|
| 班级测评管理 | 班级学生绑定（`teacher_class`）、全部测评记录总览、按危机信号与总分超阈值标记风险 |
| 学生报告查看 | 点入任一学生 → 整合报告页教师专业视图（KPI 卡、十因子条、情绪趋势、视频专业指标全套呈现） |
| 风险预警 | 危机信号学生置顶提示，提醒结合学校心理工作流程人工核实（系统提示不替代专业危机评估） |
| 预约管理 | 可约时段增删、学生预约审批与状态流转 |
| 心理推文管理 | `/teacher/articles`：新建 / 编辑 / 删除心理科普文章（标题必填、来源与简介选填、正文长文本高度自适应），数据落 `articles` 表，学生端刷新即同步；系统内置 seed 文章只读不可改删 |
| 师生互动 | 倾诉消息收发与回复、活动素材库发布管理 |
| AI 干预建议 | 学生报告详情页「🤖 AI 干预建议」入口 → 独立全屏页 `/teacher/intervention`：`POST /api/ai/intervention` 只读某学生最新 SCL-90 与视频两类数据，生成「简要状态分析（≤200 字）+ 分维度具体干预方案」，不修改学生原报告数据、不归档（原班级报告页弹窗与 `POST /api/ai/analysis` 学生端历史归档能力保留） |

### AI 分析引擎

- **文本量表智能解析**：程序完成全部数值计算后，将结构化计分 JSON 交给大模型按 `REPORT_PROMPT` 解读（详见「🧠 算法与模型说明」）
- **视频表情分析**：py-feat 客观指标 → RF 分类 → `FACE_REPORT_PROMPT` 通俗化解读；教师专业视图保留 AU/情绪概率全套指标，学生端仅呈现状态结论与调整方向
- **个性化报告生成**：三条生成链路参数——报告解读 temperature=0.5 / max_tokens=1536、视频报告 0.5 / 1024、心理陪伴对话 0.7 / 1024
- **调适建议生成**：报告主体为四维度条目化建议（每维度 3-4 条，具体到动作、贴合校园场景），占全文一半以上

---

## ⚙️ 配置说明

全部配置集中在 `ai-psy/config.py`（**无环境变量覆盖机制**，修改后重启 Flask 生效）。

### 大模型服务配置

| 配置项 | 当前值 | 作用 | 修改方法 |
|---|---|---|---|
| `MODEL_PATH` | `{AUTODL_TMP}/Qwen2.5-7B-Instruct`（bf16 原版基座） | 请求体 `model` 字段，必须与 vLLM 启动路径一致 | 换模型时同步改 vLLM 启动命令与基座目录 |
| `VLLM_API_URL` | `http://127.0.0.1:8000/v1/chat/completions` | vLLM OpenAI 兼容接口地址（同机部署） | vLLM 换端口 / 跨机部署时改此值 |
| `LLM_TIMEOUT` | `120`（秒） | 单次大模型请求超时 | 长报告偶发超时可上调（如 180） |
| `CHAT_LORA_DIR` | `{AUTODL_TMP}/qwen25-7b-lora-ai_chat` | 聊天 LoRA 适配器目录 | 换适配器路径时同步改 start_all.sh 的 `LORA_DIR` |
| `LORA_ENABLED` | `os.path.isdir(CHAT_LORA_DIR)` 自动判定 | 聊天是否路由 psych-chat | 强制关闭置 `False`；缺失自动回退通用基座 |
| `CHAT_LORA_NAME` | `psych-chat` | LoRA 注册名，须与 `--lora-modules` 一致 | 两侧同步修改 |
| `MOCK_MODE` | `False`（`--mock` 置 True） | 本地无 GPU 开发占位 | 仅调试用 |
| `SCENARIOS[*].system_prompt` | 小学生 / 中学生 / 大学生三人群 | 聊天与报告的场景化人设 | 直接编辑字符串 |

### 提示词配置（报告内容口径）

| 常量 | 占位符 | 用途 |
|---|---|---|
| `REPORT_PROMPT` | `{scenario_name}` `{result_data}` | SCL-90 文本测评 AI 报告 |
| `FACE_REPORT_PROMPT` | `{metrics_json}` | 视频表情 AI 报告 |
| `ANALYSIS_PROMPT` | `{student_name}` `{scl90_json}` `{face_json}` | AI 综合分析报告 |
| `INTERVENTION_PROMPT` | `{student_name}` `{scl90_json}` `{face_json}` | 教师端 AI 综合干预建议（【状态分析】/【干预方案】固定标记分段） |

### 路径与业务配置

| 配置项 | 值 | 说明 |
|---|---|---|
| `AUTODL_TMP` / `AUTODL_FS` | 真实路径优先，本地模拟目录自动回退 | 模型盘 / 文件盘基准 |
| `PSY_DB` | `{AUTODL_FS}/psydb/psy.db` | 统一业务库（单库 12 表） |
| `RF_MODEL_DIR` | `{AUTODL_FS}/models` | 随机森林 .joblib 产物 |
| `DATASET_DIR` / 上传暂存 | `{AUTODL_FS}/dataset` / `uploads` | 训练素材与视频暂存 |

配置文件示例片段：

```python
MODEL_PATH = os.path.join(AUTODL_TMP, "Qwen2.5-7B-Instruct")
VLLM_API_URL = "http://127.0.0.1:8000/v1/chat/completions"
LLM_TIMEOUT = 120
CHAT_LORA_DIR = os.path.join(AUTODL_TMP, "qwen25-7b-lora-ai_chat")
LORA_ENABLED = os.path.isdir(CHAT_LORA_DIR)
CHAT_LORA_NAME = "psych-chat"
```

---

## 🤖 AI 模块调优指南

> 所有大模型调用统一经由 `llm_client.py`，业务代码不直接访问 vLLM HTTP 接口。
> 模型栈：Qwen2.5-7B-Instruct（bf16 基座）+ vLLM 推理服务 + psych-chat LoRA；训练流程见 [Qwen-train/README.md](Qwen-train/README.md)。

### AI 使用位置（5 个场景）

| # | 场景 | 入口页面 | 后端接口 | 代码位置（函数名） | LoRA |
|---|------|----------|----------|----------|------|
| 1 | AI 聊天助手（心理陪伴多轮对话） | `/chat` | `POST /api/chat` | `app.py` `api_chat` | ✅ `use_chat_lora=True` |
| 2 | 视频人脸分析报告生成 | `/face` | `POST /api/face/analyze` | `app.py` `api_face_analyze` | ❌ 基座 |
| 3 | SCL-90 文本测评 AI 解读 | `/test` 提交 | `POST /api/test/submit` | `app.py` `api_test_submit` | ❌ 基座 |
| 4 | 教师端 AI 干预建议（SCL-90+视频跨模态，按需生成不归档）；旧综合分析接口保留供历史 | `/test/report` 教师视图按钮 → `/teacher/intervention` | `POST /api/ai/intervention`；旧：`POST /api/ai/analysis`、`GET /api/ai/analyses` | `app.py` `api_ai_intervention` | ❌ 基座 |
| 5 | 报告回显（读归档，不调模型） | `/test/report` 等 | `GET /api/teacher/report/<id>` 等 | `app.py` `_load_ai_content` | — |

- 场景 1-3 及旧综合分析正文归档 `ai_analysis_report.ai_content`（关联 text/video_report_id），场景 5 只读最新一份不重复调用；新干预建议页按需实时生成、不改动学生原报告数据
- 聊天按三人群（primary_student / junior_student / college_student）切换 system prompt；教师账号不可使用 `/chat` 与 `/api/chat`（前后端双重拦截）

### 调优入口速查

| 调什么 | 改哪里 | 备注 |
|---|---|---|
| 提示词 | `config.py`：`SCENARIOS[*].system_prompt` / `REPORT_PROMPT` / `FACE_REPORT_PROMPT` / `ANALYSIS_PROMPT` / `INTERVENTION_PROMPT` | 最常用，改后仅重启 Flask；口径要求见「🧠 算法与模型说明」 |
| 生成参数 | `llm_client.py` `chat()` 函数签名默认 `temperature=0.7 / max_tokens=1024`；单场景在 `app.py` 各调用处直接传参覆盖 | 建议：聊天 0.7-0.9（更有温度）、报告解读 0.3-0.5（更稳定专业）；当前线上值见「AI 分析引擎」节 |
| 模型与服务 | `config.py`：`VLLM_API_URL` / `LORA_ENABLED` / `CHAT_LORA_NAME`；vLLM 启动参数在 `start_all.sh` 顶部参数区 | LoRA 改名需两侧同步 |
| 降级文案 | `app.py` 中 `（AI 报告生成失败：…）` 等占位措辞 | — |

### 谨慎改动区（牵一发动全身）

- **`ai_analysis_report` 表结构与归档链路**：`_save_ai_content` / `_load_ai_content` 及前端报告页直接消费 `report` 字段，改表需同步 `create_db.py` 并重建库
- **聊天多轮上下文窗口**：`llm_client.build_messages` 的历史轮数截断逻辑，放大轮数会撑爆 7B 显存/上下文
- **喂给模型的视频指标**：只喂聚合值（主导情绪、均值），不要塞入逐帧 AU 原始数值，prompt 会过长

### 硬性约束（禁止修改）

1. vLLM API 必须使用 **HTTP** 协议（不支持 HTTPS）
2. LoRA 训练前必须 `pkill -f "vllm serve"` 释放显存；训练完成后必须重启 vLLM
3. 教师账号不可访问 `/chat`、`/api/chat`（前后端双重拦截）
4. 所有 API 响应不得包含用户 `id` 字段
5. 无 GPU 实例自动跳过 vLLM，聊天/解读显示占位提示，属预期降级行为

### 修改后的生效方式与验证

```bash
# 改 config.py / app.py / llm_client.py / start_all.sh 参数区：重启整套服务
pkill -f "python app.py"; pkill -f "vllm serve"
bash ~/ai-psy/start_all.sh

# 仅改提示词等 Flask 侧配置：只重启 Flask 亦可
pkill -f "python app.py" && bash ~/ai-psy/start_all.sh

# 验证
curl http://127.0.0.1:8000/v1/models          # vLLM 就绪（预期列出基座与 psych-chat）
curl http://127.0.0.1:6006/api/config         # Flask 就绪
curl -s http://127.0.0.1:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen2.5-7b-instruct","messages":[{"role":"user","content":"你好"}],"max_tokens":64}'
```

前端相关文案改动后浏览器 **Ctrl+F5 强刷**（防旧 JS 缓存）。

---

## 📂 项目目录结构

```
root/
├── ai-psy/                           # 网站主项目（部署到服务器 ~/ai-psy/）
│   ├── app.py                        # Flask 后端（:6006）：全部页面路由 + /api/* 业务接口
│   ├── config.py                     # 全局配置：路径基准 / 端口 / MODEL_PATH / VLLM_API_URL /
│   │                                 #   LLM_TIMEOUT / 聊天 LoRA 开关 / 三人群 system prompt /
│   │                                 #   REPORT_PROMPT / FACE_REPORT_PROMPT / ANALYSIS_PROMPT
│   ├── llm_client.py                 # vLLM OpenAI 兼容客户端：think 标签三层裁剪 +
│   │                                 #   psych-chat LoRA 路由与运行时回退 + mock 模式
│   ├── create_db.py                  # 一键建库（DDL 唯一权威来源，幂等；--wipe 重建空库）
│   │                                 #   注：create_db / article_seed 是 app.py 运行时 import 的模块，非纯脚本
│   ├── article_seed.py               # 心理科普内置 seed 文章（启动时自动对齐 articles 表；教师可另发布新文章）
│   ├── start_all.sh                  # 一键启动：环境校验 + vLLM(bf16+LoRA自动挂载) + Flask（顶部参数区）
│   ├── requirements.txt              # pyfeat_env Web 依赖
│   ├── rf/                           # 随机森林训练与推理（统一文档见 rf/README.md）
│   │   ├── README.md                 #   统一文档：环境/合成数据/参数详解/评估/导出/业务对接/FAQ
│   │   ├── train_rf.sh               #   一键训练：环境校验 + 样本量参数区 + 文本/视频连训 + 产物清单
│   │   ├── train_text.py             #   SCL-90 十因子严重程度模型（默认 20000 份模拟答卷）
│   │   ├── train_video.py            #   视频主导情绪 / 严重程度分类模型
│   │   └── predictor.py              #   推理：惰性加载 .joblib + 特征构造（与训练共用防漂移）+ 规则兜底
│   ├── Qwen-train/                   # 大模型微调工程（统一说明文档见 Qwen-train/README.md）
│   │   ├── README.md                 #   统一文档：环境/数据/快速开始/参数详解/模型合并/部署/FAQ
│   │   ├── config.py                 #   训练配置：基座 / LoRA r=8 α=16 / epoch=3 / max_seq=1024
│   │   ├── prepare_dataset.py        #   题库与 ai_chat 数据集生成（三人群 9:1 切分）
│   │   ├── train_qlora.py            #   QLoRA 训练（bf16 基座 + 4bit NF4；按模块名后缀匹配 target）
│   │   ├── train_all.sh              #   一键微调：环境校验 + 顶部参数区 + 自动腾显存训练
│   │   ├── merge_adapter.py          #   bf16 基座 + adapter 合并导出全量模型（线上默认热挂载、无需合并）
│   │   └── chat_with_lora.py         #   适配器自测（bf16 基座 + adapter 加载）
│   └── static/
│       ├── html/                     # 页面：login / index / profile / report（整合报告页）/
│       │                             #   chat / test / face / appointment / articles /
│       │                             #   messages / 教师端各页
│       ├── css/                      # 每页独立样式 + common.css 通用组件（青色/浅绿设计规范）
│       ├── js/                       # 每页逻辑 + auth.js 登录守卫 + md_render.js 报告排版
│       ├── data/                     # question_bank.json（三人群 × 90 题）
│       └── picture/                  # 页面配图（face.png：录制页摄像头未开启占位图）
│
├── autodl-fs/                        # 文件存储盘（持久，不随系统盘重置）
│   ├── dataset/ai_chat/              #   聊天训练数据（train.jsonl / val.jsonl）
│   ├── psydb/psy.db                  #   统一业务库（12 表）
│   └── models/                       #   scl90_*.joblib ×10 + emotion_rf.joblib + meta.json
│
└── autodl-tmp/                       # 高速数据盘（大模型层文件）
    ├── Qwen2.5-7B-Instruct/          #   bf16 原版基座（vLLM 启动基座）
    └── qwen25-7b-lora-ai_chat/       #   psych-chat 聊天 LoRA 适配器（训练产物）
```

---

## 📦 部署指南

### 生产部署（AutoDL）

1. **代码同步**：本地修改后 scp 上传对应文件（改动 `app.py` / `config.py` / `llm_client.py` / `start_all.sh` 需重启 Flask）：

   ```powershell
   scp -P <端口> "ai-psy/app.py" "ai-psy/config.py" "ai-psy/llm_client.py" "ai-psy/start_all.sh" root@connect.<region>.autodl.com:~/ai-psy/
   ```

2. **进程管理**：

   ```bash
   bash ~/ai-psy/start_all.sh                        # 一键起（已在运行的服务自动跳过）
   pkill -f "python.*app.py"; bash ~/ai-psy/start_all.sh   # 重启 Flask
   kill $(pgrep -f "vllm serve"); bash ~/ai-psy/start_all.sh # 重启 vLLM
   ```

   vLLM 常驻推荐 tmux：`tmux new -s vllm -d '...'`，`tmux attach -t vllm` 查看日志（Ctrl+B D 退出不杀进程）。

3. **端口与访问**：Flask 6006（页面 + API）、vLLM 8000（仅本机调用，**不要**在公网映射开放模型接口的写权限）。AutoDL 实例重启后公网映射端口可能变化，以控制台为准。

4. **上传体积**：视频上传已放开 `max_content_length`（Werkzeug ≥2.3；旧版自动降级 50MB）。

5. **训练与推理互斥**：QLoRA 训练前须停 vLLM 腾显存（`kill $(pgrep -f "vllm serve")`），训练完 `bash start_all.sh` 拉回——忘拉起是聊天/报告 502 的最常见原因。

### 注意事项

- bf16 基座是运行前提：`MODEL_PATH` 固定指向 bf16 目录，基座缺失时 start_all.sh 跳过 vLLM、AI 功能降级显示
- 数据全部落 `autodl-fs` 持久盘；`autodl-tmp` 仅存模型与适配器，系统盘重置不影响业务库
- 无卡降级：无 GPU 实例下测评计分、py-feat 分析、RF 分类、报告页、预约/文章/倾诉全部可用，仅大模型相关输出显示降级提示

---

## 🧠 算法与模型说明

### 随机森林：心理测评数据建模

- **文本侧**：以答卷特征向量 `xⱼ = [s₁, s₂, …, s₁₃, x̄ⱼ] ∈ ℝ¹⁴`（13 个关键条目分 + 该因子均分）训练 **10 个因子严重程度二分类模型**（Gini 准则，`Gini(S) = 1 − Σ pₖ²`），对每个因子输出「需关注」概率辅助分级；训练默认生成 20000 份模拟答卷拟合规则决策边界。
- **视频侧**：特征 `v = [AU_mean(8), AU_max(8), Emotion_mean(6), face_activity] ∈ ℝ²³` 训练主导情绪与严重程度模型。
- **工程约束**：训练与推理共用 `rf/predictor.py` 特征构造函数防顺序漂移；加载时校验 sklearn 版本与文件完整性，任何缺失自动回退规则判定（`source` 字段标记 `rf` / `规则`），优先保证业务连续性。
- **边界**：危机信号判定走独立阈值逻辑，**不依赖**随机森林与大模型输出。

### 大模型微调：psych-chat 聊天 LoRA

- **策略**：QLoRA——bf16 基座以 bitsandbytes 4bit NF4 双重量化加载，仅训练低秩适配器（`W′ = W + B·A`，r=8、α=16、dropout=0.05），冻结基座权重；`target_modules` 按模块名后缀（q/k/v/o/gate/up/down_proj 共 7 个）匹配，规避量化替换 Linear 类导致的 isinstance 失效。
- **数据**：ai_chat 三人群心理陪伴对话 570 条（9:1 切分），Linear + Warmup 学习率调度，3 epoch、等效 batch=8、max_seq=1024，约 282 steps；train_loss 0.209→0.010，eval_loss 0.039。
- **部署**：产物 `qwen25-7b-lora-ai_chat/` 经 vLLM `--enable-lora` 热挂载注册为 `psych-chat`，仅 `/api/chat` 路由适配器；报告生成走通用基座保证客观口径。

### 提示词工程：弱化术语、强化落地建议

学生端报告统一执行「**弱化专业术语、强化落地建议**」输出策略（整体定性结论仍由数据阈值决定，两者口径一致）：

- **REPORT_PROMPT（文本测评）**：角色=「温暖可靠的心理老师」，任务定位是帮学生「知道怎么办」——开头 1 句整体结论；「状态简要说明」1-2 段通俗语言，**全文禁止** SCL-90 因子名称（躯体化/强迫/人际关系敏感/焦虑/抑郁等）、常模、Z 分数等术语，不做成因推导；「具体调整建议」为报告主体（占全文一半以上），按**情绪表达 / 压力调节 / 人际互动 / 日常习惯**四维度、每维度 3-4 条，每条具体到动作、贴合中学生校园场景（如"每天课间和 1 位同学说一句与学习无关的话""晚自习间隙做 3 分钟腹式呼吸"），禁止空泛表述；成长建议口吻、禁诊断式评判；结尾强制 AI 免责声明；总字数 500-900。
- **FACE_REPORT_PROMPT（视频表情）**：**禁止 AU 编号（AU01/AU15 等）、动作单元、活跃度百分比**等术语与数值解读；「状态描述」1-2 句通俗结论；「调整方向」2-3 条具体小方法、与文本报告呼应、不重复罗列问题；200-350 字，结尾免责声明。AU/情绪概率等专业指标仅在教师专业视图呈现。
- **ANALYSIS_PROMPT（综合分析）**：两类数据交叉印证、重点解读异常维度，数据不一致时温和指出；去标签化；500-900 字。
- **输出控制**：`llm_client.strip_think()` 三层兜底裁剪 think 思考块；前端 `md_render.js` 将 Markdown 转为正式文档排版；历史归档按生成当时口径存储、不自动重写。

### 视频表情识别链路

ffmpeg 解码 → py-feat 人脸检测与逐帧 AU 激活强度 / 六类基本情绪概率提取 → 聚合统计（均值/峰值/主导情绪）→ RF 分类 → 大模型通俗化解读。分级指标由表情概率与面部活跃度启发式估算，页面明示「仅供参考、不构成医学诊断」。视频与抽帧图片的全生命周期隐私处理见下节。

---

## 🔒 隐私保护说明

人脸视频属于高敏感生物特征数据，系统按「不落盘、不入库、不留存」原则处理，覆盖从浏览器采集到服务器分析的全链路：

| 环节 | 保护措施 | 代码位置 |
|---|---|---|
| 浏览器录制 | 录制结束立即停止摄像头流（`mediaStream.getTracks().stop()`）；视频交给上传请求后立即释放 JS 侧录制缓冲引用，报告返回后录制内容不再驻留页面内存 | `static/js/face.js` |
| 上传暂存 | 仅按扩展名白名单落盘，文件名用 uuid 随机化（防路径穿越/覆盖），落盘目录 `autodl-fs/uploads/` 不作为持久存储 | `app.py` `/api/face/analyze` |
| 分析完成 | 面部测试报告生成后**立即删除暂存视频**（`finally` 保证：分析失败、大模型报错、归档异常等任何路径都会删除） | `app.py` `api_face_analyze` |
| 抽帧中间产物 | ffmpeg 抽出的逐帧 JPG 写入临时目录，检测完成后 `finally` 整目录删除 | `feat_analyzer.py` |
| 数据库归档 | `video_face_report` 仅存聚合后的 AU 强度 / 情绪概率 JSON 统计与主导情绪文本，**不保存原始视频、人脸图像或任何帧图片** | `app.py` 归档逻辑 |
| 异常残留兜底 | 进程崩溃/强杀可能遗留暂存视频，服务启动时自动清空 `uploads/` 目录残留文件并打印 `[privacy]` 日志 | `app.py` `_cleanup_stale_uploads()` |
| 数据可见范围 | 测评报告、视频检测结果与师生倾诉内容仅本人与所绑定教师可见，接口按 session 角色鉴权 | 各 `/api/student/*`、`/api/teacher/*` 路由 |

**部署注意**：启动清理假设 Flask 为单进程部署（当前 `app.run` 方式）；若改用 gunicorn 多 worker，需将清理策略调整为「仅删除超过一定时长的文件」，避免误删并发请求正在分析的暂存视频（代码注释中已标注此坑点）。

---

## ❓ 常见问题

| 现象 | 原因 | 解决 |
|---|---|---|
| 聊天 / 报告 502、`HTTPConnection refused` | vLLM 被停掉腾显存后忘拉起 | `bash start_all.sh` 恢复 |
| 报告正文「（AI 报告生成失败：…）」 | vLLM 未就绪 / 超时（`LLM_TIMEOUT=120s`）/ 模型路径与启动不一致 | `curl http://127.0.0.1:8000/v1/models` 确认；核对 `config.MODEL_PATH` 与 vLLM 启动路径一致 |
| vLLM 启动报基座缺失 | bf16 目录不存在（已移除量化版回退） | 按「快速开始」第 2 步下载 bf16 基座 |
| 聊天回复残留 think 思考标签 | 思考块未被完全裁剪 | `strip_think()` 已三层兜底；仍异常检查 vLLM 对 Qwen 模板兼容 |
| 学生报告出现 AU 编号 / 因子名 | 旧提示词生成的历史归档 | 重新提交测评/录制即按新口径生成 |
| 随机森林来源为 `规则` 非 `rf` | .joblib 缺失 / sklearn 版本不符 | `python -m rf.train_text && python -m rf.train_video` 重训后重启 |
| 训练报「未识别到任何 Qwen 线性层」 | 量化加载替换 Linear 类，isinstance 失效 | 按模块名后缀匹配（已合入 train_qlora.py） |
| 视频读取 ffmpeg 错误 | 系统未装 ffmpeg | `apt install ffmpeg -y` |
| 页面样式异常 / 改动未生效 | 浏览器缓存 | Ctrl+F5 强刷；静态资源改动无需重启 Flask |
| 公网无法访问 | AutoDL 实例关机 / 映射端口变化 | 控制台确认实例运行状态与最新 6006 映射地址 |

### 使用与安全提示

- AI 内容仅作辅助参考：所有提示词强制「禁止医学诊断结论 + 危机话题转介（老师/家长/心理援助热线）」；危机信号判定走独立阈值，不依赖大模型
- 性能：并发由 vLLM 服务端调度（`--gpu-memory-utilization 0.9`），后端同步调用无额外限流；演示可接受无卡降级
- 隐私：学生测评与倾诉数据仅本人与所任教师可见；人脸视频「不落盘、不入库、不留存」，报告生成后即时删除，全链路措施见「🔒 隐私保护说明」章节

---

## 📝 更新日志

| 版本 | 日期 | 变更 |
|---|---|---|
| v3.2 | 2026-10 | 人脸视频隐私保护强化：面部测试报告生成后暂存视频即时删除（`finally` 全路径兜底）；服务启动自动清理异常终止残留视频（`_cleanup_stale_uploads()`）；前端上传后立即释放录制缓冲引用；新增「🔒 隐私保护说明」章节 |
| v3.1 | 2026-10 | 教师端 AI 综合分析改版：移除班级报告页「AI 综合分析报告」弹窗及触发逻辑，入口迁移至学生报告详情页新增「🤖 AI 干预建议」按钮；跳转独立全屏页 `/teacher/intervention`（顶部返回+标题+全站用户徽章，主体「简要状态分析 ≤200 字 + 分维度具体干预方案」两模块，底部统一免责声明，整页滚动）；新增 `config.INTERVENTION_PROMPT` 与 `POST /api/ai/intervention`（教师专用，只读该生最新文本+视频报告，不修改原数据、不归档）；返回采用 history.back()，详情页滚动位置与状态保持 |
| v3.0 | 2026-10 | 文本链路接入随机森林混合模式（与视频链路一致）：前端提交附带 90 题原始分，`scl90_text_report` 新增 `item_answers` 列并幂等迁移；提交与报告读取时十因子严重程度以 RF 模型为主、Z 分数规则兜底，`严重程度来源` 标记 `rf`/`规则`；旧报告无原始答题自动走规则 |
| v2.9 | 2026-10 | 师生倾诉聊天布局改版：两端统一「本人消息居右带头像、对方消息居左带头像」，圆形头像与气泡垂直居中、附属时间同侧展示，气泡小圆角随左右适配；仅消息展示层样式调整，收发/加载/历史逻辑不变 |
| v2.8 | 2026-10 | 教师端新增心理科普文章管理全功能：个人中心「心理推文」入口 + `/teacher/articles` 管理页（新建/编辑/删除，来源与正文自定义），`articles` 表补 `source`/`author`/`updated_at` 列并幂等迁移；学生端首页与文章页统一读取并展示来源标签，教师增删改后刷新自动同步；内置 seed 文章只读保护 |
| v2.7 | 2026-10 | 移除 MHT 中学生心理健康测评模块（页面、脚本、样式、后端路由），聚焦 SCL-90 + 视频双通道 |
| v2.6 | 2026-10 | 大模型运行链路移除 AWQ 量化版回退，固定 bf16 基座；README 重构为工程化主文档（旧版全文归档） |
| v2.5 | 2026-10 | 报告内容口径调整：弱化专业术语、强化四维度落地建议；录制页占位图；四页面头像移除 |
| v2.4 | 2026-10 | 学生端报告整合：`/student/reports` 与 `/test/report` 统一渲染整合报告页，历史切换文本+视频同步 |
| v2.3 | 2026-09 | QLoRA 训练切换 bf16 基座 + NF4；psych-chat 适配器 vLLM 热挂载；QLoRA 实验图表页与报告配图联动 |
| v2.2 | 2026-09 | 学生端文本/视频报告首轮合并（列表页 + 弹层）；统一 psy.db 单库 12 表 |
| v2.x 以前 | — | 双环境部署、SCL-90 测评、py-feat 视频分析、随机森林、预约/文章/倾诉/素材模块等，逐节迭代记录见 [README-归档-旧版全文.md](README-归档-旧版全文.md) |

---

