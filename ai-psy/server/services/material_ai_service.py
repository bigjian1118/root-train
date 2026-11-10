# -*- coding: utf-8 -*-
"""AI 方案生成 Agent 服务：双路召回 -> 提示词组装 -> 异步生成 -> 产物落库。

任务模型：单工作线程串行消费队列（LLM 为单卡服务，并行无收益）；
进度以阶段推进（召回10% -> 生成中60% -> 完成100%），取消为协作式标记；
生成失败自动重试 1 次，LLM 超时由 Config.LLM_TIMEOUT（120s）兜底并映射为超时文案。

检索口径：关键词 LIKE（标题/简介/关键词标签）+ pgvector 语义召回双路合并，
按素材去重取最高相关度，Top 20 份进入生成上下文。
"""
import json
import os
import queue
import re
import threading
from datetime import datetime

from sqlalchemy import func, or_, select

from ..embedding import embed_query
from ..extensions import db
from ..llm import chat
from ..models import ActivityMaterial, MaterialAiTask, RagChunk, now_ms
from ..security import make_business_id
from . import material_parser

# 单日生成次数上限（无管理后台，按环境变量配置）
MATERIAL_AI_DAILY_LIMIT = int(os.environ.get("MATERIAL_AI_DAILY_LIMIT", "30"))

TOP_RECALL_MATERIALS = 20
LOW_MATCH_THRESHOLD = 3

PLAN_TYPE_PRESETS = ("活动方案", "班会方案", "教学设计", "实训方案")
AUDIENCE_PRESETS = ("小学生", "初中生", "高中生", "中职生", "大学生")
STYLE_PRESETS = ("积极活泼", "乐观向上", "严谨认真", "轻松趣味", "思政导向", "实操导向")
LENGTH_PRESETS = {
    "brief": "精简版（约 800 字）",
    "standard": "标准版（约 1500 字）",
    "detailed": "详细版（约 3000 字）",
}

# 轻量敏感词表：命中即拦截提交（合规要求，词库可持续扩充）
_SENSITIVE_WORDS = (
    "自杀方法", "自残教程", "毒品制作", "枪支制造", "暴恐", "邪教",
    "赌博网站", "诈骗话术", "色情", "颠覆",
)

_CHUNK_EXCERPT_CHARS = 260  # 每条素材进入提示词的摘录长度

# 输出结构规范：按方案类型匹配；未命中预设时用通用结构
_STRUCTURE_TEMPLATES = {
    "活动方案": (
        "一、活动主题\n二、活动背景\n三、活动目标\n四、面向对象\n五、活动时间与地点\n"
        "六、活动流程安排（分环节，含时间分配）\n七、人员分工\n八、注意事项\n九、应急预案\n十、预期效果"
    ),
    "班会方案": (
        "一、班会主题\n二、班会背景\n三、班会目标\n四、参会对象\n五、班会时长\n六、班会准备\n"
        "七、班会流程（分环节，含每个环节的师生活动与用时）\n八、班主任总结\n九、后续延伸"
    ),
    "教学设计": (
        "一、课题与课型\n二、教学对象与学情分析\n三、教学目标（知识/能力/素养）\n四、教学重难点\n"
        "五、教学方法与资源准备\n六、教学过程（导入/新授/练习/小结，含时间分配）\n"
        "七、板书设计\n八、作业与评价\n九、教学反思建议"
    ),
    "实训方案": (
        "一、实训目标\n二、实训对象与分组\n三、实训环境与设备要求\n四、实训任务分解\n"
        "五、实施步骤与时间安排\n六、安全注意事项\n七、考核评价标准\n八、成果提交要求"
    ),
}
_DEFAULT_STRUCTURE = (
    "一、方案主题\n二、背景与目标\n三、面向对象\n四、实施时间与地点\n五、具体流程安排\n"
    "六、人员与资源分工\n七、注意事项\n八、预期效果与评估方式"
)


def _match_structure(plan_type: str) -> str:
    for key, template in _STRUCTURE_TEMPLATES.items():
        if key in plan_type or plan_type in key:
            return template
    return _DEFAULT_STRUCTURE


# ==================== 校验 ====================

def validate_params(payload: dict) -> tuple[dict | None, str | None]:
    """必填与合规校验，返回 (规范化参数, 错误文案)。"""
    plan_type = str(payload.get("plan_type", "")).strip()
    audience = str(payload.get("audience", "")).strip()
    styles = [str(s).strip() for s in (payload.get("styles") or []) if str(s).strip()]
    keywords = str(payload.get("keywords", "")).strip()
    description = str(payload.get("description", "")).strip()
    length_preset = str(payload.get("length_preset", "standard")).strip()

    if not plan_type or len(plan_type) > 30:
        return None, "方案类型必填，且不超过 30 字"
    if not audience or len(audience) > 30:
        return None, "面向对象必填，且不超过 30 字"
    if not styles:
        return None, "内容风格至少选择一项"
    if not keywords or len(keywords) > 100:
        return None, "核心关键词必填，且不超过 100 字"
    if len(description) > 500:
        return None, "补充描述不超过 500 字"
    if length_preset not in LENGTH_PRESETS:
        length_preset = "standard"

    joined = f"{plan_type}{audience}{keywords}{description}"
    for word in _SENSITIVE_WORDS:
        if word in joined:
            return None, "输入内容包含违规信息，请调整后重试"

    return {
        "plan_type": plan_type, "audience": audience, "styles": styles,
        "keywords": keywords, "description": description, "length_preset": length_preset,
    }, None


# ==================== 双路召回 ====================

def recall_materials(keywords: str, plan_type: str, audience: str) -> list[dict]:
    """关键词 LIKE + 向量语义双路召回，按素材去重合并，返回 Top20。"""
    terms = [t for t in re.split(r"[\s,，、]+", keywords) if t][:6]
    like_conditions = []
    for term in terms:
        like_conditions.append(ActivityMaterial.title.ilike(f"%{term}%"))
        like_conditions.append(ActivityMaterial.brief.ilike(f"%{term}%"))
        like_conditions.append(ActivityMaterial.tags.ilike(f"%{term}%"))

    keyword_rows = []
    if like_conditions:
        keyword_rows = db.session.execute(
            select(ActivityMaterial.material_id, ActivityMaterial.title, ActivityMaterial.category)
            .where(or_(*like_conditions))
            .limit(TOP_RECALL_MATERIALS)
        ).all()

    vector_rows = []
    try:
        # 嵌入服务不可用时降级为纯关键词召回（不阻断生成）
        vector = embed_query(f"{keywords} {plan_type} {audience}")
        distance = RagChunk.embedding.cosine_distance(vector)
        vector_rows = db.session.execute(
            select(
                RagChunk.source_id, RagChunk.title, distance.label("distance")
            )
            .where(RagChunk.source_type == "material")
            .order_by(distance)
            .limit(TOP_RECALL_MATERIALS * 2)
        ).all()
    except Exception:
        vector_rows = []

    merged: dict[str, dict] = {}
    for material_id, title, category in keyword_rows:
        merged[material_id] = {"material_id": material_id, "title": title,
                               "category": category, "score": 0.6, "via": "keyword"}
    for row in vector_rows:
        entry = merged.get(row.source_id)
        score = round(1 - float(row.distance), 4)
        if entry is None:
            material = db.session.get(ActivityMaterial, row.source_id)
            if material is None:
                continue
            merged[row.source_id] = {"material_id": row.source_id, "title": material.title,
                                     "category": material.category, "score": score, "via": "vector"}
        else:
            entry["score"] = max(entry["score"], score)
            if entry["via"] != "vector":
                entry["via"] = "both"

    ranked = sorted(merged.values(), key=lambda item: item["score"], reverse=True)
    return ranked[:TOP_RECALL_MATERIALS]


def _material_excerpts(recalled: list[dict]) -> str:
    """把召回素材的向量切片拼成结构化上下文（每素材取最相关切片）。"""
    if not recalled:
        return "（素材库暂无可解析内容，请结合通用教学框架补充，并在对应位置标注[通用模板补充]）"
    lines = []
    for item in recalled:
        chunks = db.session.execute(
            select(RagChunk.content)
            .where(RagChunk.source_type == "material", RagChunk.source_id == item["material_id"])
            .limit(3)
        ).scalars().all()
        excerpt = " / ".join(c[:_CHUNK_EXCERPT_CHARS] for c in chunks) or item["title"]
        lines.append(f"· 《{item['title']}》（{item['category']}，相关度 {item['score']}）：{excerpt}")
    return "\n".join(lines)


# ==================== 提示词组装 ====================

MATERIAL_AI_SYSTEM = (
    "你是一位资深校园活动与教学设计专家，为学校教师撰写可直接落地使用的方案文档。"
    "写作原则：核心流程、环节设计、时间安排、人员分工与注意事项必须优先基于提供的校内存量素材"
    "整合重构，禁止完全脱离素材凭空捏造；存量素材不足之处可结合通用教学框架补充，"
    "并在该部分以「[通用模板补充]」明确标注。语言符合教师使用习惯，用纯自然语言分节输出，"
    "以序号（一、二、三…）组织内容，严禁使用 markdown 表格、管道符 |、代码块或任何结构化表格语法。"
)


def build_prompt(params: dict, recalled: list[dict]) -> str:
    length_label = LENGTH_PRESETS[params["length_preset"]]
    structure = _match_structure(params["plan_type"])
    parts = [
        f"请生成一份「{params['plan_type']}」，具体要求：",
        f"- 面向对象：{params['audience']}（据此调整内容难度与语言表达）",
        f"- 内容风格：{'、'.join(params['styles'])}（据此调整文案语气与活动形式）",
        f"- 核心关键词：{params['keywords']}（方案内容必须紧扣这些关键词）",
        f"- 预期篇幅：{length_label}",
    ]
    if params["description"]:
        parts.append(f"- 补充要求：{params['description']}")
    parts.append("\n【校内存量素材（检索召回，按相关度排序）】\n" + _material_excerpts(recalled))
    parts.append(f"\n【输出结构必须遵循】\n{structure}")
    parts.append("\n【硬性约束】")
    parts.append("1. 核心环节优先复用上述素材中的成熟做法，并针对关键词与对象做适配改写；")
    parts.append("2. 结尾单独一节「参考素材」，列出实际借鉴的素材标题；")
    parts.append("3. 内容积极健康，符合中小学/高校教学规范，不得出现违规表述；")
    parts.append("4. 直接输出方案正文，不要输出解释性开场白；")
    parts.append("5. 严禁输出任何 markdown 表格语法（含管道符 |、分隔线 ---、代码块），"
                 "所有需要列表或对比的内容一律用自然语言分点描述。")
    return "\n".join(parts)


# ==================== 任务队列（单工作线程） ====================

_TASK_QUEUE: "queue.Queue[str]" = queue.Queue()
_WORKER_STARTED = False
_WORKER_LOCK = threading.Lock()

# 阶段进度：状态 -> 百分比
_PROGRESS_MAP = {
    "queued": 5, "recalling": 20, "generating": 60, "saving": 90, "completed": 100,
}


def _set_progress(task_id: str, status: str, **fields) -> None:
    task = db.session.get(MaterialAiTask, task_id)
    if task is None:
        return
    task.status = status
    task.progress = _PROGRESS_MAP.get(status, task.progress)
    for key, value in fields.items():
        setattr(task, key, value)
    task.updated_at = now_ms()
    db.session.commit()


def _run_task(app, task_id: str) -> None:
    with app.app_context():
        task = db.session.get(MaterialAiTask, task_id)
        if task is None or task.status == "cancelled":
            return
        params = {
            "plan_type": task.plan_type, "audience": task.audience,
            "styles": task.styles.split(","), "keywords": task.keywords,
            "description": task.description or "", "length_preset": task.length_preset,
        }
        try:
            _set_progress(task_id, "recalling")
            recalled = recall_materials(params["keywords"], params["plan_type"], params["audience"])
            prompt = build_prompt(params, recalled)

            _set_progress(task_id, "generating",
                          recall_count=len(recalled),
                          referenced_materials=json.dumps(recalled, ensure_ascii=False))

            messages = [
                {"role": "system", "content": MATERIAL_AI_SYSTEM},
                {"role": "user", "content": prompt},
            ]
            content = ""
            for attempt in range(2):  # 失败自动重试 1 次
                try:
                    content = chat(messages, max_tokens=4096)
                    break
                except Exception as exc:
                    task = db.session.get(MaterialAiTask, task_id)
                    if task is not None:
                        task.retry_count = attempt + 1
                        db.session.commit()
                    if attempt == 1:
                        raise _GenerationError(str(exc)) from exc

            task = db.session.get(MaterialAiTask, task_id)
            if task is None or task.status == "cancelled":
                return  # 协作式取消：结果直接丢弃

            # 生成后合规校验：命中敏感词则整篇拒收（防模型输出违规内容）
            for word in _SENSITIVE_WORDS:
                if word in content:
                    raise _GenerationError("生成内容未通过合规校验，请调整关键词后重试")

            _set_progress(task_id, "completed", content=content.strip())
        except _GenerationTimeout:
            _set_progress(task_id, "timeout",
                          error_message="生成耗时过长，请精简关键词后重试")
        except Exception as exc:
            message = str(exc)
            if "timeout" in message.lower():
                _set_progress(task_id, "timeout",
                              error_message="生成耗时过长，请精简关键词后重试")
            else:
                _set_progress(task_id, "failed",
                              error_message="生成失败，请稍后重试" if not message else f"生成失败：{message[:100]}")


class _GenerationError(Exception):
    pass


class _GenerationTimeout(Exception):
    pass


def _worker_loop(app) -> None:
    while True:
        task_id = _TASK_QUEUE.get()
        try:
            _run_task(app, task_id)
        except Exception:
            app.logger.exception("[material-ai] 任务 %s 工作线程异常", task_id)
        finally:
            _TASK_QUEUE.task_done()


def start_material_ai_worker(app) -> None:
    """启动单工作线程消费生成任务队列（守护线程）。"""
    global _WORKER_STARTED
    with _WORKER_LOCK:
        if _WORKER_STARTED:
            return
        _WORKER_STARTED = True
        threading.Thread(
            target=_worker_loop, args=(app,), name="material-ai-worker", daemon=True
        ).start()


# ==================== 对外操作 ====================

def submit_task(user: dict, payload: dict) -> tuple[dict | None, str | None, int]:
    """提交生成任务。校验顺序：参数 -> 每日上限 -> 素材库空 -> 低匹配未确认。"""
    params, error = validate_params(payload)
    if error:
        return None, error, 400

    today_count = db.session.scalar(
        select(func.count()).select_from(MaterialAiTask).where(
            MaterialAiTask.teacher_id == user["id"],
            MaterialAiTask.created_at >= _today_start_ms(),
        )
    ) or 0
    if today_count >= MATERIAL_AI_DAILY_LIMIT:
        return None, "今日生成次数已达上限，请明日再用", 429

    indexed_count = db.session.scalar(
        select(func.count()).select_from(RagChunk).where(RagChunk.source_type == "material")
    ) or 0
    if indexed_count == 0:
        return None, "当前素材库暂无解析完成的素材，建议先上传方案、PPT 等文件后再使用 AI 生成", 400

    recalled = recall_materials(params["keywords"], params["plan_type"], params["audience"])
    low_match = len(recalled) < LOW_MATCH_THRESHOLD
    if low_match and not payload.get("confirm_low_match"):
        return {"low_match": True, "recall_count": len(recalled)}, \
            "当前匹配到的相关素材较少，将结合通用教学模板补充生成，是否继续？", 428

    task_id = make_business_id()
    now = now_ms()
    db.session.add(MaterialAiTask(
        task_id=task_id, teacher_id=user["id"], teacher_name=user.get("name", ""),
        plan_type=params["plan_type"], audience=params["audience"],
        styles=",".join(params["styles"]), keywords=params["keywords"],
        description=params["description"] or None, length_preset=params["length_preset"],
        status="queued", progress=0,
        low_match_confirmed=1 if (low_match and payload.get("confirm_low_match")) else 0,
        created_at=now, updated_at=now,
    ))
    db.session.commit()
    _TASK_QUEUE.put(task_id)
    return {"task_id": task_id, "recall_count": len(recalled)}, None, 200


def get_task(task_id: str, teacher_id: str) -> tuple[dict | None, str | None]:
    task = db.session.get(MaterialAiTask, task_id)
    if task is None:
        return None, "任务不存在"
    if task.teacher_id != teacher_id:
        return None, "无权查看该任务"
    return {
        "task_id": task.task_id,
        "status": task.status,
        "progress": task.progress,
        "error_message": task.error_message,
        "content": task.content if task.status == "completed" else None,
        "referenced_materials": json.loads(task.referenced_materials)
        if task.referenced_materials else [],
        "recall_count": task.recall_count,
        "plan_type": task.plan_type,
        "saved_material_id": task.saved_material_id,
    }, None


def cancel_task(task_id: str, teacher_id: str) -> tuple[bool, str | None]:
    task = db.session.get(MaterialAiTask, task_id)
    if task is None or task.teacher_id != teacher_id:
        return False, "任务不存在或无权操作"
    if task.status in ("completed", "failed", "timeout", "cancelled"):
        return False, "该任务已结束，无法取消"
    task.status = "cancelled"
    task.updated_at = now_ms()
    db.session.commit()
    return True, None


def _category_for_plan(plan_type: str) -> str:
    """生成产物按方案类型自动归入素材分类。"""
    if "班会" in plan_type:
        return "班会方案"
    if "活动" in plan_type or "社团" in plan_type or "竞赛" in plan_type:
        return "团体活动方案"
    return "其他"


def save_task_to_library(task_id: str, teacher: dict) -> tuple[dict | None, str | None]:
    """产物保存进素材库：docx 字节入库，打「AI生成」标签并记录参数。"""
    task = db.session.get(MaterialAiTask, task_id)
    if task is None or task.teacher_id != teacher["id"]:
        return None, "任务不存在或无权操作"
    if task.status != "completed" or not task.content:
        return None, "任务尚未生成完成，无法保存"
    if task.saved_material_id:
        return {"material_id": task.saved_material_id, "already": True}, None

    docx_blob = material_parser.markdown_to_docx(task.content)
    title = f"{task.plan_type}｜{task.keywords[:20]}"
    material_id = make_business_id()
    db.session.add(ActivityMaterial(
        material_id=material_id, title=title, category=_category_for_plan(task.plan_type),
        brief=f"AI 生成方案：面向{task.audience}，风格{task.styles}，关键词{task.keywords}",
        file_blob=docx_blob, file_name=f"{title}.docx",
        file_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        uploader=teacher["id"], upload_time=now_ms(),
        source="ai",
        tags=f"AI生成｜{task.keywords}｜{task.audience}｜{task.styles}",
    ))
    task.saved_material_id = material_id
    task.updated_at = now_ms()
    db.session.commit()

    # 生成产物同样入向量索引，供后续方案继续召回复用
    try:
        material_parser.index_material(material_id)
    except Exception:
        db.session.rollback()
    return {"material_id": material_id}, None


def build_download(task_id: str, teacher_id: str) -> tuple[bytes, str] | tuple[None, str]:
    task = db.session.get(MaterialAiTask, task_id)
    if task is None or task.teacher_id != teacher_id:
        return None, "任务不存在或无权操作"
    if task.status != "completed" or not task.content:
        return None, "任务尚未生成完成，无法下载"
    return material_parser.markdown_to_docx(task.content), f"{task.plan_type}_{task.keywords[:12]}.docx"


def _today_start_ms() -> int:
    start = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
    return int(start.timestamp() * 1000)
