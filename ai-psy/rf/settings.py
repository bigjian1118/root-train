# -*- coding: utf-8 -*-
"""
随机森林模型目录解析（训练脚本与推理共用）。

历史坑点：早期 rf 直接 `import config` 取项目根 config.py 的 AUTODL_FS/models。
旧单文件后端已随架构重构移除，若继续依赖根 config.py 会在删除后 ImportError，
因此这里按同样的「服务器 / 本地模拟」规则重新解析，并支持 RF_MODEL_DIR 环境变量覆盖。
"""
import os

# AutoDL 文件盘（与旧 config.AUTODL_FS 判定顺序一致，保证训练产物路径不变）
_REAL_AUTODL_FS = "/root/autodl-fs"
_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # ai-psy 目录
_MOCK_AUTODL_FS = os.path.join(os.path.dirname(_PROJECT_ROOT), "autodl-fs")

if os.path.isdir(_REAL_AUTODL_FS):
    _AUTODL_FS = _REAL_AUTODL_FS
elif os.path.isdir(_MOCK_AUTODL_FS):
    _AUTODL_FS = _MOCK_AUTODL_FS
else:
    _AUTODL_FS = _REAL_AUTODL_FS

# 模型目录可用 RF_MODEL_DIR 覆盖（如指到独立数据盘挂载目录）
RF_MODEL_DIR = os.environ.get("RF_MODEL_DIR") or os.path.join(_AUTODL_FS, "models")
