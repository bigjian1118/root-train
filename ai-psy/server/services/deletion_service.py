# -*- coding: utf-8 -*-
"""账号即时永久注销服务：准入校验 -> 多重确认 -> 单事务立即执行，无冷静期、不可恢复。

合规要点（个人信息保护法第47条删除权 + 校园心理档案留存要求）：
  - 身份校验（登录密码）+ 指定确认文案双重确认后才执行；
  - 交互数据（会话/消息/预约）物理删除；
  - 测评报告去标识化留存（心理档案合规），教师公共素材保留并匿名化创建者；
  - 账号行匿名化而非物理删除：保留注销流水号与时间，满足审计追溯；
  - 幂等闸门：账号状态条件更新命中 1 行才继续清除，网络异常/重复调用
    不会产生部分清除或重复删除（整体事务回滚，账号保持原样）。

身份校验说明：项目未接入短信网关，统一使用登录密码校验；
verify_identity 为唯一入口，未来接短信只需替换该函数实现。
"""
import secrets
from datetime import date

from sqlalchemy import delete, or_, select, update

from ..extensions import db
from ..models import (
    AccountDeletionRequest, AiAnalysisReport, Appointment, Conversation,
    CounselingSlot, Message, Scl90TextReport, Student, Teacher,
    TeacherClass, VideoFaceReport, now_ms,
)
from ..security import (
    build_password_hash, make_business_id, verify_password,
)

DELETION_STATUS_ACTIVE = "active"
DELETION_STATUS_DELETED = "deleted"

# 二级确认弹窗要求手动输入的指定文案（全等比对，大小写与标点敏感）
CONFIRM_TEXT = "确认永久注销账号，且知晓无法恢复"

_ANONYMOUS_NAME = "已注销用户"

_USER_MODEL = {"student": Student, "teacher": Teacher}


def verify_identity(row, password: str) -> bool:
    """身份校验唯一入口：当前实现为登录密码校验（无短信通道时的合规降级路径）。"""
    if row is None or not password:
        return False
    return verify_password(password, row.password)


def make_serial() -> str:
    """注销流水号：ZX + 业务ID（时间戳+随机），全局唯一。"""
    return f"ZX{make_business_id()}"


# ==================== 准入校验 ====================

def check_eligibility(user: dict) -> tuple[bool, list[dict]]:
    """注销准入校验，返回 (allowed, blockers)。任一阻断项不满足即禁止进入确认流程。

    阻断项映射本项目实际业务；订单/资金/会员/超级管理员条件无对应业务，不启用。
    """
    blockers: list[dict] = []
    model = _USER_MODEL.get(user.get("role", ""))
    row = db.session.get(model, user.get("id", "")) if model else None
    if row is None:
        return False, [{"code": "invalid_session", "message": "登录状态已失效，请重新登录。"}]

    # 1) 账号状态正常（预留封禁/冻结扩展位：非 active 一律阻断）
    if row.account_status != DELETION_STATUS_ACTIVE:
        return False, [{"code": "account_abnormal",
                        "message": "账号当前状态异常，无法自助注销，请联系学校管理员。"}]

    if user["role"] == "student":
        # 2a) 学生：未完成咨询预约
        today = date.today().isoformat()
        pending_rows = db.session.execute(
            select(Appointment.date, Appointment.status).where(
                Appointment.student_id == user["id"],
                Appointment.status.in_(("pending", "approved")),
                Appointment.date >= today,
            ).order_by(Appointment.date.asc())
        ).all()
        if pending_rows:
            blockers.append({
                "code": "unfinished_appointment",
                "message": f"存在未完成的咨询预约（{pending_rows[0][0]}），"
                           "处理路径：在「预约咨询」页取消预约或等待咨询完成。",
            })
    else:
        # 2b) 教师：待审批预约
        pending_approvals = db.session.scalar(
            select(Appointment.id).where(
                Appointment.teacher_id == user["id"],
                Appointment.status == "pending",
            ).limit(1)
        )
        if pending_approvals is not None:
            count = len(db.session.execute(
                select(Appointment.id).where(
                    Appointment.teacher_id == user["id"],
                    Appointment.status == "pending",
                )
            ).all())
            blockers.append({
                "code": "pending_approvals",
                "message": f"存在 {count} 条待审批的学生预约，"
                           "处理路径：在「预约管理」页完成同意或驳回。",
            })
        # 2c) 教师：开放中且已有学生预约的咨询时段
        open_slots = db.session.scalar(
            select(CounselingSlot.id).where(
                CounselingSlot.teacher_id == user["id"],
                CounselingSlot.status == "open",
            ).limit(1)
        )
        if open_slots is not None:
            blockers.append({
                "code": "open_slots",
                "message": "仍有开放中的可约时段，处理路径：在「预约管理」页作废全部时段。",
            })
    return (len(blockers) == 0, blockers)


# ==================== 即时注销执行 ====================

def immediate_deletion(user: dict, password: str, confirm_text: str,
                       reason: str, ip: str | None) -> tuple[dict | None, str | None, int]:
    """执行即时永久注销。返回 (成功payload, 错误文案, HTTP状态码)。

    校验顺序：登录态 -> 确认文案全等 -> 密码 -> 准入条件；任一失败不执行任何清除。
    幂等：账号状态条件更新命中 1 行才继续，重复调用直接返回「已注销」。
    """
    model = _USER_MODEL.get(user.get("role", ""))
    if model is None:
        return None, "登录状态已失效，请重新登录", 401
    row = db.session.get(model, user.get("id", ""))
    if row is None:
        return None, "登录状态已失效，请重新登录", 401
    if row.account_status == DELETION_STATUS_DELETED:
        return None, "该账号已永久注销，无法使用", 403

    # 多重确认：指定文案全等比对（先于密码，减少无谓校验）
    if str(confirm_text or "").strip() != CONFIRM_TEXT:
        return None, "确认文案输入不正确，请逐字输入指定内容后重试", 400

    if not verify_identity(row, password):
        return None, "密码验证失败，请重新输入", 401

    allowed, blockers = check_eligibility(user)
    if not allowed:
        return {"blockers": blockers}, blockers[0]["message"], 403

    serial = make_serial()
    now = now_ms()
    try:
        # 幂等闸门：条件更新命中 1 行才继续（并发重复调用只有一个成功）
        hit = db.session.execute(
            update(model)
            .where(
                model.teacher_id == user["id"] if model is Teacher
                else model.student_id == user["id"],
                model.account_status != DELETION_STATUS_DELETED,
            )
            .values(account_status=DELETION_STATUS_DELETED, deleted_at=now,
                    delete_serial=serial, delete_reason=str(reason or "").strip() or None)
        )
        if hit.rowcount != 1:
            db.session.rollback()
            return None, "该账号已永久注销，无法使用", 403

        if user["role"] == "student":
            _erase_student_data(user["id"])
            _anonymize_student(row)
        else:
            _erase_teacher_data(user["id"])
            _anonymize_teacher(row)

        # 审计流水：申请人/角色/时间/IP/校验方式/流水号，一次注销一行
        db.session.add(AccountDeletionRequest(
            user_id=user["id"], role=user["role"], status="completed",
            requested_at=now, deadline_at=now, completed_at=now,
            deletion_serial=serial, ip=ip, verify_method="password",
        ))
        db.session.commit()
    except Exception:
        # 任一环节异常整体回滚：账号状态保持原样，不产生部分清除
        db.session.rollback()
        return None, "注销执行失败，账号未发生变更，请稍后重试或联系管理员", 500

    return {"ok": True, "deletion_serial": serial, "deleted_at": now}, None, 200


def _erase_student_data(student_id: str) -> None:
    """学生数据清除：交互数据物理删除；报告去标识化留存（心理档案合规）。"""
    conversation_ids = db.session.execute(
        select(Conversation.id).where(Conversation.student_id == student_id)
    ).scalars().all()
    if conversation_ids:
        db.session.execute(delete(Message).where(Message.conversation_id.in_(conversation_ids)))
        db.session.execute(delete(Conversation).where(Conversation.id.in_(conversation_ids)))
    db.session.execute(delete(Appointment).where(Appointment.student_id == student_id))

    db.session.execute(
        update(Scl90TextReport)
        .where(Scl90TextReport.student_id == student_id)
        .values(student_name=_ANONYMOUS_NAME, student_class=_ANONYMOUS_NAME)
    )
    db.session.execute(
        update(VideoFaceReport)
        .where(VideoFaceReport.student_id == student_id)
        .values(landmark_json=None)  # 关键点坐标属生物特征衍生数据，清除
    )
    student = db.session.get(Student, student_id)
    if student is not None:
        ai_conditions = []
        if student.student_no:
            ai_conditions.append(AiAnalysisReport.student_no == student.student_no)
        if student.latest_text_report_id:
            ai_conditions.append(AiAnalysisReport.text_report_id == student.latest_text_report_id)
        if student.latest_video_report_id:
            ai_conditions.append(AiAnalysisReport.video_report_id == student.latest_video_report_id)
        if ai_conditions:
            db.session.execute(
                update(AiAnalysisReport)
                .where(or_(*ai_conditions))
                .values(student_name=_ANONYMOUS_NAME, student_class=None,
                        student_no=None, phone=None)
            )


def _erase_teacher_data(teacher_id: str) -> None:
    """教师数据清除：私信/班级关联删除；开放时段作废；进行中预约取消并留痕；
    公共素材保留（创建者随账号行匿名化）。"""
    conversation_ids = db.session.execute(
        select(Conversation.id).where(Conversation.teacher_id == teacher_id)
    ).scalars().all()
    if conversation_ids:
        db.session.execute(delete(Message).where(Message.conversation_id.in_(conversation_ids)))
        db.session.execute(delete(Conversation).where(Conversation.id.in_(conversation_ids)))
    db.session.execute(delete(TeacherClass).where(TeacherClass.teacher_id == teacher_id))

    db.session.execute(
        update(CounselingSlot)
        .where(CounselingSlot.teacher_id == teacher_id, CounselingSlot.status == "open")
        .values(status="closed")
    )
    db.session.execute(
        update(Appointment)
        .where(Appointment.teacher_id == teacher_id, Appointment.status == "pending")
        .values(status="cancelled", reply="教师账号已注销，预约自动取消")
    )


def _anonymize_account_common(row) -> None:
    row.name = _ANONYMOUS_NAME
    row.phone = None
    row.password = build_password_hash(secrets.token_urlsafe(24))
    row.account = f"deleted_{row.account}"  # 账号标识永久占用，无法再次注册


def _anonymize_student(row: Student) -> None:
    _anonymize_account_common(row)
    row.student_no = None
    row.class_ = _ANONYMOUS_NAME
    row.latest_text_report_id = None
    row.latest_video_report_id = None


def _anonymize_teacher(row: Teacher) -> None:
    _anonymize_account_common(row)
    row.job_number = None
    row.class_ = None
