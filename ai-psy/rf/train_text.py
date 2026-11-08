# -*- coding: utf-8 -*-
"""
文本测评随机森林训练（规则蒸馏）：SCL-90 各因子严重程度分级（5 类）。

思路：
  用现有 Z 分数规则自动生成伪标签 —— 随机采样大量 90 题答卷，按
  rf.predictor.rule_factor_severity（中国常模 Z 分数阈值）计算每个因子的
  「严重程度代码」作为标签，为 10 个因子各训练一个 RandomForestClassifier。
  模型学到的是规则的决策面，因此上线后可平滑替代规则、且推理更快、可扩展概率输出。

特征（14 维，与 rf.predictor.text_feature 完全一致）：
  该因子各题原始分（升序，不足 13 题补 0）+ 因子均分

标签：0 正常 / 1 轻度 / 2 中度 / 3 重度 / 4 极重

运行：
    python -m rf.train_text            # 在 ai-psy 目录下
产物：
    {RF_MODEL_DIR}/scl90_{因子名}.joblib × 10 + meta.json
"""
import json
import os
import random
import time

from rf import predictor
from rf.settings import RF_MODEL_DIR


def _sample_answers(rng: random.Random) -> dict:
    """
    混合分布采样一份 90 题答卷，保证 5 类标签都有足够样本：
      50% 均匀 1-5；30% 偏低（偏向"正常"）；20% 偏高（偏向中重度）。
    """
    r = rng.random()
    answers = {}
    for qid in range(1, 91):
        if r < 0.5:
            answers[qid] = rng.randint(1, 5)
        elif r < 0.8:
            answers[qid] = min(5, rng.randint(1, 2) + rng.randint(0, 1))  # 偏低
        else:
            answers[qid] = max(1, min(5, rng.randint(3, 5)))               # 偏高
    return answers


def build_dataset(n_samples: int):
    """返回 {因子名: (X, y)}，每因子 n_samples 行。

    伪标签 = 中国常模 Z 分数规则（rf.predictor.rule_factor_severity），
    与线上兜底规则、前端 test.js 计分逻辑完全一致；
    原后端 scl90_scorer.py 已删除（题库与计分前移到前端），此处直接复用规则纯函数。
    """
    rng = random.Random(42)
    data = {f: ([], []) for f in predictor.FACTOR_MAP}
    for _ in range(n_samples):
        answers = _sample_answers(rng)
        for factor, qids in predictor.FACTOR_MAP.items():
            scores = [answers[q] for q in qids]
            factor_avg = sum(scores) / len(scores)
            norm_mean, norm_std = predictor.CHINA_NORM[factor]
            _cn, code = predictor.rule_factor_severity(factor_avg, norm_mean, norm_std)
            data[factor][0].append(predictor.text_feature(factor, answers, factor_avg))
            data[factor][1].append(code)
    return data


def main() -> None:
    n_samples = int(os.environ.get("RF_TEXT_SAMPLES", "20000"))
    print(f"[train_text] 采样 {n_samples} 份答卷生成伪标签 ...")
    data = build_dataset(n_samples)

    from sklearn.ensemble import RandomForestClassifier
    from sklearn.metrics import accuracy_score, classification_report

    os.makedirs(RF_MODEL_DIR, exist_ok=True)
    import sklearn

    all_ok = True
    for factor, (X, y) in data.items():
        clf = RandomForestClassifier(
            n_estimators=200,
            class_weight="balanced_subsample",
            random_state=42,
            n_jobs=-1,
        )
        clf.fit(X, y)
        acc = accuracy_score(y, clf.predict(X))
        print(f"\n===== 因子「{factor}」 样本 {len(y)}  训练准确率 {acc:.4f} =====")
        print(classification_report(y, clf.predict(X), digits=3))
        if acc < 0.995:
            print(f"[警告] 因子「{factor}」准确率低于 99.5%，不写模型文件")
            all_ok = False
            continue
        import joblib
        joblib.dump(clf, os.path.join(RF_MODEL_DIR, f"scl90_{factor}.joblib"))

    if not all_ok:
        print("[train_text] 存在未达标因子，未生成完整模型集，请增大样本量后重试")
        return

    meta_path = os.path.join(RF_MODEL_DIR, "meta.json")
    meta = {}
    if os.path.exists(meta_path):
        with open(meta_path, "r", encoding="utf-8") as f:
            meta = json.load(f)
    meta.update({
        "sklearn_version": sklearn.__version__,
        "text_feature_dim": predictor.TEXT_FEATURE_DIM,
        "factors": list(predictor.FACTOR_MAP.keys()),
        "trained_at_text": time.strftime("%Y-%m-%d %H:%M:%S"),
    })
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)

    print(f"\n[train_text] 完成，模型已写入 {RF_MODEL_DIR}")


if __name__ == "__main__":
    main()
