# -*- coding: utf-8 -*-
"""
视频主导情绪随机森林训练（规则蒸馏）：7 类（6 基本情绪 + unknown）。

思路：
  合成聚合级 metrics（分布对齐 py-feat resmasknet/xgb 真实输出），
  喂进与线上完全相同的投票+微笑修正规则（rf.predictor.rule_dominant_emotion）
  打伪标签，训练单个 RandomForestClassifier。

特征（23 维，与 rf.predictor.video_feature 完全一致）：
  8 AU mean + 8 AU max + 6 情绪 mean + face_activity

运行：
    python -m rf.train_video
产物：
    {RF_MODEL_DIR}/emotion_rf.joblib + meta.json
"""
import json
import os
import time

import numpy as np

from rf import predictor
from rf.settings import RF_MODEL_DIR


# 各情绪类对应的"主导情绪"（采样时抬高其概率），unknown 表示无有效帧
CLASSES = predictor.EMOTION_CLASSES

# 与情绪联动的 AU 抬升配置：类 -> {AU: (a, b)}（Beta 分布参数）
AU_BOOST = {
    "happiness": {"AU12": (4, 2), "AU06": (4, 2)},
    "anger":     {"AU04": (3, 2), "AU45": (3, 3)},
    "fear":      {"AU04": (2, 3), "AU20": (3, 3), "AU45": (2, 3)},
    "sadness":   {"AU01": (3, 3), "AU15": (3, 3)},
    "disgust":   {"AU04": (2, 3), "AU25": (2, 4)},
    "surprise":  {"AU01": (4, 2), "AU25": (4, 2), "AU45": (3, 3)},
    "unknown":   {},
}


def _sample_metrics(rng: np.random.Generator, dominant: str) -> dict:
    """按目标主导情绪合成一份聚合级 metrics（情绪 Dirichlet + AU Beta）"""
    emo_cols = predictor.VIDEO_EMOTION_COLS
    # ---------- 情绪概率：主导类 alpha 抬高，整体乘 0.5~0.9 缩放 ----------
    alpha = np.full(len(emo_cols), 0.5)
    if dominant in emo_cols:
        alpha[emo_cols.index(dominant)] = rng.uniform(6.0, 10.0)
    probs = rng.dirichlet(alpha) * rng.uniform(0.5, 0.9)
    emotions = {c: round(float(p), 3) for c, p in zip(emo_cols, probs)}

    # ---------- AU：非激活 Beta(1,5)，联动类抬升 ----------
    boost = AU_BOOST.get(dominant, {})
    au = {}
    for c in predictor.VIDEO_AU_COLS:
        a, b = boost.get(c, (1.0, 5.0))
        mean = float(rng.beta(a, b))
        mx = min(1.0, mean + float(rng.beta(2, 5)) * (1 - mean))
        au[c] = {"mean": round(mean, 3), "max": round(mx, 3)}

    return {
        "total_frames": int(rng.integers(10, 40)),
        "face_frames": int(rng.integers(8, 38)),
        "face_activity": round(float(rng.uniform(0.5, 1.0)), 3),
        "au": au,
        "emotions": emotions,
    }


def build_dataset(n_samples: int):
    """合成样本并按线上规则打标签"""
    rng = np.random.default_rng(42)
    X, y = [], []
    per = max(1, n_samples // len(CLASSES))
    for dominant in CLASSES:
        for _ in range(per):
            m = _sample_metrics(rng, dominant)
            # 标签 = 线上规则（投票+微笑修正）在"帧级"上的等价判定：
            # 聚合情绪均值最大者近似逐帧 argmax 投票结果，再套微笑修正
            emo = m["emotions"]
            pseudo_rows = [emo] * m["face_frames"]  # 用均值构造等效投票行
            au12 = m["au"].get("AU12", {}).get("mean", 0.0)
            au06 = m["au"].get("AU06", {}).get("mean", 0.0)
            label, _, _ = predictor.rule_dominant_emotion(pseudo_rows, au12, au06)
            X.append(predictor.video_feature(m))
            y.append(label)
    return X, y


def main() -> None:
    n_samples = int(os.environ.get("RF_VIDEO_SAMPLES", "30000"))
    print(f"[train_video] 合成 {n_samples} 条聚合指标并按规则打标签 ...")
    X, y = build_dataset(n_samples)

    from sklearn.ensemble import RandomForestClassifier
    from sklearn.metrics import accuracy_score, classification_report
    import joblib
    import sklearn

    clf = RandomForestClassifier(
        n_estimators=200,
        class_weight="balanced_subsample",
        random_state=42,
        n_jobs=-1,
    )
    clf.fit(X, y)
    pred = clf.predict(X)
    acc = accuracy_score(y, pred)
    print(f"训练样本 {len(y)}  准确率 {acc:.4f}")
    print(classification_report(y, pred, digits=3))
    if acc < 0.95:
        print("[train_video] 准确率低于 95%，不写模型文件，请增大样本量后重试")
        return

    os.makedirs(RF_MODEL_DIR, exist_ok=True)
    joblib.dump(clf, os.path.join(RF_MODEL_DIR, "emotion_rf.joblib"))

    meta_path = os.path.join(RF_MODEL_DIR, "meta.json")
    meta = {}
    if os.path.exists(meta_path):
        with open(meta_path, "r", encoding="utf-8") as f:
            meta = json.load(f)
    meta.update({
        "sklearn_version": sklearn.__version__,
        "video_feature_dim": predictor.VIDEO_FEATURE_DIM,
        "emotion_classes": list(CLASSES),
        "trained_at_video": time.strftime("%Y-%m-%d %H:%M:%S"),
    })
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)

    print(f"[train_video] 完成，模型已写入 {RF_MODEL_DIR}")


if __name__ == "__main__":
    main()
