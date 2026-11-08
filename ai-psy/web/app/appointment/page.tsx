'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { AppShell } from '@/components/business/app-shell';
import { AuthGuard } from '@/components/business/auth-guard';
import { ApiError, del, getJson, postJson } from '@/lib/api';
import type { Appointment, Slot } from '@/lib/types';
import { formatTimestamp } from '@/lib/utils';

// 1:1 复刻旧版 static/appointment.html + appointment.css + appointment.js：
// 扁平时段卡、五态中文徽章、白底预约弹窗（事由选填、错误红字内联）、查看详情弹窗、原生确认取消；
// 余量以后端 current_count 计算、取消接口 404/405 回退 DELETE 为已确认新增逻辑，保持不变。

// 预约状态中文标签与配色（与旧版 STATUS_CN/STATUS_CLS 一致）
const STATUS_META: Record<string, { label: string; cls: string }> = {
  pending: { label: '⏳ 待审核', cls: 'aic-st-pending' },
  confirmed: { label: '✅ 已通过', cls: 'aic-st-confirmed' },
  rejected: { label: '❌ 已驳回', cls: 'aic-st-rejected' },
  cancelled: { label: '🚫 学生取消', cls: 'aic-st-cancelled' },
  done: { label: '🎉 已完成', cls: 'aic-st-done' },
};

function statusMeta(status: string) {
  return STATUS_META[status] ?? { label: status, cls: '' };
}

/** 旧接口返回数组，新接口返回 {slots}/{appointments}，两种形态都要兼容。 */
function normalizeList<T>(payload: unknown, key: string): T[] {
  if (Array.isArray(payload)) {
    return payload as T[];
  }
  if (payload && typeof payload === 'object') {
    const value = (payload as Record<string, unknown>)[key];
    return Array.isArray(value) ? (value as T[]) : [];
  }
  return [];
}

function remainingOf(slot: Slot): number {
  // 余量以后端 current_count 计算为准，remaining 字段仅作兜底。
  return Math.max(slot.max_capacity - slot.current_count, 0);
}

// 教师审批结果行文案（与旧版 openDetail 一致）
function approvalText(status: string): string {
  if (status === 'rejected') {
    return '❌ 已驳回';
  }
  if (status === 'confirmed' || status === 'done') {
    return '✅ 已通过';
  }
  if (status === 'pending') {
    return '⏳ 等待教师审批';
  }
  return '🚫 学生取消';
}

function AppointmentContent() {
  const queryClient = useQueryClient();

  const [bookingSlot, setBookingSlot] = useState<Slot | null>(null);
  const [reason, setReason] = useState('');
  const [bookMsg, setBookMsg] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [detailTarget, setDetailTarget] = useState<Appointment | null>(null);

  const slotsQuery = useQuery({
    queryKey: ['student', 'appointment-slots'],
    queryFn: () => getJson<Slot[] | { slots: Slot[] }>('/api/student/appointment/slots'),
  });
  const appointmentsQuery = useQuery({
    queryKey: ['student', 'appointments'],
    queryFn: () =>
      getJson<Appointment[] | { appointments: Appointment[] }>('/api/student/appointments'),
  });

  const slots = normalizeList<Slot>(slotsQuery.data, 'slots');
  const appointments = normalizeList<Appointment>(appointmentsQuery.data, 'appointments');

  const refreshAll = () => {
    void queryClient.invalidateQueries({ queryKey: ['student', 'appointment-slots'] });
    void queryClient.invalidateQueries({ queryKey: ['student', 'appointments'] });
  };

  const openBooking = (slot: Slot) => {
    setBookingSlot(slot);
    setReason('');
    setBookMsg('');
  };

  const closeBooking = () => {
    if (submitting) {
      return;
    }
    setBookingSlot(null);
  };

  const handleBook = async () => {
    if (!bookingSlot) {
      return;
    }
    setSubmitting(true);
    setBookMsg('');
    try {
      await postJson<{ ok: boolean }>('/api/student/appointment', {
        slot_id: bookingSlot.id,
        reason: reason.trim(),
      });
      setBookingSlot(null);
      refreshAll();
    } catch (caught) {
      // 旧版口径：错误红字显示在弹窗内，不关闭弹窗
      setBookMsg(caught instanceof ApiError ? caught.message : '网络错误，请重试');
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancel = async (appointment: Appointment) => {
    // 旧版口径：原生 confirm 确认后才发起取消
    if (!window.confirm('确定取消这条预约吗？')) {
      return;
    }
    try {
      // 后端实际只暴露 DELETE /api/student/appointment/<id>；
      // 先按任务约定的 /cancel 尝试，路由不存在时回退到 DELETE。
      try {
        await postJson<{ ok: boolean }>(
          `/api/student/appointment/${encodeURIComponent(appointment.id)}/cancel`,
        );
      } catch (caught) {
        if (caught instanceof ApiError && (caught.status === 404 || caught.status === 405)) {
          await del<{ ok: boolean }>(
            `/api/student/appointment/${encodeURIComponent(appointment.id)}`,
          );
        } else {
          throw caught;
        }
      }
      refreshAll();
    } catch (caught) {
      window.alert(caught instanceof ApiError ? caught.message : '取消失败');
    }
  };

  return (
    <AppShell
      role="student"
      pageClassName="min-h-screen px-[24px] pb-[60px] pt-[20px]"
      headNavClassName="mb-[12px] flex flex-wrap items-center gap-[10px]"
    >
      <h1 className="aic-page-title">🗓️ 心理咨询预约</h1>
      <p className="aic-page-sub" style={{ marginBottom: 24 }}>
        选择一位咨询师的可约时段，填写预约事由提交；待对方确认后即预约成功。
      </p>

      <h2 className="aic-sec-title">可预约时段</h2>
      <div className="aic-slot-list">
        {slotsQuery.isLoading ? <div className="aic-loading">加载中…</div> : null}
        {slotsQuery.isError ? (
          <p className="aic-empty-tip">加载时段失败，请稍后重试。</p>
        ) : null}
        {!slotsQuery.isLoading && !slotsQuery.isError && slots.length === 0 ? (
          <p className="aic-empty-tip">暂时没有可预约的时段，请稍后再来。</p>
        ) : null}
        {slots.map((slot) => {
          const remaining = remainingOf(slot);
          const full = remaining <= 0;
          return (
            <div key={slot.id} className="aic-slot-card">
              <div className="aic-slot-info">
                <span className="aic-slot-teacher">👩‍🏫 {slot.teacher_name}</span>
                <span className="aic-slot-time">
                  📅 {slot.date} {slot.time_slot}
                </span>
                <span>
                  剩余 {remaining}/{slot.max_capacity} 个名额
                </span>
                {slot.note ? <span className="aic-slot-note">💬 {slot.note}</span> : null}
              </div>
              <button
                type="button"
                className="aic-btn-book"
                disabled={full}
                onClick={() => openBooking(slot)}
              >
                {full ? '已满员' : '预约'}
              </button>
            </div>
          );
        })}
      </div>

      <h2 className="aic-sec-title">我的预约</h2>
      <div className="aic-appt-list">
        {appointmentsQuery.isLoading ? <div className="aic-loading">加载中…</div> : null}
        {appointmentsQuery.isError ? (
          <p className="aic-empty-tip">加载预约失败，请稍后重试。</p>
        ) : null}
        {!appointmentsQuery.isLoading && !appointmentsQuery.isError && appointments.length === 0 ? (
          <p className="aic-empty-tip">你还没有预约记录。</p>
        ) : null}
        {appointments.map((appointment) => {
          const meta = statusMeta(appointment.status);
          return (
            <div key={appointment.id} className="aic-appt-item">
              <div className="aic-appt-main">
                <span className="aic-appt-who">👩‍🏫 {appointment.teacher_name}</span>
                <span className="aic-appt-time">
                  📅 {appointment.date} {appointment.time_slot}
                </span>
                <span className={`aic-status ${meta.cls}`}>{meta.label}</span>
              </div>
              {appointment.reason ? <p className="aic-appt-reason">事由：{appointment.reason}</p> : null}
              {appointment.reply ? (
                <p className="aic-appt-reply">教师回复：{appointment.reply}</p>
              ) : null}
              <div className="aic-appt-ops">
                <button
                  type="button"
                  className="aic-btn-detail"
                  onClick={() => setDetailTarget(appointment)}
                >
                  查看详情
                </button>
                {appointment.status === 'pending' ? (
                  <button
                    type="button"
                    className="aic-btn-cancel-link"
                    onClick={() => void handleCancel(appointment)}
                  >
                    取消预约
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      {/* 预约弹窗（旧版 .modal 结构与文案） */}
      {bookingSlot ? (
        <div
          className="aic-modal-mask"
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              closeBooking();
            }
          }}
        >
          <div className="aic-modal">
            <h3>预约心理咨询</h3>
            <p className="aic-modal-slot">
              📅 {bookingSlot.date} {bookingSlot.time_slot} · {bookingSlot.teacher_name}
            </p>
            <label>预约事由（选填）</label>
            <textarea
              value={reason}
              placeholder="简单说说你想聊些什么…"
              onChange={(event) => setReason(event.target.value)}
            />
            <div className="aic-modal-ops">
              <button type="button" className="aic-btn-cancel" onClick={closeBooking}>
                取消
              </button>
              <button
                type="button"
                className="aic-btn-ok"
                disabled={submitting}
                onClick={() => void handleBook()}
              >
                确认提交
              </button>
            </div>
            {bookMsg ? <p className="aic-modal-msg">{bookMsg}</p> : null}
          </div>
        </div>
      ) : null}

      {/* 预约详情弹窗：查看教师审批结果 / 驳回备注 */}
      {detailTarget ? (
        <div
          className="aic-modal-mask"
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              setDetailTarget(null);
            }
          }}
        >
          <div className="aic-modal">
            <h3>预约详情</h3>
            <div className="aic-detail-row">
              <span className="aic-detail-label">教师</span>
              <span>{detailTarget.teacher_name}</span>
            </div>
            <div className="aic-detail-row">
              <span className="aic-detail-label">预约时间</span>
              <span>
                {detailTarget.date} {detailTarget.time_slot}
              </span>
            </div>
            <div className="aic-detail-row">
              <span className="aic-detail-label">当前状态</span>
              <span>
                <span className={`aic-status ${statusMeta(detailTarget.status).cls}`}>
                  {statusMeta(detailTarget.status).label}
                </span>
              </span>
            </div>
            <div className="aic-detail-row">
              <span className="aic-detail-label">提交时间</span>
              <span>{formatTimestamp(detailTarget.created_at)}</span>
            </div>
            <div className="aic-detail-row">
              <span className="aic-detail-label">预约事由</span>
              <span>{detailTarget.reason || '未填写'}</span>
            </div>
            <div className="aic-detail-row">
              <span className="aic-detail-label">教师审批结果</span>
              <span>{approvalText(detailTarget.status)}</span>
            </div>
            <div className="aic-detail-row">
              <span className="aic-detail-label">教师备注</span>
              <span>{detailTarget.reply || '暂无备注'}</span>
            </div>
            <div className="aic-modal-ops">
              <button type="button" className="aic-btn-ok" onClick={() => setDetailTarget(null)}>
                关闭
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </AppShell>
  );
}

export default function AppointmentPage() {
  return (
    <AuthGuard role="student">
      <AppointmentContent />
    </AuthGuard>
  );
}
