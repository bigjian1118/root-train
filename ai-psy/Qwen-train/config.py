# -*- coding: utf-8 -*-
"""
Qwen2.5-7B-Instruct QLoRA 指令微调 - 集中配置（AutoDL 单卡 RTX4090D 24G）

技术路线（当前生效：bf16 原版基座 + 4bit NF4 标准 QLoRA）：
  - 基座：Qwen2.5-7B-Instruct（bf16 原版），由下方 _LOCAL_BASE_CANDIDATES 优先匹配
          {AUTODL_TMP}/Qwen2.5-7B-Instruct；bf16 基座才支持产物被 vLLM --enable-lora 热挂载
  - 加载：bf16 基座以 bitsandbytes 4bit NF4 双重量化加载 + bf16 计算精度（QUANT_LOAD_IN_4BIT=True）
  - 历史 AWQ 分支已废弃：AWQ 量化基座需已停维护的 autoawq，且与新 transformers 不兼容
          （ImportError: cannot import name 'PytorchGELUTanh'），产物亦不支持热挂载；
          代码仍保留 AWQ 自动识别回退（fp16 直接加载、不叠加 bnb），仅兼容旧环境
  - 微调：LoRA r=8 / alpha=16 / dropout=0.05，目标模块自动识别 attention+MLP 线性层
  - 产物：仅保存 LoRA 适配器权重，不合并基座模型（量化基座不支持 merge_and_unload）
"""
import os

# ==================== 〇、数据盘根目录自适应解析 ====================
# 真实 AutoDL 服务器：数据盘为 /root/autodl-tmp（高速盘，放模型/适配器）
#                     与 /root/autodl-fs（文件存储盘，放训练数据集，持久保留）；
# 本地模拟服务器：项目同级目录下存在 autodl-tmp/、autodl-fs/ 文件夹（复刻服务器结构），
# 此时自动回退到本地模拟路径，保证同一份代码两端可直接运行。
_REAL_AUTODL_TMP = "/root/autodl-tmp"
_REAL_AUTODL_FS = "/root/autodl-fs"
_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_MOCK_AUTODL_TMP = os.path.join(_PROJECT_ROOT, "autodl-tmp")
_MOCK_AUTODL_FS = os.path.join(_PROJECT_ROOT, "autodl-fs")

# 优先真实数据盘；不存在且本地模拟目录存在时用模拟目录；否则保留真实路径（服务器上首次运行自动创建）
if os.path.isdir(_REAL_AUTODL_TMP):
    AUTODL_TMP = _REAL_AUTODL_TMP
elif os.path.isdir(_MOCK_AUTODL_TMP):
    AUTODL_TMP = _MOCK_AUTODL_TMP
else:
    AUTODL_TMP = _REAL_AUTODL_TMP

if os.path.isdir(_REAL_AUTODL_FS):
    AUTODL_FS = _REAL_AUTODL_FS
elif os.path.isdir(_MOCK_AUTODL_FS):
    AUTODL_FS = _MOCK_AUTODL_FS
else:
    AUTODL_FS = _REAL_AUTODL_FS

# ==================== 一、环境变量（必须在 import transformers 之前设置） ====================
# HuggingFace 模型缓存目录：AutoDL 数据盘（或本地模拟数据盘），避免占用系统盘
os.environ["HF_HOME"] = os.path.join(AUTODL_TMP, "huggingface")
# 国内镜像加速下载
os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
# 禁用 wandb 在线日志，仅控制台打印 loss
os.environ["WANDB_DISABLED"] = "true"

# ==================== 二、路径配置 ====================
# 基座模型本地候选路径（按列表顺序优先匹配；均不存在则回退 HF 仓库名）
_LOCAL_BASE_CANDIDATES = [
    os.path.join(AUTODL_TMP, "Qwen2.5-7B-Instruct"),
    os.path.join(AUTODL_TMP, "huggingface", "hub", "models--Qwen--Qwen2.5-7B-Instruct"),
    os.path.join(AUTODL_TMP, "Qwen2.5-7B-Instruct-AWQ"),
]
MODEL_NAME = next(
    (p for p in _LOCAL_BASE_CANDIDATES if os.path.isdir(p)),
    "Qwen/Qwen2.5-7B-Instruct",
)

# ==================== 二点五、数据集目录结构（autodl-fs/dataset） ====================
# 训练数据集统一存放在文件存储盘 autodl-fs（持久保留，实例释放不丢失）。
#   {AUTODL_FS}/dataset/
#   ├── ai_chat/            # AI 聊天通用微调数据库（三人群对话样本合并打乱）
#   └── question_bank.json  # 网站场景化题库（数据盘留档，前端实际加载 static/data/）
DATASET_ROOT = os.path.join(AUTODL_FS, "dataset")

# 仅保留 ai_chat 通用聊天微调数据集
AI_CHAT_KEY = "ai_chat"
ALL_TRAIN_KEYS = (AI_CHAT_KEY,)

def dataset_subdir(key: str) -> str:
    """某数据集（场景 / ai_chat）的独立子文件夹"""
    return os.path.join(DATASET_ROOT, key)

def scenario_train_file(scenario: str) -> str:
    """某数据集的训练集（prepare_dataset.py 生成）"""
    return os.path.join(dataset_subdir(scenario), "train.jsonl")

def scenario_val_file(scenario: str) -> str:
    """某数据集的验证集（prepare_dataset.py 生成）"""
    return os.path.join(dataset_subdir(scenario), "val.jsonl")

def scenario_output_dir(scenario: str) -> str:
    """某场景 LoRA 适配器输出目录（vLLM --enable-lora 直接加载此目录）"""
    return os.path.join(AUTODL_TMP, f"qwen25-7b-lora-{scenario}")

# 网站场景化题库（prepare_dataset.py 生成；前端实际静态加载 static/data/question_bank.json，
# 数据盘这份为留档备份）
QUESTION_BANK_FILE = os.path.join(DATASET_ROOT, "question_bank.json")

# 默认训练/验证集路径（ai_chat 通用聊天微调数据库，三人群对话样本）
TRAIN_FILE = scenario_train_file(AI_CHAT_KEY)
VAL_FILE = scenario_val_file(AI_CHAT_KEY)

# LoRA 适配器输出根目录（指向 ai_chat 通用聊天适配器，实际由 --scenario 决定）
OUTPUT_DIR = scenario_output_dir(AI_CHAT_KEY)

# ==================== 三、LoRA 超参数 ====================
LORA_R = 8                  # LoRA 秩
LORA_ALPHA = 16             # 缩放系数（惯例取 2*r）
LORA_DROPOUT = 0.05         # LoRA dropout
# 目标模块自动识别：匹配 Qwen 系列 transformer 中 attention(q/k/v/o) + MLP(gate/up/down) 线性层
TARGET_MODULE_PATTERNS = (
    "q_proj", "k_proj", "v_proj", "o_proj",
    "gate_proj", "up_proj", "down_proj",
)

# ==================== 四、训练超参数 ====================
NUM_EPOCHS = 3                          # 训练轮数
LEARNING_RATE = 2e-4                    # 学习率
PER_DEVICE_TRAIN_BATCH_SIZE = 4         # 单卡批大小
GRADIENT_ACCUMULATION_STEPS = 2         # 梯度累积（等效 batch = 4 x 2 = 8）
MAX_SEQ_LENGTH = 1024                   # 最大序列长度
WARMUP_RATIO = 0.03                     # 学习率预热比例
WEIGHT_DECAY = 0.01                     # 权重衰减
LOGGING_STEPS = 10                      # 每 N 步控制台打印一次 loss
SAVE_STEPS = 50                         # 每 N 步保存检查点（断点续训用）

# ==================== 五、量化与精度配置 ====================
# 训练基座为 bf16 原版：走标准 QLoRA —— 4bit NF4 双重量化加载 + bf16 计算精度
# 若基座为 AWQ 量化版，代码会自动识别并切换为 fp16 直接加载（不叠加 bnb）。
QUANT_LOAD_IN_4BIT = True         # bf16 基座：True（4bit NF4 QLoRA）
QUANT_TYPE = "nf4"
USE_DOUBLE_QUANT = True
COMPUTE_DTYPE_NAME = "bf16"       # bf16 基座用 bf16；AWQ 基座自动回退 fp16
