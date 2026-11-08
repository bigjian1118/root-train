# -*- coding: utf-8 -*-
"""AI 方案生成 Agent 接口（教师端专属）：召回试算 / 提交任务 / 轮询 / 取消 / 下载 / 保存。

全部接口 require_teacher；任务查询/取消/下载/保存均校验任务归属教师本人。
"""
from flask import Blueprint, jsonify, request, send_file
from io import BytesIO

from ..ai_guard import ai_unavailable
from ..security import require_teacher
from ..services import material_ai_service

bp = Blueprint("material_ai", __name__)


@bp.get("/api/teacher/materials/ai/recall-preview")
def recall_preview():
    """双路召回试算：前端据此决定是否弹「素材较少」二次确认。"""
    err = ai_unavailable()
    if err:
        return err
    _user, err = require_teacher()
    if err:
        return err
    keywords = (request.args.get("keywords") or "").strip()
    plan_type = (request.args.get("plan_type") or "").strip()
    audience = (request.args.get("audience") or "").strip()
    if not keywords:
        return jsonify({"count": 0, "low_match": True, "samples": []})
    recalled = material_ai_service.recall_materials(keywords, plan_type, audience)
    return jsonify({
        "count": len(recalled),
        "low_match": len(recalled) < material_ai_service.LOW_MATCH_THRESHOLD,
        "samples": [{"title": item["title"], "score": item["score"]} for item in recalled[:5]],
    })


@bp.post("/api/teacher/materials/ai/generate")
def generate():
    """提交生成任务：入参为表单全部字段 + confirm_low_match。"""
    err = ai_unavailable()
    if err:
        return err
    user, err = require_teacher()
    if err:
        return err
    payload, error, status = material_ai_service.submit_task(
        user, request.get_json(silent=True) or {})
    if error:
        body = {"error": error}
        if payload:
            body.update(payload)
        return jsonify(body), status
    return jsonify(payload)


@bp.get("/api/teacher/materials/ai/task/<task_id>")
def task_progress(task_id: str):
    """轮询任务状态：status / progress% / 失败原因 / 完成时全文与引用素材。"""
    user, err = require_teacher()
    if err:
        return err
    data, error = material_ai_service.get_task(task_id, user["id"])
    if error:
        return jsonify({"error": error}), 404
    return jsonify(data)


@bp.post("/api/teacher/materials/ai/task/<task_id>/cancel")
def task_cancel(task_id: str):
    user, err = require_teacher()
    if err:
        return err
    ok, error = material_ai_service.cancel_task(task_id, user["id"])
    if error:
        return jsonify({"error": error}), 400
    return jsonify({"ok": True})


@bp.get("/api/teacher/materials/ai/task/<task_id>/download")
def task_download(task_id: str):
    """导出 .docx（标准库 OOXML，保留标题层级）。"""
    user, err = require_teacher()
    if err:
        return err
    result, message = material_ai_service.build_download(task_id, user["id"])
    if result is None:
        return jsonify({"error": message}), 400
    blob, file_name = result
    return send_file(
        BytesIO(blob),
        mimetype="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        as_attachment=True,
        download_name=file_name,
    )


@bp.post("/api/teacher/materials/ai/task/<task_id>/save")
def task_save(task_id: str):
    """产物保存到素材库：按类型归档、打「AI生成」标签、记录参数并建向量索引。"""
    user, err = require_teacher()
    if err:
        return err
    data, error = material_ai_service.save_task_to_library(task_id, user)
    if error:
        return jsonify({"error": error}), 400
    return jsonify(data)
