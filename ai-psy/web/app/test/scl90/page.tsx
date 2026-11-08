'use client';

import { Loader2, PhoneCall } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { AppShell } from '@/components/business/app-shell';
import { AuthGuard } from '@/components/business/auth-guard';
import { EmptyState } from '@/components/business/empty-state';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { buttonVariants } from '@/components/ui/button';
import { useConfig } from '@/hooks/use-config';
import { ApiError, getJson, postJson } from '@/lib/api';
import {
  DEFAULT_SCENARIOS,
  loadQuestionBank,
  resolveScenarioQuestions,
} from '@/lib/question-bank';
import {
  CRISIS_HOTLINE,
  LIKERT_OPTIONS,
  scoreScl90,
} from '@/lib/scoring';
import type {
  ReportsResponse,
  Scl90Answers,
  StoredScl90Report,
  TestSubmitResponse,
} from '@/lib/types';

// 与旧版 test.js 一致：选中选项后短暂停留再跳题，让用户确认所选答案。
const AUTO_NEXT_DELAY_MS = 260;
// 与旧版 showToast 一致：提示 3.2s 后自动隐藏。
const TOAST_DURATION_MS = 3200;

// 场景 emoji 装饰映射（与旧版 test.js SCENE_EMOJI 一致）。
const SCENE_EMOJI: Record<string, string> = {
  primary_student: '🧒',
  junior_student: '🎒',
  college_student: '🎓',
};

const TEST_PAGE_CLASS = 'mx-auto min-h-screen max-w-[780px] px-[36px] pb-[70px] pt-[20px]';

function Scl90Content() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // 对齐旧版同页两步流程：无 scenario 参数时先在本页选择场景，选中后写入 URL 进入答题。
  const [pickedScenario, setPickedScenario] = useState<string | null>(null);
  const scenario = searchParams.get('scenario') || pickedScenario;

  const configQuery = useConfig();
  const bankQuery = useQuery({
    queryKey: ['question-bank'],
    queryFn: loadQuestionBank,
    staleTime: Infinity,
    retry: 1,
  });

  const scenarios = configQuery.data?.scenarios?.length
    ? configQuery.data.scenarios
    : DEFAULT_SCENARIOS;
  const scenarioValid = scenarios.some((item) => item.key === scenario);
  const resolved = useMemo(
    () => (scenario ? resolveScenarioQuestions(bankQuery.data, scenario) : null),
    [bankQuery.data, scenario],
  );
  const scene = resolved?.questions ?? [];
  const sceneName =
    scenarios.find((item) => item.key === scenario)?.name ??
    DEFAULT_SCENARIOS.find((item) => item.key === scenario)?.name ??
    resolved?.name ??
    '心理测评';

  const [answers, setAnswers] = useState<Scl90Answers>({});
  const [cursor, setCursor] = useState(0);
  const [navigating, setNavigating] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // 旧版 toast：未答题定位提示与提交错误都走底部胶囊提示
  const [toastText, setToastText] = useState('');

  useEffect(() => {
    if (!toastText) {
      return;
    }
    const timer = window.setTimeout(() => setToastText(''), TOAST_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [toastText]);

  const isLastQuestion = cursor === scene.length - 1;
  const currentQuestion = scene[cursor];
  const answeredCount = useMemo(
    () => scene.filter((question) => answers[question.id] != null).length,
    [answers, scene],
  );
  const allAnswered = answeredCount === scene.length;

  const handleAnswer = (questionId: number, value: number) => {
    if (navigating) {
      return;
    }
    setAnswers((current) => ({ ...current, [questionId]: value }));
    if (cursor < scene.length - 1) {
      setNavigating(true);
      window.setTimeout(() => {
        setCursor((current) => Math.min(current + 1, scene.length - 1));
        setNavigating(false);
      }, AUTO_NEXT_DELAY_MS);
    }
  };

  const handleSubmit = async () => {
    if (!scenario || submitting) {
      return;
    }
    // 与旧版一致：点击提交时若仍有未答题，先定位到第一道未答题并 toast 提示。
    const missing = scene.find((question) => answers[question.id] == null);
    if (missing) {
      setCursor(scene.indexOf(missing));
      setToastText(`还有未作答的题目：${missing.question.slice(0, 18)}…`);
      return;
    }
    setSubmitting(true);
    const result = scoreScl90(answers);

    try {
      const response = await postJson<TestSubmitResponse>('/api/test/submit', {
        scenario,
        result,
        answers,
      });

      // 提交接口不返回 report_id，补一次列表查询取最新归档 id，供报告页展示。
      let reportId: string | undefined;
      try {
        const list = await getJson<ReportsResponse>('/api/student/reports');
        const first = list.reports?.[0];
        reportId = first?.id ?? first?.report_id;
      } catch {
        // 列表查询失败不影响报告渲染，report_id 仅作展示。
      }

      const stored: StoredScl90Report = {
        scores: response.scores ?? result,
        has_crisis: response.has_crisis,
        crisis_message: response.crisis_message,
        report: response.report ?? response.ai_content ?? '',
        ai_content: response.ai_content,
        report_id: reportId,
        scenario_name: sceneName,
        submitted_at: Date.now(),
        viewer_role: 'student',
      };
      try {
        sessionStorage.setItem('scl90_report', JSON.stringify(stored));
      } catch {
        // 存储异常时仍跳转，报告页会显示兜底提示。
      }
      router.push('/test/report');
    } catch (error) {
      setSubmitting(false);
      setToastText(
        error instanceof ApiError ? error.message : `网络错误：${(error as Error).message}`,
      );
    }
  };

  // 第一步（对齐旧版 test.html pickPanel）：未选场景时先在本页选择场景。
  if (!scenario) {
    return (
      <AppShell role="student" pageClassName={TEST_PAGE_CLASS}>
        <h1 className="aic-page-title">📋 SCL-90 场景化心理测评</h1>
        <p className="aic-page-sub">
          90 道生活化情境题 · 最近一周感受 · 预计 10-15 分钟
          <br />
          请选择最贴近你的身份场景：
        </p>
        <div className="aic-pick-list">
          {scenarios.map((sceneItem) => (
            <button
              key={sceneItem.key}
              type="button"
              className="aic-pick-card"
              onClick={() => {
                setPickedScenario(sceneItem.key);
                router.replace(`/test/scl90?scenario=${sceneItem.key}`);
              }}
            >
              <div className="aic-pick-emoji">{SCENE_EMOJI[sceneItem.key] ?? '🙂'}</div>
              <div>
                <h3>{sceneItem.name}</h3>
                <p>{sceneItem.desc}</p>
              </div>
              <div className="aic-pick-arrow">→</div>
            </button>
          ))}
        </div>
        {configQuery.isError ? (
          <p className="aic-page-sub" style={{ margin: '16px 0 0' }}>
            场景配置加载失败，已使用内置的三个场景，不影响作答。
          </p>
        ) : null}
      </AppShell>
    );
  }

  if (configQuery.isSuccess && !scenarioValid) {
    return (
      <AppShell role="student" pageClassName={TEST_PAGE_CLASS}>
        <EmptyState
          title="未知的测评场景"
          description="该场景不在当前配置中，请返回重新选择。"
          action={
            <Link href="/test" className={buttonVariants()}>
              返回选择场景
            </Link>
          }
        />
      </AppShell>
    );
  }

  // 第二步（对齐旧版 test.html quizPanel）：逐题作答 + 顶部进度条 + 五级选项。
  return (
    <AppShell role="student" pageClassName={TEST_PAGE_CLASS}>
      <div className="aic-quiz-head">
        <span className="aic-quiz-scene">{sceneName}场景</span>
        <span className="aic-quiz-prog">
          第 {cursor + 1}/{scene.length} 题
        </span>
      </div>
      <div className="aic-prog-track">
        <div
          className="aic-prog-fill"
          style={{ width: `${((cursor + 1) / (scene.length || 1)) * 100}%` }}
        />
      </div>

      <div className="aic-q-card">
        <div className="aic-q-factor">测评维度：{currentQuestion?.factor || '其他'}</div>
        <div className="aic-q-text">
          {currentQuestion ? currentQuestion.question : '题目加载中…'}
        </div>
        <div className="aic-opt-list">
          {LIKERT_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              className={
                currentQuestion && answers[currentQuestion.id] === option.value
                  ? 'aic-opt-btn selected'
                  : 'aic-opt-btn'
              }
              disabled={!currentQuestion}
              onClick={() => currentQuestion && handleAnswer(currentQuestion.id, option.value)}
            >
              {option.label}
              <small>{option.value} 分</small>
            </button>
          ))}
        </div>
        <div className="aic-q-nav">
          <button
            type="button"
            className="aic-btn aic-btn-prev"
            disabled={cursor === 0}
            onClick={() => {
              if (navigating) {
                return;
              }
              setCursor((current) => Math.max(0, current - 1));
            }}
          >
            ← 上一题
          </button>
          {isLastQuestion ? (
            <button
              type="button"
              className="aic-btn aic-btn-submit"
              disabled={submitting}
              onClick={() => void handleSubmit()}
            >
              {submitting ? <Loader2 className="mr-1 inline h-4 w-4 animate-spin" /> : null}
              提交答卷并生成报告
            </button>
          ) : null}
        </div>
      </div>

      {/* 新增功能保持：全部作答后展示求助热线提示 */}
      {allAnswered ? (
        <Alert variant="warning" className="mt-4">
          <PhoneCall className="h-4 w-4" />
          <AlertTitle>需要帮助时请及时求助</AlertTitle>
          <AlertDescription className="whitespace-pre-line">{CRISIS_HOTLINE}</AlertDescription>
        </Alert>
      ) : null}

      {bankQuery.isError ? (
        <p className="aic-page-sub" style={{ margin: '16px 0 0' }}>
          场景题库加载失败，已使用标准 90 题继续作答。
        </p>
      ) : null}

      {/* 旧版提交加载遮罩 */}
      {submitting ? (
        <div className="aic-loading-mask">
          <div className="aic-spinner" />
          <p>AI 正在生成你的解读报告，请稍候…</p>
        </div>
      ) : null}

      {toastText ? <div className="aic-toast">{toastText}</div> : null}
    </AppShell>
  );
}

export default function Scl90Page() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">
          <div className="aic-spinner" />
        </div>
      }
    >
      <AuthGuard role="student">
        <Scl90Content />
      </AuthGuard>
    </Suspense>
  );
}
