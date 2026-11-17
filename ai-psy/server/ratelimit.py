# -*- coding: utf-8 -*-
"""进程内滑动窗口限流。

便携版是单进程 Flask（threaded）部署，不引入 Redis 等外部依赖；
只用于认证类接口的暴力破解/批量注册防护，重启后计数清零可接受。
"""
import threading
import time

# 兜底上限：异常大量 key 时整体清理过期桶，避免内存无限增长
_MAX_TRACKED_KEYS = 10000

_lock = threading.Lock()
_events: dict[str, list[float]] = {}


def _trim(bucket: list[float], cutoff: float) -> list[float]:
    """丢弃窗口外的历史记录（bucket 内时间单调递增，从头弹出即可）。"""
    while bucket and bucket[0] <= cutoff:
        bucket.pop(0)
    return bucket


def _prune(now: float, window_seconds: int) -> None:
    cutoff = now - window_seconds
    for key in [k for k, v in _events.items() if not v or v[-1] <= cutoff]:
        _events.pop(key, None)


def record(key: str) -> None:
    """记录一次事件（如一次登录失败）。"""
    now = time.monotonic()
    with _lock:
        _events.setdefault(key, []).append(now)


def is_limited(key: str, limit: int, window_seconds: int) -> bool:
    """窗口内事件数是否已达上限。"""
    now = time.monotonic()
    with _lock:
        _prune(now, window_seconds)
        return len(_trim(_events.get(key, []), now - window_seconds)) >= limit


def allow(key: str, limit: int, window_seconds: int) -> bool:
    """计数并放行：窗口内第 limit 次之后的调用返回 False。"""
    now = time.monotonic()
    with _lock:
        if len(_events) > _MAX_TRACKED_KEYS:
            _prune(now, window_seconds)
        bucket = _trim(_events.setdefault(key, []), now - window_seconds)
        if len(bucket) >= limit:
            return False
        bucket.append(now)
        return True


def clear(key: str) -> None:
    """清除计数（登录成功后调用，避免正常用户被历史失败拖累）。"""
    with _lock:
        _events.pop(key, None)
