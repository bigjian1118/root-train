'use client';

import { Loader2, RefreshCw } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { AppShell } from '@/components/business/app-shell';
import { AuthGuard } from '@/components/business/auth-guard';
import { LoadingSkeleton } from '@/components/business/loading-skeleton';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/components/ui/toast';
import { ApiError, getJson, postJson } from '@/lib/api';
import { formatTimestamp } from '@/lib/utils';

interface MessageItem {
  id?: string;
  conversation_id?: string;
  sender_role: 'student' | 'teacher';
  content: string;
  is_read?: boolean;
  created_at: number;
}

interface ConversationDetail {
  conversation: {
    id: string;
    teacher_id?: string;
    teacher_name?: string;
    student_name?: string;
  };
  messages?: MessageItem[];
}

interface SendMessageResponse {
  ok: boolean;
  message: MessageItem;
}

// 相邻两条消息间隔小于该秒数时合并展示时间，避免刷屏。
const TIME_MERGE_SECONDS = 90;
const POLL_INTERVAL_MS = 3000;

function ChatDetailContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  // 兼容旧链接 ?conv=xxx 与任务约定的 conversationId。
  const conversationId = searchParams.get('conversationId') ?? searchParams.get('conv') ?? '';

  const [messages, setMessages] = useState<MessageItem[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const markedReadRef = useRef(false);
  const listRef = useRef<HTMLDivElement | null>(null);

  const detailQuery = useQuery({
    queryKey: ['student', 'msg', 'conversation', conversationId],
    queryFn: () =>
      getJson<ConversationDetail>(
        `/api/student/msg/conversation/${encodeURIComponent(conversationId)}`,
      ),
    enabled: Boolean(conversationId),
    refetchInterval: POLL_INTERVAL_MS,
  });

  useEffect(() => {
    const next = detailQuery.data?.messages;
    if (!next) {
      return;
    }
    // 轮询每 3 秒返回同一份历史，若首尾消息未变化就不替换 state，
    // 否则列表会被强制滚动到底部，打断用户回看旧消息。
    setMessages((prev) => {
      const sameTail =
        prev.length === next.length && prev[prev.length - 1]?.id === next[next.length - 1]?.id;
      return sameTail ? prev : next;
    });
  }, [detailQuery.data]);

  // 打开会话即把老师发来的消息标记为已读，红点随之消失；只执行一次。
  useEffect(() => {
    if (!conversationId || !detailQuery.data || markedReadRef.current) {
      return;
    }
    markedReadRef.current = true;
    postJson<{ ok: boolean }>(
      `/api/student/msg/conversation/${encodeURIComponent(conversationId)}/read`,
    )
      .then(() => {
        // 红点与列表未读数都要同步刷新，否则返回列表仍显示旧角标。
        void queryClient.invalidateQueries({ queryKey: ['msg', 'unread'] });
        void queryClient.invalidateQueries({ queryKey: ['student', 'msg', 'conversations'] });
      })
      .catch(() => {
        // 标记失败不影响阅读，但允许下次进入重试。
        markedReadRef.current = false;
      });
  }, [conversationId, detailQuery.data, queryClient]);

  useEffect(() => {
    const list = listRef.current;
    if (list) {
      list.scrollTop = list.scrollHeight;
    }
  }, [messages]);

  const handleSend = async () => {
    const content = input.trim();
    if (!content || sending || !conversationId) {
      return;
    }
    setSending(true);
    try {
      const response = await postJson<SendMessageResponse>(
        `/api/student/msg/conversation/${encodeURIComponent(conversationId)}/messages`,
        { content },
      );
      setInput('');
      setMessages((prev) => [...prev, response.message]);
      void detailQuery.refetch();
    } catch (caught) {
      // 旧版口径：网络失败提示「发送失败，请重试。」，接口错误直接展示后端 error 文案。
      toast({
        title: caught instanceof ApiError ? caught.message : '发送失败，请重试。',
        variant: 'destructive',
      });
    } finally {
      setSending(false);
    }
  };

  const teacherName = detailQuery.data?.conversation?.teacher_name || '心理老师';

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
        <b>{teacherName}</b>
        <span>心理咨询师 · 倾诉对象</span>
      </div>
      <span className="aic-msgchat-privacy">🔒 一对一私密</span>
    </header>
  );

  const chatInput = (
    <footer className="aic-msgchat-input">
      <textarea
        value={input}
        onChange={(event) => setInput(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void handleSend();
          }
        }}
        rows={1}
        maxLength={2000}
        placeholder="写下你的心里话…"
        disabled={sending}
      />
      <button type="button" onClick={() => void handleSend()} disabled={sending || !input.trim()}>
        {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
        发送
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
              <div className="flex justify-center">
                <Link href="/msg" className="aic-msgchat-back">
                  返回会话列表
                </Link>
              </div>
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
          <div className="aic-msgchat-body" ref={listRef}>
            {detailQuery.isLoading ? (
              <p className="aic-msgchat-load-tip">正在加载记录…</p>
            ) : null}
            {detailQuery.isError ? (
              <>
                <p className="aic-msgchat-load-tip">加载失败，请检查网络。</p>
                <div className="flex justify-center">
                  <button
                    type="button"
                    className="aic-msgchat-back"
                    onClick={() => void detailQuery.refetch()}
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    重试
                  </button>
                </div>
              </>
            ) : null}
            {!detailQuery.isLoading && !detailQuery.isError && messages.length === 0 ? (
              <p className="aic-msgchat-load-tip">和老师还没有消息，写下你的第一句话吧。</p>
            ) : null}
            {!detailQuery.isLoading && !detailQuery.isError
              ? messages.map((message, index) => {
                  const isMine = message.sender_role === 'student';
                  const previous = messages[index - 1];
                  const showTime =
                    !previous ||
                    Math.abs(message.created_at - previous.created_at) >= TIME_MERGE_SECONDS;
                  return (
                    <div
                      key={message.id ?? `${index}-${message.created_at}`}
                      className={isMine ? 'aic-msgchat-msg mine' : 'aic-msgchat-msg other'}
                    >
                      <span
                        aria-hidden
                        className={
                          isMine
                            ? 'aic-msgchat-avatar avatar-student'
                            : 'aic-msgchat-avatar avatar-teacher'
                        }
                      >
                        {isMine ? '🧑‍🎓' : '🧑‍🏫'}
                      </span>
                      <div className="aic-msgchat-msg-main">
                        <div className="aic-msgchat-bubble">{message.content}</div>
                        {showTime ? (
                          <div className="aic-msgchat-msg-time">
                            {formatTimestamp(message.created_at)}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  );
                })
              : null}
          </div>

          {/* 新版新增能力保留：隐私提示 + 3 秒轮询说明（沿用旧版 .chat-hint 样式条） */}
          {messages.length > 0 ? (
            <div className="aic-msgchat-hint flex items-center justify-center gap-2">
              <Badge variant="secondary">仅你与老师可见</Badge>
              <span>每 {POLL_INTERVAL_MS / 1000} 秒自动刷新一次</span>
            </div>
          ) : null}

          {chatInput}
        </div>
      </div>
    </AppShell>
  );
}

export default function MsgChatPage() {
  return (
    <AuthGuard role="student">
      {/* useSearchParams 在 App Router 静态渲染时必须位于 Suspense 边界内。 */}
      <Suspense fallback={<LoadingSkeleton rows={3} />}>
        <ChatDetailContent />
      </Suspense>
    </AuthGuard>
  );
}
