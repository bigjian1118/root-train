# -*- coding: utf-8 -*-
"""
LoRA 适配器与基座模型合并导出脚本（bf16 基座 + psych-chat adapter → 全量模型目录）

背景：训练走 4bit NF4 量化加载（标准 QLoRA），量化状态无法 merge；
但 adapter 权重与量化方式无关，重新以 bf16 非量化加载基座即可正常
merge_and_unload。线上部署默认走 vLLM --enable-lora 热挂载、无需合并，
本脚本仅在需要「单个全量模型目录」（如不支持热挂载的推理框架）时使用。

用法（qwen_env，在 Qwen-train 目录下）：
    python merge_adapter.py                 # 默认：bf16 基座 + ai_chat adapter
    python merge_adapter.py --base <基座目录> --adapter <适配器目录> --out <输出目录>

产物：{out}/ 完整模型目录（config + safetensors + tokenizer），
可直接 vllm serve <out>（不再需要 --enable-lora）。
"""
import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import config  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(description="LoRA 适配器与 bf16 基座合并导出")
    parser.add_argument("--base", default=config.MODEL_NAME,
                        help="基座模型目录（默认 config 解析的本地基座；必须是非量化 bf16 原版）")
    parser.add_argument("--adapter", default=config.scenario_output_dir(config.AI_CHAT_KEY),
                        help="LoRA 适配器目录（默认 ai_chat 产物）")
    parser.add_argument("--out", default=os.path.join(config.AUTODL_TMP, "qwen25-7b-merged-psych-chat"),
                        help="合并后全量模型输出目录")
    args = parser.parse_args()

    # 防呆：AWQ 量化基座无法与 adapter 正确合并（训练产物即基于 bf16 基座语义）
    if "AWQ" in os.path.basename(str(args.base)).upper():
        sys.exit(f"[错误] 基座为 AWQ 量化版（{args.base}），合并必须使用 bf16 原版基座目录")
    if not os.path.isdir(args.adapter):
        sys.exit(f"[错误] 适配器目录不存在：{args.adapter}（请先完成训练或检查 --adapter 路径）")

    import torch
    from peft import PeftModel
    from transformers import AutoModelForCausalLM, AutoTokenizer

    print(f"基座：{args.base}（bf16 非量化加载）")
    print(f"适配器：{args.adapter}")
    base_model = AutoModelForCausalLM.from_pretrained(
        args.base, torch_dtype=torch.bfloat16, device_map="auto", trust_remote_code=True)
    model = PeftModel.from_pretrained(base_model, args.adapter)
    model = model.merge_and_unload()
    print(f"合并完成，导出到：{args.out}")

    os.makedirs(args.out, exist_ok=True)
    model.save_pretrained(args.out, safe_serialization=True)
    AutoTokenizer.from_pretrained(args.adapter, trust_remote_code=True).save_pretrained(args.out)

    print("✅ 合并产物为完整模型目录，可直接部署：")
    print(f"   vllm serve {args.out} --host 0.0.0.0 --port 8000 --gpu-memory-utilization 0.9")


if __name__ == "__main__":
    main()
