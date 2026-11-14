'use client';

import { AlertTriangle, ArrowLeft, FileText, RefreshCw } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';

import { AuthGuard } from '@/components/business/auth-guard';
import { EmptyState } from '@/components/business/empty-state';
import { LoadingSkeleton } from '@/components/business/loading-skeleton';
import { MarkdownText } from '@/components/business/markdown-text';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button, buttonVariants } from '@/components/ui/button';
import { ApiError, getJson } from '@/lib/api';
import { CRISIS_HOTLINE } from '@/lib/scoring';
import type {
  FaceReportDetail, TextReportDetail, TextReportSummary, VideoMetrics,
} from '@/lib/types';
import { formatTimestamp } from '@/lib/utils';

// ---- 工具函数 ----

// 教师端详情页整体结论统一橙色加粗展示（版式重构要求），不再按 GSI 分级着色；
// 结论文案仍按 GSI 分级生成。学生端报告页保留原分级配色，不受影响。
const VERDICT_ORANGE = '#c66a35';

function verdictText(gsi: number): string {
  if (gsi < 1.5) return '整体心理状态良好，情绪稳定，适应力较强。';
  if (gsi < 2.0) return '整体心理状态平稳，偶有轻度波动，属正常范围。';
  if (gsi < 2.5) return '存在中度心理困扰，建议关注情绪变化并适当调适。';
  if (gsi < 3.0) return '心理状态偏高，建议主动寻求支持与专业指导。';
  return '心理状态偏重，强烈建议尽快联系心理老师或专业机构。';
}

const EMOTION_CN: Record<string, string> = {
  anger: '愤怒', disgust: '厌恶', fear: '恐惧',
  happiness: '快乐', sadness: '悲伤', surprise: '惊讶', neutral: '中性',
};

const EMOTION_ORDER = ['anger', 'disgust', 'fear', 'happiness', 'sadness', 'surprise'];

function factorPercent(avg: number): number {
  return Math.max(4, Math.min(100, ((avg - 1) / 4) * 100));
}

function sevClass(code: number): string {
  if (code >= 3) return 'bad';
  if (code >= 1) return 'warn';
  return '';
}

/** 从视频 metrics 派生四条曲线值：大脑疲劳度 / 集中力 / 压力度 / 情绪状态 */
function deriveVideoParams(emotions: Record<string, number>, activity: number) {
  const neg = (emotions.anger || 0) + (emotions.disgust || 0)
    + (emotions.fear || 0) + (emotions.sadness || 0);
  return [
    Math.round(Math.min(1, Math.max(0, (1 - activity) * 0.6 + neg * 0.6)) * 100),
    Math.round(Math.max(0, 100 - Math.abs(activity - 0.5) * 160)),
    Math.round(Math.min(1, neg) * 100),
    Math.round(Math.min(1, (emotions.happiness || 0) + (emotions.surprise || 0)) * 100),
  ];
}

// ---- 子组件 ----

/** 综合状态趋势折线图（SVG） */
function TrendChart({ points }: { points: { total_score: number | null; created_at?: number | null }[] }) {
  const W = 250, H = 130, padL = 26, padR = 10, padT = 12, padB = 18;
  const iw = W - padL - padR, ih = H - padT - padB;
  const vals = points.map((p) => p.total_score ?? 0).filter((v) => v != null);
  if (vals.length < 2) {
    return <p className="h-empty" style={{ color: '#8aa0b0', fontSize: 12 }}>至少 2 次检测后显示趋势</p>;
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

/** 心态分布曲线（六种情绪） */
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

/** 视频参数变化趋势（四条派生指标曲线） */
function VideoParamTrend({ records }: {
  records: { emotions: Record<string, number>; face_activity: number; date?: string }[];
}) {
  if (!records.length) return null;
  const W = 480, H = 180, padL = 30, padR = 12, padT = 12, padB = 22;
  const iw = W - padL - padR, ih = H - padT - padB;
  const n = records.length;
  const X = (i: number) => (n === 1 ? padL + iw / 2 : padL + (iw * i) / (n - 1));
  const Y = (v: number) => padT + (1 - v / 100) * ih;
  const SERIES = [
    { name: '大脑疲劳度', color: '#e8935a' },
    { name: '集中力', color: '#3a9bd8' },
    { name: '压力度', color: '#d9a520' },
    { name: '情绪状态', color: '#6fc297' },
  ];
  const seriesData = records.map((r) => deriveVideoParams(r.emotions, r.face_activity));
  const multi = n >= 2;

  return (
    <div>
      <div className="flex flex-wrap gap-3 mb-2">
        {SERIES.map((s) => (
          <span key={s.name} className="flex items-center gap-1 text-xs" style={{ color: '#5b7688' }}>
            <i style={{ display: 'inline-block', width: 10, height: 3, background: s.color, borderRadius: 2 }} />
            {s.name}
          </span>
        ))}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="line-svg" width="100%" height="auto">
        {[0, 1, 2].map((g) => {
          const gy = padT + (ih * g) / 2;
          return (
            <g key={g}>
              <line x1={padL} y1={gy} x2={W - padR} y2={gy} stroke="rgba(126,200,242,0.16)" />
              <text x={padL - 4} y={gy + 3} textAnchor="end" fontSize="9" fill="#8aa0b0">{100 - g * 50}%</text>
            </g>
          );
        })}
        {SERIES.map((s, si) => {
          const vals = seriesData.map((row) => row[si]);
          if (!multi) {
            const v = vals[0];
            return (
              <g key={s.name}>
                <circle cx={X(0)} cy={Y(v)} r="5" fill={s.color} stroke="#fff" strokeWidth="1.5">
                  <title>{s.name} {v}%</title>
                </circle>
                <text x={X(0) + 8} y={Y(v) + 4} fontSize="10" fontWeight="700" fill={s.color}>{v}%</text>
              </g>
            );
          }
          const path = vals.map((v, i) => `${i === 0 ? 'M' : 'L'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(' ');
          return (
            <g key={s.name}>
              <path d={path} fill="none" stroke={s.color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              {vals.map((v, i) => (
                <circle key={i} cx={X(i)} cy={Y(v)} r={i === n - 1 ? 4.5 : 3} fill={s.color} stroke="#fff" strokeWidth="1">
                  <title>{s.name} {v}%</title>
                </circle>
              ))}
            </g>
          );
        })}
        {multi && (
          <>
            <text x={X(0)} y={H - 6} textAnchor="start" fontSize="9" fill="#8aa0b0">{records[0]?.date || ''}</text>
            <text x={X(n - 1)} y={H - 6} textAnchor="end" fontSize="9" fill="#8aa0b0">{records[n - 1]?.date || ''}</text>
          </>
        )}
      </svg>
    </div>
  );
}

/** 六种情绪变化趋势（六张小折线图） */
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
  const W = 300, H = 130, padL = 30, padR = 12, padT = 12, padB = 22;
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
          grid += `<text x="${padL - 4}" y="${gy + 3}" text-anchor="end" font-size="9" fill="#8aa0b0">${100 - g * 50}%</text>`;
        }
        let body = '';
        if (multi) {
          const path = vals.map((v, i) => `${i === 0 ? 'M' : 'L'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(' ');
          body += `<path d="${path}" fill="none" stroke="#3a9bd8" stroke-width="2" stroke-linecap="round"/>`;
          body += vals.map((v, i) =>
            `<circle cx="${X(i).toFixed(1)}" cy="${Y(v).toFixed(1)}" r="${i === recs.length - 1 ? 4.5 : 3}" fill="#d9a520" stroke="#fff" stroke-width="1.5"/>`,
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

// ---- 主页面 ----

function ReportDetailContent() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = decodeURIComponent(params.id ?? '');

  // 直达链接（history.state.idx 为空）时 back() 无效，需回退到固定列表路径（与原 DetailPageShell 逻辑一致）。
  const handleBack = () => {
    const hasHistory = typeof window !== 'undefined' && (window.history.state?.idx ?? 0) > 0;
    if (hasHistory) {
      router.back();
      return;
    }
    router.replace('/teacher/reports');
  };

  const detailQuery = useQuery({
    queryKey: ['teacher', 'report-detail', id],
    queryFn: () => getJson<TextReportDetail>(`/api/teacher/report/${encodeURIComponent(id)}`),
    enabled: Boolean(id),
  });
  const detail = detailQuery.data;
  const studentId = detail?.student_id ?? '';

  // 学生历史报告列表（左栏）
  const historyQuery = useQuery({
    queryKey: ['teacher', 'student-reports', studentId],
    queryFn: () => getJson<{ reports: TextReportSummary[] }>(
      `/api/teacher/student/${encodeURIComponent(studentId)}/reports`,
    ),
    enabled: Boolean(studentId),
  });

  // 学生视频报告列表（含 metrics）
  const faceQuery = useQuery({
    queryKey: ['teacher', 'student-face-reports', studentId],
    queryFn: () => getJson<{ reports: FaceReportDetail[] }>(
      `/api/teacher/student/${encodeURIComponent(studentId)}/face-reports`,
    ),
    enabled: Boolean(studentId),
  });

  const faceReports = faceQuery.data?.reports ?? [];
  const latestFace = faceReports[0];
  const faceMetrics: VideoMetrics | undefined = latestFace?.metrics;
  const emotions = faceMetrics?.emotions ?? latestFace?.emotions ?? {};
  const emotionMax = faceMetrics?.emotion_max ?? {};
  const faceActivity = faceMetrics?.face_activity ?? 0;
  const auEntries = Object.entries(faceMetrics?.au ?? latestFace?.au ?? {});
  const emotionEntries = EMOTION_ORDER
    .filter((k) => emotions[k] != null)
    .map((k) => [k, emotions[k]] as [string, number]);

  const scores = detail?.scores;
  const gsi = scores?.总均分 ?? 0;
  const hasCrisis = scores && Object.keys(scores.危机信号 ?? {}).length > 0;
  // 因子按得分从高到低排序（仅展示顺序调整，数据不变）
  const factors = scores
    ? Object.entries(scores.因子分 ?? {}).sort((a, b) => b[1].均分 - a[1].均分)
    : [];
  const aiContent = detail?.ai_content || detail?.report || '';

  const history = historyQuery.data?.reports ?? [];
  const recent = history.slice(0, 8);
  const trendPoints = recent.slice().reverse().map((r) => ({
    total_score: r.total_score,
    created_at: r.created_at ?? r.submit_timestamp ?? null,
  }));

  // 视频历史记录（升序，用于趋势图）
  const faceRecordsAsc = faceReports.slice().reverse().map((r) => {
    const m = r.metrics;
    return {
      emotions: m?.emotions ?? r.emotions ?? {},
      face_activity: m?.face_activity ?? 0,
      date: r.created_at ? formatTimestamp(r.created_at).slice(0, 10) : '',
    };
  });

  const time = detail?.submitted_at
    ? formatTimestamp(detail.submitted_at)
    : detail?.created_at
      ? formatTimestamp(detail.created_at)
      : '';

  return (
    <div className="aic-rpt-full">
      {/* 左侧固定信息栏：基础信息 + 历史记录 + 趋势图 + 返回按钮（功能与数据完全保留） */}
      {detail ? (
        <aside className="aic-rpt-side aic-glass">
          <div className="aic-report-info-rows">
            <div className="aic-report-info-row">
              <span className="ik">姓名</span>
              <span className="iv">{detail.student_name || '—'}</span>
            </div>
            <div className="aic-report-info-row">
              <span className="ik">性别</span>
              <span className="iv">—</span>
            </div>
            <div className="aic-report-info-row">
              <span className="ik">年龄</span>
              <span className="iv">—</span>
            </div>
            <div className="aic-report-info-row">
              <span className="ik">身份</span>
              <span className="iv">学生（教师端查看）</span>
            </div>
            <div className="aic-report-info-row">
              <span className="ik">班级</span>
              <span className="iv">{detail.class || detail.student_class || '—'}</span>
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
              // 列表渲染全量历史（超出 210px 由容器内部滚动承载）；趋势图仍取最近 8 次，业务口径不变
              history.map((r) => {
                const rid = r.id || r.report_id || '';
                const ts = r.created_at ?? r.submit_timestamp ?? null;
                const d = ts ? formatTimestamp(ts).slice(0, 10) : '';
                return (
                  <li key={rid}>
                    <Link
                      href={`/teacher/report/detail/${encodeURIComponent(rid)}`}
                      className={rid === id ? 'h-item active' : 'h-item'}
                    >
                      <span className="h-date">{d}</span>
                      <span className="h-score" style={{ color: (r.total_score ?? 0) > 200 ? '#d9a520' : '#3a9bd8' }}>
                        {r.total_score ?? '—'}
                      </span>
                      {r.crisis ? <span style={{ color: '#d9534f' }}>⚠️</span> : null}
                    </Link>
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
            <Link href="/teacher/reports" className="aic-btn aic-btn-ghost w-full">
              返回班级列表
            </Link>
          </div>
        </aside>
      ) : null}

      <main className="aic-rpt-body">
        {/* 顶部标题栏：返回 + 主标题 + 居中副标题元信息行 */}
        <section>
          <div className="aic-rpt-titleline">
            <Button variant="outline" size="sm" onClick={handleBack} className="shrink-0">
              <ArrowLeft className="h-4 w-4" />
              返回
            </Button>
            <h1>{detail ? `专属测评报告 · ${detail.student_name}` : '专属测评报告'}</h1>
          </div>
          {detail ? (
            <p className="aic-rpt-subline">
              测评人群：{detail.scenario_name || '通用'} | 提交时间：{time} | 报告编号：{id}
            </p>
          ) : null}
        </section>

      {detailQuery.isLoading ? <LoadingSkeleton rows={4} /> : null}

      {detailQuery.isError ? (
        detailQuery.error instanceof ApiError && detailQuery.error.status === 404 ? (
          <EmptyState
            icon={<FileText className="h-5 w-5" />}
            title="报告不存在或已删除"
            description="该报告可能已被学生删除，请返回列表确认。"
            action={<Link href="/teacher/reports" className={buttonVariants()}>返回列表</Link>}
          />
        ) : detailQuery.error instanceof ApiError && detailQuery.error.status === 403 ? (
          <EmptyState
            icon={<AlertTriangle className="h-5 w-5" />}
            title="权限不足"
            description="仅可查看自己负责班级的学生报告。"
            action={<Link href="/teacher/reports" className={buttonVariants()}>返回列表</Link>}
          />
        ) : (
          <Alert variant="destructive">
            <AlertDescription className="flex items-center justify-between gap-3">
              报告详情加载失败
              <Button variant="outline" size="sm" onClick={() => void detailQuery.refetch()}>
                <RefreshCw className="mr-1 h-3.5 w-3.5" />
                重新加载
              </Button>
            </AlertDescription>
          </Alert>
        )
      ) : null}

      {detail && scores ? (
        <>
          {/* 危机预警通栏提示条 */}
          {hasCrisis ? (
            <div className="aic-report-crisis-box">
              ⚠️ 该同学测评中出现危机信号题目（得分≥4），建议尽快约谈并联系心理中心：400-161-9995
            </div>
          ) : null}

              {/* 整体心理状态结论（通栏单卡片） */}
              <section className="aic-glass aic-rpt-card">
                <h2 className="aic-report-h2">🌤️ 整体心理状态结论</h2>
                <p className="aic-verdict-text" style={{ color: VERDICT_ORANGE, fontWeight: 700 }}>
                  {verdictText(gsi)}
                </p>
              </section>

              {/* 视频表情分析（2行×2列规整网格） */}
              <section className="aic-glass aic-rpt-card">
                <h2 className="aic-report-h2">📹 视频表情分析</h2>
                {emotionEntries.length > 0 ? (
                  <div className="grid gap-4 md:grid-cols-2">
                    {/* 情绪参数表 */}
                    <div className="aic-glass" style={{ padding: '16px 20px' }}>
                      <h4 style={{ fontSize: 14, marginBottom: 12, color: '#2b4a5e' }}>情绪参数表</h4>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                        <thead>
                          <tr style={{ borderBottom: '1px solid rgba(126,200,242,0.2)' }}>
                            <th style={{ textAlign: 'left', padding: '6px 8px', color: '#5b7688' }}>情绪</th>
                            <th style={{ textAlign: 'right', padding: '6px 8px', color: '#5b7688' }}>均值</th>
                            <th style={{ textAlign: 'right', padding: '6px 8px', color: '#5b7688' }}>峰值</th>
                          </tr>
                        </thead>
                        <tbody>
                          {emotionEntries.map(([k, v]) => (
                            <tr key={k} style={{ borderBottom: '1px solid rgba(126,200,242,0.1)' }}>
                              <td style={{ padding: '6px 8px', color: '#2b4a5e' }}>{EMOTION_CN[k] || k}</td>
                              <td style={{ textAlign: 'right', padding: '6px 8px' }}>{(v * 100).toFixed(1)}%</td>
                              <td style={{ textAlign: 'right', padding: '6px 8px' }}>
                                {((emotionMax[k] ?? v) * 100).toFixed(1)}%
                              </td>
                            </tr>
                          ))}
                          <tr style={{ borderBottom: '1px solid rgba(126,200,242,0.1)' }}>
                            <td style={{ padding: '6px 8px', fontWeight: 600, color: '#2b4a5e' }}>主导情绪</td>
                            <td colSpan={2} style={{ textAlign: 'right', padding: '6px 8px', color: '#d9a520' }}>
                              {EMOTION_CN[faceMetrics?.dominant_emotion ?? latestFace?.dominant_emotion ?? ''] || faceMetrics?.dominant_emotion || latestFace?.dominant_emotion || '—'}
                            </td>
                          </tr>
                        </tbody>
                      </table>
                    </div>

                    {/* 心态分布曲线 */}
                    <div className="aic-glass" style={{ padding: '16px 20px' }}>
                      <div className="flex items-center gap-2 mb-2">
                        <span style={{ fontSize: 11, color: '#8aa0b0' }}><i style={{ display: 'inline-block', width: 8, height: 8, background: '#6fc297', borderRadius: '50%', marginRight: 4 }} />情绪分布</span>
                        <span style={{ fontSize: 11, color: '#8aa0b0' }}><i style={{ display: 'inline-block', width: 8, height: 2, background: '#3a9bd8', marginRight: 4 }} />参考线</span>
                      </div>
                      <h4 style={{ fontSize: 14, marginBottom: 8, color: '#2b4a5e' }}>心态分布曲线</h4>
                      <EmotionCurve emotions={emotions} />
                    </div>

                    {/* 生理诊断指标 */}
                    <div className="aic-glass" style={{ padding: '16px 20px' }}>
                      <h4 style={{ fontSize: 14, marginBottom: 12, color: '#2b4a5e' }}>生理诊断指标</h4>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                        <tbody>
                          <tr style={{ borderBottom: '1px solid rgba(126,200,242,0.1)' }}>
                            <td style={{ padding: '6px 8px', color: '#5b7688' }}>面部检出活跃度</td>
                            <td style={{ textAlign: 'right', padding: '6px 8px' }}>
                              <b style={{ color: '#d9a520' }}>{(faceActivity * 100).toFixed(1)}%</b>
                            </td>
                          </tr>
                          <tr style={{ borderBottom: '1px solid rgba(126,200,242,0.1)' }}>
                            <td style={{ padding: '6px 8px', color: '#5b7688' }}>人脸帧 / 总帧</td>
                            <td style={{ textAlign: 'right', padding: '6px 8px' }}>
                              {faceMetrics?.face_frames ?? 0} / {faceMetrics?.total_frames ?? 0}
                            </td>
                          </tr>
                          {auEntries.length > 0 ? auEntries.map(([au, metric]) => (
                            <tr key={au} style={{ borderBottom: '1px solid rgba(126,200,242,0.1)' }}>
                              <td style={{ padding: '6px 8px', color: '#5b7688' }}>{metric.label ?? au}</td>
                              <td style={{ textAlign: 'right', padding: '6px 8px', fontSize: 12 }}>
                                均值 {((metric.mean ?? 0) * 100).toFixed(0)}% · 峰值 {((metric.max ?? 0) * 100).toFixed(0)}%
                              </td>
                            </tr>
                          )) : (
                            <tr>
                              <td colSpan={2} style={{ padding: '6px 8px', color: '#8aa0b0', fontSize: 12 }}>
                                本次检测未返回 AU 生理参数
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>

                    {/* 视频参数变化趋势 */}
                    {faceRecordsAsc.length > 0 && (
                      <div className="aic-glass" style={{ padding: '16px 20px' }}>
                        <h4 style={{ fontSize: 14, marginBottom: 8, color: '#2b4a5e' }}>视频参数变化趋势</h4>
                        <VideoParamTrend records={faceRecordsAsc} />
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="aic-glass" style={{ padding: '20px', color: '#8aa0b0', fontSize: 13 }}>
                    本报告未附带视频检测数据。学生完成面部视频分析后，情绪参数与分级曲线将在此联动展示。
                  </div>
                )}
                <p style={{ fontSize: 11, color: '#8aa0b0', marginTop: 8 }}>
                  以上分级指标由表情概率与面部活跃度启发式估算，仅供参考，不构成医学诊断。
                </p>
              </section>

              {/* 文本测评指标（SCL-90） */}
              <section className="aic-glass aic-rpt-card">
                <h2 className="aic-report-h2">📋 文本测评指标（SCL-90）</h2>

                {/* 核心指标：4 卡横向并排 */}
                <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                  {[
                    { num: scores.总分, lbl: '总分（90-450）' },
                    { num: scores.总均分.toFixed(2), lbl: '总体严重指数 GSI' },
                    { num: scores.阳性项目数, lbl: '阳性项目数' },
                    { num: scores.阳性症状均分.toFixed(2), lbl: '痛苦指数 PSI' },
                  ].map((k) => (
                    <div key={k.lbl} className="aic-glass" style={{ padding: '14px 16px', textAlign: 'center' }}>
                      <div className="hl-num" style={{ fontSize: 24, fontWeight: 800, color: '#d9a520' }}>{k.num}</div>
                      <div style={{ fontSize: 12, color: '#5b7688', marginTop: 4 }}>{k.lbl}</div>
                    </div>
                  ))}
                </div>

                {/* 十个因子得分范围与严重程度（按得分从高到低排序） */}
                <div className="aic-glass" style={{ padding: '16px 20px', marginTop: 16 }}>
                  <h4 style={{ fontSize: 14, marginBottom: 10, color: '#2b4a5e' }}>十个因子得分范围与严重程度</h4>
                  <div className="aic-rpt-legend">
                    <span><i style={{ background: '#6fc297' }} />正常</span>
                    <span><i style={{ background: '#d9a520' }} />轻·中度</span>
                    <span><i style={{ background: '#c66a35' }} />中重度</span>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {factors.map(([name, f]) => {
                      const pct = factorPercent(f.均分);
                      const cls = sevClass(f.严重程度代码);
                      const barColor = cls === 'bad' ? '#c66a35' : cls === 'warn' ? '#d9a520' : '#6fc297';
                      return (
                        <div key={name} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <span style={{ width: 90, fontSize: 13, color: '#5b7688', flexShrink: 0 }}>{name}</span>
                          <div style={{ flex: 1, height: 10, background: 'rgba(126,200,242,0.15)', borderRadius: 5, overflow: 'hidden' }}>
                            <div style={{ width: `${pct}%`, height: '100%', background: barColor, borderRadius: 5, transition: 'width .4s' }} />
                          </div>
                          <span style={{ fontSize: 12, minWidth: 130, textAlign: 'right', color: '#5b7688' }}>
                            <b style={{ color: barColor }}>{f.均分.toFixed(2)}</b>
                            {' '}常模{f.常模均值.toFixed(2)} · Z={f.标准差倍数.toFixed(2)} · {f.严重程度}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </section>

              {/* 六种情绪变化趋势（2行×3列规整网格） */}
              {faceRecordsAsc.length > 0 && (
                <section className="aic-glass aic-rpt-card">
                  <h2 className="aic-report-h2">🎭 六种情绪变化趋势（视频情绪识别）</h2>
                  <EmotionTrends records={faceRecordsAsc} />
                </section>
              )}

              {/* AI 个性化解读（通栏单卡片，左侧蓝色装饰边线） */}
              <section className="aic-glass aic-rpt-card aic-rpt-ai">
                <h2 className="aic-report-h2">🤖 AI 个性化解读</h2>
                {aiContent ? (
                  <div className="aic-report-text">
                    <MarkdownText content={aiContent} />
                  </div>
                ) : (
                  <p style={{ color: '#8aa0b0' }}>暂无 AI 综合解读。</p>
                )}

                {/* 卡片底部统一免责温馨提示条（合并原独立求助提示区，消除重复内容） */}
                <div className="aic-rpt-notice-bar">
                  <p className="aic-rpt-notice-title">需要帮助时请及时求助</p>
                  <p className="whitespace-pre-line">{CRISIS_HOTLINE}</p>
                  <p>
                    本报告由自评量表生成，不是医学诊断，也不能替代心理咨询或精神科评估。
                    若该生近期持续感到痛苦、失眠或出现伤害自己的想法，请立即联系信任的老师、家人或专业机构。
                  </p>
                </div>
              </section>

              {/* 底部操作区：导出 PDF + AI 干预建议 */}
              <div className="aic-rpt-actions">
                <button type="button" className="aic-btn aic-btn-ghost" onClick={() => window.print()}>
                  📄 导出 PDF
                </button>
                <Link
                  href={`/teacher/intervention?student=${encodeURIComponent(studentId)}`}
                  className="aic-btn aic-btn-ghost"
                >
                  🤖 AI 干预建议
                </Link>
              </div>
            </>
          ) : null}
      </main>
    </div>
  );
}

export default function TeacherReportDetailPage() {
  return (
    <AuthGuard role="teacher">
      <ReportDetailContent />
    </AuthGuard>
  );
}
