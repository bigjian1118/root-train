# Qwen2.5-7B-Instruct QLoRA 微调工程 · 统一说明文档

单卡 AutoDL RTX4090D 24G：**bf16 原版基座 + 4bit NF4 量化 + bf16 混合精度**（标准 QLoRA，不依赖 autoawq）；
仅训练 `ai_chat` 通用聊天 LoRA 适配器（psych-chat，三人群对话样本合并），产物可被 vLLM `--enable-lora` 热挂载。

## 目录文件说明

| 文件 | 功能 |
|---|---|
| `config.py` | 路径与全部超参集中配置；基座候选顺序 = bf16 原版 → hf 缓存 → AWQ 兜底 |
| `prepare_dataset.py` | 生成三人群题库（前端加载，数据盘留档）+ `ai_chat` 聊天微调数据集（9:1 切分） |
| `train_qlora.py` | QLoRA 训练主脚本；`--scenario` 选数据集，`--rank/--alpha/--lr/--epochs/--out-dir` 覆盖超参（不传 = config 默认），`--fresh` 从头训练 |
| `train_all.sh` | **一键微调启动脚本**：环境校验（conda/依赖包/显存）→ 顶部参数区集中配置（LoRA 秩/学习率/轮数等）→ 自动停 vLLM 腾退显存 → 调用 train_qlora.py；`--fresh` 从头训练 |
| `merge_adapter.py` | LoRA 适配器与 bf16 基座合并导出全量模型（见「模型合并」） |
| `chat_with_lora.py` | 基座 + adapter 加载推理自测（`--scenario`） |

**目录约定**：数据集与题库在 `{AUTODL_FS}/dataset/`（真实服务器 `/root/autodl-fs`，本地模拟自动回退项目同级 `autodl-fs/`）；基座与适配器产物在 `{AUTODL_TMP}/`（`/root/autodl-tmp`）。

---

## 一、环境依赖

- **硬件**：单卡 RTX 4090D 24GB（训练需空闲显存 ≥ 20GB）；内存 ≥ 32GB；`/root/autodl-tmp` 剩余 ≥ 30GB
- **Python**：3.12（conda 环境 `qwen_env`）
- **CUDA**：12.1（torch cu121 构建）

```bash
# 创建 qwen_env（推理 + 训练共用；pyfeat_env 属后端侧，与本目录无关）
conda create -n qwen_env python=3.12 -y
conda activate qwen_env
pip install torch==2.5.1 torchvision==0.20.1 --index-url https://download.pytorch.org/whl/cu121
pip install vllm==0.7.0 safetensors "transformers==4.51.3"

# 补齐训练依赖（标准 QLoRA 训练栈，不需要 autoawq；train_all.sh 检测到缺失时也会自动补装）
pip install peft==0.13.2 trl==0.12.0 bitsandbytes==0.45.0 accelerate==1.1.1 datasets==3.1.0

# 验证（全 ✓ 即环境 OK）
python -c "import torch, transformers, peft, bitsandbytes, trl; print('cuda可用：', torch.cuda.is_available()); print('✓ transformers', transformers.__version__, '✓ peft', peft.__version__, '✓ bnb', bitsandbytes.__version__)"

# 修 libgomp 警告（OMP_NUM_THREADS 非法值）
export OMP_NUM_THREADS=8
```

**基座模型（bf16 原版，约 16GB，必做）**：

```bash
source /etc/network_turbo          # AutoDL 学术加速
huggingface-cli download Qwen/Qwen2.5-7B-Instruct \
  --local-dir /root/autodl-tmp/Qwen2.5-7B-Instruct
unset http_proxy https_proxy
ls /root/autodl-tmp/Qwen2.5-7B-Instruct/config.json   # 能列出即完整
```

> 为什么必须 bf16：AWQ 量化基座训练依赖已废弃的 autoawq（与新版 transformers 冲突，
> `ImportError: cannot import name 'PytorchGELUTanh'`），且其 adapter 不能被 vLLM 热挂载。
> 只要 autodl-tmp 里没有 bf16 目录，config.py 就会回退 AWQ 路径报错。

## 二、数据准备

- **存放路径**：`{AUTODL_FS}/dataset/ai_chat/train.jsonl` + `val.jsonl`（9:1 切分，约 756 训练 / 84 验证）
- **生成方式**：`python prepare_dataset.py`（同时生成 `dataset/question_bank.json` 题库留档；
  该题库实际由前端 `static/data/question_bank.json` 加载，数据盘这份为备份）
- **样本格式**：JSONL 每行一条对话，`messages` 字段为角色消息数组：

```json
{"messages": [{"role": "system", "content": "..."}, {"role": "user", "content": "..."}, {"role": "assistant", "content": "..."}]}
```

- **数据构成**：三人群（小学生 / 中学生 / 大学生）× 三类样本（A 出题引导 / B 共情回应 / C 维度科普）合并打乱
- **损失范围**：训练时应用 Qwen 官方 `apply_chat_template`，仅 assistant 回答段计 loss
- SCL-90 场景化文本测试**不训练** LoRA（题库前端直接加载）

## 三、快速开始（三步启动微调）

```bash
# ① 激活环境（train_all.sh 内也会自动激活 qwen_env）
conda activate qwen_env

# ② 按需修改 train_all.sh 顶部「参数配置区」（LoRA 秩/学习率/轮数/输出目录等）

# ③ 启动训练
cd ~/ai-psy/Qwen-train
bash train_all.sh                 # 前台运行
nohup bash train_all.sh > train.log 2>&1 &   # 后台长跑
tail -f train.log

bash train_all.sh --fresh         # 忽略旧检查点，从头训练
```

中断后重跑同一条命令自动从最新 checkpoint 续训（`save_steps=50` 保存）。
脚本会自动完成：依赖包校验（缺失自动补装）、显存腾退（检测到占用即停 vLLM）、基座/数据集检查。

启动日志应显示 `模式：4bit NF4 QLoRA`；若显示 `AWQ 量化基座 + fp16 LoRA` 说明 bf16 基座目录不存在或路径名不对，回到「环境依赖」基座下载步骤检查。

**产物目录**：`/root/autodl-tmp/qwen25-7b-lora-ai_chat/`（`adapter_config.json` + `adapter_model.safetensors` + `checkpoints/`）

训练完成后推理自测：

```bash
python chat_with_lora.py -q "我最近总是失眠很焦虑" --scenario ai_chat
```

## 四、微调参数详解

全部默认值定义于 `config.py`，`train_qlora.py` CLI 可覆盖其中 5 项（下表「覆盖」列）。

**量化与精度（QLoRA 路线）**

| 参数 | 值 | 说明 |
|---|---|---|
| 基座 | Qwen2.5-7B-Instruct（bf16 原版） | 仅 bf16 基座的 adapter 可被 vLLM 热挂载 |
| 量化方案 | 4bit NF4 双重量化（bitsandbytes 0.45.0） | `QUANT_LOAD_IN_4BIT=True`，仅训练时量化加载 |
| 计算精度 | bf16 混合精度 | AWQ 基座自动回退 fp16（仅兼容旧环境，不推荐） |
| 保存策略 | 仅 LoRA 适配器权重 | 训练阶段不合并基座（量化加载不支持 merge_and_unload，合并见第六节） |

**LoRA 超参**

| 参数 | 值 | 覆盖方式 | 说明 |
|---|---|---|---|
| LORA_R（秩 r） | 8 | `--rank` | 低秩分解维度；历史消融实验表明 r=8 全 lr 收敛、性价比最优 |
| LORA_ALPHA | 16 | `--alpha` | 缩放系数，惯例取 2×r |
| LORA_DROPOUT | 0.05 | —（改 config.py） | 正则化 |
| 目标模块 | q/k/v/o_proj + gate/up/down_proj | — | 按模块名后缀匹配（量化兼容，见「常见问题」） |
| 偏置训练 | none | — | 不训练偏置 |

**训练超参**

| 参数 | 值 | 覆盖方式 | 说明 |
|---|---|---|---|
| 学习率 | 2e-4 | `--lr` | AdamW（trl SFTTrainer 默认） |
| 训练轮数 | 3 | `--epochs` | 实测总步数约 282 |
| 单卡批次 | 4 | —（改 config.py） | `PER_DEVICE_TRAIN_BATCH_SIZE` |
| 梯度累积 | 2 | — | 等效全局 batch = 8 |
| 最大序列长度 | 1024 | — | |
| warmup 比例 | 0.03 | — | |
| 权重衰减 | 0.01 | — | |
| 日志/保存间隔 | 每 10 步打印 / 每 50 步存 checkpoint | — | 断点续训依据 |
| 数据集 | `{AUTODL_FS}/dataset/ai_chat/` | —（改 config.py） | |
| 输出目录 | `{AUTODL_TMP}/qwen25-7b-lora-{scenario}` | `--out-dir` | 自定义适配器输出位置 |

实测参考（RTX 4090D，756 条训练集）：约 13 分钟 / 282 steps，train_loss 0.209→0.010，eval_loss 0.039。

## 五、模型合并（LoRA 适配器 + 基座 → 全量模型）

**先分清两条部署路线**：

- **路线 A（线上默认，推荐）：不合并**。产物是标准 QLoRA adapter，vLLM `--enable-lora` 直接热挂载（见第七节），零合并成本、更新适配器只需重挂。
- **路线 B（需要全量单模型时）：合并导出**。训练用 4bit NF4 量化加载，量化状态本身无法 merge；但 adapter 权重与量化方式无关，**重新以 bf16 非量化加载基座即可正常合并**（`merge_and_unload`）。7B bf16 全量约 15GB，24G 单卡可容纳。

```bash
conda activate qwen_env
cd ~/ai-psy/Qwen-train

# 默认：基座={AUTODL_TMP}/Qwen2.5-7B-Instruct，adapter=qwen25-7b-lora-ai_chat，
#       输出={AUTODL_TMP}/qwen25-7b-merged-psych-chat
python merge_adapter.py

# 自定义路径：
python merge_adapter.py --base /root/autodl-tmp/Qwen2.5-7B-Instruct \
                        --adapter /root/autodl-tmp/qwen25-7b-lora-ai_chat \
                        --out /root/autodl-tmp/qwen25-7b-merged-psych-chat
```

合并产物为完整模型目录（config + safetensors + tokenizer 文件），可直接 `vllm serve <合并目录>`（不再需要 `--enable-lora`），也可用于其他不支持热挂载的推理框架。

> 注意：合并必须使用 **bf16 原版基座**；AWQ 量化基座无法与 adapter 正确合并。

## 六、部署对接（vLLM 推理服务）

训练完成后重启 vLLM 挂载 psych-chat（否则聊天无个性化）：

```bash
vllm serve /root/autodl-tmp/Qwen2.5-7B-Instruct \
    --host 0.0.0.0 --port 8000 \
    --gpu-memory-utilization 0.9 \
    --enable-lora --max-loras 1 \
    --lora-modules psych-chat=/root/autodl-tmp/qwen25-7b-lora-ai_chat

curl http://127.0.0.1:8000/v1/models    # 验证就绪，预期列出基座与 psych-chat
```

- `ai-psy/start_all.sh` 已自动化：检测到 bf16 基座 + 适配器目录即自动追加 `--enable-lora` 挂载参数
- Flask 端 `ai-psy/config.py` 的 `LORA_ENABLED` 自动检测适配器目录存在即开启，无需手动改配置

## 七、常见问题

| 症状 | 原因 | 处理 |
|---|---|---|
| `ImportError: cannot import name 'PytorchGELUTanh'`（autoawq） | 本地无 bf16 基座，config 回退 AWQ 路径 | 按「环境依赖」下载 bf16 基座 |
| 日志显示 `模式：AWQ 量化基座 + fp16 LoRA` | bf16 目录名不是 `Qwen2.5-7B-Instruct` | 核对 `/root/autodl-tmp/Qwen2.5-7B-Instruct/config.json` |
| 训练启动即 CUDA OOM | vLLM 未停，显存被占 | `pkill -f "vllm serve"` 后重跑；`train_all.sh` 会自动检测腾退；训练后聊天需重跑 `bash ~/ai-psy/start_all.sh` 恢复 |
| `libgomp: Invalid value for OMP_NUM_THREADS` | 环境变量被设成非法值 | `export OMP_NUM_THREADS=8`（train_all.sh 已内置） |
| 聊天无个性化风格 | 训完没重启 vLLM 挂载 adapter | 按第七节执行 |
| 合并报 quantization 相关错误 | 用 4bit/AWQ 加载去 merge | 合并必须 bf16 非量化加载基座（用 `merge_adapter.py` 默认行为即正确） |
| 训练 target 模块为空 | 量化加载替换 Linear 类致 isinstance 失效 | 已修复：`resolve_target_modules()` 只按模块名后缀匹配，兼容所有量化格式 |
