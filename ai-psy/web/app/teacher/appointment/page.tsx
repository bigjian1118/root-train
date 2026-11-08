'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import { useMemo, useState } from 'react';

import { AppShell } from '@/components/business/app-shell';
import { AuthGuard } from '@/components/business/auth-guard';
import { LoadingSkeleton } from '@/components/business/loading-skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { ApiError, apiFetch, del, getJson, postJson } from '@/lib/api';
import type { Appointment, Slot } from '@/lib/types';
import { formatTimestamp } from '@/lib/utils';

const DECISION_ENDPOINT = '/api/teacher/appointment';

// 状态标签文案与胶囊样式类均取自旧版 appointment_manage.js 的 apptStatus 映射
const APPOINTMENT_STATUS_META: Record<string, { label: string; statusClass: string }> = {
  pending: { label: '⏳ 待审核', statusClass: 'st-pending' },
  confirmed: { label: '✅ 已通过', statusClass: 'st-confirmed' },
  rejected: { label: '❌ 已驳回', statusClass: 'st-rejected' },
  cancelled: { label: '🚫 学生取消', statusClass: 'st-cancelled' },
  done: { label: '🎉 已完成', statusClass: 'st-done' },
};

const STATUS_OPTIONS = [
  { value: 'all', label: '全部' },
  { value: 'pending', label: '⏳ 待审核' },
  { value: 'confirmed', label: '✅ 已通过' },
  { value: 'rejected', label: '❌ 已驳回' },
  { value: 'cancelled', label: '🚫 学生取消' },
  { value: 'done', label: '🎉 已完成' },
];

interface SlotFormState {
  date: string;
  startTime: string;
  endTime: string;
  maxCapacity: string;
  note: string;
}

// 旧版容量输入框默认为空（占位「最大人数（默认1）」），提交时缺省按 1
const EMPTY_SLOT_FORM: SlotFormState = {
  date: '',
  startTime: '',
  endTime: '',
  maxCapacity: '',
  note: '',
};

function pickArray<T>(raw: unknown, key: string): T[] {
  if (Array.isArray(raw)) {
    return raw as T[];
  }
  if (raw && typeof raw === 'object') {
    const record = raw as Record<string, unknown>;
    if (Array.isArray(record[key])) {
      return record[key] as T[];
    }
    if (Array.isArray(record.items)) {
      return record.items as T[];
    }
    if (Array.isArray(record.data)) {
      return record.data as T[];
    }
  }
  return [];
}

function splitTimeSlot(slot: Slot): { start: string; end: string } {
  const [start = '', end = ''] = slot.time_slot.split('-');
  return {
    start: slot.start_time || start.trim(),
    end: slot.end_time || end.trim(),
  };
}

function slotFormFrom(slot: Slot): SlotFormState {
  const times = splitTimeSlot(slot);
  return {
    date: slot.date,
    startTime: times.start,
    endTime: times.end,
    maxCapacity: String(slot.max_capacity),
    note: slot.note ?? '',
  };
}

function validateSlotForm(form: SlotFormState): string | null {
  if (!form.date || !form.startTime || !form.endTime) {
    return '请选择日期和开始/结束时间';
  }
  if (form.startTime >= form.endTime) {
    return '结束时间需晚于开始时间';
  }
  const capacity = Number(form.maxCapacity || 1);
  if (!Number.isInteger(capacity) || capacity < 1) {
    return '最大预约人数需为 >=1 的整数';
  }
  return null;
}

function getStatusMeta(status: string) {
  return APPOINTMENT_STATUS_META[status] ?? { label: status, statusClass: '' };
}

interface AppointmentCardProps {
  appointment: Appointment;
  busy: boolean;
  onAgree: () => void;
  onReject: () => void;
  onComplete: () => void;
}

/** 审批条目：结构与按钮显隐逐字对齐旧版 loadAppts 渲染（待审核高亮 appt-new，无提交时间行）。 */
function AppointmentCard({ appointment, busy, onAgree, onReject, onComplete }: AppointmentCardProps) {
  const statusMeta = getStatusMeta(appointment.status);
  return (
    <div className={`aic-tap-appt${appointment.status === 'pending' ? ' appt-new' : ''}`}>
      <div className="aic-tap-appt-head">
        <span>
          <b>{appointment.student_name}</b>（{appointment.student_class ?? '—'}）
        </span>
        <span className="aic-tap-appt-time">
          {appointment.date} {appointment.time_slot}
        </span>
        <span className={`aic-tap-status ${statusMeta.statusClass}`}>{statusMeta.label}</span>
      </div>
      {appointment.reason ? (
        <p className="aic-tap-appt-reason">事由：{appointment.reason}</p>
      ) : null}
      {appointment.reply ? (
        <p className="aic-tap-appt-reply">回复：{appointment.reply}</p>
      ) : null}
      {appointment.status === 'pending' || appointment.status === 'confirmed' ? (
        <div className="aic-tap-appt-ops">
          {appointment.status === 'pending' ? (
            <>
              <button type="button" className="aic-tap-btn-agree" onClick={onAgree} disabled={busy}>
                ✅ 同意
              </button>
              <button type="button" className="aic-tap-btn-reject" onClick={onReject} disabled={busy}>
                驳回
              </button>
            </>
          ) : (
            <button type="button" className="aic-tap-btn-done" onClick={onComplete} disabled={busy}>
              🎉 标记完成
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** 台账条目：结构与文案逐字对齐旧版 loadLedger 渲染（回复前缀为「处理备注：」，含提交/处理时间行）。 */
function LedgerItemRow({ appointment }: { appointment: Appointment }) {
  const statusMeta = getStatusMeta(appointment.status);
  return (
    <div className="aic-tap-ledger-item">
      <div className="aic-tap-ledger-head">
        <span>
          <b>{appointment.student_name}</b>（{appointment.student_class ?? '—'}）
        </span>
        <span className="aic-tap-appt-time">
          {appointment.date} {appointment.time_slot}
        </span>
        <span className={`aic-tap-status ${statusMeta.statusClass}`}>{statusMeta.label}</span>
      </div>
      {appointment.reason ? (
        <p className="aic-tap-appt-reason">事由：{appointment.reason}</p>
      ) : null}
      {appointment.reply ? (
        <p className="aic-tap-appt-reply">处理备注：{appointment.reply}</p>
      ) : null}
      <p className="aic-tap-ledger-times">
        提交：{formatTimestamp(appointment.created_at)}
        {appointment.teacher_time
          ? ` ｜ 处理： ${formatTimestamp(appointment.teacher_time)}`
          : ''}
      </p>
    </div>
  );
}

function AppointmentPageContent() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // 旧版页签：审批处理（默认）/ 历史台账，仅作用于「收到的预约申请」区
  const [tab, setTab] = useState<'approve' | 'ledger'>('approve');
  // 旧版筛选下拉默认选中「全部」
  const [statusFilter, setStatusFilter] = useState('all');

  const [slotForm, setSlotForm] = useState<SlotFormState>(EMPTY_SLOT_FORM);
  const [creatingSlot, setCreatingSlot] = useState(false);
  // 旧版排班表单错误为内联 .form-msg 红字，非 toast
  const [slotFormMsg, setSlotFormMsg] = useState('');

  const [editingSlot, setEditingSlot] = useState<Slot | null>(null);
  const [editForm, setEditForm] = useState<SlotFormState>(EMPTY_SLOT_FORM);
  const [savingEdit, setSavingEdit] = useState(false);
  const [editFormMsg, setEditFormMsg] = useState('');

  const [deletingSlot, setDeletingSlot] = useState<Slot | null>(null);
  const [deleting, setDeleting] = useState(false);

  const [rejectingAppointment, setRejectingAppointment] = useState<Appointment | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [rejectFormMsg, setRejectFormMsg] = useState('');
  const [decidingId, setDecidingId] = useState('');

  const [completingAppointment, setCompletingAppointment] = useState<Appointment | null>(null);

  const slotsQuery = useQuery({
    queryKey: ['teacher', 'appointment', 'slots'],
    queryFn: async () =>
      pickArray<Slot>(
        await getJson<unknown>('/api/teacher/appointment/slots'),
        'slots',
      ),
  });

  const appointmentsQuery = useQuery({
    queryKey: ['teacher', 'appointments', statusFilter],
    queryFn: async () =>
      pickArray<Appointment>(
        await getJson<unknown>(
          `/api/teacher/appointments?status=${encodeURIComponent(statusFilter)}`,
        ),
        'appointments',
      ),
  });

  // 旧版历史台账：切到台账页签才拉取，数据源与审批列表同为 /api/teacher/appointments?status=all
  const ledgerQuery = useQuery({
    queryKey: ['teacher', 'appointments', 'ledger'],
    queryFn: async () =>
      pickArray<Appointment>(
        await getJson<unknown>('/api/teacher/appointments?status=all'),
        'appointments',
      ),
    enabled: tab === 'ledger',
  });

  const slots = slotsQuery.data ?? [];
  const appointments = appointmentsQuery.data ?? [];
  const ledgerAppointments = ledgerQuery.data ?? [];
  const pendingCount = useMemo(
    () => appointments.filter((item) => item.status === 'pending').length,
    [appointments],
  );

  const invalidateAppointmentData = () => {
    void queryClient.invalidateQueries({ queryKey: ['teacher', 'appointment', 'slots'] });
    void queryClient.invalidateQueries({ queryKey: ['teacher', 'appointments'] });
  };

  const handleCreateSlot = async () => {
    const error = validateSlotForm(slotForm);
    if (error) {
      setSlotFormMsg(error);
      return;
    }
    setSlotFormMsg('');
    setCreatingSlot(true);
    try {
      await postJson('/api/teacher/appointment/slots', {
        date: slotForm.date,
        start_time: slotForm.startTime,
        end_time: slotForm.endTime,
        max_capacity: Number(slotForm.maxCapacity || 1),
        note: slotForm.note.trim(),
      });
      toast({ title: '时段已添加', variant: 'success' });
      // 旧版成功后仅清空人数与备注，保留日期/时间便于连续排班
      setSlotForm((form) => ({ ...form, maxCapacity: '', note: '' }));
      invalidateAppointmentData();
    } catch (err) {
      setSlotFormMsg(err instanceof ApiError ? err.message : '添加失败');
    } finally {
      setCreatingSlot(false);
    }
  };

  const openEditSlot = (slot: Slot) => {
    setEditingSlot(slot);
    setEditForm(slotFormFrom(slot));
    setEditFormMsg('');
  };

  const handleUpdateSlot = async () => {
    if (!editingSlot) {
      return;
    }
    const error = validateSlotForm(editForm);
    if (error) {
      setEditFormMsg(error);
      return;
    }
    setEditFormMsg('');
    setSavingEdit(true);
    try {
      // lib 未封装 PUT，直接用 apiFetch 保持 Cookie 携带与统一错误处理。
      await apiFetch(`/api/teacher/appointment/slots/${encodeURIComponent(editingSlot.id)}`, {
        method: 'PUT',
        body: JSON.stringify({
          date: editForm.date,
          start_time: editForm.startTime,
          end_time: editForm.endTime,
          max_capacity: Number(editForm.maxCapacity || 1),
          note: editForm.note.trim(),
        }),
      });
      toast({ title: '时段已更新', variant: 'success' });
      setEditingSlot(null);
      invalidateAppointmentData();
    } catch (err) {
      setEditFormMsg(err instanceof ApiError ? err.message : '保存失败');
    } finally {
      setSavingEdit(false);
    }
  };

  const handleDeleteSlot = async () => {
    if (!deletingSlot) {
      return;
    }
    setDeleting(true);
    try {
      await del(`/api/teacher/appointment/slots/${encodeURIComponent(deletingSlot.id)}`);
      toast({ title: '时段已作废', variant: 'success' });
      setDeletingSlot(null);
      invalidateAppointmentData();
    } catch (err) {
      toast({
        title: '作废失败',
        description: err instanceof ApiError ? err.message : '网络异常，请稍后重试',
        variant: 'destructive',
      });
    } finally {
      setDeleting(false);
    }
  };

  /**
   * 后端 decide 接口使用 action（confirm/reject/complete），不是 status；
   * 驳回必须带 reply，学生端会展示该原因。
   */
  const decideAppointment = async (
    appointment: Appointment,
    action: 'confirm' | 'reject' | 'complete',
    reply = '',
  ) => {
    setDecidingId(appointment.id);
    try {
      await postJson(`${DECISION_ENDPOINT}/${encodeURIComponent(appointment.id)}/decide`, {
        action,
        reply,
      });
      toast({
        title:
          action === 'confirm' ? '已通过预约' : action === 'reject' ? '已驳回预约' : '已标记完成',
        variant: 'success',
      });
      if (action === 'reject') {
        setRejectingAppointment(null);
        setRejectReason('');
      }
      setCompletingAppointment(null);
      invalidateAppointmentData();
    } catch (err) {
      const message = err instanceof ApiError ? err.message : '网络异常，请稍后重试';
      // 旧版驳回失败在弹窗内联 .modal-msg 提示；同意/标记完成失败为弹窗外提示
      if (action === 'reject') {
        setRejectFormMsg(message || '驳回失败');
      } else {
        toast({ title: '操作失败', description: message, variant: 'destructive' });
      }
    } finally {
      setDecidingId('');
    }
  };

  const submitReject = () => {
    if (!rejectingAppointment) {
      return;
    }
    if (!rejectReason.trim()) {
      setRejectFormMsg('请填写驳回原因');
      return;
    }
    setRejectFormMsg('');
    void decideAppointment(rejectingAppointment, 'reject', rejectReason.trim());
  };

  return (
    <AppShell
      role="teacher"
      pageClassName="min-h-screen px-[24px] pb-[60px] pt-[20px]"
      headNavClassName="mb-[12px] flex flex-wrap items-center gap-[10px]"
    >
      <h1 className="aic-page-title">🗓️ 心理咨询预约管理</h1>
      <p className="aic-tap-sub">作为咨询师，先排出可预约时段，再处理学生提交的预约（同意/拒绝）。</p>

      <h2 className="aic-tap-sec-title">排出可约时段</h2>
      <div className="aic-tap-form-row">
        <input
          type="date"
          value={slotForm.date}
          onChange={(event) => setSlotForm({ ...slotForm, date: event.target.value })}
        />
        <input
          type="time"
          value={slotForm.startTime}
          onChange={(event) => setSlotForm({ ...slotForm, startTime: event.target.value })}
        />{' '}
        至{' '}
        <input
          type="time"
          value={slotForm.endTime}
          onChange={(event) => setSlotForm({ ...slotForm, endTime: event.target.value })}
        />
        <input
          type="number"
          min={1}
          step={1}
          placeholder="最大人数（默认1）"
          value={slotForm.maxCapacity}
          onChange={(event) => setSlotForm({ ...slotForm, maxCapacity: event.target.value })}
        />
        <input
          type="text"
          className="aic-tap-note"
          placeholder="备注（选填，如地点/主题）"
          maxLength={60}
          value={slotForm.note}
          onChange={(event) => setSlotForm({ ...slotForm, note: event.target.value })}
        />
        <button
          type="button"
          className="aic-tap-btn-add"
          onClick={() => void handleCreateSlot()}
          disabled={creatingSlot}
        >
          ➕ 添加时段
        </button>
      </div>
      {slotFormMsg ? <p className="aic-tap-form-msg">{slotFormMsg}</p> : null}

      <h2 className="aic-tap-sec-title">我的可约时段</h2>

      {slotsQuery.isLoading ? <LoadingSkeleton rows={2} /> : null}

      {slotsQuery.isError ? (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription className="flex items-center justify-between gap-3">
            时段加载失败
            <Button variant="outline" size="sm" onClick={() => void slotsQuery.refetch()}>
              重试
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="aic-tap-list">
        {slots.map((slot) => {
          const remaining = slot.max_capacity - slot.current_count;
          const full = remaining <= 0;
          return (
            <div key={slot.id} className="aic-tap-slot">
              <span className="aic-tap-slot-date">{slot.date}</span>
              <span className="aic-tap-slot-time">{slot.time_slot}</span>
              <span>
                已约 {slot.current_count}/{slot.max_capacity} · 剩 {remaining}
              </span>
              {slot.note ? <span className="aic-tap-slot-note">{slot.note}</span> : null}
              <span className={`aic-tap-status ${full ? 'st-taken' : 'st-open'}`}>
                {full ? '已满员' : '可约'}
              </span>
              <div className="aic-tap-slot-ops">
                <button
                  type="button"
                  className="aic-tap-btn-edit"
                  onClick={() => openEditSlot(slot)}
                >
                  编辑
                </button>
                <button
                  type="button"
                  className="aic-tap-btn-del"
                  onClick={() => setDeletingSlot(slot)}
                >
                  作废
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {!slotsQuery.isLoading && slots.length === 0 ? (
        <p className="aic-tap-empty-tip">你还没有排可约时段。</p>
      ) : null}

      <h2 className="aic-tap-sec-title">收到的预约申请</h2>
      <div className="aic-tap-tab-bar">
        <button
          type="button"
          className={`aic-tap-tab-btn${tab === 'approve' ? ' active' : ''}`}
          onClick={() => setTab('approve')}
        >
          审批处理
        </button>
        <button
          type="button"
          className={`aic-tap-tab-btn${tab === 'ledger' ? ' active' : ''}`}
          onClick={() => setTab('ledger')}
        >
          历史台账
        </button>
      </div>

      {tab === 'approve' ? (
        <>
          {/* 新预约红色角标横幅：有待审核时醒目提示，无则隐藏 */}
          {pendingCount > 0 ? (
            <div className="aic-tap-new-alert">
              <span className="aic-tap-new-dot">●</span> 您有 <b>{pendingCount}</b>{' '}
              条新的待审核预约，请及时处理
            </div>
          ) : null}

          <div className="aic-tap-filter-row">
            <label htmlFor="status-filter">按状态筛选：</label>
            <select
              id="status-filter"
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
            >
              {STATUS_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          {appointmentsQuery.isLoading ? <LoadingSkeleton rows={2} /> : null}

          {appointmentsQuery.isError ? (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription className="flex items-center justify-between gap-3">
                预约列表加载失败
                <Button variant="outline" size="sm" onClick={() => void appointmentsQuery.refetch()}>
                  重试
                </Button>
              </AlertDescription>
            </Alert>
          ) : null}

          <div className="aic-tap-list">
            {appointments.map((appointment) => (
              <AppointmentCard
                key={appointment.id}
                appointment={appointment}
                busy={decidingId === appointment.id}
                onAgree={() => void decideAppointment(appointment, 'confirm')}
                onReject={() => {
                  setRejectingAppointment(appointment);
                  setRejectReason('');
                  setRejectFormMsg('');
                }}
                onComplete={() => setCompletingAppointment(appointment)}
              />
            ))}
          </div>

          {!appointmentsQuery.isLoading && appointments.length === 0 ? (
            <p className="aic-tap-empty-tip">没有符合条件的预约。</p>
          ) : null}
        </>
      ) : (
        <>
          {ledgerQuery.isLoading ? <LoadingSkeleton rows={2} /> : null}

          {ledgerQuery.isError ? (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription className="flex items-center justify-between gap-3">
                历史台账加载失败
                <Button variant="outline" size="sm" onClick={() => void ledgerQuery.refetch()}>
                  重试
                </Button>
              </AlertDescription>
            </Alert>
          ) : null}

          <div>
            {ledgerAppointments.map((appointment) => (
              <LedgerItemRow key={appointment.id} appointment={appointment} />
            ))}
          </div>

          {!ledgerQuery.isLoading && ledgerAppointments.length === 0 ? (
            <p className="aic-tap-empty-tip">暂无历史预约记录。</p>
          ) : null}
        </>
      )}

      {/* 编辑时段弹窗（旧版白底 modal：点遮罩关闭，错误红字内联 .modal-msg） */}
      {editingSlot ? (
        <div
          className="aic-tap-modal-mask"
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              setEditingSlot(null);
            }
          }}
        >
          <div className="aic-tap-modal">
            <h3>编辑可约时段</h3>
            <label>预约日期</label>
            <input
              type="date"
              value={editForm.date}
              onChange={(event) => setEditForm({ ...editForm, date: event.target.value })}
            />
            <label>开始时间 至 结束时间</label>
            <div className="aic-tap-modal-time">
              <input
                type="time"
                value={editForm.startTime}
                onChange={(event) => setEditForm({ ...editForm, startTime: event.target.value })}
              />{' '}
              至{' '}
              <input
                type="time"
                value={editForm.endTime}
                onChange={(event) => setEditForm({ ...editForm, endTime: event.target.value })}
              />
            </div>
            <label>最大预约人数</label>
            <input
              type="number"
              min={1}
              step={1}
              value={editForm.maxCapacity}
              onChange={(event) => setEditForm({ ...editForm, maxCapacity: event.target.value })}
            />
            <label>备注（选填，如地点/主题）</label>
            <input
              type="text"
              maxLength={60}
              value={editForm.note}
              onChange={(event) => setEditForm({ ...editForm, note: event.target.value })}
            />
            <div className="aic-tap-modal-ops">
              <button
                type="button"
                className="aic-tap-btn-cancel"
                onClick={() => setEditingSlot(null)}
                disabled={savingEdit}
              >
                取消
              </button>
              <button
                type="button"
                className="aic-tap-btn-ok"
                onClick={() => void handleUpdateSlot()}
                disabled={savingEdit}
              >
                保存
              </button>
            </div>
            {editFormMsg ? <p className="aic-tap-modal-msg">{editFormMsg}</p> : null}
          </div>
        </div>
      ) : null}

      {/* 作废时段二次确认（旧版为原生 confirm，文案一字不差保留） */}
      {deletingSlot ? (
        <div
          className="aic-tap-modal-mask"
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              setDeletingSlot(null);
            }
          }}
        >
          <div className="aic-tap-modal">
            <h3>确定作废该时段吗？若已被预约会一并取消。</h3>
            <div className="aic-tap-modal-ops">
              <button
                type="button"
                className="aic-tap-btn-cancel"
                onClick={() => setDeletingSlot(null)}
                disabled={deleting}
              >
                取消
              </button>
              <button
                type="button"
                className="aic-tap-btn-danger"
                onClick={() => void handleDeleteSlot()}
                disabled={deleting}
              >
                确认作废
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* 驳回预约弹窗：驳回原因必填，错误红字内联 .modal-msg */}
      {rejectingAppointment ? (
        <div
          className="aic-tap-modal-mask"
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              setRejectingAppointment(null);
            }
          }}
        >
          <div className="aic-tap-modal">
            <h3>驳回预约</h3>
            <p className="aic-tap-modal-tip">请填写驳回原因，学生将在预约详情中看到该原因。</p>
            <label htmlFor="reject-reason">驳回原因（必填）</label>
            <textarea
              id="reject-reason"
              rows={3}
              maxLength={200}
              autoFocus
              placeholder="如：该时段安排有调整，请改约其他时段"
              value={rejectReason}
              onChange={(event) => setRejectReason(event.target.value)}
            />
            <div className="aic-tap-modal-ops">
              <button
                type="button"
                className="aic-tap-btn-cancel"
                onClick={() => setRejectingAppointment(null)}
                disabled={Boolean(decidingId)}
              >
                取消
              </button>
              <button
                type="button"
                className="aic-tap-btn-danger"
                onClick={submitReject}
                disabled={Boolean(decidingId)}
              >
                确认驳回
              </button>
            </div>
            {rejectFormMsg ? <p className="aic-tap-modal-msg">{rejectFormMsg}</p> : null}
          </div>
        </div>
      ) : null}

      {/* 标记完成二次确认（旧版为原生 confirm，文案一字不差保留） */}
      {completingAppointment ? (
        <div
          className="aic-tap-modal-mask"
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              setCompletingAppointment(null);
            }
          }}
        >
          <div className="aic-tap-modal">
            <h3>确认该次咨询已完成？</h3>
            <p>
              {completingAppointment.student_name}（{completingAppointment.student_class ?? '—'}）·{' '}
              {completingAppointment.date} {completingAppointment.time_slot}
            </p>
            <div className="aic-tap-modal-ops">
              <button
                type="button"
                className="aic-tap-btn-cancel"
                onClick={() => setCompletingAppointment(null)}
                disabled={Boolean(decidingId)}
              >
                取消
              </button>
              <button
                type="button"
                className="aic-tap-btn-ok"
                onClick={() =>
                  completingAppointment
                    ? void decideAppointment(completingAppointment, 'complete')
                    : undefined
                }
                disabled={Boolean(decidingId)}
              >
                确认完成
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </AppShell>
  );
}

export default function TeacherAppointmentPage() {
  return (
    <AuthGuard role="teacher">
      <AppointmentPageContent />
    </AuthGuard>
  );
}
