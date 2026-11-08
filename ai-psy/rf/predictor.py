# -*- coding: utf-8 -*-
"""
随机森林推理封装（混合模式：模型为主、规则兜底）。

设计要点：
  - 惰性单例：首次调用时才加载 RF_MODEL_DIR 下的 .joblib 模型，
    进程内缓存；任一模型文件缺失 / meta 校验失败 -> 置不可用，之后直接走规则，
    不重复尝试加载、不向业务层抛异常。
  - 特征构造与训练脚本（train_text.py / train_video.py）严格共用本模块函数，
    保证训练与推理特征顺序一致。
  - 规则纯函数（Z 分数分级、情绪投票+微笑修正）也集中在此，供训练打伪标签
    与线上兜底复用，避免逻辑漂移。

对外接口：
  text_feature(factor, answers, factor_avg)   -> 文本单因子特征向量（14 维）
  video_feature(metrics)                      -> 视频聚合特征向量（23 维）
  predict_factor_severity(factor, feat)       -> (严重程度中文, 代码) | None
  predict_emotion(feat)                       -> 主导情绪 | None
  rule_factor_severity(factor_avg, mean, std) -> (中文, 代码)   # Z 分数规则
  rule_dominant_emotion(emo_rows, au_means)   -> (dominant, smile, votes)  # 投票规则
"""
import json
import os
import threading

from rf.settings import RF_MODEL_DIR

# ==================== 常量（与训练/推理共用） ====================
# 严重程度代码 -> 中文标签
SEVERITY_CN = {0: "正常", 1: "轻度", 2: "中度", 3: "重度", 4: "极重"}

# SCL-90 因子映射（标准固定条目，与前端 static/js/scl90_data.js 保持一致）
FACTOR_MAP = {
    "躯体化":        [1, 4, 12, 27, 40, 42, 48, 49, 52, 53, 56, 58],
    "强迫症状":      [3, 9, 10, 28, 38, 45, 46, 51, 55, 65],
    "人际关系敏感":  [6, 21, 34, 36, 37, 41, 61, 69, 73],
    "抑郁":          [5, 14, 15, 20, 22, 26, 29, 30, 31, 32, 54, 71, 79],
    "焦虑":          [2, 17, 23, 33, 39, 57, 72, 78, 80, 86],
    "敌对":          [11, 24, 63, 67, 74, 81],
    "恐怖":          [13, 25, 47, 50, 70, 75, 82],
    "偏执":          [8, 18, 43, 68, 76, 83],
    "精神病性":      [7, 16, 35, 62, 77, 84, 85, 87, 88, 90],
    "其他":          [19, 44, 59, 60, 64, 66, 89],
}

# 中文因子名 -> scl90_text_report 表英文列名（10 个因子分独立列，
# app.py 归档/读取时经此映射拆列与组装）
FACTOR_EN_MAP = {
    "躯体化":        "somatization",
    "强迫症状":      "ocd",
    "人际关系敏感":  "interpersonal_sensitivity",
    "抑郁":          "depression",
    "焦虑":          "anxiety",
    "敌对":          "hostility",
    "恐怖":          "phobic_anxiety",
    "偏执":          "paranoid_ideation",
    "精神病性":      "psychoticism",
    "其他":          "additional",
}

# 中国常模（金华等 1986；与 train_text.py / 前端 scl90_data.js 一致）。
# app.py 从数据库因子均分列重算 Z 分数与严重程度时使用。
CHINA_NORM = {
    "躯体化":        (1.34, 0.45),
    "强迫症状":      (1.69, 0.61),
    "人际关系敏感":  (1.76, 0.67),
    "抑郁":          (1.57, 0.61),
    "焦虑":          (1.42, 0.43),
    "敌对":          (1.50, 0.57),
    "恐怖":          (1.33, 0.47),
    "偏执":          (1.52, 0.60),
    "精神病性":      (1.36, 0.47),
    "其他":          (1.45, 0.50),
}

# 文本任务：因子题目数上限（抑郁 13 题）+ 1 维因子均分 = 14 维
MAX_FACTOR_ITEMS = 13
TEXT_FEATURE_DIM = MAX_FACTOR_ITEMS + 1

# 视频任务特征列（8 个关注 AU 的 mean/max + 6 情绪 mean + face_activity = 23 维）
VIDEO_AU_COLS = ["AU01", "AU04", "AU06", "AU12", "AU15", "AU20", "AU25", "AU45"]
VIDEO_EMOTION_COLS = ["anger", "disgust", "fear", "happiness", "sadness", "surprise"]
VIDEO_FEATURE_DIM = len(VIDEO_AU_COLS) * 2 + len(VIDEO_EMOTION_COLS) + 1

# 情绪类别（含 unknown，与规则输出值域一致）
EMOTION_CLASSES = VIDEO_EMOTION_COLS + ["unknown"]


# ==================== 规则纯函数（训练打标签 + 线上兜底共用） ====================
def rule_factor_severity(factor_avg: float, norm_mean: float, norm_std: float):
    """按中国常模 Z 分数阈值分级，返回 (中文标签, 代码)。"""
    z = round((factor_avg - norm_mean) / norm_std, 2) if norm_std > 0 else 0
    if z >= 3.0:
        return "极重", 4
    if z >= 2.0:
        return "重度", 3
    if z >= 1.0:
        return "中度", 2
    if z >= 0.5:
        return "轻度", 1
    return "正常", 0


def rule_dominant_emotion(valid_emo_rows: list, au12_mean: float, au06_mean: float):
    """
    主导情绪规则（从 feat_analyzer._aggregate 抽出）：
      1) 每帧取该帧最大概率情绪投票，多数派胜出；
      2) AU12>=0.3 且 AU06>=0.2 判为微笑，直接覆盖为 happiness。
    返回 (dominant, smile, votes)。
    """
    votes = {}
    for d in valid_emo_rows:
        m = max((k for k in VIDEO_EMOTION_COLS if k in d),
                key=lambda k: d[k], default=None)
        if m:
            votes[m] = votes.get(m, 0) + 1
    dominant = max(votes.items(), key=lambda kv: kv[1])[0] if votes else "unknown"
    smile = au12_mean >= 0.3 and au06_mean >= 0.2
    if smile:
        dominant = "happiness"
    return dominant, smile, votes


# ==================== 特征构造（训练 / 推理共用） ====================
def text_factor_items(factor: str) -> list:
    """某因子对应的题号列表（按升序，保证特征顺序稳定）"""
    return sorted(FACTOR_MAP[factor])


def text_feature(factor: str, answers: dict, factor_avg: float) -> list:
    """
    文本单因子特征（14 维）：该因子各题原始分（不足 13 题补 0）+ 因子均分。
    answers: {题号(int): 1-5}
    """
    items = text_factor_items(factor)
    vec = [float(answers.get(q, 0)) for q in items]
    vec += [0.0] * (MAX_FACTOR_ITEMS - len(vec))
    vec.append(float(factor_avg))
    return vec


def video_feature(metrics: dict) -> list:
    """
    视频聚合特征（23 维）：8 AU mean + 8 AU max + 6 情绪 mean + face_activity。
    metrics 为 feat_analyzer._aggregate 的输出结构。
    """
    au = metrics.get("au") or {}
    vec = [float(au.get(c, {}).get("mean", 0.0)) for c in VIDEO_AU_COLS]
    vec += [float(au.get(c, {}).get("max", 0.0)) for c in VIDEO_AU_COLS]
    emo = metrics.get("emotions") or {}
    vec += [float(emo.get(c, 0.0)) for c in VIDEO_EMOTION_COLS]
    vec.append(float(metrics.get("face_activity", 0.0)))
    return vec


# ==================== 模型加载（惰性单例 + 回退） ====================
_LOCK = threading.Lock()
_STATE = None  # None=未尝试加载; False=不可用; dict=已加载模型


def _expected_sklearn_version(meta: dict) -> bool:
    """meta 记录的 sklearn 主次版本与当前环境一致才允许使用（防反序列化不兼容）"""
    try:
        import sklearn
        want = str(meta.get("sklearn_version", "")).split(".")[:2]
        have = sklearn.__version__.split(".")[:2]
        return len(want) == 2 and want == have
    except Exception:
        return False


def _load():
    """尝试加载全部模型；任何缺失/异常 -> False（此后不再重试）"""
    global _STATE
    if _STATE is not None:
        return _STATE
    with _LOCK:
        if _STATE is not None:
            return _STATE
        try:
            import joblib
            model_dir = RF_MODEL_DIR
            meta_path = os.path.join(model_dir, "meta.json")
            with open(meta_path, "r", encoding="utf-8") as f:
                meta = json.load(f)
            if not _expected_sklearn_version(meta):
                print("[rf] sklearn 版本与训练时不一致，回退规则判定")
                _STATE = False
                return _STATE
            text_models = {}
            for factor in FACTOR_MAP:
                p = os.path.join(model_dir, f"scl90_{factor}.joblib")
                text_models[factor] = joblib.load(p)  # 缺失即抛异常 -> 整体回退
            emotion_model = joblib.load(os.path.join(model_dir, "emotion_rf.joblib"))
            _STATE = {"text": text_models, "emotion": emotion_model, "meta": meta}
            print(f"[rf] 随机森林模型已加载（{len(text_models)} 因子 + 情绪分类器）")
        except FileNotFoundError:
            print(f"[rf] 未找到模型文件（{RF_MODEL_DIR}），使用规则判定")
            _STATE = False
        except Exception as e:
            print(f"[rf] 模型加载失败（{e}），使用规则判定")
            _STATE = False
        return _STATE


def is_available() -> bool:
    """随机森林是否可用（模型文件齐全且版本匹配）"""
    return _load() is not False and _load() is not None


# ==================== 预测接口（失败返回 None，由调用方回退规则） ====================
def predict_factor_severity(factor: str, feature_vec: list):
    """返回 (中文标签, 代码)；模型不可用 / 异常时返回 None"""
    state = _load()
    if not state:
        return None
    try:
        clf = state["text"].get(factor)
        if clf is None:
            return None
        code = int(clf.predict([feature_vec])[0])
        return SEVERITY_CN[code], code
    except Exception as e:
        print(f"[rf] 因子「{factor}」预测异常（{e}），该项回退规则")
        return None


def predict_emotion(feature_vec: list):
    """返回主导情绪字符串；模型不可用 / 异常时返回 None"""
    state = _load()
    if not state:
        return None
    try:
        return str(state["emotion"].predict([feature_vec])[0])
    except Exception as e:
        print(f"[rf] 情绪预测异常（{e}），回退规则")
        return None
