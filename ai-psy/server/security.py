# -*- coding: utf-8 -*-
"""鉴权、角色守卫、ID 生成等通用能力。

保持与原 Flask 版本一致的行为：
  - session["user"] 结构不变（前端契约依赖）；
  - 学生/教师角色校验返回 (user, error_response)；
  - ID 生成规则不变（时间戳 + 学号/工号 / 时间戳 + 随机数）。
"""
import os
import random
import re
from datetime import datetime

from flask import jsonify, session
from werkzeug.security import check_password_hash, generate_password_hash

# 班级名禁止出现分隔符（与原校验逻辑一致）
_CLASS_SEPARATOR_RE = re.compile(r"[,，、\n\r\t]")
# 教师多班级上限（防止一次提交过多班级）
MAX_TEACHER_CLASSES = 20

# ==================== 注册密码策略（与前端 lib/password-policy.ts 同规则） ====================
_PASSWORD_MIN_LEN = 6
_PASSWORD_MAX_LEN = 20
# 允许：数字、大小写字母、常用特殊符号（含空格，但禁止纯空格）
_PASSWORD_ALLOWED_RE = re.compile(
    r"^[0-9a-zA-Z!@#$%^&*()_+\-=\[\]{};':\"\\|,.<>/?~` ]+$"
)
# 连续 6 位及以上相同字符
_PASSWORD_REPEAT_RE = re.compile(r"(.)\1{5,}")

# ==================== 手机号校验（与前端登录/注册页同规则） ====================
# 大陆手机号：11 位、1 开头、第二位 3-9
CN_PHONE_RE = re.compile(r"^1[3-9]\d{9}$")

# 系统分配账号规则（可按需调整）：固定前缀 + 纯数字随机
ACCOUNT_PREFIX = os.environ.get("ACCOUNT_PREFIX", "")
ACCOUNT_DIGITS = int(os.environ.get("ACCOUNT_DIGITS", "8"))
ACCOUNT_MAX_RETRY = 5

# 教师任教班级数量上限（0 表示不限制，按业务需求通过环境变量调整）
MAX_TEACHER_CLASSES = int(os.environ.get("MAX_TEACHER_CLASSES", "0"))


def validate_password_policy(password: str) -> str | None:
    """注册密码规则校验，返回错误文案（None 表示通过）。"""
    if not password:
        return "请设置登录密码"
    if password.strip() == "":
        return "密码不能为纯空格"
    if not (_PASSWORD_MIN_LEN <= len(password) <= _PASSWORD_MAX_LEN):
        return f"密码长度需为 {_PASSWORD_MIN_LEN}-{_PASSWORD_MAX_LEN} 位"
    if not _PASSWORD_ALLOWED_RE.match(password):
        return "密码仅支持数字、大小写字母和常用特殊符号"
    if _PASSWORD_REPEAT_RE.search(password):
        return "密码不能包含连续 6 位以上相同字符"
    return None


def validate_cn_phone(phone: str) -> str | None:
    """注册手机号校验，返回错误文案（None 表示通过）。"""
    if not phone:
        return "请填写手机号"
    if not CN_PHONE_RE.match(phone):
        return "请输入正确的 11 位手机号"
    return None


def make_generated_account() -> str:
    """生成候选账号：前缀 + 首位非 0 的纯数字随机串。"""
    digits = "".join(
        str(random.randint(0 if index else 1, 9)) for index in range(ACCOUNT_DIGITS)
    )
    return f"{ACCOUNT_PREFIX}{digits}"


def build_password_hash(password: str) -> str:
    """PBKDF2 加盐哈希（werkzeug 默认算法）。"""
    return generate_password_hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    return check_password_hash(password_hash, password)


def make_user_id(user_no: str) -> str:
    """用户 ID：当前时间 年月日时分秒 + 学号/工号（与原逻辑一致）。"""
    return datetime.now().strftime("%Y%m%d%H%M%S") + str(user_no)


def make_business_id() -> str:
    """业务 ID（报告/预约/会话）：时间戳 + 4 位随机数。"""
    return datetime.now().strftime("%Y%m%d%H%M%S") + f"{random.randint(0, 9999):04d}"


def validate_class_names(raw) -> tuple[list[str], str | None]:
    """校验教师班级数组：去空、去重、禁分隔符、限制数量。返回 (classes, error)。"""
    if isinstance(raw, str):
        raw = [raw]
    if not isinstance(raw, list):
        return [], "班级格式非法"
    classes = []
    for item in raw:
        name = str(item).strip()
        if not name:
            continue
        if _CLASS_SEPARATOR_RE.search(name):
            return [], "班级名不能包含逗号、顿号等分隔符"
        if name not in classes:
            classes.append(name)
    if not classes:
        return [], "请至少填写一个班级"
    if len(classes) > MAX_TEACHER_CLASSES:
        return [], f"班级数量不能超过 {MAX_TEACHER_CLASSES} 个"
    return classes, None


def get_session_user() -> dict | None:
    return session.get("user")


def require_login() -> tuple[dict | None, tuple | None]:
    """登录守卫：返回 (user, None) 或 (None, (response, status))。"""
    user = session.get("user")
    if not user:
        return None, (jsonify({"error": "请先登录"}), 401)
    return user, None


def require_student() -> tuple[dict | None, tuple | None]:
    user, err = require_login()
    if err:
        return None, err
    if user.get("role") != "student":
        return None, (jsonify({"error": "仅学生账号可使用该功能"}), 403)
    return user, None


def require_teacher() -> tuple[dict | None, tuple | None]:
    user, err = require_login()
    if err:
        return None, err
    if user.get("role") != "teacher":
        return None, (jsonify({"error": "仅教师账号可查看班级报告"}), 403)
    return user, None


def reject_teacher() -> tuple | None:
    """教师不可用的学生功能（AI 聊天 / 视频 / 测评），返回错误响应或 None。"""
    user = session.get("user")
    if user and user.get("role") == "teacher":
        return jsonify({"error": "教师账号仅保留查看班级测试情况功能"}), 403
    return None
