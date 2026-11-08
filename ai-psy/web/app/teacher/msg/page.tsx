'use client';

import { useQuery } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

import { AppShell } from '@/components/business/app-shell';
import { AuthGuard } from '@/components/business/auth-guard';
import { LoadingSkeleton } from '@/components/business/loading-skeleton';
import { Badge } from '@/components/ui/badge';
import { getJson } from '@/lib/api';
import type { Conversation } from '@/lib/types';

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

function readUnreadTotal(raw: unknown): number {
  if (typeof raw === 'number') {
    return raw;
  }
  if (raw && typeof raw === 'object') {
    const record = raw as Record<string, unknown>;
    if (typeof record.total === 'number') {
      return record.total;
    }
    if (typeof record.unread === 'number') {
      return record.unread;
    }
    if (typeof record.count === 'number') {
      return record.count;
    }
  }
  return 0;
}

/** 兼容后端返回秒级 epoch 与 ISO 字符串两种时间格式。 */
function formatConversationTime(value?: number | string): string {
  if (value == null || value === '') {
    return '—';
  }
  const date =
    typeof value === 'number' ? new Date(value < 1e12 ? value * 1000 : value) : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  // 旧版 teacher_msg_list.js fmtTime 口径：当天显示 HH:MM，其余显示「月/日」
  if (sameDay) {
    const hh = `0${date.getHours()}`.slice(-2);
    const mm = `0${date.getMinutes()}`.slice(-2);
    return `${hh}:${mm}`;
  }
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

function MsgListContent() {
  const router = useRouter();
  const conversationsQuery = useQuery({
    queryKey: ['teacher', 'msg', 'conversations'],
    queryFn: async () =>
      pickArray<Conversation>(
        await getJson<unknown>('/api/teacher/msg/conversations'),
        'conversations',
      ),
  });

  const unreadQuery = useQuery({
    queryKey: ['teacher', 'msg', 'unread'],
    queryFn: () => getJson<unknown>('/api/msg/unread'),
  });

  const conversations = conversationsQuery.data ?? [];
  const unreadTotal = readUnreadTotal(unreadQuery.data);
  const loadError = conversationsQuery.isError || unreadQuery.isError;

  return (
    <AppShell bare>
      {/* 旧版 .page 全屏容器 + .topbar（左 head-nav、右 head-note）1:1 复刻 */}
      <div className="aic-msgs-page min-h-screen px-[24px] pb-[60px] pt-[20px]">
        <div className="aic-msgs-topbar">
          <span className="aic-msgs-headnav">
            <button type="button" className="aic-msgs-back" onClick={() => router.back()}>
              ← 返回上一页
            </button>
            <Link href="/" className="aic-msgs-back-link">
              返回首页
            </Link>
          </span>
          {/* 新版新增能力保留：未读总数徽章 + 手动刷新，排在旧版 head-note 右侧 */}
          <span className="inline-flex items-center gap-[10px]">
            <span className="aic-tmsg-head-note">🔒 仅你和这位学生可见，永久保存</span>
            {unreadTotal > 0 ? (
              <Badge variant="destructive" className="h-7 px-3">
                {unreadTotal} 条未读
              </Badge>
            ) : (
              <Badge variant="success" className="h-7 px-3">
                已全部读
              </Badge>
            )}
            <button
              type="button"
              className="aic-msgs-back"
              onClick={() => {
                void conversationsQuery.refetch();
                void unreadQuery.refetch();
              }}
            >
              <RefreshCw className="h-3.5 w-3.5" />
              刷新
            </button>
          </span>
        </div>
        <h1 className="aic-msgs-h1">📥 学生倾诉留言</h1>
        <p className="aic-msgs-sub">
          学生向你发起的一对一倾诉，新留言高亮提醒，请及时回应疏导。
        </p>

        <div className="aic-msgs-conv-list">
          {conversationsQuery.isLoading ? <LoadingSkeleton rows={3} /> : null}
          {!conversationsQuery.isLoading && loadError ? (
            <p className="aic-msgs-empty-tip">加载失败，请检查网络。</p>
          ) : null}
          {!conversationsQuery.isLoading && !loadError && conversations.length === 0 ? (
            <p className="aic-msgs-empty-tip">暂没有学生给你留言。</p>
          ) : null}
          {conversations.map((conversation) => {
            const unreadCount = conversation.unread ?? conversation.unread_count ?? 0;
            const hasNew = unreadCount > 0;
            const lastTime =
              conversation.last_time ??
              conversation.updated_timestamp ??
              conversation.create_timestamp;
            return (
              <Link
                key={conversation.id}
                href={`/teacher/msg/chat?conversationId=${encodeURIComponent(conversation.id)}`}
                className={hasNew ? 'aic-msgs-conv-item has-new' : 'aic-msgs-conv-item'}
              >
                <span className="aic-msgs-conv-avatar">🧑‍🎓</span>
                <div className="aic-msgs-conv-main">
                  <div className="aic-msgs-conv-row">
                    <span className="aic-msgs-conv-name">
                      {conversation.student_name || '学生'}
                    </span>
                    <span className="aic-tmsg-class-tag">{conversation.student_class || ''}</span>
                    <span className="aic-msgs-conv-time">{formatConversationTime(lastTime)}</span>
                  </div>
                  <div className="aic-msgs-conv-preview">
                    {hasNew ? '🟡 新留言 · ' : ''}
                    {conversation.last_message || '学生发来了一条留言'}
                  </div>
                </div>
                {hasNew ? (
                  <span className="aic-msgs-unread-badge">
                    {unreadCount > 99 ? '99+' : unreadCount}
                  </span>
                ) : null}
              </Link>
            );
          })}
        </div>
      </div>
    </AppShell>
  );
}

export default function TeacherMsgListPage() {
  return (
    <AuthGuard role="teacher">
      <MsgListContent />
    </AuthGuard>
  );
}
