# -*- coding: utf-8 -*-
"""SCL-90 计分引擎（规则 + 随机森林混合分级）。

规则口径与前端 static/js/scl90_data.js / test.js 完全一致，
保证「前端预计算」与「后端 calculate_score 工具」结果可对齐。
"""
import sys
from pathlib import Path

FACTOR_MAP = {
    "躯体化": [1, 4, 12, 27, 40, 42, 48, 49, 52, 53, 56, 58],
    "强迫症状": [3, 9, 10, 28, 38, 45, 46, 51, 55, 65],
    "人际关系敏感": [6, 21, 34, 36, 37, 41, 61, 69, 73],
    "抑郁": [5, 14, 15, 20, 22, 26, 29, 30, 31, 32, 54, 71, 79],
    "焦虑": [2, 17, 23, 33, 39, 57, 72, 78, 80, 86],
    "敌对": [11, 24, 63, 67, 74, 81],
    "恐怖": [13, 25, 47, 50, 70, 75, 82],
    "偏执": [8, 18, 43, 68, 76, 83],
    "精神病性": [7, 16, 35, 62, 77, 84, 85, 87, 88, 90],
    "其他": [19, 44, 59, 60, 64, 66, 89],
}

# 中文因子名 -> 数据库英文列名
FACTOR_EN_MAP = {
    "躯体化": "somatization",
    "强迫症状": "ocd",
    "人际关系敏感": "interpersonal_sensitivity",
    "抑郁": "depression",
    "焦虑": "anxiety",
    "敌对": "hostility",
    "恐怖": "phobic_anxiety",
    "偏执": "paranoid_ideation",
    "精神病性": "psychoticism",
    "其他": "additional",
}

# 中国常模（金华等，1986）：[均值, 标准差]
CHINA_NORM = {
    "躯体化": (1.34, 0.45),
    "强迫症状": (1.69, 0.61),
    "人际关系敏感": (1.76, 0.67),
    "抑郁": (1.57, 0.61),
    "焦虑": (1.42, 0.43),
    "敌对": (1.50, 0.57),
    "恐怖": (1.33, 0.47),
    "偏执": (1.52, 0.60),
    "精神病性": (1.36, 0.47),
    "其他": (1.45, 0.50),
}

# 预警题目（自杀/自伤风险，得分 >= 4 记危机信号）
CRISIS_QUESTIONS = [15, 54, 59, 79, 89]
TOTAL_ITEMS = 90

_PREDICTOR = None


def _load_predictor():
    """惰性加载 rf/predictor（模型缺失时返回 False，不阻塞业务）。"""
    global _PREDICTOR
    if _PREDICTOR is None:
        root = Path(__file__).resolve().parent.parent
        if str(root) not in sys.path:
            sys.path.insert(0, str(root))
        try:
            from rf import predictor  # noqa: WPS433（复用既有训练/推理特征实现）
            _PREDICTOR = predictor
        except Exception:
            _PREDICTOR = False
    return _PREDICTOR


def round2(value: float) -> float:
    return round(value * 100) / 100


def rule_severity(z_score: float) -> tuple[str, int]:
    """常模 Z 分数阈值分级（与前端 ruleSeverity 一致）。"""
    if z_score >= 3.0:
        return "极重", 4
    if z_score >= 2.0:
        return "重度", 3
    if z_score >= 1.0:
        return "中度", 2
    if z_score >= 0.5:
        return "轻度", 1
    return "正常", 0


def parse_item_answers(raw) -> dict[int, int] | None:
    """规整 90 题原始分；缺失/非法返回 None。"""
    if not isinstance(raw, dict) or not raw:
        return None
    out = {}
    for key, value in raw.items():
        try:
            question, score = int(key), int(value)
        except (TypeError, ValueError):
            return None
        if not (1 <= question <= TOTAL_ITEMS and 1 <= score <= 5):
            return None
        out[question] = score
    return out


def compute_scores(answers: dict[int, int]) -> dict:
    """按 SCL-90 规则计分，输出结构与前端 scoreSCL90() 逐字段一致。"""
    answers = {int(k): int(v) for k, v in answers.items()}
    total = sum(answers.values())
    positive_count = sum(1 for v in answers.values() if v >= 3)
    positive_sum = sum(v for v in answers.values() if v >= 3)

    factors = {}
    for name, items in FACTOR_MAP.items():
        sum_score = sum(answers.get(qid, 0) for qid in items)
        avg = round2(sum_score / len(items))
        norm_mean, norm_std = CHINA_NORM[name]
        z_score = round2((avg - norm_mean) / norm_std) if norm_std > 0 else 0
        severity_cn, severity_code = rule_severity(z_score)
        factors[name] = {
            "均分": avg,
            "常模均值": norm_mean,
            "常模标准差": norm_std,
            "标准差倍数": z_score,
            "严重程度": severity_cn,
            "严重程度代码": severity_code,
            "严重程度来源": "规则",
        }

    # 按 Z 分数降序（稳定排序，同分保持因子定义顺序）
    sorted_factors = dict(
        sorted(factors.items(), key=lambda kv: kv[1]["标准差倍数"], reverse=True)
    )
    crisis = {qid: answers[qid] for qid in CRISIS_QUESTIONS if answers.get(qid, 0) >= 4}

    return {
        "总分": total,
        "总均分": round2(total / TOTAL_ITEMS),
        "阳性项目数": positive_count,
        "阳性症状均分": round2(positive_sum / positive_count) if positive_count else 0,
        "因子分": sorted_factors,
        "危机信号": crisis,
    }


def apply_rf_severity(factors: dict, answers: dict[int, int] | None) -> None:
    """随机森林混合分级：模型可用则覆盖规则严重程度，否则保留规则结果（就地修改）。"""
    if not answers:
        return
    predictor = _load_predictor()
    if not predictor:
        return
    for name, factor in factors.items():
        avg = factor.get("均分")
        if avg is None or name not in predictor.FACTOR_MAP:
            continue
        result = predictor.predict_factor_severity(
            name, predictor.text_feature(name, answers, float(avg))
        )
        if result is not None:
            factor["严重程度"], factor["严重程度代码"] = result
            factor["严重程度来源"] = "rf"


def factor_averages(result: dict) -> dict[str, float | None]:
    """前端计分结果 -> {英文列名: 因子均分}，用于落库拆列。"""
    factors = result.get("因子分") or {}
    columns = {}
    for cn, col in FACTOR_EN_MAP.items():
        item = factors.get(cn)
        columns[col] = item.get("均分") if isinstance(item, dict) else None
    return columns


def scores_from_report_row(row) -> dict:
    """由 scl90_text_report 行重算前端兼容计分 JSON（历史报告补算 Z 分数/严重程度）。"""
    factors = {}
    for cn, col in FACTOR_EN_MAP.items():
        avg = getattr(row, col)
        if avg is None:
            continue
        norm_mean, norm_std = CHINA_NORM[cn]
        severity_cn, severity_code = rule_severity(
            (avg - norm_mean) / norm_std if norm_std > 0 else 0
        )
        factors[cn] = {
            "均分": round(float(avg), 2),
            "常模均值": norm_mean,
            "常模标准差": norm_std,
            "标准差倍数": round((avg - norm_mean) / norm_std, 2) if norm_std > 0 else 0,
            "严重程度": severity_cn,
            "严重程度代码": severity_code,
            "严重程度来源": "规则",
        }
    apply_rf_severity(factors, _row_item_answers(row))
    return {
        "总分": row.total_score or 0,
        "总均分": row.gsi if row.gsi is not None else round((row.total_score or 0) / TOTAL_ITEMS, 2),
        "阳性项目数": row.pos_item_count or 0,
        "阳性症状均分": row.psdi or 0,
        "因子分": dict(sorted(factors.items(), key=lambda kv: kv[1]["标准差倍数"], reverse=True)),
        "危机信号": {"风险标记": 1} if row.risk_signal else {},
    }


def _row_item_answers(row) -> dict[int, int] | None:
    import json

    if not getattr(row, "item_answers", None):
        return None
    try:
        return {int(k): int(v) for k, v in json.loads(row.item_answers).items()}
    except (ValueError, TypeError):
        return None
