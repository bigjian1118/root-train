# -*- coding: utf-8 -*-
"""
训练脚本：Qwen2.5-7B-Instruct QLoRA 指令微调（单卡 AutoDL RTX4090D 24G）。

严格规范（与 config.py 一一对应）：
  - 4bit NF4 双重量化（QLoRA）+ bf16 混合精度
  - LoRA r=8、lora_alpha=16、lora_dropout=0.05，目标模块自动识别
    （遍历模型 named_modules，匹配 Qwen 的 q/k/v/o/gate/up/down_proj 线性层）
  - 学习率 2e-4、epoch=3、per_device_batch=4、grad_accum=2、max_seq_length=1024
  - 必须使用 tokenizer.apply_chat_template 官方模板，禁止手写拼接 prompt
  - loss 仅对 assistant 回复段计算（prompt 区间 label 置 -100）
  - 支持断点续训（自动检测最新 checkpoint，--fresh 强制从头训练）
  - 仅保存 LoRA 适配器权重，不合并基座模型
  - 单卡运行、关闭 wandb、仅控制台打印 loss

【运行方式】
    python prepare_dataset.py          # 先生成训练素材
    python train_qlora.py              # 正常训练（有检查点自动续训）
    python train_qlora.py --fresh      # 忽略旧检查点，从头训练
    nohup python train_qlora.py > train.log 2>&1 &   # 后台长时训练
"""
import argparse
import copy
import glob
import json
import os

# 环境变量必须在 import transformers 之前生效（config 内部已设置 HF_HOME 等）
import config

import torch
from peft import LoraConfig, TaskType, get_peft_model
from torch.utils.data import Dataset
from transformers import (
    AutoModelForCausalLM,
    AutoTokenizer,
    BitsAndBytesConfig,
    DataCollatorForSeq2Seq,
    Trainer,
    TrainingArguments,
)

IGNORE_INDEX = -100  # 该位置的 token 不参与 loss 计算


def find_last_checkpoint(ckpt_dir: str):
    """在检查点目录中找出 step 最大的 checkpoint-* 子目录，无则返回 None"""
    pts = glob.glob(os.path.join(ckpt_dir, "checkpoint-*"))
    if not pts:
        return None
    return max(pts, key=lambda p: int(p.split("-")[-1]))


def resolve_target_modules(model) -> list:
    """
    自动识别适配 Qwen 的 transformer 目标模块：
    遍历模型全部子模块，按「模块名后缀」而非 isinstance 匹配 attention(q/k/v/o_proj)
    与 MLP(gate/up/down_proj)——因为 AWQ 量化会把 Linear 替换成 WQLinear，
    isinstance(module, torch.nn.Linear) 返回 False，但名字后缀保持不变。
    """
    found = set()
    for name, _module in model.named_modules():
        tail = name.split(".")[-1]
        if tail in config.TARGET_MODULE_PATTERNS:
            found.add(tail)
    targets = sorted(found)
    if not targets:
        # 打印前 20 个线性层名字帮助排查
        sample = [n for n, m in model.named_modules() if isinstance(m, torch.nn.Linear)][:20]
        raise RuntimeError(
            f"未识别到任何 Qwen 目标模块（TARGET_MODULE_PATTERNS={config.TARGET_MODULE_PATTERNS}）。\n"
            f"模型前 20 个 Linear 层：{sample}\n"
            f"当前基座：{config.MODEL_NAME}"
        )
    print(f"[LoRA] 自动识别目标模块：{targets}")
    return targets


class InstructionDataset(Dataset):
    """
    指令微调数据集（messages 对话格式）：
    使用 Qwen 官方 chat_template 渲染文本并编码，
    通过「完整对话编码 - 仅 prompt 编码」定位 assistant 回复区间，
    prompt 区间 label 置 -100，实现只对模型回复计算 loss。
    """

    def __init__(self, file_path: str, tokenizer, max_len: int):
        self.tokenizer = tokenizer
        self.max_len = max_len
        self.samples = []
        with open(file_path, "r", encoding="utf-8") as f:
            for line in f:
                if line.strip():
                    self.samples.append(json.loads(line)["messages"])
        print(f"[数据] 加载 {file_path}：{len(self.samples)} 条")

    def __len__(self):
        return len(self.samples)

    def __getitem__(self, idx):
        messages = self.samples[idx]
        tok = self.tokenizer

        # ---------- 官方模板渲染（tokenize=False 得到纯文本，便于定位边界） ----------
        # 完整对话（含 assistant 回复）
        full_text = tok.apply_chat_template(
            messages, tokenize=False, add_generation_prompt=False
        )
        # 仅到最后一个 user（不含 assistant 回复），用于计算 prompt 长度
        prompt_msgs = copy.deepcopy(messages)
        while prompt_msgs and prompt_msgs[-1]["role"] == "assistant":
            prompt_msgs.pop()
        prompt_text = tok.apply_chat_template(
            prompt_msgs, tokenize=False, add_generation_prompt=True
        )

        full_ids = tok(full_text, add_special_tokens=False)["input_ids"]
        prompt_ids = tok(prompt_text, add_special_tokens=False)["input_ids"]

        # ---------- 截断与标签 ----------
        full_ids = full_ids[: self.max_len]
        prompt_len = min(len(prompt_ids), len(full_ids))
        labels = [IGNORE_INDEX] * prompt_len + list(full_ids[prompt_len:])

        return {
            "input_ids": full_ids,
            "labels": labels,
            "attention_mask": [1] * len(full_ids),
        }


def main() -> None:
    parser = argparse.ArgumentParser(description="Qwen2.5-7B-Instruct QLoRA 训练")
    parser.add_argument("--scenario", type=str, default=None,
                        choices=list(config.ALL_TRAIN_KEYS),
                        help="选择数据集训练（当前仅 ai_chat 通用聊天库；"
                             "场景化文本测试 LoRA 已废弃）；"
                             "不传则默认使用 ai_chat 通用聊天微调数据库")
    parser.add_argument("--fresh", action="store_true", help="忽略已有检查点，从头训练")
    # ---------- 超参覆盖（不传则用 config 默认值） ----------
    parser.add_argument("--rank", type=int, default=None, help="覆盖 LoRA 秩 r（默认 config.LORA_R）")
    parser.add_argument("--alpha", type=int, default=None, help="覆盖 LoRA alpha（默认 2*rank）")
    parser.add_argument("--lr", type=float, default=None, help="覆盖学习率（默认 config.LEARNING_RATE）")
    parser.add_argument("--epochs", type=int, default=None, help="覆盖训练轮数（默认 config.NUM_EPOCHS）")
    parser.add_argument("--out-dir", type=str, default=None, help="覆盖适配器输出目录（消融扫描隔离产物用）")
    args = parser.parse_args()

    # ---------- 按数据集确定训练/验证文件与输出目录 ----------
    # ai_chat -> autodl-fs/dataset/ai_chat/（唯一训练数据集）
    key = args.scenario or config.AI_CHAT_KEY
    train_file = config.scenario_train_file(key)
    val_file = config.scenario_val_file(key)
    output_dir = args.out_dir or config.scenario_output_dir(key)
    # 超参覆盖：命令行优先，未传用 config 默认（消融扫描据此改 r/lr）
    lora_r = args.rank if args.rank is not None else config.LORA_R
    lora_alpha = args.alpha if args.alpha is not None else (lora_r * 2 if args.rank is not None else config.LORA_ALPHA)
    learning_rate = args.lr if args.lr is not None else config.LEARNING_RATE
    num_epochs = args.epochs if args.epochs is not None else config.NUM_EPOCHS
    print(f"[数据集] {key} -> 训练 {train_file}；适配器输出 {output_dir}")
    print(f"[超参] r={lora_r} alpha={lora_alpha} lr={learning_rate} epochs={num_epochs}")

    # ---------- 0. 前置检查 ----------
    if not os.path.exists(train_file):
        print(f"[错误] 找不到训练集 {train_file}")
        print("       请先运行：python prepare_dataset.py 生成训练素材")
        return

    # ---------- 1. 加载基座模型（双模式，由 config 控制） ----------
    # 模式 A：AWQ 量化基座 -> fp16 直接加载 + LoRA（不叠加 bnb）
    # 模式 B：bf16 原版基座 -> 4bit NF4 QLoRA + bf16 计算精度
    is_awq_base = config.MODEL_NAME.upper().endswith("-AWQ")
    use_bnb_4bit = (not is_awq_base) and config.QUANT_LOAD_IN_4BIT
    compute_dtype = (torch.bfloat16 if config.COMPUTE_DTYPE_NAME == "bf16"
                     else torch.float16)

    print(f"[1/4] 加载基座模型：{config.MODEL_NAME}")
    print(f"      模式：{'AWQ 量化基座 + fp16 LoRA' if is_awq_base else ('4bit NF4 QLoRA' if use_bnb_4bit else 'bf16 全精度基座 + LoRA')}")

    tokenizer = AutoTokenizer.from_pretrained(config.MODEL_NAME, trust_remote_code=True)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token  # Qwen 无独立 pad，用 eos 兜底

    if use_bnb_4bit:
        # QLoRA：bitsandbytes 4bit NF4 双重量化
        model = AutoModelForCausalLM.from_pretrained(
            config.MODEL_NAME,
            quantization_config=BitsAndBytesConfig(
                load_in_4bit=True,                    # 4bit 量化加载
                bnb_4bit_quant_type=config.QUANT_TYPE,        # nf4 正态浮点 4bit
                bnb_4bit_use_double_quant=config.USE_DOUBLE_QUANT,  # 双重量化省显存
                bnb_4bit_compute_dtype=compute_dtype,          # 计算精度
            ),
            device_map={"": 0},            # 单卡：全部权重放 cuda:0
            trust_remote_code=True,
        )
    else:
        # AWQ 基座：权重已 int4 量化，transformers 自动识别 quantize_config.json，
        # 必须以 fp16 加载（AWQ 反量化内核仅支持 fp16），不能再传 bnb 配置
        model = AutoModelForCausalLM.from_pretrained(
            config.MODEL_NAME,
            torch_dtype=compute_dtype,
            device_map={"": 0},            # 单卡：全部权重放 cuda:0
            trust_remote_code=True,
        )
    model.enable_input_require_grads()  # 量化基座 + 梯度检查点必须开启
    model.config.use_cache = False      # 训练时关闭 kv cache

    # ---------- 2. 挂载 LoRA（自动识别目标模块） ----------
    print("[2/4] 挂载 LoRA 适配器 ...")
    lora_cfg = LoraConfig(
        task_type=TaskType.CAUSAL_LM,
        r=lora_r,
        lora_alpha=lora_alpha,
        lora_dropout=config.LORA_DROPOUT,
        target_modules=resolve_target_modules(model),
        bias="none",
    )
    model = get_peft_model(model, lora_cfg)
    model.print_trainable_parameters()  # 打印可训练参数占比（约 0.2%~0.5%）

    # ---------- 3. 数据集 ----------
    print("[3/4] 构建数据集 ...")
    train_ds = InstructionDataset(train_file, tokenizer, config.MAX_SEQ_LENGTH)
    eval_ds = None
    if os.path.exists(val_file):
        eval_ds = InstructionDataset(val_file, tokenizer, config.MAX_SEQ_LENGTH)

    # ---------- 4. 训练参数与启动 ----------
    ckpt_dir = os.path.join(output_dir, "checkpoints")
    resume = None if args.fresh else find_last_checkpoint(ckpt_dir)
    if resume:
        print(f"[续训] 从检查点恢复：{resume}（--fresh 可强制从头训练）")

    train_args = TrainingArguments(
        output_dir=ckpt_dir,
        num_train_epochs=num_epochs,                           # epoch = 3（可 --epochs 覆盖）
        learning_rate=learning_rate,                           # lr = 2e-4（可 --lr 覆盖）
        per_device_train_batch_size=config.PER_DEVICE_TRAIN_BATCH_SIZE,  # 单卡 batch = 4
        gradient_accumulation_steps=config.GRADIENT_ACCUMULATION_STEPS,  # 累积 = 2
        warmup_ratio=config.WARMUP_RATIO,
        weight_decay=config.WEIGHT_DECAY,
        logging_steps=config.LOGGING_STEPS,        # 控制台按步打印 loss
        eval_strategy="epoch" if eval_ds else "no",
        save_strategy="steps",                     # 按步存检查点（断点续训用）
        save_steps=config.SAVE_STEPS,
        save_total_limit=3,                        # 最多保留 3 个检查点，防爆盘
        gradient_checkpointing=True,               # 时间换显存
        optim="paged_adamw_8bit",                  # 量化基座推荐优化器，降低显存峰值
        report_to=[],                              # 关闭 wandb / tensorboard
        # 混合精度：AWQ/fp16 基座走 fp16；bf16 QLoRA 基座走 bf16（二者互斥）
        fp16=(compute_dtype == torch.float16),
        bf16=(compute_dtype == torch.bfloat16),
        seed=42,
        remove_unused_columns=False,               # 保留自构造数据集字段
    )

    trainer = Trainer(
        model=model,
        args=train_args,
        train_dataset=train_ds,
        eval_dataset=eval_ds,
        # 动态 padding：input_ids 用 pad_token，labels 用 -100
        data_collator=DataCollatorForSeq2Seq(
            tokenizer=tokenizer, padding=True, label_pad_token_id=IGNORE_INDEX,
        ),
    )

    print("[4/4] 开始训练 ...")
    trainer.train(resume_from_checkpoint=resume)

    # ---------- 5. 仅保存 LoRA 适配器（不合并基座） ----------
    model.save_pretrained(output_dir)
    tokenizer.save_pretrained(output_dir)
    print(f"[完成] LoRA 适配器已保存至：{output_dir}")
    print("       含 adapter_config.json / adapter_model.safetensors，")
    print("       可用 chat_with_lora.py 加载自测，")
    print("       或 vLLM --enable-lora 直接加载（见 README 部署章节）。")


if __name__ == "__main__":
    main()
