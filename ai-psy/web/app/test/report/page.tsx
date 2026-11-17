'use client';

import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { AppShell } from '@/components/business/app-shell';
import { LoadingSkeleton } from '@/components/business/loading-skeleton';
import { MarkdownText } from '@/components/business/markdown-text';
import { Button } from '@/components/ui/button';
import { ApiError, del, getJson, postJson } from '@/lib/api';
import { CRISIS_HOTLINE } from '@/lib/scoring';
import {
  clearPendingTextReport,
  loadPendingTextReport,
  savePendingTextReport,
} from '@/lib/report-pending';
import { clearReportUnread, markReportUnread } from '@/lib/report-notice';
import type {
  FaceReportDetail,
  FaceReportSummary,
  FaceReportsResponse,
  ReportStatusItem,
  ReportsResponse,
  Scl90Scores,
  StoredScl90Report,
  TestSubmitResponse,
  TextReportSummary,
} from '@/lib/types';
import { formatTimestamp } from '@/lib/utils';
import { useAuthStore } from '@/store/use-auth-store';

// 学生端专属测评报告页：全屏左右分栏（左侧粘性信息栏 + 右侧纵向滚动主内容区）。
// 右侧仅保留「文本心理测试报告」「视频心理测试报告」两大通栏模块，
// 内容全部来自后端既有接口，学生向通俗化展示，不含任何专业测评参数。
// 本页不包含 AI 实时对话入口（无浮窗、无流式会话逻辑）。

const STORAGE_KEY = 'scl90_report';

const PAGE_CLASS = 'min-h-screen px-0 pb-0 pt-[12px]';
const HEAD_NAV_CLASS = 'mb-[12px] flex flex-wrap items-center gap-[12px] px-[24px]';

// 生成状态轮询间隔：3s 足够感知完成，同时避免高频请求压后端
const STATUS_POLL_MS = 3000;
// 历史列表里存在生成中报告时的刷新间隔
const HISTORY_POLL_MS = 8000;

const EMOTION_CN: Record<string, string> = {
  anger: '愤怒', disgust: '厌恶', fear: '恐惧',
  happiness: '快乐', sadness: '悲伤', surprise: '惊讶', neutral: '中性',
};

// 主导情绪 -> 通俗状态描述（视频 AI 文本缺失时的兜底）
const EMOTION_SUMMARY: Record<string, string> = {
  happiness: '视频检测里你的表情以轻松、愉快为主，近期的情绪基调比较积极，这是很难得的状态。',
  sadness: '视频检测里你的神情有些低落，最近可能感到不开心或提不起劲，这值得被温柔地看待。',
  fear: '视频检测里你的神情偏紧张，最近可能有些担心或压力，试着给自己一些放松的时间。',
  anger: '视频检测里你的表情里有一些烦躁，最近可能遇到了让人郁闷或委屈的事。',
  disgust: '视频检测里你的表情带着抗拒，最近可能被一些不喜欢的事情困扰着。',
  surprise: '视频检测里你的表情丰富多变，你对周围的新鲜事物比较敏感，这是好奇心的体现。',
  neutral: '视频检测里你的表情总体平静，情绪起伏不大，是一种比较安稳的状态。',
};

// 主导情绪 -> 即时调节小方法（视频 AI 文本缺失时的兜底首条）
const EMOTION_TIP: Record<string, string> = {
  happiness: '继续保持哦，可以记录开心的小事，把它们分享给身边的人。',
  sadness: '试试散步、听音乐、写日记，或找信任的人聊一聊，别一个人扛着。',
  fear: '紧张时做 10 次深呼吸，规律运动和减少熬夜都会让身心放松下来。',
  anger: '感到烦躁时先离开现场冷静几分钟，再去运动或写下来，让情绪有出口。',
  disgust: '暂时离开让你不舒服的情境，做点自己喜欢的事转移注意力。',
  surprise: '保持这份好奇心，把新发现写进日记，会让生活更有意思。',
  neutral: '保持规律作息和适度运动，每天留 10 分钟安静地觉察自己的心情。',
};

// 因子名 -> 通俗说明（仅用于本地兜底的「状态简要说明」，不出现分值/常模/Z 值）
const FACTOR_PLAIN: Record<string, string> = {
  躯体化: '身体上偶有不舒服（如头痛、胃痛、乏力），但查不出明确原因',
  强迫症状: '容易被某些想法或动作困住，明明想放下却反复出现',
  人际关系敏感: '比较在意别人的看法，与人相处时容易不自在',
  抑郁: '近期情绪偏低，做事的兴致和精力有些下降',
  焦虑: '容易紧张、心神不宁，会为一些小事担心',
  敌对: '容易心烦或发脾气，偶尔有想争执的冲动',
  恐怖: '对某些场合或事物有不必要的担忧与回避',
  偏执: '对他人有些不信任，容易多想',
  精神病性: '偶尔觉得自己的思绪或感受有些混乱',
  其他: '饮食、睡眠等日常状态有些紊乱',
};

// AI 报告的小节标题（后端 prompt 固定输出这些段落名）
const TEXT_SECTION_LABELS = ['你的测评结果解读', '状态简要说明', '具体调整建议', '求助与支持'];
const VIDEO_SECTION_LABELS = ['状态描述', '观察补充', '调整方向', '求助与支持'];

// 视频 AI 文本缺失时的补充练习（与主导情绪建议合并后取前三条）
const VIDEO_TIP_FALLBACK = [
  '课间到窗边晒 2 分钟太阳，抬头远眺，配合 5 次深呼吸，让紧绷的表情松下来。',
  '对着镜子做「皱眉—舒展」练习 5 次，感受面部肌肉放松，每天睡前做一轮。',
  '睡前用 3 分钟做微笑练习：嘴角轻提保持 10 秒再放松，重复 8 次。',
];

// 文本 AI 文本缺失时的分维度建议（编号由渲染层统一生成）
const ADVICE_FALLBACK: { dimension: string; tip: string }[] = [
  { dimension: '情绪表达', tip: '每天睡前用一句话写下当天最强烈的感受，写完再合上本子，坚持一周。' },
  { dimension: '压力调节', tip: '学习 45 分钟后起身走动 3 分钟，做 5 次深呼吸，再回到座位继续。' },
  { dimension: '人际互动', tip: '本周主动找一个信任的同学或家人聊 10 分钟，不必等到难受才开口。' },
  { dimension: '日常习惯', tip: '固定睡觉和起床时间，睡前 30 分钟放下手机，每天保证 20 分钟户外活动。' },
];

/** 学生向整体结论短句（标题卡正文，正向、非诊断表述）。 */
function verdictHeadline(gsi: number, hasCrisis: boolean): string {
  if (hasCrisis) return '这次测评中出现了一些需要被认真对待的信号，请尽快寻求身边人的支持';
  if (gsi < 1.5) return '整体心理状态良好，请继续保持';
  if (gsi < 2.0) return '整体心理状态平稳，保持现在的节奏就好';
  if (gsi < 2.5) return '近期状态有些起伏，记得给自己留出放松的时间';
  if (gsi < 3.0) return '近期压力偏高，建议主动和信任的人聊一聊';
  return '近期状态需要更多照顾，请及时寻求专业支持';
}

/** 整体结论总述（AI 开头段缺失时的兜底）。 */
function conclusionParagraph(gsi: number, hasCrisis: boolean): string {
  if (hasCrisis) {
    return '这次测评里出现了一些需要被认真对待的信号。你现在可能正经历一段不容易的时期，'
      + '这不是你的错，也不代表你「有问题」。请尽快和信任的老师、家人或学校心理中心聊一聊，'
      + '会有人陪你一起面对。';
  }
  if (gsi < 1.5) return '你近期的心理状态很不错，情绪稳定，能较好地适应学习和生活。';
  if (gsi < 2.0) return '你近期的心理状态比较平稳，偶尔有小的情绪波动很正常，不必担心。';
  if (gsi < 2.5) return '最近你有一些情绪上的波动，建议多留意自己的感受，给自己一些放松和调适的时间。';
  if (gsi < 3.0) return '最近你可能感到有些疲惫或压力，建议主动和老师、家人、朋友聊聊，别一个人承受。';
  return '最近你可能正经历一段比较难的时期，建议尽快联系学校心理中心或专业机构，会有人陪你一起面对。';
}

/** 状态简要说明（AI 段落缺失时的兜底）：只用通俗描述，不出现因子名与分值。 */
function fallbackStateNote(factorNames: string[]): string {
  const plains = factorNames
    .slice(0, 2)
    .map((name) => FACTOR_PLAIN[name])
    .filter(Boolean);
  if (plains.length === 0) {
    return '从这次测评看，你在各个方面的状态都比较放松，情绪与生活节奏整体平稳，'
      + '继续保持现在的作息和运动习惯就好。';
  }
  return `从这次测评看，${plains.join('；')}。这些多是压力累积时的正常反应，`
    + '并不是你「不够好」，留意自己的感受、适当放慢节奏会很有帮助。';
}

/** 具体调整建议（AI 段落缺失时的兜底）：编号 + 维度名，便于直接照做。 */
function buildFallbackAdvice(): string {
  return ADVICE_FALLBACK
    .map((item, index) => `${index + 1}. **${item.dimension}**：${item.tip}`)
    .join('\n');
}

/** 视频调整方向（AI 段落缺失时的兜底）：主导情绪建议 + 通用小练习，共三条。 */
function buildVideoTips(dominant: string): string[] {
  const lead = EMOTION_TIP[dominant] || EMOTION_TIP.neutral;
  return [lead, ...VIDEO_TIP_FALLBACK].slice(0, 3);
}

/** 后端 AI 未开启/生成失败时会写入「（…）」占位文案，此时改用本地兜底内容。 */
function isPlaceholderAi(text: string): boolean {
  const trimmed = (text || '').trim();
  if (!trimmed) {
    return true;
  }
  return trimmed.startsWith('（') && trimmed.endsWith('）');
}

/** 去掉 AI 正文自带的分段免责声明，页面统一在卡片底部展示一次。 */
function stripDisclaimers(raw: string): string {
  return raw
    .split('\n')
    .filter((line) => {
      const text = line.trim();
      if (text === '⚠️') {
        return false;
      }
      const isDisclaimer = text.includes('本报告为AI辅助生成')
        || text.includes('本报告基于面部表情')
        || (text.includes('仅供参考') && text.includes('不能替代'));
      return !isDisclaimer;
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 标题行允许的装饰字符（#、*、【】、「」、序号等），去掉后应为空才能判定为小节标题。 */
const HEADING_DECORATION = /[#*\s【】「」[\]:：、.．\-—一二三四五六七八九十\d]/g;

function matchSectionHeading(
  line: string,
  labels: string[],
): { label: string; inline: string } | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length > 40) {
    return null;
  }
  for (const label of labels) {
    const index = trimmed.indexOf(label);
    if (index < 0) {
      continue;
    }
    // 标题前只能是装饰符号，避免把正文里提到的词误判成标题
    if (trimmed.slice(0, index).replace(HEADING_DECORATION, '') !== '') {
      continue;
    }
    const rest = trimmed.slice(index + label.length);
    if (rest.replace(HEADING_DECORATION, '').length > 20) {
      continue;
    }
    return {
      label,
      inline: rest.replace(/^[\s】」*:：]+/, '').replace(/[【「*]+$/, ''),
    };
  }
  return null;
}

interface ParsedReport {
  /** 第一个小节标题之前的内容（AI 报告的整体结论段） */
  intro: string;
  /** 小节标题 -> 正文 */
  sections: Record<string, string>;
}

/** 按后端 prompt 固定的小节标题拆分 AI 报告正文。 */
function parseReportSections(raw: string, labels: string[]): ParsedReport {
  const text = stripDisclaimers(raw || '');
  const sections: Record<string, string> = {};
  const introBlocks: string[] = [];
  let current = '';
  let buffer: string[] = [];

  const flush = () => {
    const body = buffer.join('\n').trim();
    buffer = [];
    if (!body) {
      return;
    }
    if (current) {
      sections[current] = sections[current] ? `${sections[current]}\n${body}` : body;
      return;
    }
    introBlocks.push(body);
  };

  text.split('\n').forEach((line) => {
    const heading = matchSectionHeading(line, labels);
    if (!heading) {
      buffer.push(line);
      return;
    }
    flush();
    current = heading.label;
    if (heading.inline) {
      buffer.push(heading.inline);
    }
  });
  flush();

  return {
    intro: introBlocks.filter(Boolean).join('\n').trim(),
    sections,
  };
}

function isStoredReport(value: unknown): value is StoredScl90Report {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const record = value as Partial<StoredScl90Report>;
  return Boolean(
    record.scores
      && typeof record.scores === 'object'
      && record.scores.因子分
      && typeof record.scores.总均分 === 'number',
  );
}

// ---- 图表组件 ----

/** 综合状态趋势：蓝色折线面积图，纵轴为分数刻度，附「总分 / 节点」图例。 */
function TrendChart({ points }: { points: { total_score: number | null }[] }) {
  const W = 250, H = 130, padL = 30, padR = 10, padT = 12, padB = 18;
  const iw = W - padL - padR, ih = H - padT - padB;
  const vals = points.map((p) => p.total_score ?? 0);
  if (vals.length < 2) {
    return <p className="h-empty" style={{ color: '#8aa0b0', fontSize: 12 }}>至少 2 次测评后显示趋势</p>;
  }
  const min = Math.min(...vals, 90);
  const max = Math.max(...vals, 150);
  const stepX = iw / (vals.length - 1);
  const xy = vals.map((v, i) => ({
    x: padL + i * stepX,
    y: padT + (1 - (v - min) / Math.max(1, max - min)) * ih,
    v,
  }));
  const line = xy.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const area = `${line} L${xy[xy.length - 1].x.toFixed(1)},${H - padB} L${xy[0].x.toFixed(1)},${H - padB} Z`;
  let grid = '';
  for (let g = 0; g <= 3; g++) {
    const gy = padT + (ih * g) / 3;
    grid += `<line x1="${padL}" y1="${gy}" x2="${W - padR}" y2="${gy}" stroke="rgba(126,200,242,0.16)"/>`;
    grid += `<text x="${padL - 4}" y="${gy + 3}" text-anchor="end" font-size="9" fill="#8aa0b0">${Math.round(max - ((max - min) * g) / 3)}</text>`;
  }
  return (
    <div>
      <div style={{ display: 'flex', gap: 14, marginBottom: 6, fontSize: 11.5, color: '#5b7688' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <i style={{ display: 'inline-block', width: 14, height: 3, borderRadius: 2, background: '#3a9bd8' }} />
          总分
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <i style={{
            display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
            background: '#d9a520', border: '1px solid #fff',
          }} />
          节点
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="line-svg" width="100%" height="auto">
        <defs>
          <linearGradient id="trendArea" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(126,200,242,0.5)" />
            <stop offset="100%" stopColor="rgba(126,200,242,0.04)" />
          </linearGradient>
        </defs>
        <g dangerouslySetInnerHTML={{ __html: grid }} />
        <path d={area} fill="url(#trendArea)" />
        <path d={line} fill="none" stroke="#3a9bd8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        {xy.map((p, i) => (
          <circle key={i} cx={p.x} cy={p.y} r={i === xy.length - 1 ? 5 : 3.5}
            fill="#d9a520" stroke="#fff" strokeWidth="1.5">
            <title>{p.v} 分</title>
          </circle>
        ))}
      </svg>
    </div>
  );
}

// ---- 数据模型 ----

/** /api/student/report/<id> 详情接口返回（历史报告切换用）。 */
interface StudentReportDetailPayload {
  id: string;
  scenario: string;
  scenario_name: string;
  scores: Scl90Scores;
  report: string;
  submitted_at: number; // 毫秒
}

/** 页面统一渲染用的当前报告视图模型（初始=sessionStorage 最新提交，切换=详情接口）。 */
interface ActiveReportView {
  id: string;
  scenarioName: string;
  submittedAtSec: number;
  scores: Scl90Scores;
  aiText: string;
  hasCrisis: boolean;
  /** AI 正文是否已回源拉取完成（sessionStorage 初值可能不含正文） */
  aiLoaded: boolean;
}

function toActiveView(data: StudentReportDetailPayload): ActiveReportView {
  const hasCrisis = Object.keys(data.scores?.危机信号 ?? {}).length > 0;
  return {
    id: data.id,
    scenarioName: data.scenario_name || '通用',
    // 详情接口 submitted_at 为毫秒，列表/会话为秒，统一归一到秒
    submittedAtSec: data.submitted_at > 1e12
      ? Math.round(data.submitted_at / 1000)
      : data.submitted_at,
    scores: data.scores,
    aiText: data.report?.trim() || '',
    hasCrisis,
    aiLoaded: true,
  };
}

function faceTimestampSec(report: FaceReportSummary): number {
  const ts = report.created_at ?? report.create_timestamp ?? 0;
  return ts > 1e12 ? Math.round(ts / 1000) : ts;
}

/** 取与当前文本报告时间最接近的一份已完成的视频报告。 */
function pickNearestFace(
  reports: FaceReportSummary[],
  targetSec: number,
): FaceReportSummary | null {
  const completed = reports.filter((item) => (item.status ?? 'completed') === 'completed');
  if (completed.length === 0) {
    return null;
  }
  if (!targetSec) {
    return completed[0];
  }
  return completed.reduce((best, current) => {
    const bestTs = faceTimestampSec(best);
    const currentTs = faceTimestampSec(current);
    if (!bestTs) return current;
    if (!currentTs) return best;
    return Math.abs(currentTs - targetSec) < Math.abs(bestTs - targetSec) ? current : best;
  }, completed[0]);
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="aic-report-info-row">
      <span className="ik">{label}</span>
      <span className="iv">{value || '—'}</span>
    </div>
  );
}

// ---- 异步生成状态面板：生成中 / 生成完成引导 / 生成失败重试 ----
// 任务在后端独立执行，本面板只负责轮询状态；关闭页面后重新打开会重新同步。
function ReportGenerationPanel({ reportId }: { reportId: string }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  // 失败重试所需的原始提交上下文（同一标签页内由 sessionStorage 恢复）
  const pending = useMemo(() => loadPendingTextReport(reportId), [reportId]);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState('');

  const statusQuery = useQuery({
    queryKey: ['student', 'report-status', reportId],
    queryFn: () => getJson<ReportStatusItem>(
      `/api/report/status?report_id=${encodeURIComponent(reportId)}`,
    ),
    // 只在生成中继续轮询，完成/失败后自动停止
    refetchInterval: (query) => (
      query.state.data?.status === 'processing' ? STATUS_POLL_MS : false
    ),
    refetchOnMount: 'always',
  });

  const status = statusQuery.data?.status;
  // 只有后端明确失败或报告已不存在才算失败；网络抖动继续按生成中重试
  const notFound = statusQuery.error instanceof ApiError && statusQuery.error.status === 404;
  const isCompleted = status === 'completed';
  const isFailed = status === 'failed' || notFound;
  const isProcessing = !isCompleted && !isFailed;
  const errorText = statusQuery.data?.error
    || (statusQuery.error instanceof ApiError ? statusQuery.error.message : '');
  const eta = statusQuery.data?.eta_seconds ?? null;

  // 生成完成后刷新列表缓存并点亮侧边栏红点；只在状态落到 completed 时触发
  useEffect(() => {
    if (!isCompleted) {
      return;
    }
    clearPendingTextReport();
    markReportUnread();
    void queryClient.invalidateQueries({ queryKey: ['student', 'reports-history'] });
    void queryClient.invalidateQueries({ queryKey: ['student', 'reports'] });
    void queryClient.invalidateQueries({ queryKey: ['student', 'face-reports'] });
  }, [isCompleted, queryClient]);

  const goToReportList = () => {
    clearReportUnread();
    router.replace('/test/report');
  };

  const handleRetry = async () => {
    if (!pending) {
      router.push('/test');
      return;
    }
    setRetrying(true);
    setRetryError('');
    try {
      // 失败记录先删除再重新提交，避免同一份答案留下两条归档（后端已清空幂等键）
      await del(`/api/student/report/${encodeURIComponent(reportId)}`).catch(() => undefined);
      const response = await postJson<TestSubmitResponse>('/api/test/submit', {
        scenario: pending.scenario,
        result: pending.result,
        answers: pending.answers,
      });
      const nextId = response.report_id || '';
      clearPendingTextReport();
      if (!nextId) {
        router.push('/test');
        return;
      }
      savePendingTextReport({ ...pending, report_id: nextId });
      router.replace(`/test/report?pending=${encodeURIComponent(nextId)}`);
    } catch (error) {
      setRetryError(error instanceof ApiError ? error.message : '重新生成失败，请稍后重试');
    } finally {
      setRetrying(false);
    }
  };

  return (
    <section className="aic-glass aic-gen-panel">
      {isProcessing ? (
        <>
          <div className="aic-spinner" style={{ margin: '0 auto 20px' }} />
          <h1>报告生成中…</h1>
          <p className="aic-gen-text">
            后台正在生成报告，您可关闭页面或切换其他功能，
            <br />
            生成完成后可在「我的心理测试报告」中查看。
          </p>
          {eta ? <p className="aic-gen-eta">预计还需约 {eta} 秒</p> : null}
        </>
      ) : null}

      {isCompleted ? (
        <>
          <h1>✅ 报告已生成完成</h1>
          <p className="aic-gen-text">
            文本报告已生成完成，前往「我的心理测试报告」查看详情。
            <br />
            若你已完成视频检测，AI 综合报告会自动在后台生成，
            完成后可在报告中心的「AI 综合分析」中查看。
          </p>
          <div className="aic-gen-actions">
            <button type="button" className="aic-btn aic-btn-primary" onClick={goToReportList}>
              查看报告 →
            </button>
            <Link href="/test" className="aic-btn aic-btn-ghost">再测一次</Link>
          </div>
        </>
      ) : null}

      {isFailed ? (
        <>
          <h1>⚠️ 报告生成失败</h1>
          <p className="aic-gen-text">
            报告未能生成完成，已提交的数据不会残留，可点击「重新生成」再次尝试。
          </p>
          {errorText ? <div className="aic-gen-error">{errorText}</div> : null}
          {retryError ? <div className="aic-gen-error">{retryError}</div> : null}
          <div className="aic-gen-actions">
            {pending ? (
              <button
                type="button"
                className="aic-btn aic-btn-primary"
                onClick={() => void handleRetry()}
                disabled={retrying}
              >
                {retrying ? '正在重新提交…' : '重新生成'}
              </button>
            ) : (
              <Link href="/test" className="aic-btn aic-btn-primary">重新测评</Link>
            )}
            <button
              type="button"
              className="aic-btn aic-btn-ghost"
              onClick={() => void statusQuery.refetch()}
            >
              刷新状态
            </button>
            <button type="button" className="aic-btn aic-btn-ghost" onClick={goToReportList}>
              返回报告列表
            </button>
          </div>
        </>
      ) : null}
    </section>
  );
}

// ---- 主内容 ----

// initial：刚提交测评时来自 sessionStorage 的最新结果；从其他入口直接进页面时为 null，
// 此时自动回退加载历史接口里的最新一份报告（默认展示 = history[0]）。
function ReportContent({ initial }: { initial: ActiveReportView | null }) {
  const router = useRouter();
  const storeUser = useAuthStore((state) => state.user);
  const [activeId, setActiveId] = useState(initial?.id ?? '');
  const [activeView, setActiveView] = useState<ActiveReportView | null>(initial);
  const [loadError, setLoadError] = useState('');

  // 历史报告列表（后端已按提交时间倒序返回全量）
  // 进入页面强制刷新一次；若列表里仍有生成中的报告，则按固定间隔继续刷新
  const historyQuery = useQuery({
    queryKey: ['student', 'reports-history'],
    queryFn: () => getJson<ReportsResponse>('/api/student/reports'),
    refetchOnMount: 'always',
    refetchInterval: (query) => (
      (query.state.data?.reports ?? []).some((item) => item.status === 'processing')
        ? HISTORY_POLL_MS
        : false
    ),
  });
  const history = historyQuery.data?.reports ?? [];
  const latestId = history.length ? history[0].id || history[0].report_id || '' : '';
  // 最新一份仍在后台生成：默认视图直接展示生成中面板（切页/重开页面都能同步状态）
  const latestProcessing = Boolean(latestId)
    && (history[0].status ?? 'completed') === 'processing';

  // 已经进入报告页并看到最新报告，说明红点提示已被消费
  useEffect(() => {
    if (latestId && !latestProcessing && !historyQuery.isLoading) {
      clearReportUnread();
    }
  }, [latestId, latestProcessing, historyQuery.isLoading]);

  // 未点击切换时默认展示最新一份（sessionStorage 命中则优先用它，避免重复请求）
  const effectiveId = activeId || latestId;
  const needFetch = Boolean(effectiveId)
    && (!activeView || effectiveId !== activeView.id || !activeView.aiLoaded)
    && !(latestProcessing && effectiveId === latestId);

  const detailQuery = useQuery({
    queryKey: ['student', 'report-detail', effectiveId],
    queryFn: () => getJson<StudentReportDetailPayload>(
      `/api/student/report/${encodeURIComponent(effectiveId)}`,
    ),
    enabled: needFetch,
    retry: 1,
  });

  // 详情到手后替换当前视图；切换历史记录期间保留旧内容，避免整页闪白
  useEffect(() => {
    if (!detailQuery.data) {
      return;
    }
    setActiveView(toActiveView(detailQuery.data));
    setLoadError('');
  }, [detailQuery.data]);

  useEffect(() => {
    if (!needFetch || !detailQuery.isError) {
      return;
    }
    setLoadError(
      detailQuery.error instanceof ApiError
        ? detailQuery.error.message
        : '报告加载失败，请稍后重试',
    );
  }, [needFetch, detailQuery.isError, detailQuery.error]);

  // 视频检测历史（列表项自带 emotions / dominant_emotion，详情接口补 AI 正文）
  const faceQuery = useQuery({
    queryKey: ['student', 'face-reports'],
    queryFn: () => getJson<FaceReportsResponse>('/api/face/reports'),
    refetchOnMount: 'always',
  });
  const faceReports = useMemo<FaceReportSummary[]>(
    () => faceQuery.data?.reports ?? [],
    [faceQuery.data],
  );
  const selectedFace = useMemo(
    () => pickNearestFace(faceReports, activeView?.submittedAtSec ?? 0),
    [faceReports, activeView?.submittedAtSec],
  );
  const selectedFaceId = selectedFace
    ? selectedFace.id || selectedFace.video_report_id || ''
    : '';
  const faceDetailQuery = useQuery({
    queryKey: ['student', 'face-report-detail', selectedFaceId],
    queryFn: () => getJson<FaceReportDetail>(
      `/api/face/report/${encodeURIComponent(selectedFaceId)}`,
    ),
    enabled: Boolean(selectedFaceId),
    retry: 1,
  });

  const switching = needFetch && Boolean(activeView) && !loadError && !detailQuery.isError;

  const handleBack = () => {
    const hasHistory = typeof window !== 'undefined' && (window.history.state?.idx ?? 0) > 0;
    if (hasHistory) {
      router.back();
      return;
    }
    router.replace('/student/reports');
  };

  const handleSelectHistory = (reportId: string) => {
    if (!reportId || reportId === activeView?.id) {
      return;
    }
    setActiveId(reportId);
    setLoadError('');
    // 切换后回到页面顶部，与主内容区的模块顺序保持一致
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const renderSkeleton = () => (
    <div className="aic-rpt-full">
      <aside className="aic-rpt-side aic-glass">
        <LoadingSkeleton rows={6} />
      </aside>
      <div className="aic-rpt-body">
        <LoadingSkeleton rows={8} />
      </div>
    </div>
  );

  // 首次进入且尚无任何可渲染数据：显示骨架屏
  if (!activeView) {
    if (historyQuery.isLoading || (needFetch && detailQuery.isLoading)) {
      return renderSkeleton();
    }
    // 默认视图下最新报告仍在生成：交给状态面板轮询，不渲染半成品数据
    if (latestProcessing) {
      return <ReportGenerationPanel reportId={latestId} />;
    }
    if (loadError) {
      return (
        <section className="aic-empty-panel">
          <h1 className="aic-report-title">报告加载失败</h1>
          <p className="sub">{loadError}</p>
          <div className="flex flex-wrap justify-center gap-3">
            <button
              type="button"
              className="aic-btn aic-btn-primary"
              onClick={() => void detailQuery.refetch()}
            >
              重新加载
            </button>
            <Link href="/student/reports" className="aic-btn aic-btn-ghost">
              返回报告列表
            </Link>
          </div>
        </section>
      );
    }
    // 无任何历史报告（且无 sessionStorage 初值）：空状态引导去测评
    return (
      <section className="aic-empty-panel">
        <h1 className="aic-report-title">暂无测评结果</h1>
        <p className="sub">你还没有完成过心理测评，先做一次测评，这里会生成你的专属报告。</p>
        <div className="flex flex-wrap justify-center gap-3">
          <Link href="/test" className="aic-btn aic-btn-primary">
            去参加测评 →
          </Link>
        </div>
      </section>
    );
  }

  const scores = activeView.scores;
  const gsi = scores?.总均分 ?? 0;
  const hasCrisis = activeView.hasCrisis
    || Object.keys(scores?.危机信号 ?? {}).length > 0;
  const time = activeView.submittedAtSec ? formatTimestamp(activeView.submittedAtSec) : '';
  // 关注维度：均分达到 2 分（轻度起点）的因子，仅用于生成通俗兜底文案，不展示分值
  const attentionFactors = Object.entries(scores?.因子分 ?? {})
    .filter(([, factor]) => factor.均分 >= 2)
    .sort((a, b) => b[1].均分 - a[1].均分)
    .map(([name]) => name);
  // 趋势图口径保持原逻辑：最近 8 次
  const trendPoints = history.slice(0, 8).reverse().map((r) => ({ total_score: r.total_score }));

  const textParsed = parseReportSections(activeView.aiText, TEXT_SECTION_LABELS);
  const textIntro = isPlaceholderAi(textParsed.intro) ? '' : textParsed.intro;
  const textStateNote = isPlaceholderAi(textParsed.sections['状态简要说明'] || '')
    ? ''
    : textParsed.sections['状态简要说明'];
  const textAdvice = isPlaceholderAi(textParsed.sections['具体调整建议'] || '')
    ? ''
    : textParsed.sections['具体调整建议'];
  const textSupport = isPlaceholderAi(textParsed.sections['求助与支持'] || '')
    ? ''
    : textParsed.sections['求助与支持'];

  const emotions = faceDetailQuery.data?.metrics?.emotions ?? selectedFace?.emotions ?? {};
  const dominant = faceDetailQuery.data?.dominant_emotion
    || selectedFace?.dominant_emotion
    || '';
  const faceTimeSource = selectedFace
    ? (selectedFace.created_at ?? selectedFace.create_timestamp ?? null)
    : null;
  const faceTime = faceTimeSource ? formatTimestamp(faceTimeSource) : '';
  const videoAiText = faceDetailQuery.data?.report?.trim() || '';
  const videoParsed = parseReportSections(videoAiText, VIDEO_SECTION_LABELS);
  const videoObservation = videoParsed.sections['观察补充'] || '';
  const videoDescriptionRaw = [
    videoParsed.sections['状态描述'] || '',
    videoObservation,
  ].filter(Boolean).join('\n\n');
  const videoDescription = isPlaceholderAi(videoDescriptionRaw) ? '' : videoDescriptionRaw;
  const videoAdvice = isPlaceholderAi(videoParsed.sections['调整方向'] || '')
    ? ''
    : videoParsed.sections['调整方向'];

  const hasVideo = Boolean(selectedFace);

  return (
    <div className="aic-rpt-full">
      {/* 左侧粘性侧边栏：基础信息 / 历史记录 / 综合状态趋势（无额外操作按钮） */}
      <aside className="aic-rpt-side aic-glass">
        <div className="aic-report-info-rows">
          <InfoRow label="姓名" value={storeUser?.name || '—'} />
          <InfoRow label="性别" value="—" />
          <InfoRow label="年龄" value="—" />
          <InfoRow label="身份" value="学生" />
          <InfoRow label="班级" value={storeUser?.class || '—'} />
          <InfoRow label="检测时间" value={time || '—'} />
        </div>

        <hr className="aic-grad-divider" style={{ alignSelf: 'stretch' }} />

        <h3 style={{ fontSize: 15, color: '#5b7688', alignSelf: 'flex-start', marginBottom: 8 }}>
          历史检测记录
        </h3>
        <ul className="aic-report-history-list">
          {history.length === 0 ? (
            <li className="h-empty">暂无历史记录</li>
          ) : (
            // 全量渲染（超出 210px 容器内部滚动）；日期 + 总分，生成中的记录禁用入口
            history.map((report: TextReportSummary, index: number) => {
              const rid = report.id || report.report_id || '';
              const ts = report.created_at ?? report.submit_timestamp ?? null;
              const day = ts ? formatTimestamp(ts).slice(0, 10) : '';
              const rowStatus = report.status ?? 'completed';
              const locked = rowStatus !== 'completed';
              return (
                <li key={rid}>
                  <button
                    type="button"
                    className={rid === activeView.id ? 'h-item active' : 'h-item'}
                    onClick={() => handleSelectHistory(rid)}
                    disabled={locked}
                    title={
                      rowStatus === 'processing'
                        ? '报告生成中，完成后可查看'
                        : rowStatus === 'failed'
                          ? (report.error_message || '生成失败，请重新测评')
                          : undefined
                    }
                  >
                    <span className="h-date">{day}</span>
                    {rowStatus === 'processing' ? (
                      <span className="h-score" style={{ color: '#3a9bd8', fontSize: 12 }}>生成中</span>
                    ) : rowStatus === 'failed' ? (
                      <span className="h-score" style={{ color: '#d9534f', fontSize: 12 }}>生成失败</span>
                    ) : (
                      <span
                        className="h-score"
                        style={{ color: (report.total_score ?? 0) > 200 ? '#d9a520' : '#3a9bd8' }}
                      >
                        {report.total_score ?? '—'}
                      </span>
                    )}
                    {index === 0 && rowStatus === 'completed' ? (
                      <span className="h-new">NEW</span>
                    ) : null}
                    {report.crisis && rowStatus === 'completed' ? (
                      <span style={{ color: '#d9534f' }}>⚠️</span>
                    ) : null}
                  </button>
                </li>
              );
            })
          )}
        </ul>

        {trendPoints.length >= 2 && (
          <>
            <hr className="aic-grad-divider" style={{ alignSelf: 'stretch' }} />
            <div className="aic-report-chart-panel" style={{ width: '100%', padding: '12px 10px 6px' }}>
              <h3 style={{ fontSize: 14, marginBottom: 4 }}>综合状态趋势</h3>
              <TrendChart points={trendPoints} />
            </div>
          </>
        )}
      </aside>

      {/* 右侧主内容区：标题栏 → 文本报告 → 视频报告 */}
      <div className="aic-rpt-body">
        {/* 切换历史报告：轻量加载提示 + 失败可重试，不遮挡已有内容 */}
        {switching ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: '#3a9bd8' }}>
            <span
              className="aic-spinner"
              style={{ width: 14, height: 14, borderWidth: 2, margin: 0 }}
            />
            正在加载该次报告…
          </div>
        ) : null}
        {loadError && activeView ? (
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
            background: 'rgba(217, 83, 79, 0.1)', border: '1px solid rgba(217, 83, 79, 0.28)',
            borderRadius: 12, padding: '10px 14px', color: '#b03a34', fontSize: 13.5,
          }}>
            <span>{loadError}</span>
            <button
              type="button"
              className="aic-btn aic-btn-ghost"
              style={{ padding: '4px 12px' }}
              onClick={() => void detailQuery.refetch()}
            >
              重试
            </button>
          </div>
        ) : null}

        {/* 1. 顶部标题栏：左上返回 + 居中绿色主标题 + 居中元信息行 */}
        <section>
          <div
            className="aic-rpt-titleline"
            style={{ position: 'relative', justifyContent: 'center' }}
          >
            <Button
              variant="outline"
              size="sm"
              onClick={handleBack}
              className="shrink-0"
              style={{ position: 'absolute', left: 0 }}
            >
              <ArrowLeft className="h-4 w-4" />
              返回上一页
            </Button>
            <h1 style={{ color: '#2f7d52', fontSize: 24 }}>专属测评报告</h1>
          </div>
          <p className="aic-rpt-subline">
            测评人群：{activeView.scenarioName} | 提交时间：{time || '—'}
          </p>
        </section>

        {/* 2. 文本心理测试报告 */}
        <section style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <h2 className="aic-report-h2">📄 文本心理测试报告</h2>

          {/* 2.1 整体心理状态结论 */}
          <div className="aic-glass aic-rpt-card">
            <h3 style={{
              display: 'flex', alignItems: 'center', gap: 8,
              fontSize: 15, fontWeight: 700, color: '#c66a35', marginBottom: 10,
            }}>
              <span style={{ fontSize: 18 }}>🌤️</span>
              整体心理状态结论
            </h3>
            <p style={{
              fontSize: 16, fontWeight: 700, lineHeight: 1.8,
              color: hasCrisis ? '#b03a34' : '#2b4a5e',
            }}>
              {verdictHeadline(gsi, hasCrisis)}
            </p>
          </div>

          {/* 2.2 AI 个性化解读：状态简要说明与具体调整建议（左侧蓝色装饰边线） */}
          <div
            className="aic-glass aic-rpt-card"
            style={{ borderLeft: '5px solid #3a9bd8', borderRadius: '0 18px 18px 0' }}
          >
            <h3 style={{
              display: 'flex', alignItems: 'center', gap: 8,
              fontSize: 15, fontWeight: 700, color: '#2b6f9c', marginBottom: 14,
            }}>
              <span style={{ fontSize: 18 }}>🤖</span>
              AI 个性化解读
            </h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
              <div>
                <h4 className="aic-report-h4">你的测评结果解读</h4>
                <div style={{ fontSize: 13.5, lineHeight: 1.95, color: '#2b4a5e' }}>
                  <MarkdownText content={textIntro || conclusionParagraph(gsi, hasCrisis)} />
                </div>
              </div>

              <div>
                <h4 className="aic-report-h4">状态简要说明</h4>
                <div style={{ fontSize: 13.5, lineHeight: 1.95, color: '#2b4a5e' }}>
                  <MarkdownText content={textStateNote || fallbackStateNote(attentionFactors)} />
                </div>
              </div>

              <div>
                <h4 className="aic-report-h4">具体调整建议</h4>
                <div
                  className="aic-rpt-advice"
                  style={{ fontSize: 13.5, lineHeight: 1.95, color: '#2b4a5e' }}
                >
                  <MarkdownText content={textAdvice || buildFallbackAdvice()} />
                  {textSupport ? <MarkdownText content={textSupport} /> : null}
                </div>
              </div>
            </div>

            <div className="aic-rpt-notice-bar">
              <p>本报告为AI辅助生成，仅供参考，不能替代专业心理诊断与治疗。</p>
              {hasCrisis ? (
                <p className="whitespace-pre-line" style={{ color: '#b03a34', marginTop: 6 }}>
                  {CRISIS_HOTLINE}
                </p>
              ) : null}
            </div>
          </div>
        </section>

        {/* 3. 视频心理测试报告 */}
        <section style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {hasVideo ? (
            <p style={{ fontSize: 12.5, color: '#6c8494' }}>
              主导情绪：{EMOTION_CN[dominant] || '—'} | 检测时间：{faceTime || '—'}
            </p>
          ) : null}
          <h2 className="aic-report-h2">🍃 面部状态与情绪结论 · 调整方向</h2>

          <div
            className="aic-glass aic-rpt-card"
            style={{ borderLeft: '5px solid #3a9bd8', borderRadius: '0 18px 18px 0' }}
          >
            {hasVideo ? (
              <>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
                  <div>
                    <h4 className="aic-report-h4">状态描述</h4>
                    <div style={{ fontSize: 13.5, lineHeight: 1.95, color: '#2b4a5e' }}>
                      <MarkdownText
                        content={videoDescription
                          || EMOTION_SUMMARY[dominant]
                          || EMOTION_SUMMARY.neutral}
                      />
                    </div>
                  </div>

                  <div>
                    <h4 className="aic-report-h4">调整方向</h4>
                    {videoAdvice ? (
                      <div
                        className="aic-rpt-advice"
                        style={{ fontSize: 13.5, lineHeight: 1.95, color: '#2b4a5e' }}
                      >
                        <MarkdownText content={videoAdvice} />
                      </div>
                    ) : (
                      <ol style={{
                        display: 'flex', flexDirection: 'column', gap: 8,
                        paddingLeft: 22, margin: 0,
                        fontSize: 13.5, lineHeight: 1.95, color: '#2b4a5e',
                      }}>
                        {buildVideoTips(dominant).map((tip) => (
                          <li key={tip}>{tip}</li>
                        ))}
                      </ol>
                    )}
                  </div>
                </div>

                <div className="aic-rpt-notice-bar">
                  <p>本报告基于面部表情的AI分析，仅供参考，不能替代专业心理评估。</p>
                </div>
              </>
            ) : (
              <p style={{ fontSize: 13.5, lineHeight: 1.95, color: '#6c8494' }}>
                暂无视频心理测试报告。完成一次视频情绪检测后，这里会自动展示面部状态与调整方向。
              </p>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function TestReportRoute() {
  const searchParams = useSearchParams();
  // 刚提交测评跳转过来时携带 pending=<report_id>，进入生成中轮询视图
  const pendingId = (searchParams.get('pending') || '').trim();
  const [report, setReport] = useState<StoredScl90Report | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      setReport(isStoredReport(parsed) ? parsed : null);
    } catch {
      setReport(null);
    } finally {
      setLoaded(true);
    }
  }, []);

  if (!loaded) {
    return (
      <div className={PAGE_CLASS}>
        <LoadingSkeleton rows={4} />
      </div>
    );
  }

  if (pendingId) {
    return (
      <AppShell role="student" pageClassName={PAGE_CLASS} headNavClassName={HEAD_NAV_CLASS}>
        <ReportGenerationPanel reportId={pendingId} />
      </AppShell>
    );
  }

  // sessionStorage 仅在「刚提交完测评跳转过来」时提供即时初值；
  // 从其他入口直接进入时为空，由 ReportContent 自动加载最新一份历史报告。
  const initial: ActiveReportView | null = report
    ? {
        id: report.report_id ?? '',
        scenarioName: report.scenario_name || '通用',
        submittedAtSec: report.submitted_at,
        scores: report.scores,
        aiText: report.report?.trim() || report.ai_content?.trim() || '',
        hasCrisis: Boolean(report.has_crisis),
        aiLoaded: Boolean(report.report?.trim() || report.ai_content?.trim()),
      }
    : null;

  return (
    <AppShell role="student" pageClassName={PAGE_CLASS} headNavClassName={HEAD_NAV_CLASS}>
      <ReportContent initial={initial} />
    </AppShell>
  );
}

export default function TestReportPage() {
  return (
    <Suspense
      fallback={
        <div className={PAGE_CLASS}>
          <LoadingSkeleton rows={4} />
        </div>
      }
    >
      <TestReportRoute />
    </Suspense>
  );
}
