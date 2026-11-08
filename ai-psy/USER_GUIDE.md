# 「芯心向荣 AIC」使用文档

> AI+心理健康校园测评系统 · 部署、训练与使用总说明
> 配套细分文档：`ai-psy/README.md`（系统工程主文档）、`ai-psy/rf/README.md`（随机森林模块）、`ai-psy/Qwen-train/README.md`（大模型微调模块）、`env-deployment/部署手册-新AutoDL实例.md`（分步部署手册）

---

## 〇、交付形态说明（请先阅读）

本作品为**服务器端 AI Web 系统**，交付形态为「源码 + 一键脚本 + 文档」，不提供单机可执行文件——系统依赖 GPU 推理服务（vLLM）、人脸分析引擎（py-feat）与数据库服务，属服务器部署形态软件，这是此类作品的标准交付方式。

复现与运行按下列脚本与启动步骤完成，无手工拼接命令：

| 脚本 | 作用 |
|---|---|
| `env-deployment/setup_qwen_env.sh` | 一键配置大模型推理与微调环境（conda + vLLM 依赖 + bf16 基座下载） |
| `env-deployment/setup_pyfeat_env.sh` | 一键配置后端环境（conda + py-feat 权重 + 建库 + 题库 + 随机森林训练） |
| `ai-psy/Qwen-train/train_all.sh` | 一键微调 psych-chat LoRA 适配器（约 13 分钟） |
| `ai-psy/start_all.sh` | 一键启停全部服务（PG + vLLM + 嵌入 + 网关 + Flask + Next，见第 4 步） |

全流程从零到可访问约 40 分钟（不含基座下载 10~20 分钟）。

---

## 一、系统要求

| 项目 | 要求 |
|---|---|
| 部署平台 | AutoDL 容器（Ubuntu + Miniconda 社区镜像），区域任选 |
| GPU（推理/训练） | 单卡 RTX 4090 / 4090D 24GB；无卡实例可降级运行（AI 功能显示占位提示，测评/视频分析/预约等全部可用） |
| 内存 | ≥ 32GB |
| 磁盘 | 系统盘存代码；`/root/autodl-tmp` ≥ 30GB（基座+适配器）；`/root/autodl-fs` ≥ 1GB（数据库/模型/数据集，实例释放不丢失） |
| 客户端 | 现代浏览器（Chrome/Edge）；摄像头功能需 https 或 localhost 环境授权 |

---

## 二、快速开始（新实例从零部署）

### 第 1 步：上传代码

把 `ai-psy/` 与 `env-deployment/` 上传到服务器（环境脚本保持 `env-deployment/` 目录结构）：

```powershell
# 本地 Windows PowerShell（端口/地址以 AutoDL 控制台为准）
scp -P <端口> -r ai-psy root@<地址>:~/ai-psy
scp -P <端口> -r env-deployment root@<地址>:~/env-deployment
```

### 第 2 步：一键配置双环境（两个终端可并行，串行更稳）

```bash
bash ~/env-deployment/setup_qwen_env.sh        # 推理环境：qwen_env + vLLM 栈 + 训练栈依赖 + bf16 基座下载
bash ~/env-deployment/setup_pyfeat_env.sh      # 后端环境：pyfeat_env + py-feat 权重 + 建库 + 题库 + 随机森林训练
```

两脚本幂等：环境已存在/依赖已装/权重已就位/模型已训练时自动跳过对应步骤，中断可重跑。

### 第 3 步：微调聊天适配器（可选，约 13 分钟，需有卡）

```bash
bash ~/ai-psy/Qwen-train/train_all.sh
```

不做此步系统同样运行：vLLM 未注册 `psych-chat` 适配器且 `.env` 的 `LLM_LORA_NAME` 置空时，后端自动以通用基座 + 三人群 system prompt 提供聊天服务（设计内回退）。

### 第 4 步：启动与验证（推荐一键脚本）

```bash
chmod +x ~/ai-psy/start_all.sh           # 首次执行赋权（Windows 上传后常丢可执行位）
cd ~/ai-psy && ./start_all.sh start      # 依次拉起 PG → 主模型 → BGE-M3 → 网关 → 后端 → 前端
./start_all.sh status                    # 端口 / PID / 监听状态一览
./start_all.sh stop                      # 全部停止（PostgreSQL 保留，便于下次直接 start）
./start_all.sh restart                   # 关闭当前全部进程并重新拉起（代码更新后换新进程）
./start_all.sh init                      # 首次部署：建表 + 重建 RAG 索引（需先 start）
```

脚本默认后端 6007、前端 6006——AutoDL 自定义服务只映射 6006，前端必须占这个端口（见 6.2-23）。端口可覆盖：

```bash
API_PORT=6006 WEB_PORT=3000 ./start_all.sh start
```

日志按服务拆分在 `~/ai-psy/logs/{llm,embed,gateway,api,web}.log`，PID 在同目录 `*.pid`，排查时 `tail -f ~/ai-psy/logs/*.log`。脚本已内置前序问题的规避：`ss` 不可用改 socket 探活、`next` 可执行位丢失改用 `node` 直调、`BACKEND_URL` 变更后自动重建前端。

更新代码后按需重启对应服务，不必全量 restart（vLLM 重新加载权重约 1~3 分钟）：

```bash
bash start_all.sh restart                # 全量：关闭当前全部进程并换新进程（不确定改了什么时用）
bash start_all.sh stop && bash start_all.sh start   # 等价分步写法，中间可用 status 确认已停净
```

| 改动范围 | 需要重启 |
|---|---|
| 前端页面（web/） | 仅前端（脚本会先 build 再 start） |
| 后端接口（server/、pyfeat_gateway.py） | 仅 Flask / 网关 |
| 模型、适配器、.env 的 LLM_* 配置 | vLLM（restart 全量最稳） |

需要逐终端手工启动时（答辩演示分解讲解用）：

| 服务 | 命令 |
|---|---|
| PostgreSQL | `pg_ctlcluster 16 main start && pg_lsclusters` |
| vLLM 主模型 | `conda activate qwen_env && vllm serve /root/autodl-tmp/Qwen2.5-7B-Instruct --port 8000 --served-model-name Qwen2.5-7B-Instruct --gpu-memory-utilization 0.86 --max-model-len 8192 --enable-auto-tool-choice --tool-call-parser hermes --enable-lora --lora-modules psych-chat=/root/autodl-tmp/qwen25-7b-lora-ai_chat` |
| BGE-M3 | `conda activate qwen_env && vllm serve BAAI/bge-m3 --task embed --port 8001 --served-model-name BGE-M3 --gpu-memory-utilization 0.1` |
| Flask 后端 | `conda activate pyfeat_env && cd ~/ai-psy && PORT=6007 python run_server.py` |
| py-feat 网关 | `conda activate pyfeat_env && cd ~/ai-psy && python pyfeat_gateway.py` |
| Next 前端 | `conda activate web_env && cd ~/ai-psy/web && BACKEND_URL=http://127.0.0.1:6007 node node_modules/next/dist/bin/next build && BACKEND_URL=http://127.0.0.1:6007 node node_modules/next/dist/bin/next start -p 6006` |

验证（端口按上面的默认值）：

```bash
curl http://127.0.0.1:6007/api/health      # Flask 正常
curl http://127.0.0.1:6007/api/config      # 返回三人群配置 JSON
curl http://127.0.0.1:8000/v1/models       # vLLM 正常（首次加载权重约 1~3 分钟）
curl http://127.0.0.1:8001/v1/models       # 嵌入服务正常（应返回 BGE-M3）
curl http://127.0.0.1:8002/health          # 视频网关正常（detector_loaded 首次分析后变 true）
```

主模型参数中 `--enable-auto-tool-choice --tool-call-parser hermes` 是 Agent 四工具循环的前置条件，缺失时 vLLM 会拒绝带 `tools` 的请求（见第六章第 11 条）。`--max-model-len 8192` 必须保留：显存 24G 下默认 32k 上下文装不进 KV cache（见 6.2-15）。

浏览器访问 AutoDL 控制台「自定义服务」给出的地址（固定映射 6006，即前端），注册账号（手机号 + 密码）即可使用全部功能。

### 第 5 步：清空业务数据（演示前重置，可选）

演示或验收前需要把测试账号、测评报告、预约、素材等业务数据清空，但保留系统内置科普文章时，执行 `ai-psy/reset_data.py`：

```bash
cd ~/ai-psy
./start_all.sh stop                  # 建议先停服务，避免清空过程中有请求写入
./start_all.sh reset                 # 推荐：自动激活后端环境，打印各表行数并等待 YES 确认
./start_all.sh reset --force         # 跳过确认，一键执行（无人值守）
```

> 不要直接执行 `python reset_data.py`：服务器默认解释器可能没有 `sqlalchemy`（报 `ModuleNotFoundError`），必须用上面的 `reset` 子命令，或先 `conda activate pyfeat_env` 再运行。

- **清空**：学生/教师账号、任教班级绑定与审计日志、SCL90/视频/AI 报告、预约与可约时段、素材与 AI 方案任务、师生倾诉会话与消息、账号注销流水、教师自建文章，以及素材等非内置 RAG 切片。
- **保留**：`articles` 表中 id 以 `seed-` 开头的系统内置文章、内置文章切片与 `source_type=knowledge` 的内置知识切片。
- 脚本不清表结构、不重建数据库，全部删除在同一事务内完成，任一表失败自动回滚。
- **不可恢复**：执行前建议先备份数据库（`cd ~/ai-psy/deploy && ./backup.sh`，导出文件在 `deploy/backups/`），确认数据可丢弃后再执行。
- 清空后如需恢复素材 AI 召回的向量索引，可执行 `python -m flask --app run_server reindex-rag`（内置文章切片已保留，非必须）。

---

## 三、功能使用指南

### 3.1 学生端

| 功能 | 入口 | 操作说明 |
|---|---|---|
| 注册/登录 | `/login` | 注册需填写**手机号 + 密码**（手机号：大陆 11 位，学生/教师全局唯一；密码 6-20 位并含复杂度实时校验），另填姓名/学号（工号）/班级；系统仍自动分配账号作为备用登录方式。登录支持「手机号或系统账号 + 密码」，存量无手机号的老账号仍可用原账号登录 |
| 场景化心理测评 | `/test` | 选人群（小学/中学/大学）→ **一题一页**作答（选中自动跳下一题，可回看上题）→ 末题提交即出十因子分、常模 Z 分数与严重程度分级；危机条目独立阈值自动预警 |
| 视频面部情绪分析 | `/face` | 开摄像头 → 录制（单次/多次分段）→ 上传分析 → 情绪分布、AU 指标、心态曲线与四分级指标卡；**报告生成后原始视频即时删除** |
| 个人整合报告 | `/student/reports` | 文本 + 视频双通道同页呈现，左侧历史一键切换 |
| AI 聊天陪伴 | `/chat` | 多轮心理陪伴对话（微调模型），危机话题自动引导转介 |
| 咨询预约 | `/appointment` | 查看教师可约时段 → 提交预约 → 教师审批后生效，可取消 |
| 师生倾诉 | `/msg` | 与绑定教师一对一私密留言，进入会话后自动标记已读 |
| 心理科普 | `/articles` | 内置文章 + 教师发布文章 |
| 个人中心 | `/profile` | 修改姓名等资料；手机号作为登录凭据只读展示；**账号安全**模块可发起即时永久注销：准入校验（未完成预约阻断）→ 风险告知勾选 → 输入指定确认文案 + 密码 → 立即执行，无冷静期、不可恢复；注销后跳转结果页 |

### 3.2 教师端

| 功能 | 入口 | 说明 |
|---|---|---|
| 班级测评管理 | `/teacher/reports` | 绑定班级（支持多班）、全部测评记录总览、危机信号学生置顶标红 |
| 学生报告专业视图 | 报告页教师视角 | KPI 卡、十因子条、情绪趋势、AU 全套专业指标 |
| AI 干预建议 | 学生报告页按钮 | 双通道数据交叉印证，实时生成「状态分析 + 分维度干预方案」，只读不改原始数据 |
| 预约审批 | `/teacher/appointment` | 时段增删、预约同意/拒绝 |
| 文章/素材管理 | `/teacher/articles`、`/teacher/materials` | 发布科普推文、上传班会/活动素材 |
| 倾诉回复 | `/teacher/msg` | 与学生私信 |
| 注销申请查看 | `/api/teacher/account-deletions` | 只读列表：可查看全校注销记录/流水号/IP/校验方式，不支持代他人注销 |
| 账号安全（注销入口） | 工作台页底 | 教师即时永久注销：阻断校验（待审批预约/开放时段）→ 双重确认 → 立即执行；名下素材保留并匿名化创建者，班级关联解除 |

---

## 四、模型训练详解（复现指南）

### 4.1 随机森林（CPU 即可，数分钟）

```bash
bash ~/ai-psy/rf/train_rf.sh
```

- 原理：规则蒸馏——用中国常模 Z 分数规则 / 情绪投票规则对合成数据打伪标签，训练 RandomForestClassifier（200 棵树，种子 42，完全可复现）
- 可调参数：脚本顶部 `TEXT_SAMPLES`（默认 20000）/ `VIDEO_SAMPLES`（默认 30000）
- 质量门槛：文本每因子准确率 ≥99.5%、视频 ≥95%，不达标不写模型文件（宁缺毋滥，线上自动回退规则判定）
- 产物：`/root/autodl-fs/models/` 下 `scl90_*.joblib`×10 + `emotion_rf.joblib` + `meta.json`
- 详细说明：`ai-psy/rf/README.md`

### 4.2 QLoRA 大模型微调（需 24G 显存，约 13 分钟）

```bash
bash ~/ai-psy/Qwen-train/train_all.sh            # 自动停 vLLM 腾显存，训完提示恢复
bash ~/ai-psy/Qwen-train/train_all.sh --fresh    # 忽略检查点从头训练
```

- 路线：bf16 原版基座 + 4bit NF4 双重量化 + bf16 计算（标准 QLoRA）；LoRA r=8 / α=16 / dropout=0.05，lr=2e-4，3 epoch，等效 batch=8，max_seq=1024
- 数据：`/root/autodl-fs/dataset/ai_chat/`（三人群对话样本，9:1 切分，仅 assistant 段计 loss）
- 超参调整：脚本顶部参数区集中修改，或 `python train_qlora.py --rank 16 --lr 5e-4` 直接覆盖
- 产物：`/root/autodl-tmp/qwen25-7b-lora-ai_chat/`（adapter_config.json + adapter_model.safetensors）
- **建议训完备份到持久盘**：`cp -r /root/autodl-tmp/qwen25-7b-lora-ai_chat /root/autodl-fs/backup-lora/`
- 部署：vLLM 启动参数加 `--enable-lora --lora-modules psych-chat=/root/autodl-tmp/qwen25-7b-lora-ai_chat`，`.env` 的 `LLM_LORA_NAME=psych-chat` 与之对应
- 详细说明：`ai-psy/Qwen-train/README.md`（含模型合并、消融方法）

### 4.3 直接复用已训练适配器（跳过训练）

使用提交材料中的「模型适配器包」：解压到 `/root/autodl-tmp/qwen25-7b-lora-ai_chat/`，重启 vLLM（`pkill -f "vllm serve"` 后按第 4 步重新拉起）即完成挂载。

---

## 五、目录结构

```
root-train/
├── USER_GUIDE.md                  # 本文档（ai-psy/USER_GUIDE.md）
├── env-deployment/                # 服务器环境配置与部署资料
│   ├── setup_qwen_env.sh          #   一键：推理/微调环境 + 基座
│   ├── setup_pyfeat_env.sh        #   一键：后端环境 + 权重 + 初始化 + RF 训练
│   └── 部署手册-新AutoDL实例.md    #   分步部署手册（含每步验证点）
├── ai-psy/                        # 网站主项目（详见 ai-psy/README.md）
│   ├── server/                    # Flask 后端：api/ services/ models/ Agent/RAG
│   ├── web/                       # Next.js 前端（App Router + shadcn + ECharts）
│   ├── deploy/                    # 数据库备份脚本（backup.sh）
│   ├── start_all.sh               # 一键 start/stop/restart/status/init：PG→模型→嵌入→网关→后端→前端
│   ├── reset_data.py              # 一键清空业务数据（保留内置文章，演示前重置）
│   ├── run_server.py              # 后端启动入口（默认 :6006；start_all.sh 以 6007 启动、前端占 6006）
│   ├── pyfeat_gateway.py          # py-feat 视频分析网关（:8002，视频表情分析必需）
│   ├── rf/                        # 随机森林训练与推理（rf/README.md）
│   └── Qwen-train/                # 大模型微调工程（Qwen-train/README.md）
├── autodl-fs/                     # 文件存储盘数据副本（持久）
│   ├── dataset/                   #   ai_chat 训练数据 + 题库
│   └── models/                    #   随机森林 .joblib + meta.json
└── autodl-tmp/                    # 数据盘占位（基座/适配器实际在服务器生成）
```

服务器运行时数据落位：基座与适配器在 `/root/autodl-tmp/`；数据库、RF 模型、数据集、上传暂存在 `/root/autodl-fs/`。

---

## 六、常见问题与解决方案（实测记录）

> 本章持续记录部署过程中真实遇到的问题与验证过的解法，遇到新问题时追加条目，编号不重排。

### 6.1 速查表

| # | 现象 | 根因 | 解决 |
|---|---|---|---|
| 1 | `-bash: lsb_release: command not found` | 镜像未装 `lsb-release`；若前一条 `apt update` 已失败，`&&` 会短路导致安装命令根本没执行 | 见 6.2-1 |
| 2 | `apt update` 报 `does not have a Release file` / 404 | `pgdg.list` 里 URL 被反引号包裹、代号为空 | 见 6.2-2 |
| 3 | 粘贴含 URL 的命令后行为异常、文件内容错乱 | 终端把 URL 自动包成反引号，bash 反引号是命令替换 | 见 6.2-3 |
| 4 | `invoke-rc.d: policy-rc.d denied execution of start` | 容器无 systemd，装包时不会自动起服务 | 见 6.2-4 |
| 5 | `The folder you are executing pip from can no longer be found` | 当前工作目录已被删除或改名 | 见 6.2-5 |
| 6 | `ModuleNotFoundError: No module named 'sqlalchemy'` | `pyfeat_env` 只装了 py-feat 依赖，后端依赖未装 | 见 6.2-6 |
| 7 | `reindex-rag` 报 8001 `Connection refused` | BGE-M3 嵌入服务未启动 | 见 6.2-7 |
| 8 | 任意接口报 5432 `Connection refused` | 实例重启后 PostgreSQL 未自启 | 见 6.2-8 |
| 9 | vLLM 报 `Failed to infer device type` / 横幅 `GPU: No devices were found` | 实例处于 AutoDL「无卡模式」 | 见 6.2-9 |
| 10 | 调用模型返回 404 `model not found` | `--served-model-name` 与 `.env` 模型名不一致 | 见 6.2-10 |
| 11 | Agent 带工具请求被 vLLM 拒绝 | 未开启自动工具选择与解析器 | 见 6.2-11 |
| 12 | 用 `LLM_PROVIDER=mock` 重建索引后聊天也变假回答 | 该开关同时作用于 LLM 与嵌入 | 见 6.2-12 |
| 13 | `npm run build` 被杀（OOM） | 无卡模式仅 0.5 核 / 2GB 内存 | 见 6.2-13 |
| 14 | 权重下载极慢或超时 | 直连 HuggingFace 受限 | 见 6.2-14 |
| 15 | `The model's max seq len (32768) is larger than … KV cache (2768)` | 显存分配比例不足，KV cache 装不下默认 32k 上下文 | 见 6.2-15 |
| 16 | `vllm: command not found` | 在 `pyfeat_env` 里启动 vLLM，环境切错 | 见 6.2-16 |
| 17 | `npm: command not found` | 镜像未装 Node.js；`apt` 版 node 12 不满足 Next 14 | 见 6.2-17 |
| 18 | `sh: 1: next: Permission denied`（`npm install` 只追加个别包） | `node_modules` 由 Windows 上传，Linux 下可执行位丢失 | 见 6.2-18 |
| 19 | 浏览器打开 6006 显示 `{"error":"接口不存在"}` | 访问的是 Flask 后端根路径，前端在 3000 | 见 6.2-19 |
| 20 | 隧道工具填 3000→3000 报「不能相同否则冲突」，填 3000→6006 报「每个套接字地址只允许使用一次」，填 3001→3000 报 `Port forwarding for '127.0.0.1' port '3000' failed to start` | 工具要求两端端口都空闲（它会在本机与实例两侧各起监听）；3000 已被 Next 占用 | 见 6.2-20 |
| 21 | 视频分析失败：`无法连接视频分析服务… port=8002 … Connection refused` | py-feat 网关进程未启动（重构后旧 `feat_analyzer.py` 已删除，网关由 `pyfeat_gateway.py` 提供） | 见 6.2-21 |
| 22 | `-bash: ss: command not found` | 镜像未装 `iproute2`，`ss`/`netstat`/`lsof` 均不可用 | 见 6.2-22 |
| 23 | 用 AutoDL 自定义服务打开网页报「无法访问/连接被拒绝」 | 该入口只映射容器 **6006**，而 6006 是 Flask，前端在 3000 | 见 6.2-23 |
| 24 | `./start_all.sh` 报 `Permission denied` 或 `$'\r': command not found` | Windows 上传丢了可执行位 / 文件是 CRLF 换行 | 见 6.2-24 |
| 25 | 视频分析失败：网关 `500`，traceback 为 `ValueError: No objects to concatenate`，其上有 `0it [00:00, ?it/s]` | py-feat 用 av 的 `stream.frames` 取总帧数，webm（matroska）该字段恒为 0，`VideoDataset` 长度为 0，`pd.concat` 空列表才炸 | 见 6.2-25 |
| 26 | 视频测试报 500，网关进度条长时间不结束（如 `125/4976`） | CPU 推理约 3.8s/帧，默认抽帧过密导致超过后端 120s 读超时 | 见 6.2-26 |

### 6.2 逐条说明

**1. lsb_release 不存在**
镜像精简版未带该命令。两种解法：
```bash
# 解法 A：补装（先单独执行 apt update，确认没有 404 再装）
apt update && apt install -y lsb-release curl ca-certificates
# 解法 B：直接用 os-release 取代号，不依赖 lsb_release
. /etc/os-release && CODENAME=${VERSION_CODENAME:-jammy}
```
注意：`apt update && apt install ...` 串联时，只要 update 有一条源报错就会中断，因此要先修源再装包。

**2. PGDG 源 404 / 无 Release 文件**
表现：`E: The repository '`http://...` -pgdg Release' does not have a Release file.`，说明文件里既有反引号、又缺代号。用变量拼接重写（避开终端自动加引号），并 `cat` 校验：
```bash
P='http'; P="$P://apt.postgresql.org/pub/repos/apt"
printf 'deb [signed-by=/usr/share/keyrings/pgdg.gpg] %s jammy-pgdg main\n' "$P" > /etc/apt/sources.list.d/pgdg.list
cat /etc/apt/sources.list.d/pgdg.list
```
输出必须是一行纯文本、无任何反引号。官方源仍不通时换 USTC：
```bash
P='https'; P="$P://mirrors.ustc.edu.cn/postgresql/repos/apt"
printf 'deb [signed-by=/usr/share/keyrings/pgdg.gpg] %s jammy-pgdg main\n' "$P" > /etc/apt/sources.list.d/pgdg.list
```
兜底：装系统自带 PostgreSQL 14 + 源码编译 pgvector（见部署手册 5.1 注释）。

**3. 粘贴命令带反引号**
反引号在 bash 中是命令替换，`echo "...`http://x`..."` 会尝试执行 URL。凡是含 URL 的命令，一律用单引号或变量拼接书写；粘贴后回显出现反引号要立即删掉重写。

**4. policy-rc.d 拒绝启动**
Debian/Ubuntu 容器无 systemd 时的正常提示，安装不会自动起服务。手动启动：
```bash
pg_ctlcluster 16 main start      # 或 service postgresql start
pg_lsclusters                    # Status 应为 online
```

**5. pip 找不到工作目录**
说明当前目录已被删除/改名。先 `cd ~` 或 `cd ~/ai-psy`，再执行 pip；项目内执行前建议先 `pwd` 确认。

**6. 后端依赖缺失**
`pyfeat_env` 是按 py-feat 需求创建的，不含 Web 依赖。补装：
```bash
conda activate pyfeat_env
pip install -i https://pypi.tuna.tsinghua.edu.cn/simple -r ~/ai-psy/requirements.txt
python -c "import sqlalchemy, flask_sqlalchemy, psycopg, pgvector, dotenv; print('deps ok')"
```
`requirements.txt` 已包含 `python-dotenv`，装好后 Flask 才会自动加载 `.env`（否则会提示 "There are .env files present. Install python-dotenv"）。

**7. reindex-rag 连不上 8001**
必须先起嵌入服务，再建索引：
```bash
conda activate qwen_env && export HF_ENDPOINT=https://hf-mirror.com
vllm serve BAAI/bge-m3 --task embed --port 8001 --served-model-name BGE-M3 --gpu-memory-utilization 0.12
# 另开终端验证后重跑
curl -s http://127.0.0.1:8001/v1/models
cd ~/ai-psy && python -m flask --app run_server reindex-rag
```
索引失败不影响系统启动，但 `rag_chunk` 为空时 Agent 的 `rag_search` 返回空结果。

**8. 实例重启后数据库连不上**
容器无 systemd，PG 不随开机自启。每次重启后先：
```bash
pg_ctlcluster 16 main start
```
日志里出现 `[db] 初始化跳过 … Connection refused` 也是同一原因，先起 PG 再执行任何 CLI 命令。

**9. 无卡模式导致 vLLM 失败**
横幅 `GPU ：No devices were found`、`vLLM is running on UnspecifiedPlatform` 即表示实例无 GPU。处理：控制台关机 → 选择有卡开机；`nvidia-smi -L` 能列出卡型后再启动服务。无卡期间可临时用 `LLM_PROVIDER=mock` 跑通业务功能（测评、报告、预约、消息不依赖 GPU），或把 `.env` 切到 `LLM_PROVIDER=remote` 走远程 OpenAI 兼容 API。

**10. 模型名不匹配 404**
三处名称必须一致：
- 主模型 `--served-model-name Qwen2.5-7B-Instruct` ↔ `.env` 的 `LLM_MODEL`
- `--lora-modules psych-chat=...` ↔ `.env` 的 `LLM_LORA_NAME=psych-chat`
- 嵌入 `--served-model-name BGE-M3` ↔ `.env` 的 `EMBEDDING_MODEL=BGE-M3`

未挂 LoRA 时必须把 `.env` 的 `LLM_LORA_NAME` 留空，否则后端仍请求 `psych-chat` 而服务端无此模型。

**11. 工具调用被拒**
vLLM 启动参数必须带：
```bash
--enable-auto-tool-choice --tool-call-parser hermes
```
Qwen2.5 用 `hermes` 解析器；缺少这两项时带 `tools` 的请求会失败，Agent 循环退化为普通对话。启动后可用 `curl /v1/models` 确认服务已注册模型，再测 `/api/chat/stream`。

**12. mock 模式的副作用**
`LLM_PROVIDER=mock` 同时让 LLM 与嵌入走假实现：聊天返回占位内容、`rag_chunk` 写入无意义向量。仅用于无卡联调；恢复后必须以真实嵌入服务重跑一次 `reindex-rag`，否则检索质量不可用。

**13. 低内存构建前端 OOM**
无卡模式仅 0.5 核 / 2GB，`npm run build` 极易被 OOM kill。改用 `npm run dev`，或换到有卡实例（内存 ≥ 32GB）构建后再回传 `.next/`。

**14. 权重下载慢**
```bash
export HF_ENDPOINT=https://hf-mirror.com
```
建议写入 `~/.bashrc` 常驻；`pip` 同样建议配国内镜像（清华源）。

**15. KV cache 装不下 32k 上下文**
vLLM 按模型默认 `max_position_embeddings=32768` 校验，但扣除权重后剩余显存只够缓存 2768 tokens，于是启动即失败。本系统单轮提示词 + 回答远小于 8k，显式下调上下文并调整显存比例即可：
```bash
# 嵌入服务压缩到 0.10，给主模型腾空间
vllm serve BAAI/bge-m3 --task embed --port 8001 \
  --served-model-name BGE-M3 --gpu-memory-utilization 0.10

# 主模型提高比例并限制上下文
vllm serve /root/autodl-tmp/Qwen2.5-7B-Instruct --port 8000 \
  --served-model-name Qwen2.5-7B-Instruct --gpu-memory-utilization 0.86 \
  --max-model-len 8192 \
  --enable-auto-tool-choice --tool-call-parser hermes \
  --enable-lora --lora-modules psych-chat=/root/autodl-tmp/qwen25-7b-lora-ai_chat
```
仍报同一错误时按 `8192 → 4096 → 2048` 递减；16G 卡建议 `0.90 + 2048` 且不挂 LoRA。两个 vLLM 进程的 `gpu-memory-utilization` 之和不要超过 0.95，避免互相挤爆。<br>
排查顺序：先 `nvidia-smi` 看总显存与嵌入进程占用，再定比例；不要盲目把主模型调到 0.95。

**16. `vllm: command not found`**
vLLM 只装在 `qwen_env`，`pyfeat_env` 里没有。启动前先切环境并确认路径：
```bash
conda activate qwen_env
which vllm        # 应为 /root/miniconda-new/envs/qwen_env/bin/vllm
```
环境分工：`qwen_env` 跑 vLLM（嵌入 + 主模型）与微调；`pyfeat_env` 跑 Flask、`reindex-rag`、RF 训练。

**17. `npm: command not found`**
镜像未预装 Node.js，且 `apt install nodejs` 在 Ubuntu 22.04 只给 v12，不满足 Next 14 要求的 ≥18.17。用 conda 建独立环境：
```bash
conda create -y -n web_env -c conda-forge nodejs=20
conda activate web_env
node -v && npm -v
npm config set registry https://registry.npmmirror.com
```
之后每次启前端都要先 `conda activate web_env`。`npm install` 长时间无响应时先查 `npm config get registry` 是否已是国内镜像。

**18. `next: Permission denied`**
特征：`npm install` 只输出「added 2 packages」，随后 `npm run build` 报 `sh: 1: next: Permission denied`。根因是 `node_modules` 从 Windows 直接上传，Linux 下可执行位为 0，且已存在的依赖被 npm 跳过。删掉依赖重装即可：
```bash
cd ~/ai-psy/web
rm -rf node_modules package-lock.json .next
npm install
npm run build
npm run start
```
应急方案（不想重装时）：`chmod -R u+x node_modules/.bin`；`npx next ...` 与 `npm run` 走的是同一个 `.bin/next`，同样会报错，等价绕法是直接调 node 执行脚本：
```bash
cd ~/ai-psy/web
BACKEND_URL=http://127.0.0.1:6007 node node_modules/next/dist/bin/next build
BACKEND_URL=http://127.0.0.1:6007 node node_modules/next/dist/bin/next start -p 6006
```
这种方式不依赖可执行位，也是临时改端口时的推荐写法。<br>
注意：`.next` 必须在构建成功前删除，否则 `next start` 会报找不到生产构建；另外跨平台上传 `node_modules` / `package-lock.json` 容易带入平台专用二进制冲突，**部署到服务器一律重装依赖**，不要随代码上传。

**19. 打开 6006 显示 `{"error":"接口不存在"}`**
Flask 只注册 `/api/*`，根路径 `/` 一律返回该 JSON，说明后端其实是健康的，只是你打开的是后端入口而不是前端。前端 Next 默认在 3000；AutoDL 自定义服务固定映射 6006，因此有两种做法：本机 `ssh -L` 把 3000 转出来（见 6.2-20），或把前端挪到 6006、后端退到 6007（见 6.2-23）。端口职责：3000 前端、6006 后端/平台入口、8000 主模型、8001 嵌入、8002 py-feat 网关。

**20. 隧道工具无法访问 3000**
AutoDL 隧道工具的两条硬限制：**「代理到本地端口」与「代理到远程端口」不能相同**（填 3000→3000 会弹「不能相同否则冲突」）；**本地端口同一时间只能被一个监听占用**（填 3000→6006 会弹 Windows 错误「通常每个套接字地址(协议/网络地址/端口)只允许使用一次」，即本地 3000 已被上一次的代理仍在占用）。按以下顺序处理：

1. 先在工具里点「停止代理」，确认下方状态不再显示「代理中」；仍报占用说明是本机上一个残留监听，换端口最简单。
2. 重新填一组**不冲突且语义正确**的映射：**代理到本地端口 `3001`、代理到远程端口 `3000`**（本地≠远程，满足工具约束；浏览器访问 `http://127.0.0.1:3001` 即为服务器前端 3000）。
3. 后端 6006 不需要再经隧道：前端 Next 已配置 `rewrites` 把 `/api/*` 代理到本机 6006（见 `web/next.config.mjs`）。

命令行方案（本地已有 OpenSSH，PowerShell 执行，保持窗口不关）：
```powershell
ssh -p 26691 root@connect.cqa1.seetacloud.com `
  -L 127.0.0.1:3001:127.0.0.1:3000 `
  -L 127.0.0.1:6006:127.0.0.1:6006 -N
```
端口与主机以实例当前 SSH 登录指令为准。之后浏览器访问 `http://127.0.0.1:3001`（前端），后端仍可直接 `curl http://127.0.0.1:6006/api/health`。

AutoDL 控制台方案：把「自定义服务」端口设为 **3000**，用控制台给出的公网地址访问前端。

注意：本地端口与远程端口互换（如本地 3000 映到远程 3001）不是等价转发，远程并没有监听 3001，访问会失败，不要这样填。

实测补充：把「本地 3001 / 远程 3000」填进该工具后仍会报
`错误：转发端口时发生错误！Port forwarding for '127.0.0.1' port '3000' failed to start.`
原因是这个工具两端都要**自己起监听**（弹窗下方「在实例中执行 export https_proxy=http://127.0.0.1:3000」说明实例侧 3000 也被它占作入口），而实例 3000 已被 Next 占用，抢不到就失败。先在实例确认占用（本镜像无 `ss`，用 6.2-22 的探活脚本，或下面两条 curl）：
```bash
curl -s -o /dev/null -w '3000=%{http_code}\n' http://127.0.0.1:3000   # 200/404 = 被 Next 占用
curl -s -o /dev/null -w '6006=%{http_code}\n' http://127.0.0.1:6006   # 200 = Flask 在跑
```
若 3000 确实被 node 占用，就别再用这个工具暴露前端（它抢不到该端口），改用上面的 `ssh -L`（`-L` 只在本机起监听，远程 3000 只是转发目标，不要求空闲）或 AutoDL 控制台自定义服务；若 3000 空着，说明前端进程没起，先按第 4 步「终端 5」把 Next 拉起来再试。

**21. 视频分析失败：8002 Connection refused**
`POST /api/face/analyze` 的后端链路是「Flask 6006 → py-feat 网关 8002 → 聚合指标 → 大模型生成报告」。重构时旧的 `feat_analyzer.py` 已删除，网关改由项目根目录的 `pyfeat_gateway.py` 独立进程提供，**未启动时后端必然报 8002 拒绝连接**。启动与验证：
```bash
conda activate pyfeat_env
cd ~/ai-psy && python pyfeat_gateway.py      # 监听 0.0.0.0:8002，与 Flask 同环境即可
# 另开终端验证（返回 {"status":"ok","detector_loaded":false} 即说明进程已起）
curl http://127.0.0.1:8002/health
```
首次分析会现场加载 py-feat 权重（数十秒），之后进程内复用；检测器为 CPU 串行推理，网关默认隔帧采样（`PYFEAT_SKIP_FRAMES=2`，10 秒视频约 150 帧）。若后端报 `Read timed out`（后端对该网关的读超时为 120 秒），说明机器偏慢，用 `PYFEAT_SKIP_FRAMES=4 python pyfeat_gateway.py` 重启网关即可。若返回 `未检测到人脸`，属于视频质量问题，不是服务故障。

排障顺序：
1. 先确认 8002 进程在跑（`ps aux | grep pyfeat_gateway`），再确认 `.env` 的 `PYFEAT_GATEWAY_URL` 未被改成别的地址/端口。用 6.2-22 的探活脚本可一眼看出：正常部署时 3000/6006/8000/8001 均「监听中」，只有 8002「未监听」就是本条故障。
2. 报 `No such file or directory ... July4_AU*_XGB.ubj`：py-feat 权重未预置，执行 `bash ~/env-deployment/setup_pyfeat_env.sh feat` 补齐离线权重（需先 `source /etc/network_turbo`）。
3. 报 `ModuleNotFoundError: No module named 'feat'`：网关必须在 `pyfeat_env` 里启动（`conda activate pyfeat_env`），不要在 `qwen_env` 或系统 python 里跑。
4. 报 `未上传视频文件` / `仅支持 webm / mp4 / mov`：网关契约是 multipart 字段 `video`，由前端 `FormData.append('video', blob)` 发起，不是 JSON 接口。
5. 只想先验收其他功能、暂不做视频分析：可在 `.env` 设 `LLM_PROVIDER=mock` 让后端返回示例指标（注意该开关同时影响聊天与嵌入，验收完务必改回 `vllm` 并重建索引，见 6.2-12）。
6. 报 `500 Server Error for url: http://127.0.0.1:8002/analyze`：与「连接拒绝」性质不同——8002 进程已起，是网关内部分析失败。后端把 `requests` 的异常统一转述，**看不到网关返回的具体原因**，必须去网关终端找 `[pyfeat-gateway] 视频分析异常` 的 traceback（用 nohup 起的看 `/tmp/pyfeat_gateway.log`），或用 `curl -s -X POST -F "video=@测试.mp4" http://127.0.0.1:8002/analyze` 直连网关拿 `py-feat 分析失败：<原因>`。多数是权重缺失，用下面脚本一次判定：
```bash
conda activate pyfeat_env
python - <<'EOF'
import feat, os
res = os.path.join(feat.__path__[0], "resources")
need = ["mobilenet0.25_Final.pth", "July4_AU43_XGB.ubj",
        "ResMaskNet_Z_resmasking_dropout1_rot30.pth", "all_data_Fullpca_June30.pkl"]
for f in need:
    print("OK  " if os.path.exists(os.path.join(res, f)) else "缺失", f)
EOF
```

**22. `ss: command not found`**
镜像未装 `iproute2`，`ss`、`netstat`、`lsof` 三个命令都不可用，不要再用它们查端口。改用 Python 原生 socket 探活（不依赖任何额外包）：
```bash
python - <<'EOF'
import socket
for port in (3000, 6006, 8000, 8001, 8002):
    s = socket.socket()
    s.settimeout(0.5)
    try:
        s.connect(("127.0.0.1", port))
        print(f"{port:<5} 监听中")
    except Exception:
        print(f"{port:<5} 未监听")
    finally:
        s.close()
EOF
```
只看单个端口时用 curl 更快：
```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000
# 000 = 没起；200 / 404 / 405 都说明进程在监听
```
确需恢复原命令时补装工具（可选，会拉几十 MB 包）：
```bash
apt update && apt install -y iproute2 net-tools
```
端口职责对照：3000 前端 Next、6006 Flask、8000 主模型、8001 BGE-M3、8002 py-feat 网关。

**23. 自定义服务打开是「无法访问 / 连接被拒绝」**
AutoDL「自定义服务」只把容器 **6006** 暴露到公网，入口地址形如 `https://xxx.autodl.com:端口`。当前 6006 是 Flask（根路径返回 `{"error":"接口不存在"}`），前端 Next 在 3000，所以直接用该入口一定打不开前端；实例重启/换卡后入口地址还会变，用旧链接则表现为「连接被拒绝」。

处理顺序：
1. 先回控制台重新点「自定义服务」，复制**当前**地址再试。地址过期是最常见的「拒绝连接」原因，零改动。
2. 仍打不开就交换端口，让前端占用平台唯一开放的 6006。先停旧进程（`pgrep -af "next-server|run_server"` 取 PID 再 `kill`），然后：
```bash
# 后端改 6007
conda activate pyfeat_env && cd ~/ai-psy
PORT=6007 python run_server.py

# 前端重新构建并起在 6006；BACKEND_URL 会固化进产物，必须 build 时就传
conda activate web_env && cd ~/ai-psy/web
BACKEND_URL=http://127.0.0.1:6007 npx next build
BACKEND_URL=http://127.0.0.1:6007 npx next start -p 6006
```
3. `web/package.json` 的 `start` 写死 `-p 3000`，改端口必须用 `npx next start -p 6006`，`npm run start` 不认附加参数。`web/` 下只有 `.env.example`、没有 `.env`，所以命令行传参不会被覆盖；若日后新建 `web/.env` 并在其中写了 `BACKEND_URL`，以环境变量优先规则仍需命令行显式传。
4. 不想换端口时改用本机 SSH 转发（见 6.2-20 命令行方案），浏览器访问 `http://127.0.0.1:3001` 即为服务器 3000 前端。

**24. `./start_all.sh` 报 `Permission denied` 或 `$'\r': command not found`**
脚本在 Windows 上编辑、经 `scp` 上传后必然带两个问题：
- 可执行位丢失（Windows 文件系统没有该属性），直接 `./start_all.sh` → `Permission denied`；
- 换行是 CRLF，bash 会把 `\r` 当成命令名的一部分 → `$'\r': command not found`，脚本第一行 `#!/usr/bin/env bash\r` 甚至会导致解释器找不到。

一次性修好（只需执行一次）：
```bash
chmod +x ~/ai-psy/start_all.sh
sed -i 's/\r$//' ~/ai-psy/start_all.sh
bash -n ~/ai-psy/start_all.sh          # 语法自检：无输出即通过
```

处理后按 `cd ~/ai-psy && ./start_all.sh start` 使用；若仍嫌麻烦，可跳过赋权直接用 `bash ~/ai-psy/start_all.sh start`（`bash` 显式调用不需要可执行位，但 CRLF 仍必须先转）。

脚本本身的两个约定要记住：
1. **端口**：默认前端 6006、后端 6007（原因见 6.2-23）。改端口用环境变量覆盖，如 `API_PORT=6006 WEB_PORT=3000 ./start_all.sh start`；改完 `API_PORT` 后脚本会自动重建前端（`BACKEND_URL` 构建期固化），无需手工 build。
2. **日志**：各服务输出在 `~/ai-psy/logs/{llm,embed,gateway,api,web}.log`，PID 在同目录 `*.pid`。某个服务卡在等待健康检查时，先 `tail -n 50 ~/ai-psy/logs/<服务>.log` 看真实报错，再对照本章对应条目。

`stop` 不会停 PostgreSQL（容器内数据库启停成本低但重连麻烦，保留可让下次 `start` 秒起）；需要彻底停止时执行 `pg_ctlcluster 16 main stop`。

**25. 视频分析报 500：`No objects to concatenate`（webm 容器帧数为 0）**
前端只显示 `无法连接视频分析服务：500 Server Error: INTERNAL SERVER ERROR`，真实原因要看网关日志（`~/ai-psy/logs/gateway.log` 或网关前台终端）：
```
[pyfeat-gateway] Detector 加载完成
0it [00:00, ?it/s]
ERROR:pyfeat_gateway:[pyfeat-gateway] 视频分析异常
  ... feat/detector.py, line 883, in detect_video
    batch_output = pd.concat(batch_output)
ValueError: No objects to concatenate
```
`0it` 表示一批都没跑，`pd.concat` 收到空列表才报错。**不是权重问题**（`Detector 加载完成` 已打印），也不是解码器缺失。

根因在 py-feat 0.6.1 的 `feat/data.py::VideoDataset.get_video_metadata`：
```python
container = av.open(video_file)
stream = container.streams.video[0]
num_frames = stream.frames        # 关键
```
它用 PyAV 的 `stream.frames` 取总帧数，而 **matroska(webm) 容器的该字段恒为 0**，于是 `VideoDataset.__len__` 为 0、`DataLoader` 没有批次，最终 `pd.concat([])` 报错。

一条命令即可验证（PyAV 和 torchvision 本身都能正常解码 90 帧，不用怀疑解码器）：
```bash
conda activate pyfeat_env
python -c "
from feat.data import VideoDataset
for f in ['/tmp/demo.webm', '/tmp/demo.mp4']:
    print(f, '-> len:', len(VideoDataset(f, skip_frames=1)))
"
# 输出：demo.webm -> len: 0 ；demo.mp4 -> len: 90
```

修复（已在代码中实现，无需再手工处理）：网关 `analyze()` 在调用 py-feat 前，把 webm 用 ffmpeg 转成 mp4（同一份临时目录，`libx264 -preset veryfast`），分析完统一清理；mp4 / mov 走原路径。ffmpeg 优先取系统命令，回退 `imageio_ffmpeg.get_ffmpeg_exe()`。转换失败时退回原文件，仍能返回原始报错而不是静默失败。

部署后重启网关即可生效：
```bash
pkill -f pyfeat_gateway.py
cd ~/ai-psy && ./start_all.sh start      # 其余服务已在跑，脚本只补起网关
```

验证（预期 422 而非 500，testsrc 画面里没有人脸）：
```bash
curl -s -F "video=@/tmp/demo.webm" http://127.0.0.1:8002/analyze | head -c 200
# {"error":"未检测到人脸，请正对镜头重新录制"} = 读帧与转码链路均正常
```
再用真人 webm 录制，应返回 `{"metrics": {...}}`。

排查过程中走过的弯路一并记下，避免重复：
- 装 `imageio-ffmpeg` 不解决问题——py-feat 走的是 PyAV / torchvision，不是 imageio；该包现在只作为 ffmpeg 二进制的回退来源。
- 系统 `ffmpeg` 命令能读 webm，不代表 py-feat 能——它自己不调用命令行 ffmpeg。

同一段日志里若出现 `libgomp: Invalid value for environment variable OMP_NUM_THREADS`：该变量被镜像设成空值（`echo "[$OMP_NUM_THREADS]"` 输出 `[]`），不影响分析结果，只刷警告。`start_all.sh` 启动网关时已按 `${OMP_NUM_THREADS:-4}` 补默认值；手工启动时用 `export OMP_NUM_THREADS=4` 再跑网关。

`requirements.txt` 与 `env-deployment/setup_pyfeat_env.sh` 已补齐 `imageio` / `imageio-ffmpeg`（转码兜底用），新实例不会再缺。

**26. 前端视频测试报 500（后端日志为 `POST /api/face/analyze 422/500`，网关仍在跑很长的进度条）**

现象：网关终端出现类似 `125/4976 [1:18:10]` 的进度条，或单次分析耗时数分钟；前端等待后报 500。

根因：py-feat 在 CPU 上逐帧推理实测约 **3.8 秒/帧**（Retinaface + img2pose + XGB AU + ResMaskNet）。前端固定录制 10 秒 ≈ 300 帧，原默认 `PYFEAT_SKIP_FRAMES=2` 要跑 150 帧 ≈ 9.5 分钟，远超后端 `server/services/face_service.py` 的 120 秒读超时，必然 500。若上传了长视频（如 4976 帧），单次可达 1 小时以上，同时拖慢后续请求。

解决：抽帧步长改为 15（默认值已在代码中生效），10 秒视频约 20 帧 ≈ 76 秒，落在 120s 超时内。另设单次分析帧数上限 `PYFEAT_MAX_FRAMES`（默认 30），网关会按视频实际总帧数再算一次步长，因此浏览器录出远超 10 秒的视频（实测出现过 1066 帧、7995 帧）也不会把耗时拖到超时。启动时日志会打印 `总帧=… 抽帧步长=… 计划帧数≈…`，可直接核对。

```bash
cd ~/ai-psy && ./start_all.sh restart        # 脚本已透传 PYFEAT_SKIP_FRAMES=15
# 需要临时改密度时：
PYFEAT_SKIP_FRAMES=30 ./start_all.sh restart  # 10 帧，更快但指标更粗
PYFEAT_SKIP_FRAMES=5  ./start_all.sh restart  # 60 帧，更细但可能超时
```

排查要点：
- 重启前先看网关是否还在跑旧的长任务，`restart` 会按进程特征清理 `pyfeat_gateway.py`，但**已开始的单次分析不会被中断**，必要时 `pkill -f pyfeat_gateway.py` 后再起。
- 后端读超时已从 120s 放宽到 `PYFEAT_TIMEOUT_SECONDS`（默认 300s，`start_all.sh` 已透传）。30 帧 × 3.8s ≈ 114s 原本正好卡在 120s 临界线上，是真会偶发 500 的原因。
- 若机器更慢，可把 `PYFEAT_MAX_FRAMES` 调小（如 15）换取更短等待；调大超时意义有限，Next 与 AutoDL 反向代理也有各自的等待上限。
- 若返回 422 而日志无异常，是「未检测到人脸」，属业务正常分支（光线不足、人脸太小、镜头偏移），换正对镜头重录即可。

---

