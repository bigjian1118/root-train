'use client';

import { Loader2, PhoneCall } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { AppShell } from '@/components/business/app-shell';
import { AuthGuard } from '@/components/business/auth-guard';
import { EmptyState } from '@/components/business/empty-state';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { buttonVariants } from '@/components/ui/button';
import { useConfig } from '@/hooks/use-config';
import { ApiError, postJson } from '@/lib/api';
import { savePendingTextReport } from '@/lib/report-pending';
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
  Scl90Answers,
  Scl90Question,
  StoredScl90Report,
  TestSubmitResponse,
} from '@/lib/types';

// 与旧版 showToast 一致：提示 3.2s 后自动隐藏。
const TOAST_DURATION_MS = 3200;
// 选完选项到自动翻页的间隔：留出选中态反馈时间，避免视觉上"闪一下"
const AUTO_ADVANCE_DELAY_MS = 220;
// 报告页读取的 sessionStorage 键（与 /test/report 保持一致）
const REPORT_STORAGE_KEY = 'scl90_report';

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
  // 一页一题：stepIndex 即当前题目下标
  const [stepIndex, setStepIndex] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  // 旧版 toast：未答题定位提示与提交错误都走底部胶囊提示
  const [toastText, setToastText] = useState('');
  // 自动翻页定时器：手动翻页时需取消，避免连跳两题
  const advanceTimerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (advanceTimerRef.current != null) {
      window.clearTimeout(advanceTimerRef.current);
    }
  }, []);

  const clearAdvanceTimer = () => {
    if (advanceTimerRef.current != null) {
      window.clearTimeout(advanceTimerRef.current);
      advanceTimerRef.current = null;
    }
  };

  useEffect(() => {
    if (!toastText) {
      return;
    }
    const timer = window.setTimeout(() => setToastText(''), TOAST_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [toastText]);

  // 标准 90 题全部作答，不再做题目截断与默认分值补全
  const visibleQuestions = scene;
  const total = visibleQuestions.length;
  const currentQuestion: Scl90Question | undefined = visibleQuestions[
    Math.min(stepIndex, Math.max(0, total - 1))
  ];
  const isLastStep = total > 0 && stepIndex >= total - 1;
  const stepAllAnswered = currentQuestion ? answers[currentQuestion.id] != null : false;
  const answeredCount = visibleQuestions.filter(
    (question) => answers[question.id] != null,
  ).length;
  const allAnswered = total > 0 && answeredCount === total;

  /** 选中即记录答案；非最后一题时短暂停留后自动进入下一题。 */
  const handleAnswer = (questionId: number, value: number) => {
    setAnswers((current) => ({ ...current, [questionId]: value }));
    if (isLastStep) {
      return;
    }
    clearAdvanceTimer();
    advanceTimerRef.current = window.setTimeout(() => {
      advanceTimerRef.current = null;
      setStepIndex((current) => Math.min(current + 1, Math.max(0, total - 1)));
    }, AUTO_ADVANCE_DELAY_MS);
  };

  const handleNextStep = () => {
    if (!currentQuestion) {
      return;
    }
    clearAdvanceTimer();
    if (answers[currentQuestion.id] == null) {
      setToastText(`还有未作答的题目：${currentQuestion.question.slice(0, 18)}…`);
      return;
    }
    setStepIndex((current) => Math.min(current + 1, Math.max(0, total - 1)));
  };

  const handlePrevStep = () => {
    clearAdvanceTimer();
    setStepIndex((current) => Math.max(0, current - 1));
  };

  const handleSubmit = async () => {
    if (!scenario || submitting) {
      return;
    }
    clearAdvanceTimer();
    // 与旧版一致：点击提交时若仍有未答题，定位到对应题目并 toast 提示。
    const missingIndex = visibleQuestions.findIndex(
      (question) => answers[question.id] == null,
    );
    if (missingIndex >= 0) {
      setStepIndex(missingIndex);
      setToastText(`还有未作答的题目：${visibleQuestions[missingIndex].question.slice(0, 18)}…`);
      return;
    }
    setSubmitting(true);
    // 90 题全部作答后才允许走到这里，直接以真实作答计分
    const result = scoreScl90(answers);

    try {
      // 异步模式：接口只负责建档并立即返回 processing，报告由后台任务生成
      const response = await postJson<TestSubmitResponse>('/api/test/submit', {
        scenario,
        result,
        answers,
      });
      const reportId = response.report_id ?? '';

      const stored: StoredScl90Report = {
        report_id: reportId,
        status: response.status ?? 'processing',
        scores: response.scores ?? result,
        has_crisis: response.has_crisis,
        crisis_message: response.crisis_message,
        report: response.report ?? response.ai_content ?? '',
        ai_content: response.ai_content,
        scenario_name: sceneName,
        submitted_at: Date.now(),
        viewer_role: 'student',
      };
      try {
        sessionStorage.setItem(REPORT_STORAGE_KEY, JSON.stringify(stored));
      } catch {
        // 存储异常时仍跳转，报告页会回退到历史接口拉取最新报告
      }
      // 报告页轮询与失败重试所需的最小上下文
      if (reportId) {
        savePendingTextReport({
          report_id: reportId,
          scenario,
          scene_name: sceneName,
          result: stored.scores,
          answers,
        });
      }
      router.push(reportId ? `/test/report?pending=${encodeURIComponent(reportId)}` : '/test/report');
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
          最近一周感受 · 一页一题
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

  // 第二步（对齐旧版 test.html quizPanel）：一页一题 + 顶部进度条 + 五级选项。
  return (
    <AppShell role="student" pageClassName={TEST_PAGE_CLASS}>
      <div className="aic-quiz-head">
        <span className="aic-quiz-scene">{sceneName}场景</span>
        <span className="aic-quiz-prog">
          第 {total ? stepIndex + 1 : 0}/{total} 题 · 已答 {answeredCount}/{total} 题
        </span>
      </div>
      <div className="aic-prog-track">
        <div
          className="aic-prog-fill"
          style={{ width: `${((stepIndex + 1) / (total || 1)) * 100}%` }}
        />
      </div>

      {!currentQuestion ? (
        <div className="aic-q-card">
          <div className="aic-q-text">题目加载中…</div>
        </div>
      ) : (
        <div className="aic-q-card">
          <div className="aic-q-factor">测评维度：{currentQuestion.factor || '其他'}</div>
          <div className="aic-q-text">{currentQuestion.question}</div>
          <div className="aic-opt-list">
            {LIKERT_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                className={
                  answers[currentQuestion.id] === option.value
                    ? 'aic-opt-btn selected'
                    : 'aic-opt-btn'
                }
                onClick={() => handleAnswer(currentQuestion.id, option.value)}
              >
                {option.label}
                <small>{option.value} 分</small>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="aic-q-nav">
        <button
          type="button"
          className="aic-btn aic-btn-prev"
          disabled={stepIndex === 0 || total === 0}
          onClick={handlePrevStep}
        >
          ← 上一题
        </button>
        {isLastStep ? (
          <button
            type="button"
            className="aic-btn aic-btn-submit"
            disabled={submitting || total === 0}
            onClick={() => void handleSubmit()}
          >
            {submitting ? <Loader2 className="mr-1 inline h-4 w-4 animate-spin" /> : null}
            提交答卷并生成报告
          </button>
        ) : (
          <button
            type="button"
            className="aic-btn aic-btn-submit"
            disabled={total === 0}
            onClick={handleNextStep}
          >
            下一题 →
          </button>
        )}
      </div>

      {total > 0 && !stepAllAnswered ? (
        <p className="aic-page-sub" style={{ margin: '10px 0 0' }}>
          请选择本页选项后继续作答。
        </p>
      ) : null}

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

      {/* 提交中遮罩：异步模式只在提交请求期间展示，生成进度由报告页轮询 */}
      {submitting ? (
        <div className="aic-loading-mask">
          <div className="aic-spinner" />
          <p>正在提交测评，请稍候…</p>
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
