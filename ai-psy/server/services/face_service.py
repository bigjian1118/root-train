# -*- coding: utf-8 -*-
"""人脸视频分析服务客户端。

职责：把本地暂存视频交给 py-feat 网关，返回客观指标 dict。
两种模式：
  - LLM_PROVIDER=mock：返回结构完整的示例指标，便于本地演示（不依赖网关）；
  - 其他：POST {PYFEAT_GATEWAY_URL}/analyze，multipart 字段 video。
"""
import os

import requests

from ..config import Config

# 网关推理为 CPU 串行任务，按帧数上限 30 帧 × 约 3.8s/帧 ≈ 114s，
# 默认 120s 会临界超时，故放宽到 300s；可用环境变量按机器性能调整
_PYFEAT_TIMEOUT_SECONDS = int(os.environ.get("PYFEAT_TIMEOUT_SECONDS", "300"))


class FaceAnalysisError(Exception):
    """视频分析失败异常（网关不可用 / 无人脸 / 抽帧失败等）。"""


def _mock_metrics() -> dict:
    """示例指标：字段与真实分析结果保持一致，前端/提示词可直接消费。"""
    return {
        "total_frames": 24,
        "face_frames": 22,
        "face_activity": 0.917,
        "au": {
            "AU06": {"label": "脸颊提起（真诚微笑标志）", "mean": 0.42, "max": 0.78},
            "AU12": {"label": "嘴角提起（微笑）", "mean": 0.51, "max": 0.85},
            "AU04": {"label": "眉毛压低（愤怒/专注相关）", "mean": 0.08, "max": 0.2},
            "AU45": {"label": "眨眼（频密眨眼常与紧张相关）", "mean": 0.15, "max": 0.3},
        },
        "emotions": {
            "anger": 0.04, "disgust": 0.02, "fear": 0.05,
            "happiness": 0.71, "sadness": 0.09, "surprise": 0.09,
        },
        "dominant_emotion": "happiness",
        "dominant_emotion_source": "规则",
        "smile_detected": True,
        "vote_scores": {},
        "mock": True,
    }


def analyze_video(video_path: str) -> dict:
    """调用网关分析视频，返回指标 dict；失败统一抛 FaceAnalysisError。"""
    if Config.LLM_PROVIDER == "mock":
        return _mock_metrics()

    url = Config.PYFEAT_GATEWAY_URL.rstrip("/") + "/analyze"
    try:
        with open(video_path, "rb") as fh:
            resp = requests.post(
                url,
                files={"video": (os.path.basename(video_path), fh)},
                timeout=_PYFEAT_TIMEOUT_SECONDS,
            )
        resp.raise_for_status()
        data = resp.json()
    except requests.RequestException as exc:
        raise FaceAnalysisError(f"无法连接视频分析服务：{exc}") from exc
    except ValueError as exc:  # 网关返回非 JSON 文本
        raise FaceAnalysisError(f"视频分析服务返回非 JSON：{exc}") from exc

    # 兼容网关两种返回：直接给 metrics，或包一层 {"metrics": {...}}
    if isinstance(data, dict) and isinstance(data.get("metrics"), dict):
        return data["metrics"]
    if isinstance(data, dict):
        return data
    raise FaceAnalysisError("视频分析服务返回格式非法")
