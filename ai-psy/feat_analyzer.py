# -*- coding: utf-8 -*-
"""
py-feat 人脸视频分析封装（运行于 pyfeat_env，CPU 推理，适配 2GB 内存限额容器）。

背景（为什么要 monkey-patch 掉 facepose）：
  py-feat 0.6.x 的 Detector.__init__ 把 facepose_model 默认设为 "img2pose"，
  且 get_pretrained_models() 对 facepose_model=None 会直接 raise。因此使用默认
  Detector 时必然联网下载并实例化 img2pose 头部姿态模型（连带 resnet18，约 200MB+）。
  在 AutoDL 2GB cgroup 内存限额下，与 resmasknet(526MB)+人脸+关键点+AU 叠加后
  触发 OOM，进程被 Killed。

  本模块在首次创建 Detector 前打三个小补丁让 facepose 变成可选（传 None）：
    1) get_pretrained_models：facepose_model=None 时只校验四模型名称、返回 None，
       绝不联网下载 img2pose；
    2) Detector.__init__：默认 facepose_model=None；
    3) Detector._init_detectors：跳过后不因缺少 facepose_model_columns 而 KeyError。
  这样只加载人脸 / landmark / AU / 情绪四个必要模型，内存峰值大幅下降，2GB 够用。
  （不输出头部姿态角 pitch/roll/yaw，对情绪分析无影响。）

流程：
  1. 系统 ffmpeg 将上传视频按 2fps 抽帧为 jpg 序列
  2. Detector(detect_faces -> detect_landmarks -> detect_aus -> detect_emotions)
  3. 聚合为指标字典交给大模型生成报告

说明：
  - 权重需预先放入 <site-packages>/feat/resources/（离线，已就位）。
  - config.MOCK_MODE=True 时返回示例数据（本地展演用）。
"""
import glob
import os
import shutil
import subprocess
import tempfile

import numpy as np
from PIL import Image

import config
from rf import predictor

# ==================== monkey-patch：跳过 facepose(img2pose) ====================
_ORIG_GET_PRETRAINED_MODELS = None
_ORIG_DETECTOR_INIT = None
_ORIG_DETECTOR_INIT_DETECTORS = None


def _patch_pyfeat():
    """在首次创建 Detector 前给 py-feat 打补丁，把 facepose 变为可选，默认不加载 img2pose。"""
    global _ORIG_GET_PRETRAINED_MODELS, _ORIG_DETECTOR_INIT, _ORIG_DETECTOR_INIT_DETECTORS
    try:
        import feat.pretrained as _pretrained
        import feat.detector as _detector_mod
    except Exception:
        return  # 本机无 py-feat / 导入失败时不强打；模拟模式也不依赖它

    from feat.pretrained import PRETRAINED_MODELS

    # ---------- 1) get_pretrained_models 支持 facepose_model=None ----------
    if _ORIG_GET_PRETRAINED_MODELS is None:
        _ORIG_GET_PRETRAINED_MODELS = _pretrained.get_pretrained_models

        def _get_pretrained_models_no_pose(
            face_model, landmark_model, au_model, emotion_model,
            facepose_model, verbose=False,
        ):
            if facepose_model is None:
                get_names = lambda s: list(
                    map(lambda e: list(e.keys())[0], PRETRAINED_MODELS[s])
                )

                def _norm(m, s):
                    if m is None:
                        raise ValueError(f"{s} must be a valid model, got None")
                    mm = m.lower()
                    if mm not in get_names(s):
                        raise ValueError(f"Requested {mm} not in {get_names(s)}")
                    return mm

                # 权重已放入 resources/，这里只做事先的名称校验，不再联网下载；
                # facepose 直接置 None，让 _init_detectors 跳过整个姿态模型分支。
                return (
                    _norm(face_model, "face_model"),
                    _norm(landmark_model, "landmark_model"),
                    _norm(au_model, "au_model"),
                    _norm(emotion_model, "emotion_model"),
                    None,
                )
            # facepose 仍是正常模型名：走原逻辑（保留对 img2pose 的兼容）
            return _ORIG_GET_PRETRAINED_MODELS(
                face_model, landmark_model, au_model, emotion_model,
                facepose_model, verbose,
            )

        _pretrained.get_pretrained_models = _get_pretrained_models_no_pose

        # feat.detector 在模块顶部 `from feat.pretrained import get_pretrained_models`
        # 直接导入了原函数引用，必须连这里一起替换，Detector.__init__ 才走得到补丁版本。
        _detector_mod.get_pretrained_models = _get_pretrained_models_no_pose

    # ---------- 2) Detector.__init__ 默认 facepose_model=None ----------
    if _ORIG_DETECTOR_INIT is None:
        cls = _detector_mod.Detector
        _ORIG_DETECTOR_INIT = cls.__init__

        def _detector_init_no_pose(
            self,
            face_model="retinaface",
            landmark_model="mobilefacenet",
            au_model="xgb",
            emotion_model="resmasknet",
            facepose_model=None,  # 关键：默认不加载 img2pose
            device="cpu",
            n_jobs=1,
            verbose=False,
            **kwargs,
        ):
            return _ORIG_DETECTOR_INIT(
                self,
                face_model=face_model,
                landmark_model=landmark_model,
                au_model=au_model,
                emotion_model=emotion_model,
                facepose_model=facepose_model,
                device=device,
                n_jobs=n_jobs,
                verbose=verbose,
                **kwargs,
            )

        cls.__init__ = _detector_init_no_pose

    # ---------- 3) _init_detectors 跳过后不炸 ----------
    if _ORIG_DETECTOR_INIT_DETECTORS is None:
        orig = _detector_mod.Detector._init_detectors

        def _init_detectors_no_pose(self, *a, **kw):
            self.info.setdefault("facepose_model", None)
            # 若 facepose 被跳过，先补上列名与空容器，避免组装 output_columns 时 KeyError
            self.info.setdefault("facepose_model_columns", _EMPTY_FACEPOSE_COLS)
            if not self.info.get("facepose_model"):
                self.facepose_detector = None
            return orig(self, *a, **kw)

        _detector_mod.Detector._init_detectors = _init_detectors_no_pose


# 空 facepose 列名（本模块从不使用姿态角，仅为让 output_columns 合法）
_EMPTY_FACEPOSE_COLS = []


# ==================== 常量 ====================
AU_LABELS = {
    "AU01": "内侧眉毛抬起（忧虑/悲伤相关）",
    "AU04": "眉毛压低（愤怒/专注相关）",
    "AU06": "脸颊提起（真诚微笑标志）",
    "AU12": "嘴角提起（微笑）",
    "AU15": "嘴角下拉（不悦/悲伤）",
    "AU20": "嘴唇拉伸（紧张）",
    "AU25": "嘴唇分开（说话/惊讶）",
    "AU45": "眨眼（频密眨眼常与紧张相关）",
}

EMOTION_LABELS = ["anger", "disgust", "fear", "happiness", "sadness", "surprise"]

_ALL_AU_COLS = [
    "AU01", "AU02", "AU04", "AU05", "AU06", "AU07", "AU09", "AU10",
    "AU11", "AU12", "AU14", "AU15", "AU17", "AU20", "AU23", "AU24",
    "AU25", "AU26", "AU28", "AU43", "AU45",
]


class FaceAnalysisError(Exception):
    """视频分析失败异常"""


_detector = None


def _get_detector():
    """惰性创建并缓存 Detector（已 patch 掉 img2pose，只载人脸/landmark/AU/情绪）。"""
    global _detector
    if _detector is None:
        _patch_pyfeat()  # 首次创建前先打补丁
        from feat import Detector
        _detector = Detector(
            face_model="retinaface",
            landmark_model="mobilefacenet",
            au_model="xgb",
            # resmasknet：情绪识别高清模型（526MB）
            emotion_model="resmasknet",
            facepose_model=None,  # 关闭头部姿态模型，省内存且不影响情绪分析
            device="cpu",
        )
    return _detector


def _extract_frames(video_path: str, fps: int = 2) -> str:
    if shutil.which("ffmpeg") is None:
        raise FaceAnalysisError("系统未安装 ffmpeg，请先执行：apt install ffmpeg -y")

    frame_dir = tempfile.mkdtemp(prefix="feat_frames_")
    out_pattern = os.path.join(frame_dir, "frame_%06d.jpg")
    cmd = [
        "ffmpeg", "-y", "-i", video_path,
        "-vf", f"fps={fps}",
        "-q:v", "2",
        out_pattern,
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    if proc.returncode != 0:
        raise FaceAnalysisError(f"ffmpeg 抽帧失败：{proc.stderr[-300:]}")
    frames = glob.glob(os.path.join(frame_dir, "frame_*.jpg"))
    if not frames:
        raise FaceAnalysisError("视频未能抽出任何帧，请确认录制内容非空")
    return frame_dir


def _frame_to_arr(jpg_path: str) -> np.ndarray:
    img = Image.open(jpg_path).convert("RGB")
    return np.asarray(img, dtype=np.uint8)


def _detect_one_frame(detector, arr: np.ndarray):
    """
    对单帧做完整检测，返回 (frame_id, au_dict, emo_dict)。

    py-feat 的 detect_faces / detect_landmarks / detect_aus / detect_emotions 均返回
    list-of-lists：外层是"帧"，内层是"该帧的每张脸"。这里一次只喂一帧，所以取
    第一个帧元素；若该帧无人脸则整体跳过。au/emo 内层元素是 numpy 行向量（列名见
    detector.info 的 au_presence_columns / emotion_model_columns）。
    """
    try:
        # 逐帧调用，保持 py-feat 的调用顺序：人脸 -> landmark -> AU -> 情绪
        faces = detector.detect_faces(arr)            # [[face1, face2, ...]]
        if not faces or not faces[0]:
            return arr, None, None

        landmarks = detector.detect_landmarks(arr, faces)   # 每帧每脸的 landmark
        aus = detector.detect_aus(arr, landmarks)           # AU 行向量
        emotions = detector.detect_emotions(arr, faces, landmarks)  # 情绪行向量

        # 取第一帧的第一张脸
        au_row = aus[0][0] if aus and aus[0] is not None and len(aus[0]) else None
        emo_row = emotions[0][0] if emotions and emotions[0] is not None and len(emotions[0]) else None

        au_cols = detector.info.get("au_presence_columns") or []
        emo_cols = detector.info.get("emotion_model_columns") or EMOTION_LABELS

        au_dict = {}
        if au_row is not None:
            for k, v in zip(au_cols, np.asarray(au_row).reshape(-1)):
                if k in _ALL_AU_COLS:
                    try:
                        au_dict[k] = round(float(v), 3)
                    except Exception:
                        pass

        emo_dict = {}
        if emo_row is not None:
            for k, v in zip(emo_cols, np.asarray(emo_row).reshape(-1)):
                if k in EMOTION_LABELS:
                    try:
                        emo_dict[k] = round(float(v), 3)
                    except Exception:
                        pass
        return arr, au_dict, emo_dict
    except Exception:
        # 单帧失败不影响整体（人脸不清晰 / 模型单帧报错）
        return arr, None, None


def _aggregate(au_rows, emo_rows, total_frames: int, face_frames: int) -> dict:
    metrics = {
        "total_frames": total_frames,
        "face_frames": face_frames,
        "face_activity": round(face_frames / total_frames, 3) if total_frames else 0.0,
        "au": {},
        "emotions": {},
    }

    valid_au = [d for d in au_rows if d]
    if valid_au:
        for col in _ALL_AU_COLS:
            if col in AU_LABELS:
                vals = [d.get(col) for d in valid_au if d.get(col) is not None]
                if vals:
                    metrics["au"][col] = {
                        "label": AU_LABELS[col],
                        "mean": round(float(np.mean(vals)), 3),
                        "max": round(float(np.max(vals)), 3),
                    }

    valid_emo = [d for d in emo_rows if d]
    if valid_emo:
        for col in EMOTION_LABELS:
            vals = [d.get(col) for d in valid_emo if d.get(col) is not None]
            if vals:
                metrics["emotions"][col] = round(float(np.mean(vals)), 3)

    # ---------- dominant: 规则（投票法 + 微笑修正）兜底，随机森林可用则以模型为主 ----------
    # resmasknet 没有"平静/微笑"类，日常微笑常被误判为 anger/disgust。
    # 规则：1) 每帧取该帧最大概率的情绪投票，多数派胜出；
    #       2) AU12(嘴角上提) 与 AU06(脸颊提起) 明显 → 微笑，直接判 happiness。
    # 投票逻辑抽至 rf.predictor.rule_dominant_emotion（训练打伪标签共用，避免漂移）。
    au12 = metrics["au"].get("AU12", {}).get("mean", 0.0)
    au06 = metrics["au"].get("AU06", {}).get("mean", 0.0)
    dominant, smile, votes = predictor.rule_dominant_emotion(valid_emo, au12, au06)
    dominant_source = "规则"

    # ---------- 混合模式：随机森林情绪分类器可用则覆盖 ----------
    rf_emotion = predictor.predict_emotion(predictor.video_feature(metrics))
    if rf_emotion is not None:
        dominant = rf_emotion
        dominant_source = "rf"

    metrics["dominant_emotion"] = dominant
    metrics["dominant_emotion_source"] = dominant_source
    metrics["smile_detected"] = smile
    metrics["vote_scores"] = votes if votes else {}
    return metrics


def analyze_video(video_path: str) -> dict:
    if config.MOCK_MODE:
        return {
            "total_frames": 24,
            "face_frames": 22,
            "face_activity": 0.917,
            "au": {
                "AU06": {"label": AU_LABELS["AU06"], "mean": 0.42, "max": 0.78},
                "AU12": {"label": AU_LABELS["AU12"], "mean": 0.51, "max": 0.85},
                "AU04": {"label": AU_LABELS["AU04"], "mean": 0.08, "max": 0.2},
                "AU45": {"label": AU_LABELS["AU45"], "mean": 0.15, "max": 0.3},
            },
            "emotions": {
                "anger": 0.04, "disgust": 0.02, "fear": 0.05,
                "happiness": 0.71, "sadness": 0.09, "surprise": 0.09,
            },
            "dominant_emotion": "happiness",
            "mock": True,
        }

    frame_dir = _extract_frames(video_path)
    try:
        detector = _get_detector()
        frame_paths = sorted(glob.glob(os.path.join(frame_dir, "frame_*.jpg")))
        total_frames = len(frame_paths)

        au_rows = []
        emo_rows = []
        face_frames = 0
        for jpg in frame_paths:
            arr = _frame_to_arr(jpg)
            _, au_dict, emo_dict = _detect_one_frame(detector, arr)
            if au_dict and emo_dict:
                face_frames += 1
            au_rows.append(au_dict)
            emo_rows.append(emo_dict)

        if face_frames == 0:
            raise FaceAnalysisError("视频中未检测到人脸，请正对摄像头、保证光线充足后重录")

        return _aggregate(au_rows, emo_rows, total_frames, face_frames)
    finally:
        shutil.rmtree(frame_dir, ignore_errors=True)
