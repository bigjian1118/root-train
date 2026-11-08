# -*- coding: utf-8 -*-
"""教师端心理活动素材库：列表/详情/下载/上传（文件二进制存 file_blob）。"""
import os
from datetime import datetime
from io import BytesIO

from flask import Blueprint, jsonify, request, send_file
from sqlalchemy import func, select

from ..extensions import db
from ..models import ActivityMaterial, Teacher, now_ms
from ..security import make_business_id, require_teacher

bp = Blueprint("material", __name__)

_MS_PER_SECOND = 1000
_DEFAULT_PAGE = 1
_DEFAULT_PAGE_SIZE = 8
_MIN_PAGE_SIZE = 5
_MAX_PAGE_SIZE = 50
_UPLOAD_PATH = "/api/teacher/materials/upload"
MATERIAL_CATEGORIES = ("班会方案", "团体活动方案", "心理科普PPT", "其他")
MATERIAL_EXTS = (".pdf", ".docx", ".pptx")


@bp.before_request
def _unlimited_upload_size():
    """素材上传不受 50MB 限制：仅对该接口按请求解除上限，其他接口保持全局限制。

    Werkzeug>=2.3 支持按请求覆盖 max_content_length；旧版本自动降级为全局上限。
    """
    if request.path == _UPLOAD_PATH:
        try:
            request.max_content_length = None
        except Exception:
            pass
    return None


def _teacher_name_map(teacher_ids: list[str]) -> dict[str, str]:
    """上传者 id -> 姓名（不对外暴露教师 id）。"""
    if not teacher_ids:
        return {}
    rows = db.session.execute(
        select(Teacher.teacher_id, Teacher.name).where(Teacher.teacher_id.in_(teacher_ids))
    ).all()
    return {teacher_id: name for teacher_id, name in rows}


def _material_public_dict(material: ActivityMaterial, name_map: dict[str, str]) -> dict:
    return {
        "material_id": material.material_id,
        "title": material.title,
        "category": material.category,
        "brief": material.brief or "",
        "file_name": material.file_name,
        "file_type": material.file_type or "",
        "uploader_name": name_map.get(material.uploader, "教师"),
        # 库内毫秒 -> 本地时间展示字符串（前端直接显示）
        "upload_time": datetime.fromtimestamp(
            material.upload_time / _MS_PER_SECOND
        ).strftime("%Y-%m-%d %H:%M"),
        # AI 方案生成产物标识与参数标签（列表卡片展示「AI生成」徽标）
        "source": getattr(material, "source", "upload") or "upload",
        "tags": getattr(material, "tags", None) or "",
    }


@bp.get("/api/teacher/materials")
def list_materials():
    """素材列表：分页 + 标题关键词 + 分类筛选，所有教师可见全部素材。"""
    _user, err = require_teacher()
    if err:
        return err
    keyword = (request.args.get("q") or "").strip()
    category = (request.args.get("category") or "").strip()
    page = max(_DEFAULT_PAGE, request.args.get("page", _DEFAULT_PAGE, type=int))
    page_size = min(
        _MAX_PAGE_SIZE,
        max(_MIN_PAGE_SIZE, request.args.get("page_size", _DEFAULT_PAGE_SIZE, type=int)),
    )

    conditions = []
    if keyword:
        # SQLite 的 LIKE 对 ASCII 不区分大小写，PG 用 ilike 保持旧检索体验
        conditions.append(ActivityMaterial.title.ilike(f"%{keyword}%"))
    if category:
        conditions.append(ActivityMaterial.category == category)

    total = db.session.scalar(
        select(func.count()).select_from(ActivityMaterial).where(*conditions)
    ) or 0
    rows = db.session.scalars(
        select(ActivityMaterial)
        .where(*conditions)
        .order_by(ActivityMaterial.upload_time.desc())
        .limit(page_size)
        .offset((page - 1) * page_size)
    ).all()
    name_map = _teacher_name_map([row.uploader for row in rows])
    return jsonify({
        "total": total,
        "page": page,
        "page_size": page_size,
        "categories": list(MATERIAL_CATEGORIES),
        "materials": [_material_public_dict(row, name_map) for row in rows],
    })


@bp.get("/api/teacher/materials/<material_id>")
def get_material_detail(material_id: str):
    """素材详情：只返回元信息 + 字节数（不加载 blob 本体）。"""
    _user, err = require_teacher()
    if err:
        return err
    row = db.session.execute(
        select(ActivityMaterial, func.length(ActivityMaterial.file_blob))
        .where(ActivityMaterial.material_id == material_id)
    ).first()
    if not row:
        return jsonify({"error": "素材不存在或已被删除"}), 404
    material, file_size = row
    data = _material_public_dict(material, _teacher_name_map([material.uploader]))
    data["file_size"] = file_size or 0
    return jsonify(data)


@bp.get("/api/teacher/materials/<material_id>/download")
def download_material(material_id: str):
    """素材下载：流式返回 BLOB，按原始文件名保存（所有教师可下载）。"""
    _user, err = require_teacher()
    if err:
        return err
    row = db.session.execute(
        select(
            ActivityMaterial.file_blob,
            ActivityMaterial.file_name,
            ActivityMaterial.file_type,
        ).where(ActivityMaterial.material_id == material_id)
    ).first()
    if not row:
        return jsonify({"error": "素材不存在或已被删除"}), 404
    file_blob, file_name, file_type = row
    return send_file(
        BytesIO(file_blob),
        mimetype=file_type or "application/octet-stream",
        as_attachment=True,
        download_name=file_name,  # Flask 自动按 RFC 5987 编码中文文件名
    )


@bp.post("/api/teacher/materials/upload")
def upload_material():
    """上传素材（仅教师）：multipart title/category/brief/file，二进制直接入库。"""
    user, err = require_teacher()
    if err:
        return err
    title = (request.form.get("title") or "").strip()
    category = (request.form.get("category") or "").strip()
    brief = (request.form.get("brief") or "").strip()
    if not title:
        return jsonify({"error": "请填写素材标题"}), 400
    if category not in MATERIAL_CATEGORIES:
        return jsonify({"error": "请选择有效的素材分类"}), 400

    upload = request.files.get("file")
    if upload is None or not upload.filename:
        return jsonify({"error": "请选择要上传的文件"}), 400
    file_name = os.path.basename(upload.filename).strip()
    ext = os.path.splitext(file_name)[1].lower()
    if ext not in MATERIAL_EXTS:
        return jsonify({
            "error": f"仅支持 pdf / docx / pptx 格式，当前文件：{ext or '（无扩展名）'}"
        }), 400
    file_blob = upload.read()
    if not file_blob:
        return jsonify({"error": "文件内容为空，请重新选择"}), 400

    material_id = make_business_id()
    db.session.add(ActivityMaterial(
        material_id=material_id,
        title=title,
        category=category,
        brief=brief,
        file_blob=file_blob,
        file_name=file_name,
        file_type=upload.mimetype or "",
        uploader=user["id"],
        upload_time=now_ms(),
    ))
    db.session.commit()
    _index_material_async(material_id)
    return jsonify({"ok": True, "material_id": material_id, "title": title})


def _index_material_async(material_id: str) -> None:
    """上传即建向量索引（AI 方案生成召回依赖）；解析/嵌入失败不影响上传结果。"""
    import threading

    from flask import current_app

    app = current_app._get_current_object()

    def work() -> None:
        from ..services.material_parser import index_material

        with app.app_context():
            try:
                index_material(material_id)
            except Exception:
                app.logger.warning("[material] 素材 %s 向量索引失败，可在重建索引时补齐", material_id)

    threading.Thread(target=work, name=f"material-index-{material_id}", daemon=True).start()
