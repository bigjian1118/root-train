'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState, type KeyboardEvent } from 'react';

import { AppShell } from '@/components/business/app-shell';
import { AuthGuard } from '@/components/business/auth-guard';
import { LoadingSkeleton } from '@/components/business/loading-skeleton';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/components/ui/toast';
import { ApiError, getJson, postJson } from '@/lib/api';

const MAX_MESSAGE_LENGTH = 2000;
const POLL_INTERVAL_MS = 3000;

interface ConversationMeta {
  id: string;
  student_id?: string;
  student_name?: string;
  student_class?: string;
  teacher_name?: string;
}

interface ConversationMessage {
  id: string;
  sender_role: 'student' | 'teacher' | string;
  content: string;
  created_at: number;
  is_read?: boolean;
}

interface ConversationDetailResponse {
  conversation: ConversationMeta;
  messages: ConversationMessage[];
}

interface SendMessageResponse {
  ok?: boolean;
  message?: ConversationMessage;
}

function formatChatTime(timestamp?: number): string {
  if (!timestamp) {
    return '';
  }
  const date = new Date(timestamp < 1e12 ? timestamp * 1000 : timestamp);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  const time = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  if (sameDay) {
    return time;
  }
  return `${date.getMonth() + 1}-${date.getDate()} ${time}`;
}

function ChatContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const conversationId = (
    searchParams.get('conversationId') ||
    searchParams.get('conv') ||
    ''
  ).trim();

  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const markedReadRef = useRef('');

  // 旧后端没有单独的 GET messages 接口，会话详情接口已返回完整 messages。
  const detailQuery = useQuery({
    queryKey: ['teacher', 'msg', 'conversation', conversationId],
    queryFn: () =>
      getJson<ConversationDetailResponse>(
        `/api/teacher/msg/conversation/${encodeURIComponent(conversationId)}`,
      ),
    enabled: Boolean(conversationId),
    refetchInterval: POLL_INTERVAL_MS,
  });

  const conversation = detailQuery.data?.conversation;
  const messages = detailQuery.data?.messages ?? [];

  // 进入会话只标记一次已读；轮询刷新时无需重复请求。
  useEffect(() => {
    if (!conversationId || markedReadRef.current === conversationId) {
      return;
    }
    markedReadRef.current = conversationId;
    postJson(`/api/teacher/msg/conversation/${encodeURIComponent(conversationId)}/read`)
      .then(() => queryClient.invalidateQueries({ queryKey: ['teacher', 'msg', 'unread'] }))
      .catch(() => {
        // 标记已读失败不影响聊天，下次进入会再次尝试。
        markedReadRef.current = '';
      });
  }, [conversationId, queryClient]);

  // 新消息到达后滚动到底部，避免轮询把阅读位置打断。
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (container) {
      container.scrollTop = container.scrollHeight;
    }
  }, [conversationId, messages.length]);

  const sendMessage = async () => {
    const content = draft.trim();
    if (!content || !conversationId || sending) {
      return;
    }
    if (content.length > MAX_MESSAGE_LENGTH) {
      toast({ title: `消息内容过长（限 ${MAX_MESSAGE_LENGTH} 字）`, variant: 'destructive' });
      return;
    }
    setSending(true);
    try {
      await postJson<SendMessageResponse>(
        `/api/teacher/msg/conversation/${encodeURIComponent(conversationId)}/messages`,
        { content },
      );
      setDraft('');
      await detailQuery.refetch();
    } catch (error) {
      // 旧版口径：网络失败提示「回复失败，请重试。」，接口错误直接展示后端 error 文案。
      toast({
        title: error instanceof ApiError ? error.message : '回复失败，请重试。',
        variant: 'destructive',
      });
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void sendMessage();
    }
  };

  const backLink = (
    <Link href="/teacher/msg" className="aic-msgchat-back">
      <ChevronLeft className="h-4 w-4" />
      返回会话列表
    </Link>
  );

  const chatHead = (
    <header className="aic-msgchat-head">
      <span className="aic-msgchat-headnav">
        <button type="button" className="aic-msgchat-back" onClick={() => router.back()}>
          ← 返回上一页
        </button>
        <Link href="/" className="aic-msgchat-back-link">
          首页
        </Link>
      </span>
      <div className="aic-msgchat-head-who">
        <b>{conversation?.student_name || '学生'}</b>
        <span>
          {conversation ? `学生 · ${conversation.student_class || ''} · 倾诉者` : '心理倾诉者'}
        </span>
      </div>
      <span className="aic-msgchat-privacy">🔒 一对一私密</span>
    </header>
  );

  const chatInput = (
    <footer className="aic-msgchat-input">
      <textarea
        rows={1}
        maxLength={MAX_MESSAGE_LENGTH}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="用心回应、温柔疏导…"
        disabled={sending}
      />
      <button type="button" onClick={() => void sendMessage()} disabled={sending || !draft.trim()}>
        {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
        回复
      </button>
    </footer>
  );

  if (!conversationId) {
    return (
      <AppShell bare>
        <div className="aic-msgchat-root">
          <div className="aic-msgchat-page">
            {chatHead}
            <div className="aic-msgchat-body">
              <p className="aic-msgchat-load-tip">缺少会话参数，无法打开。</p>
              {/* 新版新增能力保留：一键返回会话列表 */}
              <div className="flex justify-center">{backLink}</div>
            </div>
            {chatInput}
          </div>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell bare>
      <div className="aic-msgchat-root">
        <div className="aic-msgchat-page">
          {chatHead}
          <div className="aic-msgchat-body" ref={scrollContainerRef}>
            {detailQuery.isLoading ? (
              <p className="aic-msgchat-load-tip">正在加载留言…</p>
            ) : null}
            {detailQuery.isError ? (
              <>
                <p className="aic-msgchat-load-tip">
                  {detailQuery.error instanceof ApiError ? detailQuery.error.message : '加载失败，请检查网络。'}
                </p>
                <div className="flex justify-center">
                  <button
                    type="button"
                    className="aic-msgchat-back"
                    onClick={() => void detailQuery.refetch()}
                  >
                    重试
                  </button>
                </div>
              </>
            ) : null}
            {!detailQuery.isLoading && !detailQuery.isError && messages.length === 0 ? (
              <p className="aic-msgchat-load-tip">还没有留言，学生倾诉后可在此发起对话。</p>
            ) : null}
            {messages.map((message) => {
              const isTeacher = message.sender_role === 'teacher';
              return (
                <div
                  key={message.id}
                  className={isTeacher ? 'aic-msgchat-msg mine' : 'aic-msgchat-msg other'}
                >
                  <span
                    aria-hidden
                    className={
                      isTeacher
                        ? 'aic-msgchat-avatar avatar-teacher'
                        : 'aic-msgchat-avatar avatar-student'
                    }
                  >
                    {isTeacher ? '🧑‍🏫' : '🧑‍🎓'}
                  </span>
                  <div className="aic-msgchat-msg-main">
                    <div className="aic-msgchat-bubble">{message.content}</div>
                    <div className="aic-msgchat-msg-time">{formatChatTime(message.created_at)}</div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* 新版新增能力保留：班级/学号徽章、返回会话列表、字数统计（沿用旧版 .chat-hint 样式条） */}
          <div className="aic-msgchat-hint flex flex-wrap items-center justify-center gap-2">
            {conversation?.student_class ? (
              <Badge variant="secondary">{conversation.student_class}</Badge>
            ) : null}
            {conversation?.student_id ? (
              <Badge variant="outline">{conversation.student_id}</Badge>
            ) : null}
            {backLink}
            <span>
              {draft.length} / {MAX_MESSAGE_LENGTH}
            </span>
          </div>

          {chatInput}
        </div>
      </div>
    </AppShell>
  );
}

export default function TeacherMsgChatPage() {
  return (
    <AuthGuard role="teacher">
      {/* useSearchParams 在 App Router 静态渲染时必须位于 Suspense 边界内。 */}
      <Suspense fallback={<LoadingSkeleton rows={3} />}>
        <ChatContent />
      </Suspense>
    </AuthGuard>
  );
}
