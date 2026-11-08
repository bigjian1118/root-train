# -*- coding: utf-8 -*-
"""SQLAlchemy 2.0 数据模型：原 SQLite 12 表平移至 PostgreSQL，字段名/语义不变。

约定：
  - 时间戳统一 BIGINT 毫秒；
  - 原 INTEGER 自增主键改为 Identity；
  - 新增 rag_chunk 表承载 pgvector 向量（业务表不存向量，保持结构稳定）。
"""
from datetime import datetime, timezone

from pgvector.sqlalchemy import Vector
from sqlalchemy import (
    BigInteger, Float, Identity, Index, Integer, LargeBinary, String, Text, UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from .extensions import db


def now_ms() -> int:
    """当前毫秒时间戳（与原全库时间戳约定一致）。"""
    return int(datetime.now(tz=timezone.utc).timestamp() * 1000)


class Teacher(db.Model):
    __tablename__ = "teacher"

    teacher_id: Mapped[str] = mapped_column(Text, primary_key=True)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    class_: Mapped[str | None] = mapped_column("class", Text)
    job_number: Mapped[str | None] = mapped_column(Text, unique=True)
    account: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    password: Mapped[str] = mapped_column(Text, nullable=False)
    phone: Mapped[str | None] = mapped_column(Text)
    login_timestamp: Mapped[int | None] = mapped_column(BigInteger)
    # 账号注销（即时永久模式）：active / deleted；deleted 后三字段记录注销流水
    account_status: Mapped[str] = mapped_column(Text, nullable=False, default="active")
    deleted_at: Mapped[int | None] = mapped_column(BigInteger)
    delete_reason: Mapped[str | None] = mapped_column(Text)
    delete_serial: Mapped[str | None] = mapped_column(Text, unique=True)


class TeacherClass(db.Model):
    __tablename__ = "teacher_class"

    seq_id: Mapped[int] = mapped_column(Integer, Identity(), primary_key=True)
    teacher_id: Mapped[str] = mapped_column(Text, nullable=False, index=True)
    class_id: Mapped[str] = mapped_column(Text, nullable=False, index=True)
    create_timestamp: Mapped[int] = mapped_column(BigInteger, nullable=False)

    __table_args__ = (UniqueConstraint("teacher_id", "class_id", name="uq_teacher_class"),)


class TeacherClassChangeLog(db.Model):
    """任教班级修改审计日志：操作人、前后班级、IP、时间，支持后台追溯。"""

    __tablename__ = "teacher_class_change_log"

    id: Mapped[int] = mapped_column(Integer, Identity(), primary_key=True)
    operator_id: Mapped[str] = mapped_column(Text, nullable=False, index=True)
    operator_name: Mapped[str] = mapped_column(Text, nullable=False)
    before_classes: Mapped[str | None] = mapped_column(Text)  # 顿号分隔
    after_classes: Mapped[str | None] = mapped_column(Text)
    ip: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[int] = mapped_column(BigInteger, nullable=False)


class Student(db.Model):
    __tablename__ = "student"

    student_id: Mapped[str] = mapped_column(Text, primary_key=True)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    class_: Mapped[str] = mapped_column("class", Text, nullable=False)
    student_no: Mapped[str | None] = mapped_column(Text, unique=True)
    account: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    password: Mapped[str] = mapped_column(Text, nullable=False)
    latest_text_report_id: Mapped[str | None] = mapped_column(Text)
    latest_video_report_id: Mapped[str | None] = mapped_column(Text)
    phone: Mapped[str | None] = mapped_column(Text)
    register_timestamp: Mapped[int] = mapped_column(BigInteger, nullable=False)
    # 账号注销（即时永久模式）：active / deleted；deleted 后三字段记录注销流水
    account_status: Mapped[str] = mapped_column(Text, nullable=False, default="active")
    deleted_at: Mapped[int | None] = mapped_column(BigInteger)
    delete_reason: Mapped[str | None] = mapped_column(Text)
    delete_serial: Mapped[str | None] = mapped_column(Text, unique=True)


class AccountDeletionRequest(db.Model):
    """账号注销操作流水：即时永久注销模式下仅作审计留痕，一次注销一行。"""

    __tablename__ = "account_deletion_request"

    seq_id: Mapped[int] = mapped_column(Integer, Identity(), primary_key=True)
    user_id: Mapped[str] = mapped_column(Text, nullable=False, index=True)
    role: Mapped[str] = mapped_column(Text, nullable=False)
    # 即时模式固定写入 completed（历史冷静期数据保留可读，不再产生新状态）
    status: Mapped[str] = mapped_column(Text, nullable=False, default="completed", index=True)
    requested_at: Mapped[int] = mapped_column(BigInteger, nullable=False)
    deadline_at: Mapped[int] = mapped_column(BigInteger, nullable=False)
    cancelled_at: Mapped[int | None] = mapped_column(BigInteger)
    completed_at: Mapped[int | None] = mapped_column(BigInteger)
    # 注销流水号：ZX+时间戳+随机，完成时写入，作为合规凭证保留
    deletion_serial: Mapped[str | None] = mapped_column(Text, unique=True)
    blocked_reason: Mapped[str | None] = mapped_column(Text)
    # 审计四要素补充：操作 IP 与校验方式（password / sms）
    ip: Mapped[str | None] = mapped_column(String(64))
    verify_method: Mapped[str | None] = mapped_column(String(16))


class Scl90TextReport(db.Model):
    __tablename__ = "scl90_text_report"

    seq_id: Mapped[int] = mapped_column(Integer, Identity(), primary_key=True)
    report_id: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    student_id: Mapped[str] = mapped_column(Text, nullable=False, index=True)
    student_name: Mapped[str] = mapped_column(Text, nullable=False)
    student_class: Mapped[str] = mapped_column(Text, nullable=False, index=True)
    crowd_tag: Mapped[str] = mapped_column(Text, nullable=False)
    total_score: Mapped[int | None] = mapped_column(Integer)
    pos_item_count: Mapped[int | None] = mapped_column(Integer)
    neg_item_count: Mapped[int | None] = mapped_column(Integer)
    risk_signal: Mapped[int] = mapped_column(Integer, default=0)
    # 10 个因子分独立列（列名与前端契约保持不变）
    somatization: Mapped[float | None] = mapped_column(Float)
    ocd: Mapped[float | None] = mapped_column(Float)
    interpersonal_sensitivity: Mapped[float | None] = mapped_column(Float)
    depression: Mapped[float | None] = mapped_column(Float)
    anxiety: Mapped[float | None] = mapped_column(Float)
    hostility: Mapped[float | None] = mapped_column(Float)
    phobic_anxiety: Mapped[float | None] = mapped_column(Float)
    paranoid_ideation: Mapped[float | None] = mapped_column(Float)
    psychoticism: Mapped[float | None] = mapped_column(Float)
    additional: Mapped[float | None] = mapped_column(Float)
    max_factor_score: Mapped[float | None] = mapped_column(Float)
    gsi: Mapped[float | None] = mapped_column(Float)
    psdi: Mapped[float | None] = mapped_column(Float)
    submit_timestamp: Mapped[int] = mapped_column(BigInteger, nullable=False)
    item_answers: Mapped[str | None] = mapped_column(Text)


class VideoFaceReport(db.Model):
    __tablename__ = "video_face_report"

    seq_id: Mapped[int] = mapped_column(Integer, Identity(), primary_key=True)
    video_report_id: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    student_id: Mapped[str] = mapped_column(Text, nullable=False, index=True)
    au_json: Mapped[str | None] = mapped_column(Text)
    emotion_json: Mapped[str | None] = mapped_column(Text)
    landmark_json: Mapped[str | None] = mapped_column(Text)
    prominent_dimension: Mapped[str | None] = mapped_column(Text)
    create_timestamp: Mapped[int] = mapped_column(BigInteger, nullable=False)


class AiAnalysisReport(db.Model):
    __tablename__ = "ai_analysis_report"

    seq_id: Mapped[int] = mapped_column(Integer, Identity(), primary_key=True)
    student_name: Mapped[str] = mapped_column(Text, nullable=False)
    student_class: Mapped[str | None] = mapped_column(Text)
    student_no: Mapped[str | None] = mapped_column(Text, index=True)
    phone: Mapped[str | None] = mapped_column(Text)
    text_report_id: Mapped[str | None] = mapped_column(Text, index=True)
    video_report_id: Mapped[str | None] = mapped_column(Text, index=True)
    ai_content: Mapped[str | None] = mapped_column(Text)
    create_timestamp: Mapped[int] = mapped_column(BigInteger, nullable=False)


class CounselingSlot(db.Model):
    __tablename__ = "counseling_slots"

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    teacher_id: Mapped[str] = mapped_column(Text, nullable=False, index=True)
    teacher_name: Mapped[str] = mapped_column(Text, nullable=False)
    date: Mapped[str] = mapped_column(Text, nullable=False)
    time_slot: Mapped[str] = mapped_column(Text, nullable=False)
    start_time: Mapped[str | None] = mapped_column(Text)
    end_time: Mapped[str | None] = mapped_column(Text)
    max_capacity: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    current_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    note: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(Text, nullable=False, default="open", index=True)
    created_at: Mapped[int] = mapped_column(BigInteger, nullable=False)


class Appointment(db.Model):
    __tablename__ = "appointments"

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    slot_id: Mapped[str] = mapped_column(Text, nullable=False)
    teacher_id: Mapped[str] = mapped_column(Text, nullable=False, index=True)
    teacher_name: Mapped[str] = mapped_column(Text, nullable=False)
    student_id: Mapped[str] = mapped_column(Text, nullable=False, index=True)
    student_name: Mapped[str] = mapped_column(Text, nullable=False)
    student_class: Mapped[str] = mapped_column(Text, nullable=False)
    date: Mapped[str] = mapped_column(Text, nullable=False)
    time_slot: Mapped[str] = mapped_column(Text, nullable=False)
    reason: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(Text, nullable=False, default="pending", index=True)
    reply: Mapped[str | None] = mapped_column(Text)
    teacher_time: Mapped[int | None] = mapped_column(BigInteger)
    created_at: Mapped[int] = mapped_column(BigInteger, nullable=False)


class Article(db.Model):
    __tablename__ = "articles"

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    cover: Mapped[str | None] = mapped_column(Text)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    summary: Mapped[str | None] = mapped_column(Text)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    source: Mapped[str | None] = mapped_column(Text)
    author: Mapped[str | None] = mapped_column(Text)
    is_active: Mapped[int] = mapped_column(Integer, nullable=False, default=1, index=True)
    created_at: Mapped[int] = mapped_column(BigInteger, nullable=False)
    updated_at: Mapped[int | None] = mapped_column(BigInteger)


class ActivityMaterial(db.Model):
    __tablename__ = "activity_material"

    material_id: Mapped[str] = mapped_column(Text, primary_key=True)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    category: Mapped[str] = mapped_column(Text, nullable=False)
    brief: Mapped[str | None] = mapped_column(Text)
    file_blob: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    file_name: Mapped[str] = mapped_column(Text, nullable=False)
    file_type: Mapped[str | None] = mapped_column(Text)
    uploader: Mapped[str] = mapped_column(Text, nullable=False)
    upload_time: Mapped[int] = mapped_column(BigInteger, nullable=False, index=True)
    # AI 方案生成功能新增：upload=教师上传 / ai=AI 生成产物；tags 存「AI生成｜参数摘要」
    source: Mapped[str] = mapped_column(Text, nullable=False, default="upload")
    tags: Mapped[str | None] = mapped_column(Text)


class MaterialAiTask(db.Model):
    """AI 方案生成任务：参数、状态、进度、产物与引用素材的全生命周期记录（审计留痕）。"""

    __tablename__ = "material_ai_task"

    task_id: Mapped[str] = mapped_column(Text, primary_key=True)
    teacher_id: Mapped[str] = mapped_column(Text, nullable=False, index=True)
    teacher_name: Mapped[str] = mapped_column(Text, nullable=False)
    plan_type: Mapped[str] = mapped_column(Text, nullable=False)
    audience: Mapped[str] = mapped_column(Text, nullable=False)
    styles: Mapped[str] = mapped_column(Text, nullable=False)  # 逗号分隔
    keywords: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    length_preset: Mapped[str] = mapped_column(Text, nullable=False, default="standard")
    # queued/recalling/generating/saving/completed/failed/cancelled/timeout
    status: Mapped[str] = mapped_column(Text, nullable=False, default="queued", index=True)
    progress: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    error_message: Mapped[str | None] = mapped_column(Text)
    content: Mapped[str | None] = mapped_column(Text)  # 产物 Markdown 全文
    referenced_materials: Mapped[str | None] = mapped_column(Text)  # JSON：素材标题/来源/相关度
    recall_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    low_match_confirmed: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    retry_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    saved_material_id: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[int] = mapped_column(BigInteger, nullable=False)
    updated_at: Mapped[int] = mapped_column(BigInteger, nullable=False)


class Conversation(db.Model):
    __tablename__ = "conversation"

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    student_id: Mapped[str] = mapped_column(Text, nullable=False, index=True)
    teacher_id: Mapped[str] = mapped_column(Text, nullable=False, index=True)
    student_name: Mapped[str] = mapped_column(Text, nullable=False)
    teacher_name: Mapped[str] = mapped_column(Text, nullable=False)
    updated_timestamp: Mapped[int] = mapped_column(BigInteger, nullable=False)
    create_timestamp: Mapped[int] = mapped_column(BigInteger, nullable=False)

    __table_args__ = (UniqueConstraint("student_id", "teacher_id", name="uq_conversation_pair"),)


class Message(db.Model):
    __tablename__ = "message"

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    conversation_id: Mapped[str] = mapped_column(Text, nullable=False, index=True)
    sender_id: Mapped[str] = mapped_column(Text, nullable=False)
    sender_role: Mapped[str] = mapped_column(Text, nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    is_read: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    create_timestamp: Mapped[int] = mapped_column(BigInteger, nullable=False)


class RagChunk(db.Model):
    """RAG 切片表：同时存原文与 BGE-M3 向量（pgvector）。

    设计说明：文章、科普内容、危机指引统一切条入库，
    向量用余弦距离检索；source_type + source_id 便于增量重建。
    """

    __tablename__ = "rag_chunk"

    id: Mapped[int] = mapped_column(Integer, Identity(), primary_key=True)
    source_type: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    source_id: Mapped[str] = mapped_column(Text, nullable=False, index=True)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    chunk_index: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    embedding: Mapped[list[float]] = mapped_column(Vector(1024))
    created_at: Mapped[int] = mapped_column(BigInteger, nullable=False)

    __table_args__ = (
        Index("ix_rag_chunk_source", "source_type", "source_id"),
        # 余弦距离 HNSW 索引：建表后由 init_db 补齐（需要 pgvector >= 0.5）
        Index(
            "ix_rag_chunk_embedding",
            "embedding",
            postgresql_using="hnsw",
            postgresql_with={"m": 16, "ef_construction": 64},
            postgresql_ops={"embedding": "vector_cosine_ops"},
        ),
    )
