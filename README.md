# 心晴 · 校园 AI 心理健康测评系统

![版本](https://img.shields.io/badge/version-v4.1-informational)
![前端](https://img.shields.io/badge/Next.js-14-black)
![后端](https://img.shields.io/badge/Flask-3.0%20%2B%20SQLAlchemy%202.0-green)
![数据库](https://img.shields.io/badge/PostgreSQL-16%20%2B%20pgvector-blue)
![模型](https://img.shields.io/badge/LLM-Qwen2.5--7B--Instruct%20%7C%20BGE--M3-blueviolet)

> 本文件是仓库主页，包含项目介绍、技术架构、安装运行指南与团队信息。
> 接口清单、数据库表结构、部署验收标准等细节见 [`ai-psy/README.md`](ai-psy/README.md)。

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

### 2.5 仓库目录结构

```
root-train/
├── ai-psy/                     # 主工程
│   ├── server/                 # Flask 后端（api 蓝图 / agent / tools / services）
│   ├── web/                    # Next.js 前端（app 路由 / components / lib / store）
│   ├── rf/                     # 随机森林：训练脚本、推理封装、规则兜底
│   ├── Qwen-train/             # Qwen2.5-7B QLoRA 微调全流程
│   ├── deploy/backup.sh        # pg_dump 全库备份（含向量）
│   ├── start_all.sh            # 一键 start/stop/restart/status/init
│   ├── run_server.py           # Flask 启动入口
│   ├── seed_test_data.py       # 演示测试数据种子
│   └── README.md               # 详细技术说明（接口清单 / 表结构 / 验收标准）
├── env-deployment/             # 环境初始化脚本（pyfeat_env / qwen_env）与部署手册
├── portable-windows/run/       # Windows 便携版启动、停止、初始化脚本与使用说明
├── 使用文档.md                  # 快速上手与部署要点
├── 部署手册-新AutoDL实例.md      # 分步部署手册（含每步验证点）
├── 项目功能与AI运用.md           # 功能清单与 AI 能力说明
└── README.md                   # 本文件
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

### 3.2 环境初始化（服务器首次部署）

`env-deployment/` 下提供两个**幂等**初始化脚本，重复运行安全：

```bash
# 在仓库根目录执行

# 1) 后端 + 视频分析环境：conda 环境(pyfeat_env, Python 3.11)
#    + CPU torch / py-feat / requirements.txt / ffmpeg
#    + py-feat 离线权重预置 + 建库 / 生成题库 / 训练随机森林
bash env-deployment/setup_pyfeat_env.sh all

# 2) 推理环境：conda 环境(qwen_env, Python 3.12)
#    + vLLM 0.7.0 / QLoRA 训练依赖 + 下载 Qwen2.5-7B-Instruct 基座(约 15GB)
bash env-deployment/setup_qwen_env.sh all
```

- 支持按阶段执行：`setup_pyfeat_env.sh env|feat|init`（环境/权重/初始化），`setup_qwen_env.sh env|model`（环境/基座下载）；
- 可覆盖变量：`PROJ`（项目路径）、`PIP_MIRROR`（pip 镜像源）；
- 权重下载失败可重跑续传；仓库根目录另有两份同名脚本副本，内容与 `env-deployment/` 一致，便于直接 `scp` 到服务器。

### 3.3 一键启动服务

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

- **端口**：默认前端 **6006**、后端 **6007**（反向代理通常只映射 6006，前端须占此端口）；可用环境变量覆盖，如 `API_PORT=6006 WEB_PORT=3000 ./start_all.sh start`；
- **日志**：`ai-psy/logs/{llm,embed,gateway,api,web}.log`，PID 在同目录 `*.pid`；`tail -f logs/*.log` 排查；
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

完整的配置模板见 [`ai-psy/.env.example`](ai-psy/.env.example) 与 [`ai-psy/web/.env.example`](ai-psy/web/.env.example)。

### 3.5 数据备份与恢复

```bash
cd ai-psy/deploy && ./backup.sh     # 输出 backups/psy_*.dump
PGPASSWORD=psy pg_restore -h 127.0.0.1 -U psy -d psy --clean --if-exists < backups/psy_xxx.dump
```

### 3.6 部署验收标准

1. `GET /api/health` 返回 200；
2. 前端登录、SCL-90 答题（90 题漏答拦截）、报告生成正常；
3. AI 聊天回答逐字流式出现，含工具调用时展示「检索中」状态；
4. 教师端班级看板、干预建议生成、素材方案导出正常；
5. 视频检测返回 200（需网关就绪），AI 问答需模型服务就绪；
6. 重启后存量数据可正常读取（建表/迁移幂等）。

### 3.7 Windows 便携版（免安装演示）

`portable-windows/` 提供完整自包含的便携运行方案（内置 Python / Node.js / PostgreSQL 运行环境与模型权重，可在移动硬盘上运行）。

1. 用记事本打开 `app\.env`，填写 `REMOTE_API_KEY`（不填也能启动，但 AI 聊天与报告解读会报错，其余功能正常）；
2. 双击 `run\初始化数据库.bat`，等待出现 `[OK] Database initialized`（仅首次，数据随后保存在 `data\pgdata` 内）；
3. 双击 `run\启动.bat`，等待出现 `[OK] All services started`（首次启动向量模型加载约 1–5 分钟）；
4. 浏览器打开 <http://localhost:6006>；局域网访问 `http://本机IP:6006`（需放行防火墙 6006）；
5. 拔盘前务必双击 `run\停止.bat`，否则数据库可能损坏。

**注意：** GitHub 仓库中的便携版脚本不包含完整运行环境、模型权重及数据库文件，仅下载脚本无法直接运行完整系统。详细说明见 [`portable-windows/run/使用说明.txt`](portable-windows/run/使用说明.txt)。

---

## 四、团队信息

| 项目 | 内容 |
|---|---|
| 作品名称 | 心晴 · 校园 AI 心理健康测评系统 |
| 参赛赛事 | 2026 年传智杯全国大学生计算机应用能力与信息素养大赛 |
| 参赛组别 | 大二组 |
| 团队成员 | 徐斌宸、王博奕、邓钰函 |
| 联系方式 | 19305129575 |
| 代码仓库 | https://github.com/bigjian1118/root-train |

---

## 五、文档索引

| 文档 | 内容 |
|---|---|
| [`ai-psy/README.md`](ai-psy/README.md) | 系统工程主文档：架构、目录、部署、配置、接口清单、数据库表结构、隐私与安全 |
| [`ai-psy/USER_GUIDE.md`](ai-psy/USER_GUIDE.md) | 使用手册：功能操作、角色说明、常见问题 |
| [`使用文档.md`](使用文档.md) | 快速上手与服务器部署要点 |
| [`部署手册-新AutoDL实例.md`](部署手册-新AutoDL实例.md) | 分步部署手册（含每步验证点） |
| [`env-deployment/部署手册-新AutoDL实例.md`](env-deployment/部署手册-新AutoDL实例.md) | 按 `env-deployment/` 目录结构组织的部署手册 |
| [`项目功能与AI运用.md`](项目功能与AI运用.md) | 功能清单与 AI 能力说明 |
| [`portable-windows/run/使用说明.txt`](portable-windows/run/使用说明.txt) | Windows 便携版使用说明 |
| [`ai-psy/Qwen-train/README.md`](ai-psy/Qwen-train/README.md) | Qwen2.5-7B-Instruct QLoRA 微调工程 |
| [`ai-psy/rf/README.md`](ai-psy/rf/README.md) | 随机森林模块（规则蒸馏：模型为主、规则兜底） |

---

## 六、开发与版本记录

项目使用 Git 与 GitHub 进行代码管理，保留完整开发过程的提交历史。当前版本 **v4.1**。

主要开发工作包括：

- 基础心理测评流程，学生端与教师端功能拆分
- 前后端架构升级：前端 Next.js 14 + React 18 + TypeScript，后端重构为 Flask 分层架构
- 接入 Agent 工具调用与 RAG 检索，实现流式对话与回答溯源
- AI 报告与教师端功能优化，新增历史因子图表组件
- Windows 便携版启动、停止与数据库初始化脚本与部署说明
- 报告/分析异步任务与接口限流；`SECRET_KEY` 安全取值策略；后端默认仅监听回环地址

具体提交历史见 GitHub 的 Commits 页面。

---

## 七、隐私与安全说明

- **数据不出校园（本地模型模式）**：`LLM_PROVIDER=vllm` 时主模型、嵌入模型与数据库均运行在校内服务器，学生数据不经过外部服务；切换 `LLM_PROVIDER=remote`（或使用便携版）时，对话内容会发往所配置的 API 服务商，需自行评估合规性；
- **视频不留存**：视频仅用于瞬时分析，分析结束 `finally` 删除源文件，数据库只存聚合指标与生成报告；
- **仅表情不识别身份**：视频分析只输出表情维度，不做人脸识别与身份绑定；
- **AI 兜底**：AI 报告与对话均附「仅供参考、不能替代专业诊断」免责声明，出现危机条目时优先展示求助与转介提示；
- **权限隔离**：学生数据仅本人与所任班级教师可见，所有接口在服务端校验角色与会话归属；接口层有限流保护；
- **密钥不入库**：真实 API Key、数据库密码、`data/.secret_key` 等敏感项均已被 `.gitignore` 排除，仓库只提供 `.env.example` 模板；
- **账号注销**：即时永久模式，数据分级处理（交互数据删除 / 报告去标识化留存 / 教师素材匿名化），并留存流水号与 IP 审计；
- **便携版默认凭据**仅适用于受控的本地演示环境，不可直接用于公网部署；正式部署前应完成密码修改、访问控制与安全配置检查。
