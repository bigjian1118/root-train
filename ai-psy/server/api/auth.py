# -*- coding: utf-8 -*-
"""认证与个人资料接口：注册 / 登录 / 登出 / 当前用户 / 资料查询与更新。

接口契约（字段、状态码、中文文案）与旧 Flask 版本保持一致；
session["user"] 结构 {id, role, name, account, class, classes} 前端依赖，不可改动。
"""
import re

from flask import Blueprint, jsonify, request, session
from sqlalchemy import or_, select
from sqlalchemy.exc import IntegrityError, SQLAlchemyError

from ..extensions import db
from ..models import Student, Teacher, TeacherClass, now_ms
from ..security import (
    ACCOUNT_MAX_RETRY, MAX_TEACHER_CLASSES, build_password_hash,
    make_generated_account, make_user_id,
    require_login, validate_cn_phone, validate_password_policy, verify_password,
)

bp = Blueprint("auth", __name__)

_CLASS_SEPARATOR_RE = re.compile(r"[,，、\n\r\t]")
_STUDENT_ROLE = "student"
_TEACHER_ROLE = "teacher"


def _user_model(role: str):
    if role == _STUDENT_ROLE:
        return Student
    if role == _TEACHER_ROLE:
        return Teacher
    return None


def _teacher_classes(teacher_id: str) -> list[str]:
    """教师绑定班级（按绑定时间升序），业务查询的唯一入口。"""
    rows = db.session.execute(
        select(TeacherClass.class_id)
        .where(TeacherClass.teacher_id == teacher_id)
        .order_by(TeacherClass.create_timestamp.asc())
    ).scalars().all()
    return list(rows)


def _validate_class_names(raw) -> tuple[list[str], str | None]:
    """沿用旧版校验口径：错误文案带具体班级名且不限制数量（前端按此提示）。"""
    if not isinstance(raw, list):
        return [], "班级格式错误"
    clean = []
    for item in raw:
        name = str(item).strip() if item is not None else ""
        if not name:
            continue
        if _CLASS_SEPARATOR_RE.search(name):
            return [], f"班级名「{name}」不能包含逗号、顿号等分隔符"
        clean.append(name)
    if not clean:
        return [], "请至少填写一个班级"
    return list(dict.fromkeys(clean)), None


def _public_session_user(user: dict) -> dict:
    """id 为用户不可见字段，不下发给前端。"""
    return {key: value for key, value in user.items() if key != "id"}


def _set_session_user(uid: str, role: str, name: str, account: str,
                      classes: list[str]) -> dict:
    user = {
        "id": uid,
        "role": role,
        "name": name,
        "account": account,
        "classes": classes,
        "class": classes[0] if classes else "",  # 向后兼容单列 class（报告归档等依赖）
    }
    session["user"] = user
    return user


def _profile_payload(user: dict) -> dict:
    """按当前会话用户组装资料；数据库优先保证编辑后刷新不回滚，时间戳转秒。"""
    is_teacher = user.get("role") == _TEACHER_ROLE
    name, account = user.get("name"), user.get("account")
    phone = user.get("phone")
    no_val, created_ms = None, None
    classes = user.get("classes") or []

    if is_teacher:
        row = db.session.execute(
            select(Teacher).where(Teacher.teacher_id == user["id"])
        ).scalar_one_or_none()
        if row:
            no_val, name, account, phone, created_ms = (
                row.job_number, row.name, row.account, row.phone, row.login_timestamp,
            )
            classes = _teacher_classes(user["id"])
    else:
        row = db.session.execute(
            select(Student).where(Student.student_id == user["id"])
        ).scalar_one_or_none()
        if row:
            no_val, name, account, phone, created_ms = (
                row.student_no, row.name, row.account, row.phone, row.register_timestamp,
            )
            classes = [row.class_] if row.class_ else []

    return {
        "role": user.get("role"),
        "role_name": "教师" if is_teacher else "学生",
        "name": name,
        "account": account,
        "classes": classes,
        "class": ", ".join(classes),  # 兼容旧前端：拼接字符串
        "no": no_val,
        "phone": phone,
        "created_at": (created_ms // 1000) if created_ms else None,
    }


def _account_taken(account: str) -> bool:
    """账号全局唯一检查：学生/教师两表统一命名空间。"""
    for model in (Student, Teacher):
        if db.session.execute(
            select(model.account).where(model.account == account)
        ).scalar_one_or_none():
            return True
    return False


def _phone_taken(phone: str) -> bool:
    """手机号全局唯一检查：学生/教师跨角色共用同一号码空间。"""
    for model in (Student, Teacher):
        if db.session.execute(
            select(model.phone).where(model.phone == phone)
        ).scalar_one_or_none():
            return True
    return False


def _phone_taken_by_other(phone: str, self_uid: str) -> bool:
    """个人中心改手机号查重（排除自己）：新号不得被其他学生/教师占用。"""
    for model, id_column in ((Student, Student.student_id), (Teacher, Teacher.teacher_id)):
        if db.session.execute(
            select(id_column).where(model.phone == phone, id_column != self_uid)
        ).scalar_one_or_none():
            return True
    return False


@bp.post("/api/auth/register")
def register():
    """注册：手机号 + 密码；账号仍由系统自动分配，作为备用登录方式。"""
    data = request.get_json(silent=True) or {}
    role = data.get("role")
    user_no = str(data.get("no", "")).strip()
    name = str(data.get("name", "")).strip()
    # 手机号是登录凭据，注册必填（大陆 11 位）
    phone = str(data.get("phone", "")).strip()
    password = str(data.get("password", ""))
    confirm_password = str(data.get("confirm_password", ""))

    model = _user_model(role)
    if model is None:
        return jsonify({"error": "注册身份只能是 student 或 teacher"}), 400
    no_column = Teacher.job_number if role == _TEACHER_ROLE else Student.student_no

    if role == _TEACHER_ROLE:
        # 优先 classes 数组（新格式），回退 class 单字符串（旧格式兼容）
        raw_classes = data.get("classes")
        if raw_classes is None:
            raw_classes = [data.get("class", "")]
        classes, class_err = _validate_class_names(raw_classes)
        if class_err:
            return jsonify({"error": class_err}), 400
        clazz = ",".join(classes)
    else:
        clazz = str(data.get("class", "")).strip()
        if not clazz:
            return jsonify({"error": "请填写班级"}), 400
        if _CLASS_SEPARATOR_RE.search(clazz):
            return jsonify({"error": "班级名不能包含逗号、顿号等分隔符"}), 400
        classes = [clazz]

    if not user_no:
        return jsonify({"error": "请填写学号/工号"}), 400
    if not name:
        return jsonify({"error": "请填写姓名"}), 400
    phone_err = validate_cn_phone(phone)
    if phone_err:
        return jsonify({"error": phone_err}), 400

    # 密码后端兜底校验（防绕过前端直连接口）；两次不一致大小写敏感
    password_err = validate_password_policy(password)
    if password_err:
        return jsonify({"error": password_err}), 400
    if password != confirm_password:
        return jsonify({"error": "两次输入的密码不一致"}), 400

    if db.session.execute(
        select(no_column).where(no_column == user_no)
    ).scalar_one_or_none():
        return jsonify({"error": "该学号/工号已被注册"}), 409
    if _phone_taken(phone):
        return jsonify({"error": "该手机号已被注册"}), 409

    # 账号自动分配：查重 + 唯一索引冲突重试，超限返回通用提示（不暴露生成逻辑）
    uid = make_user_id(user_no)
    now = now_ms()
    password_hash = build_password_hash(password)
    for _attempt in range(ACCOUNT_MAX_RETRY):
        account = make_generated_account()
        if _account_taken(account):
            continue
        try:
            if role == _TEACHER_ROLE:
                db.session.add(Teacher(
                    teacher_id=uid, name=name, class_=clazz, job_number=user_no,
                    account=account, password=password_hash, phone=phone,
                ))
                # 多对多真正存储：teacher_class 关联表（同事务）
                for class_name in classes:
                    db.session.add(TeacherClass(
                        teacher_id=uid, class_id=class_name, create_timestamp=now,
                    ))
            else:
                db.session.add(Student(
                    student_id=uid, name=name, class_=clazz, student_no=user_no,
                    account=account, password=password_hash, phone=phone,
                    register_timestamp=now,
                ))
            db.session.commit()
        except IntegrityError:
            db.session.rollback()
            # 学号/工号并发撞车：非账号冲突，直接终止重试
            if db.session.execute(
                select(no_column).where(no_column == user_no)
            ).scalar_one_or_none():
                return jsonify({"error": "该学号/工号已被注册"}), 409
            # 手机号唯一索引冲突（并发注册同一号码）：直接返回，不再重试
            if _phone_taken(phone):
                return jsonify({"error": "该手机号已被注册"}), 409
            continue
        break
    else:
        return jsonify({"error": "注册繁忙，请稍后重试"}), 503

    if role == _TEACHER_ROLE:
        classes = _teacher_classes(uid)
    user = _set_session_user(uid, role, name, account, classes)
    return jsonify({
        "ok": True,
        "account": account,
        "phone": phone,
        "user_id": uid,
        "user": _public_session_user(user),
    })


@bp.post("/api/auth/login")
def login():
    data = request.get_json(silent=True) or {}
    role = data.get("role")
    # identifier = 手机号或系统账号；兼容旧前端仍传 account 字段
    identifier = str(data.get("identifier", data.get("account", ""))).strip()
    password = str(data.get("password", ""))

    model = _user_model(role)
    if model is None:
        return jsonify({"error": "登录身份只能是 student 或 teacher"}), 400
    if not identifier or not password:
        return jsonify({"error": "请填写手机号/账号和密码"}), 400

    row = db.session.execute(
        select(model).where(
            or_(model.phone == identifier, model.account == identifier)
        )
    ).scalar_one_or_none()
    # 账号注销功能：已注销账号禁止登录/找回。状态检查必须在密码校验之前——
    # 注销后密码已随机化，若先验密码只会得到笼统的"账号或密码错误"，不符合合规提示要求。
    if row is not None and getattr(row, "account_status", "active") == "deleted":
        return jsonify({"error": "该账号已永久注销，无法使用"}), 403
    if not row or not verify_password(password, row.password):
        return jsonify({"error": "手机号/账号或密码错误"}), 401

    if role == _TEACHER_ROLE:
        uid = row.teacher_id
        classes = _teacher_classes(uid)
        # 教师登录刷新最近登录时间（与旧版一致）
        row.login_timestamp = now_ms()
        db.session.commit()
    else:
        uid = row.student_id
        classes = [row.class_]

    user = _set_session_user(uid, role, row.name, row.account, classes)
    return jsonify({"ok": True, "user": _public_session_user(user)})


@bp.post("/api/auth/logout")
def logout():
    session.pop("user", None)
    return jsonify({"ok": True})


@bp.get("/api/auth/me")
def me():
    user = session.get("user")
    if not user:
        return jsonify({"logged_in": False, "user": None})
    return jsonify({"logged_in": True, "user": _public_session_user(user)})


@bp.get("/api/auth/profile")
def profile():
    user, err = require_login()
    if err:
        return err
    return jsonify(_profile_payload(user))


@bp.post("/api/auth/profile/update")
def update_profile():
    user, err = require_login()
    if err:
        return err
    data = request.get_json(silent=True) or {}
    name = str(data.get("name", "")).strip()
    # 手机号支持自助修改（修改后即成为新的登录凭据）；校验口径与注册一致：11 位 + 全局唯一（排除自己）
    phone = str(data.get("phone", "")).strip()
    is_teacher = user.get("role") == _TEACHER_ROLE

    if not name:
        return jsonify({"error": "请填写姓名"}), 400
    phone_err = validate_cn_phone(phone)
    if phone_err:
        return jsonify({"error": phone_err}), 400
    if _phone_taken_by_other(phone, user["id"]):
        return jsonify({"error": "该手机号已被其他账号使用"}), 409

    if is_teacher:
        raw_classes = data.get("classes")
        classes, class_err = _validate_class_names(
            raw_classes if raw_classes is not None else []
        )
        if class_err:
            return jsonify({"error": class_err}), 400
        # 数量上限：MAX_TEACHER_CLASSES=0 时不限制
        if MAX_TEACHER_CLASSES > 0 and len(classes) > MAX_TEACHER_CLASSES:
            return jsonify({"error": f"最多可选择 {MAX_TEACHER_CLASSES} 个任教班级"}), 400
        # 任教班级自主修改：后端兜底校验班级合法性，防前端篡改选择无效班级
        from ..services.class_group import valid_class_names

        invalid = [name for name in classes if name not in valid_class_names()]
        if invalid:
            return jsonify({
                "error": f"部分班级不存在或已停用（{'、'.join(invalid[:3])}），请重新选择"
            }), 400
    else:
        clazz = str(data.get("class", "")).strip()
        if not clazz:
            return jsonify({"error": "请填写班级"}), 400
        if _CLASS_SEPARATOR_RE.search(clazz):
            return jsonify({"error": "班级名不能包含逗号、顿号等分隔符"}), 400

    try:
        if is_teacher:
            row = db.session.execute(
                select(Teacher).where(Teacher.teacher_id == user["id"])
            ).scalar_one_or_none()
            # teacher_class 关联表全量覆盖（先删后插，同事务）
            old_bindings = db.session.execute(
                select(TeacherClass).where(TeacherClass.teacher_id == user["id"])
            ).scalars().all()
            old_names = [binding.class_id for binding in old_bindings]
            if row:
                # teacher.class 冗余列 = 全部班级逗号拼接；手机号随资料一并更新
                row.name, row.class_, row.phone = name, ",".join(classes), phone
            for binding in old_bindings:
                db.session.delete(binding)
            now = now_ms()
            for class_name in classes:
                db.session.add(TeacherClass(
                    teacher_id=user["id"], class_id=class_name, create_timestamp=now,
                ))
            # 任教班级变更审计日志：仅在集合实际变化时记录（操作人/前后/时间/IP）
            if set(old_names) != set(classes):
                from ..models import TeacherClassChangeLog

                db.session.add(TeacherClassChangeLog(
                    operator_id=user["id"], operator_name=name,
                    before_classes="、".join(old_names) or None,
                    after_classes="、".join(classes) or None,
                    ip=request.remote_addr, created_at=now,
                ))
            new_classes = classes
        else:
            row = db.session.execute(
                select(Student).where(Student.student_id == user["id"])
            ).scalar_one_or_none()
            if row:
                row.name, row.class_, row.phone = name, clazz, phone
            new_classes = [clazz]
        db.session.commit()
    except SQLAlchemyError:
        db.session.rollback()
        return jsonify({"error": "保存失败，请稍后重试"}), 500

    session["user"]["name"] = name
    session["user"]["classes"] = new_classes
    session["user"]["class"] = new_classes[0] if new_classes else ""
    session.modified = True
    return jsonify({"ok": True, "user": _profile_payload(session["user"])})
