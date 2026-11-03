# -*- coding: utf-8 -*-
"""
推理自测脚本：加载 bf16 基座 + LoRA 适配器进行对话测试（验证微调效果）。

【运行方式】
    python chat_with_lora.py                          # 交互模式（多轮对话）
    python chat_with_lora.py -q "我最近总是头疼怎么办"  # 单次提问

说明：训练产物仅为 LoRA 适配器；本脚本用 bf16 基座 + adapter 加载自测。
      线上部署的 AWQ 模型无法直接挂该 adapter（量化格式不兼容），
      如需线上使用微调能力，可将 adapter 合并到 bf16 基座后重新量化部署。
"""
import argparse

import config

import torch
from peft import PeftModel
from transformers import AutoModelForCausalLM, AutoTokenizer


def load_model(adapter_dir: str):
    """加载基座 + 指定场景的 LoRA 适配器（AWQ 基座必须 fp16，bf16 基座用 bfloat16）"""
    is_awq = config.MODEL_NAME.upper().endswith("-AWQ")
    dtype = torch.float16 if is_awq else torch.bfloat16
    print("[加载] tokenizer ...")
    tokenizer = AutoTokenizer.from_pretrained(config.MODEL_NAME, trust_remote_code=True)
    print(f"[加载] 基座模型（{'AWQ fp16' if is_awq else 'bf16'}）...")
    base = AutoModelForCausalLM.from_pretrained(
        config.MODEL_NAME,
        torch_dtype=dtype,
        device_map={"": 0},
        trust_remote_code=True,
    )
    print(f"[加载] LoRA 适配器：{adapter_dir} ...")
    model = PeftModel.from_pretrained(base, adapter_dir)
    model.eval()
    return tokenizer, model


def chat_once(tokenizer, model, messages) -> str:
    """单轮生成：使用 Qwen 官方 chat_template 构造输入"""
    text = tokenizer.apply_chat_template(
        messages, tokenize=False, add_generation_prompt=True
    )
    inputs = tokenizer(text, return_tensors="pt").to(model.device)
    with torch.no_grad():
        out = model.generate(
            **inputs,
            max_new_tokens=512,
            temperature=0.7,
            top_p=0.9,
            do_sample=True,
            pad_token_id=tokenizer.eos_token_id,
        )
    # 只取新生成的部分（去掉 prompt）
    new_tokens = out[0][inputs["input_ids"].shape[1]:]
    return tokenizer.decode(new_tokens, skip_special_tokens=True)


def main() -> None:
    parser = argparse.ArgumentParser(description="LoRA 模型推理自测")
    parser.add_argument("-q", "--question", type=str, default=None, help="单次提问内容")
    parser.add_argument("--scenario", type=str, default=config.AI_CHAT_KEY,
                        choices=list(config.ALL_TRAIN_KEYS),
                        help="加载对应数据集的 LoRA 适配器（当前仅 ai_chat 通用聊天适配器，"
                             "场景化文本测试 LoRA 已废弃）")
    args = parser.parse_args()

    tokenizer, model = load_model(config.scenario_output_dir(args.scenario))

    # ---------- 单次提问模式 ----------
    if args.question:
        msgs = [{"role": "user", "content": args.question}]
        print("\n[模型回复]", chat_once(tokenizer, model, msgs))
        return

    # ---------- 多轮交互模式 ----------
    print(f"\n===== 交互模式（数据集：{args.scenario}；输入 exit 退出，clear 清空上下文） =====")
    messages = []
    while True:
        user_input = input("\n你: ").strip()
        if not user_input:
            continue
        if user_input.lower() == "exit":
            break
        if user_input.lower() == "clear":
            messages = []
            print("[系统] 上下文已清空")
            continue
        messages.append({"role": "user", "content": user_input})
        reply = chat_once(tokenizer, model, messages)
        messages.append({"role": "assistant", "content": reply})
        print("\n模型:", reply)


if __name__ == "__main__":
    main()
