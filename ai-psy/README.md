# 芯心向荣 AIC · 校园 AI 心理健康测评系统

> 面向校园场景的 AI 心理测评系统 —— SCL-90 量表 + 视频面部状态双通道采集，
> 以「Flask Agent 编排 + RAG 知识检索 + SSE 流式输出」完成测评解读、心理陪伴与教师干预闭环。

![版本](https://img.shields.io/badge/version-v4.1-informational)
![前端](https://img.shields.io/badge/Next.js-14-black)
![后端](https://img.shields.io/badge/Flask-3.0%20%2B%20SQLAlchemy%202.0-green)
![数据库](https://img.shields.io/badge/PostgreSQL-16%20%2B%20pgvector-blue)
![模型](https://img.shields.io/badge/LLM-Qwen2.5--7B--Instruct%20%7C%20BGE--M3-blueviolet)

---

## 📌 项目简介

校园心理健康工作长期存在三个瓶颈：**普查效率低**、**隐性情绪问题识别滞后**、**专业量表结果难以转译为可执行建议**。

本系统以「双通道采集 + Agent 智能分析」为核心：

1. **文本量表通道**：SCL-90 在线测评（三人群场景化题库），后端完成标准化计分、危机条目判定与随机森林辅助分级；
2. **视频状态通道**：学生录制 10 秒面部视频，经 py-feat 网关提取面部动作单元与情绪概率，形成通俗化状态报告；
3. **Agent 智能层**：Qwen2.5-7B-Instruct（领域微调 + function calling）自主调度 4 个工具，结合 BGE-M3 + pgvector 知识检索生成回答，SSE 流式推送前端；
4. **教师端**：班级测评总览、风险预警、AI 干预建议、咨询预约、师生私密倾诉、科普文章与素材库，形成干预闭环。

---

## 🏗️ 架构说明

### 分层结构

```
┌──────────────────────────────────────────────────────────────┐
│ 前端层  Next.js 14 + React 18 + TypeScript                   │
│   shadcn/ui ｜ TanStack Query ｜ Zustand ｜ ECharts 雷达图      │
│   EventSource ← /api/chat/stream（SSE 打字机）                │
└──────────────────────────┬───────────────────────────────────┘
                           │ HTTP / SSE（Next rewrites 同源代理）
┌──────────────────────────▼───────────────────────────────────┐
│ 后端层  Flask 3 + SQLAlchemy 2.0（server/ 包）                 │
│   api/        鉴权、测评、报告、教师、聊天、预约、私信、素材、    │
│               账号注销                                          │
│   agent.py    手写 Agent 调度循环（非 LangGraph）              │
│   tools.py    rag_search / get_user_report / save_report /    │
│               calculate_score                                │
│   services/   rag_service、face_service、deletion_service（注销  │
│               即时执行）                                         │
└───────┬───────────────────────────────────┬──────────────────┘
        │ SQLAlchemy 2.0                    │ OpenAI 兼容协议
┌───────▼──────────────────────┐  ┌─────────▼───────────────────┐
│ 数据库层 PostgreSQL 16        │  │ AI 推理层                   │
│   pgvector 扩展               │  │  vLLM 主模型 :8000          │
│   业务表 + rag_chunk 向量表    │  │   Qwen2.5-7B-Instruct       │
│   pg_dump 可整库备份           │  │  + psych-chat LoRA          │
└──────────────────────────────┘  │  独立嵌入服务 :8001 BGE-M3   │
                                   └─────────────────────────────┘
```

### 数据流（一次 AI 对话）

```
前端 EventSource
  → GET /api/chat/stream?scenario&content&history
  → Agent 决策轮（Qwen2.5 非流式，自主决定是否调用工具）
      ├─ rag_search：文本 → BGE-M3 embed → pgvector 余弦检索 → 返回片段
      ├─ get_user_report / save_report / calculate_score：SQLAlchemy 读写 PostgreSQL
      └─ 工具结果回填 messages，进入下一轮
  → 最终回答 Qwen2.5 流式生成
  → SSE：meta / tool_call / tool_result / delta / done
  → 前端逐字渲染；测评分数交给 ECharts 雷达图/柱状图
```

### 关键设计约束

- **RAG 与 Agent 是流程，不是模型**；BGE-M3（向量化）与 Qwen2.5（生成）是两个独立服务，分别调用、互不混用；
- **Agent 循环手写**：决策轮 + 工具执行 + 结果回填，最多 `AGENT_MAX_TOOL_ROUNDS`（默认 4）轮，便于答辩讲解；
- **模型权重不进镜像**：Qwen2.5 / BGE-M3 权重置于宿主机 `models/`，以只读 volume 挂载；
- **远程备选**：`LLM_PROVIDER=remote` 可整体切换到任意 OpenAI 兼容 API，便于无 GPU 演示；
- **接口契约不变**：所有 `/api/*` 路径、请求/响应字段与旧版保持一致，前端已统一类型定义。

---

## 🛠️ 技术栈

| 层 | 组件 |
|---|---|
| 前端 | Next.js 14（App Router）、React 18、TypeScript、Tailwind CSS、shadcn/ui 风格组件、TanStack Query v5、Zustand、ECharts 5 |
| 后端 | Python 3.11、Flask 3、SQLAlchemy 2.0、Flask-SQLAlchemy、psycopg3、pgvector |
| 数据库 | PostgreSQL 16 + pgvector（业务数据与向量同库，HNSW 余弦索引） |
| 推理 | vLLM 0.7.0；主 LLM：Qwen2.5-7B-Instruct（支持 function calling）；嵌入：BGE-M3（1024 维） |
| 算法 | scikit-learn 随机森林（因子严重程度 / 视频主导情绪，模型为主、规则兜底）、py-feat 表情分析网关 |
| 部署 | 服务器进程直启（PostgreSQL + vLLM + BGE-M3 嵌入服务 + Flask + Next），模型权重放宿主机 |

---

## 📂 目录结构

```
ai-psy/
├── server/                      # 新后端（Flask 应用工厂 + SQLAlchemy 2.0）
│   ├── __init__.py              # create_app：注册蓝图、建表、健康检查、CLI
│   ├── config.py                # 环境变量配置（DB / vLLM / 嵌入 / RAG / Agent）
│   ├── extensions.py            # db = SQLAlchemy()
│   ├── models.py                # 12 张业务表 + rag_chunk(pgvector)
│   ├── security.py              # PBKDF2、session、角色守卫、ID 生成
│   ├── scoring.py               # SCL-90 计分 + 常模分级 + RF 混合分级
│   ├── prompt.py                # 三人群提示词、报告/干预/Agent 提示词
│   ├── llm.py                   # OpenAI 兼容客户端（vLLM / 远程 / mock）
│   ├── embedding.py             # BGE-M3 嵌入客户端（独立模型）
│   ├── sse.py                   # SSE 事件封装
│   ├── agent.py                 # 手写 Agent 调度循环
│   ├── tools.py                 # 4 个工具函数 + OpenAI function schema
│   ├── api/                     # 蓝图：auth / config / test / report / teacher
│   │                            #       chat / article / appointment / message
│   │                            #       material / face / account(注销)
│   └── services/
│       ├── rag_service.py       # 切条、索引、pgvector 检索、全量重建
│       ├── knowledge_seed.py    # 内置科普/危机指引知识条目
│       ├── face_service.py      # py-feat 网关调用（mock 兜底）
│       ├── deletion_service.py  # 账号注销：冷静期/撤销/到期执行/扫描线程
│       └── article_seed.py      # 文章种子数据
├── web/                         # Next.js 前端（AIC 2026 浅蓝+青绿玻璃拟态设计体系）
│   ├── app/                     # 23 个路由页面（学生端 / 教师端 / 注册结果页）
│   ├── components/ui/           # shadcn 风格基础组件
│   ├── components/business/     # AppShell、AuthGuard、ECharts、报告面板等
│   ├── lib/                     # api.ts、types.ts、scoring.ts、question-bank.ts
│   ├── store/use-auth-store.ts  # Zustand 登录态
│   └── public/data/             # 三人群 SCL-90 题库 JSON
├── deploy/
│   └── backup.sh                # pg_dump 全库备份（含向量）
├── start_all.sh                 # 一键 start/stop/restart/status/init：PG→模型→嵌入→网关→后端→前端
├── run_server.py                # Flask 启动入口（默认 :6006；start_all.sh 以 6007 启动、前端占 6006）
├── requirements.txt
├── .env.example
├── rf/                          # 随机森林：训练脚本、推理封装、规则兜底
└── Qwen-train/                  # Qwen2.5-7B QLoRA 微调：数据集准备、训练、合并、对话验证
```

---

## 🔌 核心接口清单

> 全部接口均为 `/api/*`，除登录/注册外要求登录态（Cookie session）；教师/学生角色由后端守卫。

### 鉴权与配置

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/auth/register` | 注册：**手机号 + 密码**（手机号大陆 11 位，学生/教师全局唯一）；入参 `phone + password + confirm_password`；系统仍自动分配账号作备用登录（8 位纯数字，`ACCOUNT_PREFIX`/`ACCOUNT_DIGITS` 可配）；返回 `{ok, account, phone, user_id, user}` |
| POST | `/api/auth/login` | 登录，入参 `identifier`（手机号或系统账号）/兼容旧字段 `account` + `password`，返回 `{ok, user}`；已注销账号返回 403 |
| POST | `/api/auth/logout` | 退出登录 |
| GET | `/api/auth/me` | 当前登录用户 |
| GET/POST | `/api/auth/profile`、`/api/auth/profile/update` | 个人资料查询/更新 |
| GET | `/api/config` | 三人群场景配置 |
| GET | `/api/health` | 健康检查 |

### 账号注销（即时永久模式，学生/教师通用）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/account/deletion/eligibility` | 注销准入校验，逐条返回阻断原因与处理路径（学生：未完成预约；教师：待审批预约/开放时段） |
| POST | `/api/account/deletion/immediate` | 即时永久注销：入参 `{password, confirm_text}`，指定确认文案全等 + 密码双重校验通过后**立即执行**；无冷静期、不可撤销 |

执行逻辑（单事务，任一步失败整体回滚）：交互数据物理删除；测评报告去标识化留存（心理档案合规）；教师公共素材保留并匿名化创建者、班级关联解除、进行中预约自动取消；账号锁定 + 注销流水号 + IP/校验方式审计留痕。条件更新命中 1 行才执行清除，重复调用幂等。

### 测评与报告

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/test/submit` | 提交 90 题答案，计分 + AI 解读 + 归档 |
| GET | `/api/student/reports` | 学生文字测评列表 |
| GET/DELETE | `/api/student/report/<id>` | 报告详情 / 删除 |
| GET | `/api/face/reports` | 视频状态报告列表 |
| GET/DELETE | `/api/face/report/<id>` | 视频报告详情 / 删除 |
| GET | `/api/ai/analyses` | AI 综合分析历史 |
| POST | `/api/ai/analysis` | 文本+视频联合分析 |
| POST | `/api/ai/intervention` | 面向班主任的干预建议 |

### Agent 对话与 RAG

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/chat/stream?scenario=&content=&history=` | **SSE**（EventSource 专用），事件 `meta/tool_call/tool_result/delta/done/error` |
| POST | `/api/chat/stream` | **SSE**（fetch 流式客户端） |
| POST | `/api/chat` | 兼容旧契约，一次性返回 `{reply}` |
| POST | `/api/teacher/...` | 教师端管理接口（见下） |

### 业务管理

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/teacher/classes`、`/api/teacher/reports` | 班级列表 / 班级报告 |
| GET | `/api/teacher/report/<id>`、`/api/teacher/student/<sid>/face-reports` | 报告详情 / 学生视频报告 |
| GET/POST/PUT/DELETE | `/api/teacher/articles`、`/api/teacher/articles/<id>` | 科普文章 CRUD（写后自动重建 RAG 索引） |
| GET/POST | `/api/articles`、`/api/articles/<id>` | 学生端文章列表/详情 |
| GET/POST/DELETE | `/api/student/appointment/*` | 时段查询、预约、取消 |
| GET/POST/PUT/DELETE | `/api/teacher/appointment/*`、`/api/teacher/appointments` | 时段管理、预约审批（confirm/reject/complete） |
| GET/POST | `/api/student/msg/*`、`/api/teacher/msg/*`、`/api/msg/unread` | 师生私信与会话 |
| GET/POST | `/api/teacher/materials*` | 素材列表、详情、下载、上传 |
| POST | `/api/face/analyze` | 视频面部状态分析（multipart，分析后删除源文件） |

---

## 🗄️ 数据库表结构

PostgreSQL 16，启动时自动 `CREATE EXTENSION vector` 并 `db.create_all()`。

| 表 | 主键 | 关键字段 |
|---|---|---|
| `teacher` | teacher_id | name、class、job_number、account、password、login_timestamp、**account_status**（active/deleted）、deleted_at、delete_serial、delete_reason |
| `teacher_class` | seq_id | teacher_id、class_id（多班级关联） |
| `student` | student_id | name、class、student_no、account、password、latest_text_report_id、latest_video_report_id、**account_status**（active/deleted）、deleted_at、delete_serial、delete_reason |
| `scl90_text_report` | seq_id / report_id | student_id、crowd_tag、total_score、pos_item_count、risk_signal、10 因子列、gsi、psdi、item_answers |
| `video_face_report` | seq_id / video_report_id | student_id、au_json、emotion_json、landmark_json、prominent_dimension |
| `ai_analysis_report` | seq_id | student_no、student_class、text_report_id、video_report_id、ai_content |
| `counseling_slots` | id | teacher_id、date、time_slot、max_capacity、current_count、status |
| `appointments` | id | slot_id、student_id、teacher_id、reason、status、reply、teacher_time |
| `articles` | id | title、summary、content、source、author、is_active |
| `activity_material` | material_id | title、category、brief、file_blob(BYTEA)、file_name、uploader |
| `conversation` | id | student_id、teacher_id、updated_timestamp（唯一 pair） |
| `message` | id | conversation_id、sender_id、sender_role、content、is_read |
| `rag_chunk` | id | source_type、source_id、title、chunk_index、content、**embedding vector(1024)**（HNSW 余弦索引） |
| `account_deletion_request` | seq_id | user_id、role、status(completed 审计流水)、requested_at、completed_at、**deletion_serial**（注销流水号）、ip、verify_method |

---

## 🚀 快速开始

### 方式一：一键脚本（当前推荐）

```bash
cd ai-psy
cp .env.example .env                  # 至少确认 DATABASE_URL 与模型服务地址
chmod +x start_all.sh                 # 仅首次：Windows 上传后丢了可执行位
sed -i 's/\r$//' start_all.sh         # 仅首次：转掉 CRLF 换行

./start_all.sh start                  # PG → vLLM(8000) → BGE-M3(8001) → 网关(8002) → Flask(6007) → Next(6006)
./start_all.sh init                   # 首次部署：建表 + 重建 RAG 索引（需先 start）
./start_all.sh status                 # 端口 / PID / 监听状态
./start_all.sh stop                   # 停止全部（PostgreSQL 保留）
```

- 端口：默认前端 **6006**、后端 **6007**。AutoDL「自定义服务」只映射 6006，前端必须占此端口，故后端让位；全部可用环境变量覆盖，如 `API_PORT=6006 WEB_PORT=3000 ./start_all.sh start`。
- 日志：`ai-psy/logs/{llm,embed,gateway,api,web}.log`，PID 在同目录 `*.pid`；`tail -f logs/*.log` 排查。
- 脚本已内建规避：`ss` 缺失改用 socket 探活、`next` 可执行位丢失改用 `node` 直调、`BACKEND_URL` 变更后自动重建前端。

访问 <http://localhost:6006>（或 AutoDL 自定义服务地址）；后端健康检查 <http://127.0.0.1:6007/api/health>。

### 方式一·手工分解（答辩讲解用）

需要逐个进程演示时，每个服务各开一个终端：

| 服务 | 命令 |
|---|---|
| PostgreSQL | `pg_ctlcluster 16 main start` |
| vLLM 主模型 | `conda activate qwen_env && vllm serve /root/autodl-tmp/Qwen2.5-7B-Instruct --port 8000 --served-model-name Qwen2.5-7B-Instruct --gpu-memory-utilization 0.85 --enable-lora --lora-modules psych-chat=/root/autodl-tmp/qwen25-7b-lora-ai_chat` |
| BGE-M3 | `vllm serve BAAI/bge-m3 --task embed --port 8001 --gpu-memory-utilization 0.1` |
| py-feat 网关 | `conda activate pyfeat_env && cd ai-psy && python pyfeat_gateway.py` |
| Flask 后端 | `conda activate pyfeat_env && cd ai-psy && PORT=6007 python run_server.py` |
| Next 前端 | `conda activate web_env && cd ai-psy/web && BACKEND_URL=http://127.0.0.1:6007 node node_modules/next/dist/bin/next build && BACKEND_URL=http://127.0.0.1:6007 node node_modules/next/dist/bin/next start -p 6006` |

未部署 LoRA 时去掉 `--enable-lora --lora-modules ...`；嵌入服务不可用时后端自动回退本地确定性向量（不阻断启动，检索质量下降）。`BACKEND_URL` 在 `next build` 时固化进产物，改了后端端口必须重新 build。

### 方式二：本地开发（无 GPU，mock 模式）

```bash
# 后端
python -m venv .venv && . .venv/Scripts/activate      # Windows
pip install -r requirements.txt
export LLM_PROVIDER=mock            # PowerShell: $env:LLM_PROVIDER="mock"
export DATABASE_URL=postgresql+psycopg://psy:psy@127.0.0.1:5432/psy
python run_server.py                # :6006

# 前端
cd web && npm install && npm run dev # :3000
```

首次索引知识库：

```bash
flask --app server reindex-rag
```

### 全库备份（业务数据 + 向量）

```bash
cd deploy && ./backup.sh           # 输出 backups/psy_*.dump
PGPASSWORD=psy pg_restore -h 127.0.0.1 -U psy -d psy --clean --if-exists < backups/psy_xxx.dump
```

---

## ⚙️ 配置说明（.env）

| 变量 | 默认 | 说明 |
|---|---|---|
| `DATABASE_URL` | `postgresql+psycopg://psy:psy@127.0.0.1:5432/psy` | 数据库连接 |
| `LLM_PROVIDER` | `vllm` | `vllm` / `remote` / `mock` |
| `VLLM_BASE_URL` / `LLM_MODEL` / `LLM_LORA_NAME` | `http://127.0.0.1:8000/v1` / `Qwen2.5-7B-Instruct` / `psych-chat` | 主模型 |
| `REMOTE_BASE_URL` / `REMOTE_API_KEY` / `REMOTE_MODEL` | — | 远程 OpenAI 兼容备选 |
| `EMBEDDING_BASE_URL` / `EMBEDDING_MODEL` / `EMBEDDING_DIM` | `http://127.0.0.1:8001/v1` / `BGE-M3` / `1024` | 嵌入模型（独立） |
| `RAG_TOP_K` / `RAG_CHUNK_SIZE` / `RAG_CHUNK_OVERLAP` | `3` / `400` / `60` | 检索与切条参数 |
| `AGENT_MAX_TOOL_ROUNDS` | `4` | Agent 最大工具轮次 |
| `PYFEAT_GATEWAY_URL` | `http://127.0.0.1:8002` | 视频表情分析网关 |
| `UPLOAD_DIR` | `/data/uploads` | 视频临时目录（分析后立即删除） |
| `ACCOUNT_PREFIX` / `ACCOUNT_DIGITS` | 空 / `8` | 注册自动分配账号的前缀与位数 |
| `MATERIAL_AI_DAILY_LIMIT` / `MATERIAL_AI_WORKER` | `30` / `1` | 素材 AI 单日生成上限 / 生成工作线程开关 |

---

## 🧠 Agent 与 RAG 说明

| 工具 | 作用 | 依赖 |
|---|---|---|
| `rag_search(query, top_k)` | 知识库向量检索 | BGE-M3 + pgvector |
| `get_user_report()` | 查询当前用户最新测评 / 视频 / AI 报告摘要 | SQLAlchemy |
| `save_report(report_type, content, ...)` | 保存 AI 生成报告 | SQLAlchemy |
| `calculate_score(answers)` | SCL-90 计分 + 危机判定 + RF 分级 | scoring.py |

- 决策轮采用**非流式** function calling，确定工具调用后执行并回填；
- 最终回答采用**流式**生成，通过 SSE `delta` 事件逐字下发；
- 工具调用过程以 `tool_call` / `tool_result` 事件暴露给前端，便于展示「正在检索知识库」状态；
- RAG 数据来源：科普文章（增删改自动重建索引）+ 内置危机指引知识条目。

---

## 🔒 隐私与安全

- 视频仅用于瞬时分析，落盘后分析结束 `finally` 删除；数据库只存聚合指标与生成报告；
- AI 报告与对话均附「仅供参考、不能替代专业诊断」免责声明，出现危机条目时展示援助热线；
- 学生数据仅本人与所任班级教师可见；所有接口服务端校验角色与会话归属；
- **账号注销合规**：即时永久注销（确认文案+密码双重校验，无冷静期、不可撤销）；交互数据删除，测评报告去标识化留存（校园心理档案要求），注销流水号 + IP + 校验方式可审计；

---

## 📝 更新日志

### v4.1（合规与功能增强）

- **注册/登录规则**：注册使用「手机号 + 密码」（手机号大陆 11 位、学生/教师全局唯一），系统自动分配账号保留为备用登录；登录支持手机号或系统账号 + 密码，存量无手机号账号仍可登录；手机号为登录凭据，个人中心只读；密码 6-20 位复杂度前后端双重校验、两次输入确认、掩码独立显隐；注册成功跳转独立结果页展示手机号并支持复制；
- **账号注销（即时永久模式）**：准入校验（逐条阻断原因+处理路径）→ 风险告知勾选 → 指定确认文案 + 密码双重校验 → 立即执行永久注销；无冷静期、不可撤销；学生端入口在个人中心、教师端入口在工作台页底，共用同一组件；注销含数据分级处理（交互数据删除 / 报告去标识化留存 / 教师素材匿名化保留 / 班级关联解除）与 IP、流水号审计留痕；
- **前端视觉体系**：对齐 AIC 2026 设计基座（浅蓝+青绿+淡金、玻璃拟态卡片、渐变胶囊按钮、SSE 打字机与工具调用可视化统一风格）；
- 答题页对齐旧版交互：一题一页、选中自动跳题、提交定位未答题；报告页两栏布局与因子横条。

### v4.0（架构重构）

- 前端由原生 HTML/JS 重写为 Next.js 14 + TypeScript + shadcn/ui + TanStack Query + Zustand + ECharts，接入 SSE 打字机对话；
- 后端由单文件 Flask + SQLite 重构为 Flask 应用工厂 + SQLAlchemy 2.0 分层包（api / services / tools / agent）；
- 数据库迁移至 PostgreSQL 16 + pgvector，新增 `rag_chunk` 向量表与 HNSW 索引，支持 `pg_dump` 整库备份；
- 新增手写 Agent 调度循环与 4 个工具，新增 BGE-M3 独立嵌入服务与 RAG 检索；
- 部署改为服务器进程直启（PostgreSQL + vLLM + 嵌入服务 + Flask + Next），暂不提供容器编排，模型权重放宿主机，支持远程 OpenAI 兼容 API 备选。

### v3.1（历史版本）

- SCL-90 双通道测评、py-feat 视频分析、随机森林分级、教师端完整业务闭环（旧版单文件实现已在 v4.0 中移除，业务逻辑已迁移至 `server/` 分层实现）。
