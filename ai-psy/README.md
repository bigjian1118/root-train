# 心晴 · 校园 AI 心理健康测评系统

![版本](https://img.shields.io/badge/version-v4.1-informational)
![前端](https://img.shields.io/badge/Next.js-14-black)
![后端](https://img.shields.io/badge/Flask-3.0%20%2B%20SQLAlchemy%202.0-green)
![数据库](https://img.shields.io/badge/PostgreSQL-16%20%2B%20pgvector-blue)
![模型](https://img.shields.io/badge/LLM-Qwen2.5--7B--Instruct%20%7C%20BGE--M3-blueviolet)

---

## 一、项目介绍

### 1.1 项目背景

校园心理健康工作长期存在三个瓶颈：

1. **普查效率低**——传统纸笔量表统计慢、易漏答、易造假；
2. **隐性情绪问题识别滞后**——只看问卷答了什么，看不到学生当下真实状态；
3. **量表结果难以转化**——专业分数躺在表格里，学生看不懂，教师拿不出可执行的干预动作。

### 1.2 项目定位

「心晴」是一套面向高校和中小学的 **AI 心理健康测评与干预平台**，围绕「测评—发现—解读—干预」构建完整闭环，服务学生与教师两类用户。核心理念：**测评和视频双通道采集，AI 完成解读与陪伴，最终落到教师的干预动作上**。

### 1.3 核心功能

**学生端：**

| 功能 | 说明 |
|---|---|
| 心理测评 | 标准 SCL-90 量表，按小学生/中学生/大学生三套场景化题干呈现；**90 题全量必答**，漏答自动拦截定位，无默认分值；报告异步生成，九因子雷达图 + AI 通俗解读 |
| 视频状态检测 | 对摄像头录制 5 秒面部视频，分析表情特征判断当下更接近平静/低落/紧张/愉悦；只分析表情、不识别身份，与文字测评互相印证 |
| AI 心语助手 | 选择学段场景后自然语言倾诉，回答**逐字流式输出**；结合个人测评报告与校内知识库给出针对性建议并列出引用来源；识别危机表达时优先给出求助与转介提示 |
| 我的报告 | 历次文本报告、视频报告与 AI 综合报告，阅读状态与教师端同步 |
| 心理咨询预约 | 选择老师与时段发起预约，教师审批 |
| 私密倾诉 | 匿名选择信任的老师一对一文字倾诉 |

**教师端：**

| 功能 | 说明 |
|---|---|
| 班级看板 | 正常/需关注/重点三档分布 + 各因子班级均分 |
| 学生详情 | 雷达图、因子得分、危机条目标记、报告已读状态（教师打开即已读，学生端红点同步清除） |
| AI 综合干预建议 | 一键结合文本与视频双通道结果，生成「状态分析 + 干预做法」两段式建议 |
| 活动素材库 | 上传素材后 AI 参考校内存量素材生成完整活动方案，支持导出 Word |
| 科普文章发布 | 文章进入知识库供学生阅读，并被 AI 助手检索引用 |
| 预约审批与倾诉回复 | 时段管理、预约审批、私信会话 |

### 1.4 项目亮点

1. **双通道印证**：文字量表反映学生「怎么说」，5 秒视频反映「当下状态」，互相印证；
2. **测评真实可信**：90 题全量必答、漏答拦截、无默认分值，杜绝「半截问卷出报告」；
3. **AI 真正落地**：大模型经 QLoRA 领域微调，正式部署运行在校内服务器，学生数据不出校园；回答可溯源、遇危机主动兜底；
4. **学生端与教师端打通**：测评结果直接转化为教师的干预动作，形成完整闭环；
5. **覆盖日常心理工作全流程**：预约、私密倾诉、科普文章等高频场景全部在线；
6. **体验细节**：SSE 逐字流式回答、报告异步生成不卡页面、已读状态实时同步。

---

## 二、技术架构

### 2.1 分层结构

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
│   services/   rag_service、face_service、deletion_service      │
└───────┬───────────────────────────────────┬──────────────────┘
        │ SQLAlchemy 2.0                    │ OpenAI 兼容协议
┌───────▼──────────────────────┐  ┌─────────▼───────────────────┐
│ 数据库层 PostgreSQL 16        │  │ AI 推理层                   │
│   pgvector 扩展               │  │  vLLM 主模型 :8000          │
│   业务表 + rag_chunk 向量表    │  │   Qwen2.5-7B-Instruct       │
│   pg_dump 可整库备份           │  │   + psych-chat LoRA          │
└──────────────────────────────┘  │  独立嵌入服务 :8001 BGE-M3   │
                                  │  py-feat 网关 :8002          │
                                  └─────────────────────────────┘
```

### 2.2 数据流（一次 AI 对话）

```
前端 EventSource
  → GET /api/chat/stream?scenario&content&history
  → Agent 决策轮（Qwen2.5 流式 function calling，自主决定是否调用工具）
      ├─ rag_search：文本 → BGE-M3 embed → pgvector 余弦检索 → 返回片段
      ├─ get_user_report / save_report / calculate_score：SQLAlchemy 读写 PostgreSQL
      └─ 工具结果回填 messages，进入下一轮（最多 4 轮）
  → 最终回答流式生成，SSE 事件：meta / tool_call / tool_result / delta / done
  → 前端逐字渲染；测评分数交给 ECharts 雷达图/柱状图
```

### 2.3 技术栈

| 层 | 组件 |
|---|---|
| 前端 | Next.js 14（App Router）、React 18、TypeScript、Tailwind CSS、shadcn/ui 风格组件、TanStack Query v5、Zustand、ECharts 5 |
| 后端 | Python 3.11、Flask 3、SQLAlchemy 2.0、Flask-SQLAlchemy、psycopg3、pgvector |
| 数据库 | PostgreSQL 16 + pgvector（业务数据与向量同库，HNSW 余弦索引） |
| 推理 | vLLM 0.7.0；主 LLM：Qwen2.5-7B-Instruct + psych-chat QLoRA 适配器（支持 function calling）；嵌入：BGE-M3（1024 维，独立服务） |
| 算法 | scikit-learn 随机森林（因子严重程度 / 视频主导情绪，模型为主、规则兜底）、py-feat 表情分析网关 |
| 微调 | Qwen-train：QLoRA（4bit 量化 + LoRA）监督微调，含数据准备、训练、合并、对话验证全流程脚本 |
| 部署 | 服务器进程直启（PostgreSQL + vLLM + BGE-M3 + 网关 + Flask + Next），模型权重放宿主机 |

### 2.4 关键设计约束

- **RAG 与 Agent 是流程，不是模型**：BGE-M3（向量化）与 Qwen2.5（生成）是两个独立服务，分别调用、互不混用；
- **Agent 循环手写**：决策轮 + 工具执行 + 结果回填，最多 `AGENT_MAX_TOOL_ROUNDS`（默认 4）轮，便于答辩讲解；
- **计分确定性**：SCL-90 分数全部由固定规则计算（`scoring.py`），AI 只负责解读，不影响分数；
- **模型权重不进镜像**：Qwen2.5 / BGE-M3 权重置于宿主机，以只读方式挂载；
- **远程备选**：`LLM_PROVIDER=remote` 可整体切换到任意 OpenAI 兼容 API，便于无 GPU 演示；
- **接口契约不变**：所有 `/api/*` 路径、请求/响应字段与旧版保持一致，前端已统一类型定义。

### 2.5 目录结构

```
ai-psy/
├── server/                      # 后端（Flask 应用工厂 + SQLAlchemy 2.0）
│   ├── __init__.py              # create_app：注册蓝图、建表、增量迁移、健康检查、CLI
│   ├── config.py                # 环境变量配置（DB / vLLM / 嵌入 / RAG / Agent）
│   ├── extensions.py            # db = SQLAlchemy()
│   ├── models.py                # 业务表 + rag_chunk(pgvector)
│   ├── security.py              # PBKDF2、session、角色守卫、ID 生成
│   ├── scoring.py               # SCL-90 计分 + 常模分级 + RF 混合分级
│   ├── prompt.py                # 三人群提示词、报告/干预/Agent 提示词
│   ├── llm.py                   # OpenAI 兼容客户端（流式/非流式，vLLM / 远程 / mock）
│   ├── embedding.py             # BGE-M3 嵌入客户端（独立模型）
│   ├── sse.py                   # SSE 事件封装
│   ├── agent.py                 # 手写 Agent 调度循环（流式决策轮）
│   ├── tools.py                 # 4 个工具函数 + OpenAI function schema
│   ├── ratelimit.py             # 接口限流
│   ├── api/                     # 蓝图：auth / config / test / report / teacher
│   │                            #       chat / article / appointment / message
│   │                            #       material / face / account(注销)
│   └── services/
│       ├── rag_service.py       # 切条、索引、pgvector 检索、全量重建
│       ├── knowledge_seed.py    # 内置科普/危机指引知识条目
│       ├── face_service.py      # py-feat 网关调用（mock 兜底）
│       ├── deletion_service.py  # 账号注销：准入校验/即时执行/审计留痕
│       ├── analysis_tasks.py    # AI 综合分析异步任务（状态机 + 幂等）
│       ├── report_tasks.py      # 报告 AI 解读异步任务
│       ├── material_ai_service.py # 素材活动方案生成（异步 + 幂等）
│       └── article_seed.py      # 文章种子数据
├── web/                         # Next.js 前端（浅蓝+青绿玻璃拟态设计体系）
│   ├── app/                     # 路由页面（学生端 / 教师端 / 注册结果页）
│   ├── components/ui/           # shadcn 风格基础组件
│   ├── components/business/     # AppShell、AuthGuard、ECharts、报告面板等
│   ├── lib/                     # api.ts、types.ts、scoring.ts、question-bank.ts
│   ├── store/use-auth-store.ts  # Zustand 登录态
│   └── public/data/             # 三人群 SCL-90 题库 JSON
├── deploy/backup.sh             # pg_dump 全库备份（含向量）
├── start_all.sh                 # 一键 start/stop/restart/status/init
├── run_server.py                # Flask 启动入口
├── embed_service.py             # 本地 BGE-M3 向量服务
├── pyfeat_gateway.py            # py-feat 视频特征网关
├── seed_test_data.py            # 演示测试数据种子
├── requirements.txt / .env.example
├── rf/                          # 随机森林：训练脚本、推理封装、规则兜底
├── Qwen-train/                  # Qwen2.5-7B QLoRA 微调全流程
└── logs/                        # 服务日志（llm/embed/gateway/api/web/pg）
```

---

## 三、安装运行指南

### 3.1 环境要求

| 项 | 要求 |
|---|---|
| 操作系统 | Linux（推荐，云服务器）或 Windows（开发用） |
| Python | 3.11（**不支持 3.13+**，依赖 scikit-learn 1.5.2） |
| Node.js | 18+（前端构建与运行） |
| 数据库 | PostgreSQL 16（需启用 `vector` 扩展） |
| GPU（可选） | 正式部署跑本地 vLLM 需 GPU；无 GPU 时用 `LLM_PROVIDER=mock/remote` |

### 3.2 方式：环境初始化脚本（服务器首次部署）

项目同级目录 `env-deployment/` 提供两个幂等初始化脚本，首次部署建议先执行：

```bash
# 1) 后端 + 视频分析环境：conda 环境(pyfeat_env, Python 3.11)
#    + CPU torch / py-feat / requirements.txt / ffmpeg
#    + py-feat 离线权重预置 + 建库 / 生成题库 / 训练随机森林
bash ../env-deployment/setup_pyfeat_env.sh all

# 2) 推理环境：conda 环境(qwen_env, Python 3.12)
#    + vLLM 0.7.0 / QLoRA 训练依赖 + 下载 Qwen2.5-7B-Instruct 基座(约 15GB)
bash ../env-deployment/setup_qwen_env.sh all
```

- 两脚本均**幂等**：环境已存在、依赖已装、权重已就位时自动跳过，重复运行安全；
- 支持按阶段执行：`setup_pyfeat_env.sh env|feat|init`（环境/权重/初始化），`setup_qwen_env.sh env|model`（环境/基座下载）；
- 可覆盖变量：`PROJ`（项目路径，默认 `$HOME/ai-psy`）、`PIP_MIRROR`（pip 镜像源）；
- 权重下载失败可重跑续传；全部就绪后按 3.3 启动服务。

### 3.3 方式：一键启动服务

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

- **端口**：默认前端 **6006**、后端 **6007**（反向代理通常只映射 6006，前端须占此端口）；可用环境变量覆盖，如 `API_PORT=6006 WEB_PORT=3000 ./start_all.sh start`。
- **日志**：`logs/{llm,embed,gateway,api,web}.log`，PID 在同目录 `*.pid`；`tail -f logs/*.log` 排查。
- 访问 <http://localhost:6006>；后端健康检查 <http://127.0.0.1:6007/api/health>。



### 3.4 配置说明（.env）

| 变量 | 默认 | 说明 |
|---|---|---|
| `DATABASE_URL` | `postgresql+psycopg://psy:psy@127.0.0.1:5432/psy` | 数据库连接 |
| `LLM_PROVIDER` | `vllm` | `vllm` / `remote` / `mock` |
| `VLLM_BASE_URL` / `LLM_MODEL` / `LLM_LORA_NAME` | `http://127.0.0.1:8000/v1` / `Qwen2.5-7B-Instruct` / `psych-chat` | 主模型与微调适配器 |
| `REMOTE_BASE_URL` / `REMOTE_API_KEY` / `REMOTE_MODEL` | — | 远程 OpenAI 兼容备选 |
| `EMBEDDING_BASE_URL` / `EMBEDDING_MODEL` / `EMBEDDING_DIM` | `http://127.0.0.1:8001/v1` / `BGE-M3` / `1024` | 嵌入模型（独立） |
| `RAG_TOP_K` / `RAG_CHUNK_SIZE` / `RAG_CHUNK_OVERLAP` | `3` / `400` / `60` | 检索与切条参数 |
| `AGENT_MAX_TOOL_ROUNDS` | `4` | Agent 最大工具轮次 |
| `PYFEAT_GATEWAY_URL` | `http://127.0.0.1:8002` | 视频表情分析网关 |
| `UPLOAD_DIR` | `/data/uploads` | 视频临时目录（分析后立即删除） |
| `ACCOUNT_PREFIX` / `ACCOUNT_DIGITS` | 空 / `8` | 注册自动分配账号的前缀与位数 |
| `MATERIAL_AI_DAILY_LIMIT` / `MATERIAL_AI_WORKER` | `30` / `1` | 素材 AI 单日生成上限 / 生成工作线程开关 |

### 3.5 数据备份与恢复

```bash
cd deploy && ./backup.sh           # 输出 backups/psy_*.dump
PGPASSWORD=psy pg_restore -h 127.0.0.1 -U psy -d psy --clean --if-exists < backups/psy_xxx.dump
```

### 3.6 部署验收标准

1. `GET /api/health` 返回 200；
2. 前端登录、SCL-90 答题（90 题漏答拦截）、报告生成正常；
3. AI 聊天回答逐字流式出现，含工具调用时展示「检索中」状态；
4. 教师端班级看板、干预建议生成、素材方案导出正常；
5. 视频检测返回 200（需网关就绪），AI 问答需模型服务就绪；
6. 重启后存量数据可正常读取（建表/迁移幂等）。

---

## 四、团队信息

| 项目 | 内容 |
|---|---|
| 作品名称 | 心晴 · 校园 AI 心理健康测评系统 |
| 参赛赛事 | 2026 年传智杯全国大学生计算机应用能力与信息素养大赛 |
| 参赛组别 | 大二组 |
| 团队成员 | 徐斌宸、王博奕、邓钰函 |
| 联系方式 | 19305129575 |
| 代码仓库 | https://github.com/bigjian1118/ai-psy |。

---

## 附录 A：核心接口清单

> 全部接口均为 `/api/*`，除登录/注册外要求登录态（Cookie session）；教师/学生角色由后端守卫。

### 鉴权与配置

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/auth/register` | 注册：手机号 + 密码（大陆 11 位、全局唯一）；系统自动分配账号作备用登录；返回 `{ok, account, phone, user_id, user}` |
| POST | `/api/auth/login` | 登录，`identifier`（手机号或系统账号）+ `password`；已注销账号返回 403 |
| POST | `/api/auth/logout` | 退出登录 |
| GET | `/api/auth/me` | 当前登录用户 |
| GET/POST | `/api/auth/profile`、`/api/auth/profile/update` | 个人资料查询/更新 |
| GET | `/api/config` | 三人群场景配置 |
| GET | `/api/health` | 健康检查 |

### 账号注销（即时永久模式，学生/教师通用）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/account/deletion/eligibility` | 准入校验，逐条返回阻断原因与处理路径 |
| POST | `/api/account/deletion/immediate` | 即时永久注销：指定确认文案 + 密码双重校验后立即执行；数据分级处理（交互数据删除 / 报告去标识化留存 / 教师素材匿名化），流水号 + IP 审计 |

### 测评与报告

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/test/submit` | 提交 90 题答案，计分 + AI 解读（异步）+ 归档 |
| GET | `/api/student/reports` | 学生文字测评列表 |
| GET/DELETE | `/api/student/report/<id>` | 报告详情 / 删除 |
| GET | `/api/face/reports` | 视频状态报告列表 |
| GET/DELETE | `/api/face/report/<id>` | 视频报告详情 / 删除 |
| GET | `/api/ai/analyses` | AI 综合分析历史 |
| POST | `/api/ai/analysis` | 文本+视频联合分析（异步任务，状态机 + 幂等） |
| POST | `/api/ai/intervention` | 面向班主任的干预建议 |

### Agent 对话与 RAG

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/chat/stream?scenario=&content=&history=` | **SSE**（EventSource），事件 `meta/tool_call/tool_result/delta/done/error` |
| POST | `/api/chat/stream` | **SSE**（fetch 流式客户端） |
| POST | `/api/chat` | 兼容旧契约，一次性返回 `{reply}` |

### 业务管理

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/teacher/classes`、`/api/teacher/reports` | 班级列表 / 班级报告 |
| GET | `/api/teacher/report/<id>`、`/api/teacher/student/<sid>/face-reports` | 报告详情 / 学生视频报告 |
| GET/POST/PUT/DELETE | `/api/teacher/articles`、`/api/teacher/articles/<id>` | 科普文章 CRUD（写后自动重建 RAG 索引） |
| GET/POST | `/api/articles`、`/api/articles/<id>` | 学生端文章列表/详情 |
| GET/POST/DELETE | `/api/student/appointment/*` | 时段查询、预约、取消 |
| GET/POST/PUT/DELETE | `/api/teacher/appointment/*`、`/api/teacher/appointments` | 时段管理、预约审批 |
| GET/POST | `/api/student/msg/*`、`/api/teacher/msg/*`、`/api/msg/unread` | 师生私信与会话 |
| GET/POST | `/api/teacher/materials*` | 素材列表、详情、下载、上传 |
| POST | `/api/face/analyze` | 视频面部状态分析（multipart，分析后删除源文件） |

---

## 附录 B：数据库表结构

PostgreSQL 16，启动时自动 `CREATE EXTENSION vector` 并 `db.create_all()`（含增量 `ALTER TABLE ... IF NOT EXISTS` 迁移）。

| 表 | 主键 | 关键字段 |
|---|---|---|
| `teacher` | teacher_id | name、class、job_number、account、password、login_timestamp、account_status（active/deleted）、deleted_at、delete_serial |
| `teacher_class` | seq_id | teacher_id、class_id（多班级关联） |
| `student` | student_id | name、class、student_no、account、password、latest_text_report_id、latest_video_report_id、account_status |
| `scl90_text_report` | seq_id / report_id | student_id、crowd_tag、total_score、pos_item_count、risk_signal、10 因子列、gsi、psdi、item_answers、status（异步状态）、teacher_read |
| `video_face_report` | seq_id / video_report_id | student_id、au_json、emotion_json、landmark_json、prominent_dimension、status、teacher_read |
| `ai_analysis_report` | seq_id | student_no、student_class、text_report_id、video_report_id、ai_content、status、teacher_read |
| `counseling_slots` | id | teacher_id、date、time_slot、max_capacity、current_count、status |
| `appointments` | id | slot_id、student_id、teacher_id、reason、status、reply、teacher_time |
| `articles` | id | title、summary、content、source、author、is_active |
| `activity_material` | material_id | title、category、brief、file_blob(BYTEA)、file_name、uploader |
| `conversation` | id | student_id、teacher_id、updated_timestamp（唯一 pair） |
| `message` | id | conversation_id、sender_id、sender_role、content、is_read |
| `rag_chunk` | id | source_type、source_id、title、chunk_index、content、embedding vector(1024)（HNSW 余弦索引） |
| `account_deletion_request` | seq_id | user_id、role、status、deletion_serial、ip、verify_method |

---

## 附录 C：隐私与安全

- 视频仅用于瞬时分析，落盘后分析结束 `finally` 删除；数据库只存聚合指标与生成报告；
- AI 报告与对话均附「仅供参考、不能替代专业诊断」免责声明，出现危机条目时展示援助热线；
- 学生数据仅本人与所任班级教师可见；所有接口服务端校验角色与会话归属；
- 账号注销为即时永久模式，数据分级处理 + 流水号/IP 审计；
- 接口限流（`ratelimit.py`）与 `.env` 敏感项隔离（真实 Key 不入库、不入库仓）。

---

