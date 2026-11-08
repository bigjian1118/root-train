'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { AppShell } from '@/components/business/app-shell';
import { AuthGuard } from '@/components/business/auth-guard';
import { MarkdownText } from '@/components/business/markdown-text';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { ShieldAlert } from 'lucide-react';
import { useConfig } from '@/hooks/use-config';
import type { ChatMessage, Citation, Scenario } from '@/lib/types';
import { useAuthStore } from '@/store/use-auth-store';

// 1:1 复刻旧版 static/chat.html + chat.css：全屏双栏（左渐变侧栏场景切换 + 右聊天区）；
// SSE 流式对话、工具状态提示、引用来源、教师拦截为已确认新增逻辑，保持不变。

// /api/config 不可用时仍要能对话，键名必须与后端 SCENARIOS 一致。
const FALLBACK_SCENARIOS: Scenario[] = [
  { key: 'primary_student', name: '小学生', desc: '用简单易懂的话陪你聊聊' },
  { key: 'junior_student', name: '中学生', desc: '学业与成长中的烦恼' },
  { key: 'college_student', name: '大学生', desc: '人际、情绪与未来规划' },
];

// 工具调用期间的状态条文案；未命中的工具统一显示通用提示。
const TOOL_LABELS: Record<string, string> = {
  rag_search: '正在检索知识库…',
  get_user_report: '正在查询测评记录…',
  save_report: '正在保存测评报告…',
  calculate_score: '正在计算因子分…',
};

const DEFAULT_SCENARIO = 'college_student';
// 与旧版 showToast 一致：提示 3.2s 后自动隐藏。
const TOAST_DURATION_MS = 3200;

interface DeltaPayload {
  content?: string;
}

interface DonePayload {
  citations?: Citation[];
}

interface ErrorPayload {
  message?: string;
}

interface ToolCallPayload {
  name?: string;
}

/** EventSource 的自定义事件统一是 MessageEvent，浏览器 error 事件没有 data。 */
function parseEventPayload<T>(event: Event): T | null {
  const raw = (event as MessageEvent).data;
  if (typeof raw !== 'string' || !raw) {
    return null;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function appendToLastAssistant(
  messages: ChatMessage[],
  updater: (message: ChatMessage) => ChatMessage,
): ChatMessage[] {
  const next = [...messages];
  for (let index = next.length - 1; index >= 0; index -= 1) {
    if (next[index].role === 'assistant') {
      next[index] = updater(next[index]);
      break;
    }
  }
  return next;
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user';
  return (
    <>
      <div className={isUser ? 'aic-msg user' : 'aic-msg'}>
        <div className="aic-msg-avatar" aria-hidden>
          {isUser ? '🙂' : '🌤'}
        </div>
        {isUser ? (
          <div className="aic-bubble">{message.content}</div>
        ) : message.content ? (
          <div className="aic-bubble md-out">
            <MarkdownText content={message.content} />
          </div>
        ) : (
          <div className="aic-bubble">
            <span className="aic-typing-dot" />
            <span className="aic-typing-dot" />
            <span className="aic-typing-dot" />
          </div>
        )}
      </div>
      {message.citations && message.citations.length > 0 ? (
        <div className="aic-cite-box" style={{ marginLeft: 48 }}>
          <p style={{ marginBottom: 4 }}>📖 引用来源</p>
          {message.citations.map((citation, index) => (
            <p key={`${citation.source_id}-${index}`}>· {citation.title || citation.source_id}</p>
          ))}
        </div>
      ) : null}
    </>
  );
}

function ChatContent() {
  const router = useRouter();
  const user = useAuthStore((state) => state.user);
  const configQuery = useConfig();

  const [scenarioKey, setScenarioKey] = useState(DEFAULT_SCENARIO);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [statusText, setStatusText] = useState('');
  const [toastText, setToastText] = useState('');
  const sourceRef = useRef<EventSource | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const scenarios = configQuery.data?.scenarios?.length
    ? configQuery.data.scenarios
    : FALLBACK_SCENARIOS;
  const currentScenario = scenarios.find((item) => item.key === scenarioKey) ?? scenarios[0];

  useEffect(() => {
    if (!toastText) {
      return;
    }
    const timer = window.setTimeout(() => setToastText(''), TOAST_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [toastText]);

  // 组件卸载或切换场景时必须关闭连接，否则后端生成器会一直挂起。
  useEffect(() => {
    return () => {
      sourceRef.current?.close();
      sourceRef.current = null;
    };
  }, []);

  useEffect(() => {
    const list = listRef.current;
    if (list) {
      list.scrollTop = list.scrollHeight;
    }
  }, [messages, statusText]);

  const closeStream = () => {
    sourceRef.current?.close();
    sourceRef.current = null;
    setStreaming(false);
    setStatusText('');
  };

  const handleSend = () => {
    const text = input.trim();
    if (!text || streaming) {
      return;
    }

    setToastText('');
    setInput('');
    setStreaming(true);
    setStatusText('正在思考…');

    // history 只传此前已完成的多轮对话，本轮内容走 content 参数，避免后端重复拼接。
    const history = messages
      .filter((message) => message.content && message.role !== 'system')
      .map((message) => ({ role: message.role, content: message.content }));

    setMessages((prev) => [
      ...prev,
      { role: 'user', content: text },
      { role: 'assistant', content: '' },
    ]);

    const query = new URLSearchParams({
      scenario: scenarioKey,
      content: text,
      history: JSON.stringify(history),
    });
    const source = new EventSource(`/api/chat/stream?${query.toString()}`);
    sourceRef.current = source;

    source.addEventListener('meta', () => setStatusText(''));
    source.addEventListener('tool_call', (event) => {
      const payload = parseEventPayload<ToolCallPayload>(event);
      const name = payload?.name ?? '';
      setStatusText(TOOL_LABELS[name] ?? '正在准备资料…');
    });
    source.addEventListener('tool_result', () => setStatusText('正在整理回答…'));
    source.addEventListener('delta', (event) => {
      const payload = parseEventPayload<DeltaPayload>(event);
      const piece = payload?.content ?? '';
      if (!piece) {
        return;
      }
      setStatusText('');
      setMessages((prev) =>
        appendToLastAssistant(prev, (message) => ({
          ...message,
          content: message.content + piece,
        })),
      );
    });
    source.addEventListener('done', (event) => {
      const payload = parseEventPayload<DonePayload>(event);
      const citations = payload?.citations ?? [];
      if (citations.length > 0) {
        setMessages((prev) =>
          appendToLastAssistant(prev, (message) => ({ ...message, citations })),
        );
      }
      closeStream();
    });
    source.addEventListener('error', (event) => {
      const payload = parseEventPayload<ErrorPayload>(event);
      const message =
        payload?.message ?? '连接中断，可能是后端未启动或网络异常，请稍后重试。';
      setToastText(message);
      // 失败时移除空的 AI 占位气泡，避免界面停在打字动画。
      setMessages((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last && last.role === 'assistant' && !last.content) {
          next.pop();
        }
        return next;
      });
      closeStream();
    });
  };

  const handleClear = () => {
    closeStream();
    setMessages([]);
    setToastText('');
  };

  if (user?.role === 'teacher') {
    return (
      <AppShell role="student">
        <Alert variant="warning">
          <ShieldAlert className="h-4 w-4" />
          <AlertTitle>该功能仅向学生开放</AlertTitle>
          <AlertDescription>教师账号仅保留查看班级测试情况功能</AlertDescription>
        </Alert>
      </AppShell>
    );
  }

  return (
    <AppShell bare>
      <div className="aic-chat-layout">
        <aside className="aic-chat-sidebar">
          <div className="aic-chat-headnav">
            <button type="button" className="aic-chat-back" onClick={() => router.back()}>
              ← 返回上一页
            </button>
            <Link href="/" className="aic-chat-back-link">
              返回首页
            </Link>
          </div>
          <h1 className="aic-chat-brand">💬 心语助手</h1>
          <p className="aic-chat-tip">选择你的身份场景，获得更贴合的陪伴</p>
          <div className="aic-scenario-list">
            {scenarios.map((scenario) => (
              <button
                key={scenario.key}
                type="button"
                className={
                  scenario.key === currentScenario?.key ? 'aic-scenario-btn active' : 'aic-scenario-btn'
                }
                onClick={() => setScenarioKey(scenario.key)}
              >
                {scenario.name}
                <small>{scenario.desc}</small>
              </button>
            ))}
          </div>
          <button type="button" className="aic-clear-btn" onClick={handleClear}>
            🗑 清空会话
          </button>
          {configQuery.data?.mock ? <div className="aic-mock-badge">MOCK 演示模式</div> : null}
        </aside>

        <main className="aic-chat-main">
          <div className="aic-chat-headbar">当前场景：{currentScenario?.name ?? '大学生'}</div>
          {/* 新增功能保持：AI 内容免责提示 */}
          <Alert variant="info" className="m-0 rounded-none border-x-0 border-t-0">
            <ShieldAlert className="h-4 w-4" />
            <AlertTitle>AI 生成内容仅供参考</AlertTitle>
            <AlertDescription>
              心语助手不能替代心理咨询或医疗诊断。若你出现持续的情绪困扰，请及时联系学校心理老师，
              或拨打全国心理援助热线 12356。
            </AlertDescription>
          </Alert>
          <div className="aic-msg-list" ref={listRef}>
            {messages.length === 0 ? (
              <div className="aic-msg">
                <div className="aic-msg-avatar">🌤</div>
                <div className="aic-bubble">
                  你好呀，我是心语助手。选择左侧的身份场景，就可以开始和我聊心事啦～
                </div>
              </div>
            ) : (
              messages.map((message, index) => (
                <MessageBubble key={`${message.role}-${index}`} message={message} />
              ))
            )}
            {statusText ? (
              <p className="aic-chat-tip" style={{ color: '#5b7688', marginLeft: 48 }}>
                {statusText}
              </p>
            ) : null}
          </div>
          <div className="aic-input-bar">
            <textarea
              className="aic-chat-input"
              value={input}
              rows={1}
              placeholder="输入你想说的话，Enter 发送"
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                // Enter 发送，Shift+Enter 换行，与旧版交互保持一致。
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  handleSend();
                }
              }}
              disabled={streaming}
            />
            <button
              type="button"
              className="aic-send-btn"
              onClick={handleSend}
              disabled={streaming || !input.trim()}
            >
              发送
            </button>
          </div>
        </main>
      </div>
      {toastText ? <div className="aic-toast">{toastText}</div> : null}
    </AppShell>
  );
}

export default function ChatPage() {
  return (
    <AuthGuard role="student">
      <ChatContent />
    </AuthGuard>
  );
}
