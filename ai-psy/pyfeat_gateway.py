# -*- coding: utf-8 -*-
"""py-feat 视频分析网关（:8002）。

职责：接收 Flask 后端 `POST /analyze`（multipart 字段 video），用 py-feat 抽取
帧级 AU 强度与表情概率，聚合为与后端 face_service 约定一致的指标结构。

独立进程运行（与 Flask 分离，避免 py-feat 的 CPU 推理阻塞 Web 请求）：
    conda activate pyfeat_env
    cd ~/ai-psy && python pyfeat_gateway.py

健康检查：GET /health
"""
import atexit
import glob
import logging
import math
import os
import shutil
import subprocess
import tempfile
import threading
import time

from flask import Flask, jsonify, request

# ==================== 常量（与后端 face_service / rf.predictor 对齐） ====================
GATEWAY_PORT = int(os.environ.get("PYFEAT_PORT", "8002"))
MAX_UPLOAD_BYTES = 50 * 1024 * 1024
VIDEO_EXTENSIONS = (".webm", ".mp4", ".mov")

# 与 rf/predictor.py 的 VIDEO_AU_COLS / VIDEO_EMOTION_COLS 保持一致
AU_COLUMNS = ["AU01", "AU04", "AU06", "AU12", "AU15", "AU20", "AU25", "AU45"]
EMOTION_COLUMNS = ["anger", "disgust", "fear", "happiness", "sadness", "surprise"]

# 前端会展示 label，沿用旧版四项中文说明；其余 AU 不下发 label
AU_LABELS = {
    "AU06": "脸颊提起（真诚微笑标志）",
    "AU12": "嘴角提起（微笑）",
    "AU04": "眉毛压低（愤怒/专注相关）",
    "AU45": "眨眼（频密眨眼常与紧张相关）",
}

# 微笑判定阈值：与 rf.predictor.rule_dominant_emotion 一致
SMILE_AU12_THRESHOLD = 0.3
SMILE_AU06_THRESHOLD = 0.2

# 抽帧帧率：ffmpeg 按固定 fps 抽帧，待分析帧数只取决于视频时长（10~15 秒 ≈ 20~30 帧）。
# 历史坑点：py-feat 的 detect_video 用 av 的 stream.frames 统计总帧数，
# matroska(webm) 该字段恒为 0，会抛 ValueError: No objects to concatenate；
# 且浏览器偶尔录出数千帧的长视频，整视频管线耗时不可控，撞上反向代理 60s 掐线。
# 改为 ffmpeg 抽帧 + 逐帧 detect_image 后，两个问题从源头消除（同旧版 feat_analyzer 方案）。
EXTRACT_FPS = int(os.environ.get("PYFEAT_EXTRACT_FPS", "2"))
FRAME_EXTRACT_TIMEOUT_SECONDS = 120

# 单次分析帧数上限：CPU 约 1.5~3.8s/帧，AutoDL 自定义服务反向代理约 60s 会掐断连接，
# 10 帧（约 20~30s）最稳；抽帧超出该数时均匀降采样。
MAX_ANALYZE_FRAMES = int(os.environ.get("PYFEAT_MAX_FRAMES", "10"))

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_BYTES

# ---- 监测日志（便携版专用）----
# 独立文件 gateway_monitor.log：与 启动.bat 对 stdout 的重定向文件（gateway.log）分开，
# 避免同一文件双句柄追加写串扰；每条带时间戳，用于排查"视频分析报错"发生在哪一段。
_LOG_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "logs")
os.makedirs(_LOG_DIR, exist_ok=True)
_monitor_logger = logging.getLogger("pyfeat-gateway.monitor")
_monitor_logger.setLevel(logging.INFO)
if not _monitor_logger.handlers:
    _file_handler = logging.FileHandler(
        os.path.join(_LOG_DIR, "gateway_monitor.log"), encoding="utf-8")
    _file_handler.setFormatter(logging.Formatter("[%(asctime)s] %(message)s"))
    _monitor_logger.addHandler(_file_handler)


def _monitor(msg: str) -> None:
    """监测日志双写：文件（带时间戳）+ 控制台（进 gateway.log）。"""
    _monitor_logger.info(msg)
    print(f"[pyfeat-gateway] {msg}", flush=True)

# py-feat 推理是 CPU 重任务，单进程内串行执行，避免并发导致内存翻倍
_DETECTOR = None
_DETECTOR_LOCK = threading.Lock()
_INFER_LOCK = threading.Lock()


def _get_detector():
    """惰性加载 Detector（首次请求约需数十秒，之后进程内复用）。"""
    global _DETECTOR
    if _DETECTOR is not None:
        return _DETECTOR
    with _DETECTOR_LOCK:
        if _DETECTOR is None:
            from feat import Detector

            _monitor("Detector 首次加载开始（约需 30-60 秒，期间视频分析请求请等待勿重启）")
            _t = time.time()
            # 其余模型用 py-feat 默认值（retinaface / mobilefacenet / posenet），
            # 三者权重已在 setup_pyfeat_env.sh 离线预置，Detector 不会联网下载
            _DETECTOR = Detector(
                au_model="xgb",
                emotion_model="resmasknet",
                device="cpu",
            )
            _monitor(f"Detector 加载完成，耗时 {time.time() - _t:.1f}s")
    return _DETECTOR


def _ffmpeg_executable():
    """优先系统 ffmpeg，回退 imageio-ffmpeg 自带二进制；两者都没有时返回 None。"""
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return None


def _extract_frames(video_path: str):
    """ffmpeg 按 EXTRACT_FPS 抽帧为 jpg 序列，返回 (帧目录, 帧路径列表)。

    走命令行 ffmpeg 而非 PyAV：webm/mp4/mov 解码兼容性最好，且不依赖容器元数据。
    """
    ffmpeg = _ffmpeg_executable()
    if ffmpeg is None:
        raise RuntimeError("未找到 ffmpeg，无法抽帧（系统命令与 imageio-ffmpeg 均不可用）")

    frame_dir = tempfile.mkdtemp(prefix="pyfeat_frames_")
    out_pattern = os.path.join(frame_dir, "frame_%06d.jpg")
    command = [
        ffmpeg, "-y", "-loglevel", "error",
        "-i", video_path,
        "-vf", f"fps={EXTRACT_FPS}", "-q:v", "2",
        out_pattern,
    ]
    try:
        subprocess.run(
            command,
            check=True,
            timeout=FRAME_EXTRACT_TIMEOUT_SECONDS,
            capture_output=True,
        )
    except subprocess.TimeoutExpired as exc:
        shutil.rmtree(frame_dir, ignore_errors=True)
        raise RuntimeError(f"ffmpeg 抽帧超时：{exc}") from exc
    except Exception as exc:
        shutil.rmtree(frame_dir, ignore_errors=True)
        raise RuntimeError(f"ffmpeg 抽帧失败：{exc}") from exc
    return frame_dir, sorted(glob.glob(os.path.join(frame_dir, "frame_*.jpg")))


def _select_frames(frame_paths: list) -> list:
    """抽帧数超过上限时均匀降采样，保证单次分析帧数 ≤ MAX_ANALYZE_FRAMES。"""
    if len(frame_paths) <= MAX_ANALYZE_FRAMES:
        return frame_paths
    step = math.ceil(len(frame_paths) / MAX_ANALYZE_FRAMES)
    return frame_paths[::step]


def _as_dataframe(result):
    """兼容 py-feat 各版本返回：Fex 对象取 Face 表，或已是 DataFrame。"""
    import pandas as pd

    if hasattr(result, "columns"):
        return result
    try:
        face_df = result["Face"]
    except Exception:
        face_df = None
    if face_df is not None and hasattr(face_df, "columns"):
        return face_df
    frames = [value for value in result.values() if hasattr(value, "columns")]
    return pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()


def _detect_frames(detector, frame_paths: list):
    """逐帧 detect_image 并合并有效帧；单帧失败（人脸不清晰等）只丢该帧不整体报错。"""
    import pandas as pd

    frames = []
    failures = []
    for path in frame_paths:
        try:
            face_df = _as_dataframe(detector.detect_image(path))
            if not face_df.empty:
                frames.append(face_df)
        except Exception as exc:
            # 历史坑点：此处静默 continue 曾把 np.mat 崩溃伪装成"未检测到人脸"，
            # 故失败明细必须落监测日志，方便区分"视频里真没脸"与"管线代码异常"
            failures.append(f"{os.path.basename(path)}: {type(exc).__name__}: {exc}")
            continue
    if failures:
        _monitor(f"单帧检测失败 {len(failures)}/{len(frame_paths)}，前 3 条明细：{failures[:3]}")
    return pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()


def _column_of(face_df, name: str):
    """按列名取值（py-feat 输出大小写不一，做一次不区分大小写匹配）。"""
    if name in face_df.columns:
        return face_df[name]
    lowered = {str(col).lower(): col for col in face_df.columns}
    col = lowered.get(name.lower())
    return face_df[col] if col is not None else None


def _column_float(face_df, name: str):
    """取数值列并清洗 NaN；缺列返回 None。"""
    col = _column_of(face_df, name)
    if col is None:
        return None
    import pandas as pd

    return pd.to_numeric(col, errors="coerce").fillna(0.0).astype(float)


def _aggregate_au(face_df) -> dict:
    """8 个关注 AU 的均值/最大值；py-feat 缺失的 AU（如 AU45）补 0。"""
    au = {}
    for name in AU_COLUMNS:
        values = _column_float(face_df, f"{name}_r")
        mean = round(float(values.mean()), 3) if values is not None and len(values) else 0.0
        peak = round(float(values.max()), 3) if values is not None and len(values) else 0.0
        item = {"mean": mean, "max": peak}
        if name in AU_LABELS:
            item["label"] = AU_LABELS[name]
        au[name] = item
    return au


def _aggregate_emotions(face_df) -> dict:
    """6 类基本情绪均值；缺列按 0 处理，保证前端图表字段齐全。"""
    emotions = {}
    for name in EMOTION_COLUMNS:
        values = _column_float(face_df, name)
        emotions[name] = round(float(values.mean()), 3) if values is not None and len(values) else 0.0
    return emotions


def _dominant_emotion(face_df, au: dict):
    """逐帧取最大概率情绪投票，AU12/AU06 达标时覆盖为 happiness（规则同 predictor）。"""
    votes = {}
    emotion_cols = {}
    for name in EMOTION_COLUMNS:
        values = _column_float(face_df, name)
        if values is not None and len(values):
            emotion_cols[name] = values

    if emotion_cols:
        row_count = min(len(values) for values in emotion_cols.values())
        for index in range(row_count):
            scores = {name: values.iloc[index] for name, values in emotion_cols.items()}
            top = max(scores, key=scores.get)
            votes[top] = votes.get(top, 0) + 1

    dominant = max(votes, key=votes.get) if votes else "unknown"
    smile = (
        au.get("AU12", {}).get("mean", 0.0) >= SMILE_AU12_THRESHOLD
        and au.get("AU06", {}).get("mean", 0.0) >= SMILE_AU06_THRESHOLD
    )
    if smile:
        dominant = "happiness"
    return dominant, smile, votes


def _build_metrics(face_df, total_frames) -> dict:
    """组装后端约定的 metrics 结构。"""
    face_frames = int(len(face_df))
    total = int(total_frames or face_frames)
    au = _aggregate_au(face_df)
    emotions = _aggregate_emotions(face_df)
    dominant, smile, votes = _dominant_emotion(face_df, au)
    return {
        "total_frames": total,
        "face_frames": face_frames,
        "face_activity": round(face_frames / total, 3) if total else 0.0,
        "au": au,
        "emotions": emotions,
        "dominant_emotion": dominant,
        "dominant_emotion_source": "规则",
        "smile_detected": smile,
        "vote_scores": votes,
    }


@app.get("/health")
def health():
    """健康检查：detector_loaded=False 表示尚未处理过请求（首次分析会慢一些）。"""
    return jsonify({"status": "ok", "detector_loaded": _DETECTOR is not None})


@app.post("/analyze")
def analyze():
    """分析上传的视频，返回 metrics；无人脸/解码失败返回 422。"""
    video = request.files.get("video")
    if video is None or not video.filename:
        return jsonify({"error": "未上传视频文件（字段名 video）"}), 400

    ext = os.path.splitext(video.filename)[1].lower()
    if ext not in VIDEO_EXTENSIONS:
        return jsonify({"error": "仅支持 webm / mp4 / mov 视频"}), 400

    handle, video_path = tempfile.mkstemp(suffix=ext, prefix="pyfeat_")
    os.close(handle)
    frame_dir = None
    _t0 = time.time()
    try:
        video.save(video_path)
        # ffmpeg 抽帧后逐帧检测：帧数只取决于时长，webm 元数据 bug 与长视频失控从源头消除
        frame_dir, frame_paths = _extract_frames(video_path)
        if not frame_paths:
            _monitor(f"分析失败：视频无有效帧 video={video.filename} "
                     f"size={os.path.getsize(video_path) / 1048576:.1f}MB 耗时={time.time() - _t0:.1f}s")
            return jsonify({"error": "视频无有效帧，请重新录制"}), 422
        selected = _select_frames(frame_paths)
        _monitor(
            f"抽帧={len(frame_paths)} 分析帧={len(selected)}（上限 {MAX_ANALYZE_FRAMES}） "
            f"video={video.filename} size={os.path.getsize(video_path) / 1048576:.1f}MB"
        )
        with _INFER_LOCK:
            face_df = _detect_frames(_get_detector(), selected)
            if face_df.empty:
                _monitor(f"分析失败：{len(selected)} 帧均未检测到人脸，"
                         f"耗时={time.time() - _t0:.1f}s（若上方有单帧失败明细则为管线异常而非无人脸）")
                return jsonify({"error": "未检测到人脸，请正对镜头重新录制"}), 422
            metrics = _build_metrics(face_df, len(selected))
        _monitor(f"分析成功：有效人脸帧={len(face_df)}，耗时={time.time() - _t0:.1f}s")
        return jsonify({"metrics": metrics})
    except Exception as exc:
        _monitor(f"分析异常：{type(exc).__name__}: {exc}，耗时={time.time() - _t0:.1f}s")
        app.logger.exception("[pyfeat-gateway] 视频分析异常")
        return jsonify({"error": f"py-feat 分析失败：{exc}"}), 500
    finally:
        try:
            os.remove(video_path)
        except OSError:
            pass
        if frame_dir:
            shutil.rmtree(frame_dir, ignore_errors=True)


@atexit.register
def _cleanup():
    """进程退出时释放 Detector，避免 CPU 推理线程残留。"""
    global _DETECTOR
    _DETECTOR = None


if __name__ == "__main__":
    print(f"[pyfeat-gateway] 监听 0.0.0.0:{GATEWAY_PORT}", flush=True)
    app.run(host="0.0.0.0", port=GATEWAY_PORT, threaded=True)
