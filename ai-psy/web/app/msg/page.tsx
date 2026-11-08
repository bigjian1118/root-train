'use client';

import { HeartHandshake, MessageSquare, RefreshCw } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';

import { AppShell } from '@/components/business/app-shell';
import { AuthGuard } from '@/components/business/auth-guard';
import { LoadingSkeleton } from '@/components/business/loading-skeleton';
import { StatCard } from '@/components/business/stat-card';
import { getJson } from '@/lib/api';
import type { Conversation, ConversationsResponse } from '@/lib/types';
import { formatTimestamp } from '@/lib/utils';

interface UnreadPayload {
  total?: number;
}

type ConversationListPayload = Partial<ConversationsResponse> & { conversations?: Conversation[] };

function conversationsOf(payload?: ConversationListPayload | Conversation[]): Conversation[] {
  if (Array.isArray(payload)) {
    return payload;
  }
  return payload?.conversations ?? [];
}

function unreadOf(conversation: Conversation): number {
  return conversation.unread ?? conversation.unread_count ?? 0;
}

function ConversationsContent() {
  const router = useRouter();
  const unreadQuery = useQuery({
    queryKey: ['msg', 'unread'],
    queryFn: () => getJson<UnreadPayload>('/api/msg/unread'),
  });
  const listQuery = useQuery({
    queryKey: ['student', 'msg', 'conversations'],
    queryFn: () =>
      getJson<ConversationListPayload | Conversation[]>('/api/student/msg/conversations'),
  });

  const conversations = conversationsOf(listQuery.data);
  const unreadTotal = unreadQuery.data?.total ?? 0;

  return (
    <AppShell bare>
      {/* 旧版 .page 全屏容器 + .topbar（左 head-nav、右「＋ 选择老师倾诉」）1:1 复刻 */}
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
          <Link href="/msg/choose" className="aic-msgs-btn-new">
            ＋ 选择老师倾诉
          </Link>
        </div>
        <h1 className="aic-msgs-h1">💬 我的倾诉</h1>
        <p className="aic-msgs-sub">与心理老师的一对一私密留言，仅你与老师可见，永久保存。</p>

        {/* 新版新增能力保留：未读/会话统计卡 + 手动刷新 */}
        <div className="mb-4 flex justify-end">
          <button
            type="button"
            className="aic-msgs-back"
            onClick={() => {
              void listQuery.refetch();
              void unreadQuery.refetch();
            }}
          >
            <RefreshCw className="h-3.5 w-3.5" />
            刷新
          </button>
        </div>
        <div className="mb-4 grid gap-3 sm:grid-cols-2">
          <StatCard
            title="未读消息"
            value={unreadTotal}
            description={unreadTotal > 0 ? '有老师回复了你，点开会话查看' : '暂无新的老师回复'}
            icon={MessageSquare}
            tone={unreadTotal > 0 ? 'primary' : 'default'}
          />
          <StatCard
            title="会话数量"
            value={conversations.length}
            description="每位老师一个独立会话"
            icon={HeartHandshake}
          />
        </div>

        <div className="aic-msgs-conv-list">
          {listQuery.isLoading ? <LoadingSkeleton rows={2} /> : null}
          {listQuery.isError ? (
            <p className="aic-msgs-empty-tip">加载失败，请检查网络。</p>
          ) : null}
          {!listQuery.isLoading && !listQuery.isError && conversations.length === 0 ? (
            <p className="aic-msgs-empty-tip">还没有倾诉会话，点击「选择老师倾诉」开始吧。</p>
          ) : null}
          {conversations.map((conversation) => {
            const unread = unreadOf(conversation);
            return (
              <Link
                key={conversation.id}
                href={`/msg/chat?conversationId=${encodeURIComponent(conversation.id)}`}
                className="aic-msgs-conv-item"
              >
                <span className="aic-msgs-conv-avatar">🧑‍🏫</span>
                <div className="aic-msgs-conv-main">
                  <div className="aic-msgs-conv-row">
                    <span className="aic-msgs-conv-name">
                      {conversation.teacher_name ?? '心理老师'}
                    </span>
                    <span className="aic-msgs-conv-time">
                      {formatTimestamp(conversation.last_time)}
                    </span>
                  </div>
                  <div className="aic-msgs-conv-preview">
                    {conversation.last_message || '开始一段倾诉吧'}
                  </div>
                </div>
                {unread > 0 ? (
                  <span className="aic-msgs-unread-badge">
                    {unread > 99 ? '99+' : unread}
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

export default function MsgListPage() {
  return (
    <AuthGuard role="student">
      <ConversationsContent />
    </AuthGuard>
  );
}
