'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { AppShell } from '@/components/business/app-shell';
import { LoadingSkeleton } from '@/components/business/loading-skeleton';
import { MarkdownText } from '@/components/business/markdown-text';
import { CRISIS_HOTLINE } from '@/lib/scoring';
import { getJson } from '@/lib/api';
import type {
  FaceReportSummary,
  FaceReportsResponse,
  ReportsResponse,
  Scl90Scores,
  StoredScl90Report,
  TextReportSummary,
} from '@/lib/types';
import { formatTimestamp } from '@/lib/utils';
import { useAuthStore } from '@/store/use-auth-store';

// 学生端心理报告页：布局框架与教师端「专属测评报告」详情页 1:1 对齐
// （aic-rpt-full 全屏两栏 + 左侧粘性侧边栏 + 右侧纵向滚动主内容区，模块顺序一致），
// 但面向学生做通俗化改写：不展示因子分/常模/Z值/GSI/PSI/AU 等专业技术参数，
// 仅保留状态结论、情绪可视化、通俗说明与调适建议。后端接口与数据结构零改动，全部为展示层过滤。

const STORAGE_KEY = 'scl90_report';

const PAGE_CLASS = 'min-h-screen px-0 pb-0 pt-[12px]';
const HEAD_NAV_CLASS = 'mb-[12px] flex flex-wrap items-center gap-[12px] px-[24px]';

const EMOTION_CN: Record<string, string> = {
  anger: '愤怒', disgust: '厌恶', fear: '恐惧',
  happiness: '快乐', sadness: '悲伤', surprise: '惊讶', neutral: '中性',
};

const EMOTION_ORDER = ['anger', 'disgust', 'fear', 'happiness', 'sadness', 'surprise'];

// 主导情绪 -> 通俗小结（替代教师端生理诊断指标卡，无任何技术参数）
const EMOTION_SUMMARY: Record<string, string> = {
  happiness: '视频检测里你的表情以轻松、愉快为主，近期的情绪基调比较积极，这是很难得的状态。',
  sadness: '视频检测里你的神情有些低落，最近可能感到不开心或提不起劲，这值得被温柔地看待。',
  fear: '视频检测里你的神情偏紧张，最近可能有些担心或压力，试着给自己一些放松的时间。',
  anger: '视频检测里你的表情里有一些烦躁，最近可能遇到了让人郁闷或委屈的事。',
  disgust: '视频检测里你的表情带着抗拒，最近可能被一些不喜欢的事情困扰着。',
  surprise: '视频检测里你的表情丰富多变，你对周围的新鲜事物比较敏感，这是好奇心的体现。',
  neutral: '视频检测里你的表情总体平静，情绪起伏不大，是一种比较安稳的状态。',
};

// 主导情绪 -> 落地调节小提示（替代教师端视频参数趋势卡）
const EMOTION_TIP: Record<string, string> = {
  happiness: '继续保持哦，可以记录开心的小事，把它们分享给身边的人。',
  sadness: '试试散步、听音乐、写日记，或找信任的人聊一聊，别一个人扛着。',
  fear: '紧张时做 10 次深呼吸，规律运动和减少熬夜都会让身心放松下来。',
  anger: '感到烦躁时先离开现场冷静几分钟，再去运动或写下来，让情绪有出口。',
  disgust: '暂时离开让你不舒服的情境，做点自己喜欢的事转移注意力。',
  surprise: '保持这份好奇心，把新发现写进日记，会让生活更有意思。',
  neutral: '保持规律作息和适度运动，每天留 10 分钟安静地觉察自己的心情。',
};

// 因子名 -> 通俗「重点关注方向」说明（不出现分值、常模、Z 值与严重程度分级）
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

function verdictLevel(gsi: number): string {
  if (gsi < 1.5) return '状态良好';
  if (gsi < 2.0) return '整体平稳';
  if (gsi < 2.5) return '轻度波动';
  if (gsi < 3.0) return '压力偏高';
  return '需要支持';
}

// 学生向结论文案：正向引导语气，不含临床判定类表述
function studentVerdictText(gsi: number): string {
  if (gsi < 1.5) return '你近期的心理状态很不错，情绪稳定，能较好地适应学习和生活。';
  if (gsi < 2.0) return '你近期的心理状态比较平稳，偶尔有小的情绪波动很正常，不必担心。';
  if (gsi < 2.5) return '最近你有一些情绪上的波动，建议多留意自己的感受，给自己一些放松和调适的时间。';
  if (gsi < 3.0) return '最近你可能感到有些疲惫或压力，建议主动和老师、家人、朋友聊聊，别一个人承受。';
  return '最近你可能正经历一段比较难的时期，建议尽快联系学校心理中心或专业机构，会有人陪你一起面对。';
}

function isStoredReport(value: unknown): value is StoredScl90Report {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const record = value as Partial<StoredScl90Report>;
  return Boolean(
    record.scores &&
      typeof record.scores === 'object' &&
      record.scores.因子分 &&
      typeof record.scores.总均分 === 'number',
  );
}

// ---- 图表组件（与教师端同款可视化，坐标标注做通俗化处理） ----

/** 综合状态趋势：折线面积图与教师端一致，纵轴分值标注替换为通俗状态等级。 */
function TrendChart({ points }: { points: { total_score: number | null }[] }) {
  const W = 250, H = 130, padL = 44, padR = 10, padT = 12, padB = 18;
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
  // 纵轴不再标注具体分值，用「需要支持 / 压力偏高 / 比较平稳 / 状态良好」四档通俗等级代替
  const LEVEL_LABELS = ['需要支持', '压力偏高', '比较平稳', '状态良好'];
  let grid = '';
  for (let g = 0; g <= 3; g++) {
    const gy = padT + (ih * g) / 3;
    grid += `<line x1="${padL}" y1="${gy}" x2="${W - padR}" y2="${gy}" stroke="rgba(126,200,242,0.16)"/>`;
    grid += `<text x="${padL - 6}" y="${gy + 3}" text-anchor="end" font-size="9" fill="#8aa0b0">${LEVEL_LABELS[g]}</text>`;
  }
  return (
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
  );
}

/** 心态分布曲线：与教师端同款，纵轴无刻度数字，仅保留占比标注。 */
function EmotionCurve({ emotions }: { emotions: Record<string, number> }) {
  const keys = EMOTION_ORDER.filter((k) => emotions[k] != null);
  if (!keys.length) return null;
  const W = 480, H = 180, padL = 34, padR = 14, padT = 14, padB = 26;
  const iw = W - padL - padR, ih = H - padT - padB;
  const stepX = iw / Math.max(1, keys.length - 1);
  const pts = keys.map((k, i) => ({
    x: padL + i * stepX,
    y: padT + (1 - Math.max(0, Math.min(1, emotions[k] || 0))) * ih,
    v: emotions[k] || 0, k,
  }));
  const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const refY = padT + (1 - 1 / keys.length) * ih;
  let grid = '';
  for (let g = 0; g <= 4; g++) {
    const gy = padT + (ih * g) / 4;
    grid += `<line x1="${padL}" y1="${gy}" x2="${W - padR}" y2="${gy}" stroke="rgba(126,200,242,0.16)"/>`;
  }
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="line-svg" width="100%" height="auto">
      <g dangerouslySetInnerHTML={{ __html: grid }} />
      <line x1={padL} y1={refY} x2={W - padR} y2={refY} stroke="#3a9bd8" strokeWidth="1.2" strokeDasharray="5 4" />
      <path d={d} fill="none" stroke="#6fc297" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      {pts.map((p) => (
        <g key={p.k}>
          <circle cx={p.x} cy={p.y} r="4" fill="#d9a520" stroke="#fff" strokeWidth="1.5">
            <title>{EMOTION_CN[p.k] || p.k} {Math.round(p.v * 100)}%</title>
          </circle>
          <text x={p.x} y={Math.max(p.y - 8, 10)} textAnchor="middle" fontSize="10" fontWeight="700" fill="#d9a520">
            {Math.round(p.v * 100)}%
          </text>
          <text x={p.x} y={H - 8} textAnchor="middle" fontSize="10" fill="#5b7688">
            {EMOTION_CN[p.k] || p.k}
          </text>
        </g>
      ))}
    </svg>
  );
}

/** 六种情绪变化趋势（2×3）：与教师端同款网格，去掉纵轴百分比刻度，仅保留走向与最近一次占比。 */
function EmotionTrends({ records }: {
  records: { emotions: Record<string, number>; date?: string }[];
}) {
  if (!records.length) {
    return <p className="h-empty" style={{ color: '#8aa0b0', fontSize: 12 }}>暂无视频情绪检测数据</p>;
  }
  const EMO: [string, string][] = [
    ['anger', '愤怒'], ['disgust', '厌恶'], ['fear', '恐惧'],
    ['happiness', '快乐'], ['sadness', '悲伤'], ['surprise', '惊讶'],
  ];
  const recs = records.slice().reverse();
  const multi = recs.length >= 2;
  const W = 300, H = 130, padL = 14, padR = 12, padT = 12, padB = 22;
  const iw = W - padL - padR, ih = H - padT - padB;

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
      {EMO.map(([key, cn]) => {
        const vals = recs.map((r) => Math.max(0, Math.min(1, (r.emotions && r.emotions[key]) || 0)));
        const X = (i: number) => (recs.length === 1 ? padL + iw / 2 : padL + (iw * i) / (recs.length - 1));
        const Y = (v: number) => padT + (1 - v) * ih;
        let grid = '';
        for (let g = 0; g <= 2; g++) {
          const gy = padT + (ih * g) / 2;
          grid += `<line x1="${padL}" y1="${gy}" x2="${W - padR}" y2="${gy}" stroke="rgba(126,200,242,0.16)"/>`;
        }
        let body = '';
        if (multi) {
          const path = vals.map((v, i) => `${i === 0 ? 'M' : 'L'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(' ');
          body += `<path d="${path}" fill="none" stroke="#3a9bd8" stroke-width="2" stroke-linecap="round"/>`;
          body += vals.map((v, i) =>
            `<circle cx="${X(i).toFixed(1)}" cy="${Y(v).toFixed(1)}" r="${i === recs.length - 1 ? 4.5 : 3}" fill="#d9a520" stroke="#fff" stroke-width="1"/>`,
          ).join('');
          const last = vals[recs.length - 1];
          body += `<text x="${(X(recs.length - 1) - 2).toFixed(1)}" y="${(Y(last) - 8).toFixed(1)}" text-anchor="end" font-size="10" font-weight="700" fill="#d9a520">${Math.round(last * 100)}%</text>`;
        } else {
          body += `<circle cx="${X(0).toFixed(1)}" cy="${Y(vals[0]).toFixed(1)}" r="6" fill="#d9a520" stroke="#fff" stroke-width="1.5"/>`;
          body += `<text x="${(X(0) + 10).toFixed(1)}" y="${(Y(vals[0]) + 4).toFixed(1)}" font-size="10" font-weight="700" fill="#d9a520">${Math.round(vals[0] * 100)}%</text>`;
        }
        const xLabels = multi
          ? `<text x="${X(0).toFixed(1)}" y="${H - 6}" text-anchor="start" font-size="9" fill="#8aa0b0">${recs[0]?.date || ''}</text>`
          + `<text x="${X(recs.length - 1).toFixed(1)}" y="${H - 6}" text-anchor="end" font-size="9" fill="#8aa0b0">${recs[recs.length - 1]?.date || ''}</text>`
          : `<text x="${X(0).toFixed(1)}" y="${H - 6}" text-anchor="middle" font-size="9" fill="#8aa0b0">${recs[0]?.date || '本次'}</text>`;
        return (
          <div key={key} className="rounded-lg bg-white/50 p-2">
            <h5 style={{ fontSize: 13, color: '#5b7688', marginBottom: 4 }}>{cn}</h5>
            <svg viewBox={`0 0 ${W} ${H}`} className="line-svg" width="100%" height="auto"
              dangerouslySetInnerHTML={{ __html: grid + body + xLabels }} />
          </div>
        );
      })}
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
  crisisMessage: string;
}

function toCrisisMessage(hasCrisis: boolean, storedMessage?: string): string {
  if (!hasCrisis) return '';
  // 历史报告详情接口不返回文案，这里用与后端提交响应一致的固定话术兜底
  return storedMessage?.trim()
    || `⚠️ 测评中检测到你可能正处于比较痛苦的阶段，请务必寻求专业帮助：\n${CRISIS_HOTLINE}`;
}

// ---- 主内容 ----

// initial：刚提交测评时来自 sessionStorage 的最新结果；从个人中心等入口直接进页面时为 null，
// 此时自动回退加载历史接口里的最新一份报告（默认展示 = history[0]）。
function ReportContent({ initial }: { initial: ActiveReportView | null }) {
  const storeUser = useAuthStore((state) => state.user);
  const [activeId, setActiveId] = useState(initial?.id ?? '');

  // 历史报告列表（后端已按提交时间倒序返回全量）
  const historyQuery = useQuery({
    queryKey: ['student', 'reports-history'],
    queryFn: () => getJson<ReportsResponse>('/api/student/reports'),
  });
  const history = historyQuery.data?.reports ?? [];
  const latestId = history.length ? history[0].id || history[0].report_id || '' : '';
  // 未点击切换时默认展示最新一份（sessionStorage 命中则优先用它，避免重复请求）
  const effectiveId = activeId || latestId;

  // 点击历史记录 / 无 sessionStorage 初值时，按需拉取该份报告详情
  const needFetch = Boolean(effectiveId) && (!initial || effectiveId !== initial.id);
  const detailQuery = useQuery({
    queryKey: ['student', 'report-detail', effectiveId],
    queryFn: () => getJson<StudentReportDetailPayload>(
      `/api/student/report/${encodeURIComponent(effectiveId)}`,
    ),
    enabled: needFetch,
  });

  // 视频检测历史（列表项自带 emotions / dominant_emotion，无需逐份拉详情）
  const faceQuery = useQuery({
    queryKey: ['student', 'face-reports'],
    queryFn: () => getJson<FaceReportsResponse>('/api/face/reports'),
  });
  const faceReports: FaceReportSummary[] = faceQuery.data?.reports ?? [];
  const latestFace = faceReports[0];
  const emotions = latestFace?.emotions ?? {};
  const dominant = latestFace?.dominant_emotion || '';
  const emotionEntries = EMOTION_ORDER
    .filter((k) => emotions[k] != null)
    .map((k) => [k, emotions[k]] as [string, number]);
  const faceRecordsAsc = faceReports.slice().reverse().map((r) => ({
    emotions: r.emotions ?? {},
    date: (r.created_at ?? r.create_timestamp)
      ? formatTimestamp((r.created_at ?? r.create_timestamp) as number).slice(0, 10)
      : '',
  }));

  const active: ActiveReportView | null = needFetch && detailQuery.data
    ? {
        id: detailQuery.data.id,
        scenarioName: detailQuery.data.scenario_name || '通用',
        // 详情接口 submitted_at 为毫秒，sessionStorage 为秒，统一归一为秒
        submittedAtSec: detailQuery.data.submitted_at > 1e12
          ? Math.round(detailQuery.data.submitted_at / 1000)
          : detailQuery.data.submitted_at,
        scores: detailQuery.data.scores,
        aiText: detailQuery.data.report?.trim() || '',
        hasCrisis: Object.keys(detailQuery.data.scores?.危机信号 ?? {}).length > 0,
        crisisMessage: toCrisisMessage(
          Object.keys(detailQuery.data.scores?.危机信号 ?? {}).length > 0,
        ),
      }
    : initial;

  if (historyQuery.isLoading || (needFetch && detailQuery.isLoading)) {
    return (
      <div className="aic-rpt-full">
        <aside className="aic-rpt-side aic-glass">
          <LoadingSkeleton rows={6} />
        </aside>
        <main className="aic-rpt-body">
          <LoadingSkeleton rows={8} />
        </main>
      </div>
    );
  }

  // 无任何历史报告（且无 sessionStorage 初值）：空状态引导去测评
  if (!active) {
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

  const scores = active.scores;
  const gsi = scores?.总均分 ?? 0;
  const time = active.submittedAtSec ? formatTimestamp(active.submittedAtSec) : '';
  // 关注维度：均分达到 2 分（轻度起点）的因子，仅用于计数与通俗列表，不展示分值
  const attentionFactors = Object.entries(scores?.因子分 ?? {})
    .filter(([, f]) => f.均分 >= 2)
    .sort((a, b) => b[1].均分 - a[1].均分);
  // 趋势图口径保持原逻辑：最近 8 次
  const trendPoints = history.slice(0, 8).reverse().map((r) => ({ total_score: r.total_score }));

  return (
    <div className="aic-rpt-full">
      {/* 左侧粘性侧边栏：结构与教师端一致（信息区 / 历史记录 / 趋势图 / 底部按钮） */}
      <aside className="aic-rpt-side aic-glass">
        <div className="aic-report-info-rows">
          <div className="aic-report-info-row">
            <span className="ik">姓名</span>
            <span className="iv">{storeUser?.name || '—'}</span>
          </div>
          <div className="aic-report-info-row">
            <span className="ik">身份</span>
            <span className="iv">学生</span>
          </div>
          <div className="aic-report-info-row">
            <span className="ik">测评人群</span>
            <span className="iv">{active.scenarioName}</span>
          </div>
          <div className="aic-report-info-row">
            <span className="ik">检测时间</span>
            <span className="iv">{time || '—'}</span>
          </div>
        </div>

        <hr className="aic-grad-divider" style={{ alignSelf: 'stretch' }} />

        <h3 style={{ fontSize: 15, color: '#5b7688', alignSelf: 'flex-start', marginBottom: 8 }}>
          历史检测记录
        </h3>
        <ul className="aic-report-history-list">
          {history.length === 0 ? (
            <li className="h-empty">暂无历史记录</li>
          ) : (
            // 全量渲染（超出 210px 容器内部滚动）；不展示分值，仅通俗状态标签
            history.map((r: TextReportSummary) => {
              const rid = r.id || r.report_id || '';
              const ts = r.created_at ?? r.submit_timestamp ?? null;
              const d = ts ? formatTimestamp(ts).slice(0, 10) : '';
              const label = r.crisis
                ? { text: '危机信号', color: '#d9534f' }
                : (r.total_score ?? 0) > 200
                  ? { text: '需要关注', color: '#d9a520' }
                  : { text: '平稳', color: '#2f7d52' };
              return (
                <li key={rid}>
                  <button
                    type="button"
                    className={rid === active.id ? 'h-item active' : 'h-item'}
                    onClick={() => setActiveId(rid)}
                  >
                    <span className="h-date">{d}</span>
                    <span className="h-score" style={{ color: label.color, fontSize: 12 }}>
                      {label.text}
                    </span>
                    {r.crisis ? <span style={{ color: '#d9534f' }}>⚠️</span> : null}
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

        <div className="aic-report-side-actions">
          <Link href="/test" className="aic-btn aic-btn-primary w-full">
            📝 新的测评
          </Link>
        </div>
      </aside>

      {/* 右侧主内容区：模块顺序与教师端 1:1 对齐 */}
      <main className="aic-rpt-body">
        {/* 1. 顶部标题栏（通栏；返回/首页导航在顶部全局导航中，标题栏不再重复放返回按钮） */}
        <section>
          <div className="aic-rpt-titleline">
            <h1>专属心理状态报告</h1>
          </div>
          <p className="aic-rpt-subline">
            测评人群：{active.scenarioName} | 提交时间：{time || '—'}
          </p>
        </section>

        {/* 2. 危机预警提示条（风险信息完整触达） */}
        {active.hasCrisis && active.crisisMessage ? (
          <div className="aic-report-crisis-box" style={{ whiteSpace: 'pre-line' }}>
            {active.crisisMessage}
          </div>
        ) : null}

        {/* 3. 整体心理状态结论（通栏单卡，通俗正向表述） */}
        <section className="aic-glass aic-rpt-card">
          <h2 className="aic-report-h2">🌤️ 整体心理状态结论</h2>
          <p className="aic-verdict-text" style={{ color: '#c66a35', fontWeight: 700 }}>
            {studentVerdictText(gsi)}
          </p>
        </section>

        {/* 4. 视频表情分析（2×2 网格；AU/生理指标/参数趋势已替换为通俗小结与提示） */}
        <section className="aic-glass aic-rpt-card">
          <h2 className="aic-report-h2">📹 视频表情分析</h2>
          {emotionEntries.length > 0 ? (
            <div className="grid gap-4 md:grid-cols-2">
              <div className="aic-glass" style={{ padding: '16px 20px' }}>
                <h4 style={{ fontSize: 14, marginBottom: 12, color: '#2b4a5e' }}>核心情绪占比</h4>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid rgba(126,200,242,0.2)' }}>
                      <th style={{ textAlign: 'left', padding: '6px 8px', color: '#5b7688' }}>情绪</th>
                      <th style={{ textAlign: 'right', padding: '6px 8px', color: '#5b7688' }}>占比</th>
                    </tr>
                  </thead>
                  <tbody>
                    {emotionEntries.map(([k, v]) => (
                      <tr key={k} style={{ borderBottom: '1px solid rgba(126,200,242,0.1)' }}>
                        <td style={{ padding: '6px 8px', color: '#2b4a5e' }}>{EMOTION_CN[k] || k}</td>
                        <td style={{ textAlign: 'right', padding: '6px 8px' }}>{(v * 100).toFixed(0)}%</td>
                      </tr>
                    ))}
                    <tr>
                      <td style={{ padding: '6px 8px', fontWeight: 600, color: '#2b4a5e' }}>最常被捕捉到</td>
                      <td style={{ textAlign: 'right', padding: '6px 8px', color: '#d9a520', fontWeight: 700 }}>
                        {EMOTION_CN[dominant] || dominant || '—'}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div className="aic-glass" style={{ padding: '16px 20px' }}>
                <h4 style={{ fontSize: 14, marginBottom: 8, color: '#2b4a5e' }}>心态分布曲线</h4>
                <EmotionCurve emotions={emotions} />
              </div>
              <div className="aic-glass" style={{ padding: '16px 20px' }}>
                <h4 style={{ fontSize: 14, marginBottom: 10, color: '#2b4a5e' }}>情绪状态小结</h4>
                <p style={{ fontSize: 13.5, lineHeight: 1.9, color: '#2b4a5e' }}>
                  {EMOTION_SUMMARY[dominant] || EMOTION_SUMMARY.neutral}
                </p>
              </div>
              <div className="aic-glass" style={{ padding: '16px 20px' }}>
                <h4 style={{ fontSize: 14, marginBottom: 10, color: '#2b4a5e' }}>情绪状态提示</h4>
                <p style={{ fontSize: 13.5, lineHeight: 1.9, color: '#2b4a5e' }}>
                  {EMOTION_TIP[dominant] || EMOTION_TIP.neutral}
                </p>
              </div>
            </div>
          ) : (
            <p className="aic-report-text">
              暂无视频状态记录。完成一次视频情绪检测后，这里会呈现你的情绪状态解读与调节小建议。
            </p>
          )}
        </section>

        {/* 5. 文本测评结果（通栏卡；GSI/PSI/因子条形图已替换为通俗状态卡 + 关注方向列表） */}
        <section className="aic-glass aic-rpt-card">
          <h2 className="aic-report-h2">📋 文本测评结果</h2>
          <div className="grid grid-cols-2 gap-3">
            <div className="aic-glass" style={{ padding: '14px 16px', textAlign: 'center' }}>
              <div className="hl-num" style={{ fontSize: 22, fontWeight: 800, color: '#3a9bd8' }}>
                {verdictLevel(gsi)}
              </div>
              <div style={{ fontSize: 12, color: '#5b7688', marginTop: 4 }}>整体状态等级</div>
            </div>
            <div className="aic-glass" style={{ padding: '14px 16px', textAlign: 'center' }}>
              <div className="hl-num" style={{ fontSize: 22, fontWeight: 800, color: '#d9a520' }}>
                {attentionFactors.length} 个
              </div>
              <div style={{ fontSize: 12, color: '#5b7688', marginTop: 4 }}>需要留意的方向</div>
            </div>
          </div>
          <div className="aic-glass" style={{ padding: '16px 20px', marginTop: 16 }}>
            <h4 style={{ fontSize: 14, marginBottom: 10, color: '#2b4a5e' }}>重点关注方向</h4>
            {attentionFactors.length === 0 ? (
              <p style={{ fontSize: 13.5, color: '#2b4a5e', lineHeight: 1.9 }}>
                这次测评里，你的各个状态维度都比较放松，没有特别需要留意的方面，继续保持良好的生活节奏就好。
              </p>
            ) : (
              <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 10, padding: 0, margin: 0 }}>
                {attentionFactors.map(([name]) => (
                  <li
                    key={name}
                    style={{
                      display: 'flex', alignItems: 'baseline', gap: 10,
                      fontSize: 13.5, lineHeight: 1.8, color: '#2b4a5e',
                      background: 'rgba(255,255,255,0.55)', border: '1px solid rgba(255,255,255,0.8)',
                      borderRadius: 10, padding: '8px 12px',
                    }}
                  >
                    <span style={{ flexShrink: 0, fontWeight: 700, color: '#3a9bd8' }}>{name}</span>
                    <span>{FACTOR_PLAIN[name] || '最近这个方面的状态有些波动，留意一下自己的感受。'}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        {/* 6. 情绪变化趋势（2×3 网格，弱化分值解读） */}
        <section className="aic-glass aic-rpt-card">
          <h2 className="aic-report-h2">🎭 情绪变化趋势</h2>
          <EmotionTrends records={faceRecordsAsc} />
        </section>

        {/* 7. AI 个性化解读（通栏单卡 + 底部免责提示条） */}
        <section className="aic-glass aic-rpt-card aic-rpt-ai">
          <h2 className="aic-report-h2">🤖 AI 个性化解读</h2>
          {active.aiText ? (
            <div className="aic-report-text">
              <MarkdownText content={active.aiText} />
            </div>
          ) : (
            <p className="aic-report-text">本次暂未生成文字解读，可稍后在报告中心查看。</p>
          )}
          <div className="aic-rpt-notice-bar">
            <p className="aic-rpt-notice-title">需要帮助时请及时求助</p>
            <p className="whitespace-pre-line">{CRISIS_HOTLINE}</p>
            <p>
              本报告由自评量表生成，不是医学诊断，也不能替代心理咨询或专业评估。
              若近期持续感到痛苦、失眠或出现伤害自己的想法，请立即联系信任的老师、家人或专业机构。
            </p>
          </div>
        </section>

        {/* 8. 底部操作区：双按钮居中 */}
        <div className="aic-rpt-actions">
          <Link href="/test" className="aic-btn aic-btn-primary">📝 重新测评</Link>
          <Link href="/student/reports" className="aic-btn aic-btn-ghost">💡 查看更多建议</Link>
        </div>
      </main>
    </div>
  );
}

export default function TestReportPage() {
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

  // sessionStorage 仅在「刚提交完测评跳转过来」时提供即时初值；
  // 从个人中心等入口直接进入时为空，由 ReportContent 自动加载最新一份历史报告。
  const initial: ActiveReportView | null = report
    ? {
        id: report.report_id ?? '',
        scenarioName: report.scenario_name || '通用',
        submittedAtSec: report.submitted_at,
        scores: report.scores,
        aiText: report.report?.trim() || report.ai_content?.trim() || '',
        hasCrisis: Boolean(report.has_crisis),
        crisisMessage: toCrisisMessage(Boolean(report.has_crisis), report.crisis_message),
      }
    : null;

  return (
    <AppShell role="student" pageClassName={PAGE_CLASS} headNavClassName={HEAD_NAV_CLASS}>
      <ReportContent initial={initial} />
    </AppShell>
  );
}
