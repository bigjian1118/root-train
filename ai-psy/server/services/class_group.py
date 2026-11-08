# -*- coding: utf-8 -*-
"""班级聚合工具：有效班级集合与年级分组（任教班级自主修改的选项源与校验源）。

项目无班级主表，班级为自由文本；「有效」定义为：
  学生在读班级（student.class） ∪ 历史教师绑定班级（teacher_class.class_id）。
分组按名称前缀年级（如「初一(2)班」「七年级3班」「计算机2301」的年级段）尽力识别，
识别不了的归入「其他」，供前端分组展示。
"""
import re

from sqlalchemy import select

from ..extensions import db
from ..models import Student, TeacherClass

# 常见年级前缀：小学/初中/高中中文年级、年级+数字班、专业+入学年份班（如 计算机2301）
_GRADE_RE = re.compile(
    r"^(小学|初中|高中)?"
    r"(一|二|三|四|五|六|七|八|九|十|高一|高二|高三|初一|初二|初三)"
    r"(年级)?(?=[(（\d]|\s|$)"
)
_PROFESSIONAL_YEAR_RE = re.compile(r"^([\u4e00-\u9fa5]{2,6}?)(\d{4})[\d班]*$")


def valid_class_names() -> set[str]:
    student_classes = db.session.execute(select(Student.class_)).scalars().all()
    bound_classes = db.session.execute(select(TeacherClass.class_id)).scalars().all()
    return {name.strip() for name in (*student_classes, *bound_classes) if name and name.strip()}


def grade_of(class_name: str) -> str:
    """班级名 -> 年级/专业分组标签；无法识别归「其他」。"""
    match = _GRADE_RE.match(class_name)
    if match:
        prefix = match.group(1) or ""
        grade = match.group(2)
        # 「高一(2)班」这类自带高/初前缀的直接用；否则拼小学/初中/高中限定
        if grade.startswith(("高", "初")) or prefix == "":
            return f"{prefix}{grade}"
        return f"{prefix}{grade}年级"
    pro = _PROFESSIONAL_YEAR_RE.match(class_name)
    if pro:
        return pro.group(1)  # 专业名作为分组（如 计算机）
    return "其他"


def grouped_valid_classes() -> dict:
    """返回 {all:[班级名…], groups:[{grade, classes:[…]}]}，组内与组间均按名称排序。"""
    names = sorted(valid_class_names())
    buckets: dict[str, list[str]] = {}
    for name in names:
        buckets.setdefault(grade_of(name), []).append(name)
    # 「其他」固定排最后，其余按分组名排序
    group_items = sorted((k, v) for k, v in buckets.items() if k != "其他")
    if "其他" in buckets:
        group_items.append(("其他", buckets["其他"]))
    return {
        "all": names,
        "groups": [{"grade": grade, "classes": classes} for grade, classes in group_items],
    }
