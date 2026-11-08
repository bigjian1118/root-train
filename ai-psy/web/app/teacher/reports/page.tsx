'use client';

import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';

import { AppShell } from '@/components/business/app-shell';
import { AuthGuard } from '@/components/business/auth-guard';
import { useScrollRestore } from '@/components/business/detail-page-shell';
import { LoadingSkeleton } from '@/components/business/loading-skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { getJson } from '@/lib/api';
import type { TextReportSummary } from '@/lib/types';
import { formatTimestamp } from '@/lib/utils';

const ALL_CLASSES = '';

// 统计天数下拉选项（旧版 daySelect：默认近 7 天，0 表示全部）。
const DAY_OPTIONS = [
  { value: '7', label: '近 7 天' },
  { value: '14', label: '近 14 天' },
  { value: '30', label: '近 30 天' },
  { value: '0', label: '全部' },
];

const SECONDS_PER_DAY = 86400;

// 因子固定展示顺序（与旧版 teacher_reports.js FACTOR_ORDER / 后端 FACTOR_EN_MAP 一致）。
const FACTOR_ORDER = [
  '躯体化', '强迫症状', '人际关系敏感', '抑郁', '焦虑',
  '敌对', '恐怖', '偏执', '精神病性', '其他',
];

type RiskLevel = 'high' | 'watch' | 'normal';

const RISK_WEIGHT: Record<RiskLevel, number> = { high: 2, watch: 1, normal: 0 };

// 测评场景中文名映射：与旧版 teacher_reports.js scenarioName 一字不差。
const SCENARIO_LABELS: Record<string, string> = {
  primary_student: '小学生',
  junior_student: '中学生',
  college_student: '大学生',
  teacher: '教师（旧版）',
};

function scenarioName(key?: string): string {
  if (!key) {
    return '—';
  }
  return SCENARIO_LABELS[key] || key;
}

/** 后端列表/详情存在数组与 {reports}/{classes} 两种形态，统一取数组。 */
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

function reportId(report: TextReportSummary): string {
  return report.id ?? report.report_id ?? '';
}

function riskLevel(report: TextReportSummary): RiskLevel {
  // 与旧教师端口径一致：危机信号或总分 > 300 为高危，> 200 需关注。
  if (report.crisis || (report.total_score != null && report.total_score > 300)) {
    return 'high';
  }
  if (report.total_score != null && report.total_score > 200) {
    return 'watch';
  }
  return 'normal';
}

/** 每位学生只保留最新一条报告，用于列表展示与统计。 */
function latestPerStudent(reports: TextReportSummary[]): TextReportSummary[] {
  const best = new Map<string, TextReportSummary>();
  reports.forEach((report) => {
    const key = report.student_id || `${report.student_name}|${report.class ?? ''}`;
    const previous = best.get(key);
    if (!previous || (report.created_at ?? 0) >= (previous.created_at ?? 0)) {
      best.set(key, report);
    }
  });
  return Array.from(best.values()).sort((a, b) => {
    const riskDiff = RISK_WEIGHT[riskLevel(b)] - RISK_WEIGHT[riskLevel(a)];
    if (riskDiff !== 0) {
      return riskDiff;
    }
    return (b.created_at ?? 0) - (a.created_at ?? 0);
  });
}

/** 按所选天数过滤（0 表示全部），口径同旧版 byDays。 */
function filterByDays(list: TextReportSummary[], days: string): TextReportSummary[] {
  const num = parseInt(days, 10);
  if (!num) {
    return list;
  }
  const since = Date.now() / 1000 - num * SECONDS_PER_DAY;
  return list.filter((report) => (report.created_at ?? 0) >= since);
}

/** 按起止日期过滤（可空；含止日 23:59:59），口径同旧版 byDateRange。 */
function filterByDateRange(
  list: TextReportSummary[],
  dateFrom: string,
  dateTo: string,
): TextReportSummary[] {
  const from = dateFrom ? new Date(`${dateFrom}T00:00:00`).getTime() / 1000 : null;
  const to = dateTo ? new Date(`${dateTo}T23:59:59`).getTime() / 1000 : null;
  return list.filter((report) => {
    const ts = report.created_at ?? 0;
    if (from != null && ts < from) {
      return false;
    }
    if (to != null && ts > to) {
      return false;
    }
    return true;
  });
}

/** 图表标题时间范围文案，口径同旧版 dayLabel（7 天显示「近一周」）。 */
function dayLabel(days: string): string {
  const num = parseInt(days, 10);
  if (!num) {
    return '全部';
  }
  return num === 7 ? '近一周' : `近 ${num} 天`;
}

/** 五张统计卡：口径同旧版 renderStats，基于筛选后（含重复）列表按 student_id 去重。 */
function buildStats(list: TextReportSummary[]) {
  const students = new Set<string>();
  const todayStudents = new Set<string>();
  const focus = new Set<string>();
  let todayReports = 0;
  const d0 = new Date();
  d0.setHours(0, 0, 0, 0);
  const todayStart = d0.getTime() / 1000;
  list.forEach((report) => {
    students.add(report.student_id);
    if ((report.created_at ?? 0) >= todayStart) {
      todayReports += 1;
      todayStudents.add(report.student_id);
    }
    if (riskLevel(report) === 'high') {
      focus.add(report.student_id);
    }
  });
  return {
    students: students.size,
    todayStudents: todayStudents.size,
    reports: list.length,
    todayReports,
    focus: focus.size,
  };
}

interface FactorBar {
  factor: string;
  count: number;
  pct: number;
  level: 'ok' | 'warn' | 'focus';
}

/** 因子偏向柱数据：口径同旧版 renderChart——每生取最新报告的 top_factor 计数，柱色按班级均分。 */
function buildFactorBars(list: TextReportSummary[]): FactorBar[] {
  const latestByStudent = new Map<string, TextReportSummary>();
  list.forEach((report) => {
    const previous = latestByStudent.get(report.student_id);
    if (!previous || (report.created_at ?? 0) >= (previous.created_at ?? 0)) {
      latestByStudent.set(report.student_id, report);
    }
  });
  const counts = new Map<string, number>(FACTOR_ORDER.map((factor) => [factor, 0]));
  const avgAcc = new Map<string, { sum: number; n: number }>();
  latestByStudent.forEach((report) => {
    const avgs = report.factor_avgs ?? {};
    let top: string | undefined = report.top_factor;
    if (!top) {
      // 旧数据无 top_factor 时回退：从因子均分中现场找最大项
      let best = -Infinity;
      FACTOR_ORDER.forEach((factor) => {
        if (avgs[factor] != null && avgs[factor] > best) {
          best = avgs[factor];
          top = factor;
        }
      });
    }
    if (top && counts.has(top)) {
      counts.set(top, (counts.get(top) ?? 0) + 1);
    }
    FACTOR_ORDER.forEach((factor) => {
      const value = avgs[factor];
      if (value == null) {
        return;
      }
      const acc = avgAcc.get(factor) ?? { sum: 0, n: 0 };
      acc.sum += value;
      acc.n += 1;
      avgAcc.set(factor, acc);
    });
  });
  const total = latestByStudent.size;
  return FACTOR_ORDER.map((factor) => {
    const count = counts.get(factor) ?? 0;
    const pct = total > 0 ? Math.round((count / total) * 100) : 0;
    const acc = avgAcc.get(factor);
    const avg = acc ? acc.sum / acc.n : 0;
    const level: FactorBar['level'] = avg >= 3 ? 'focus' : avg >= 2 ? 'warn' : 'ok';
    return { factor, count, pct, level };
  });
}

/** 因子偏向柱状图卡（旧版 chart-wrap）：首帧 0 高，rAF 后写内联高度触发 0.5s 过渡动画。 */
function FactorBiasChart({ title, bars }: { title: string; bars: FactorBar[] }) {
  const chartRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = chartRef.current;
    if (!el) {
      return;
    }
    const raf = requestAnimationFrame(() => {
      el.querySelectorAll<HTMLElement>('.aic-tr-col-fill').forEach((fill) => {
        fill.style.height = `${fill.dataset.h ?? '0'}%`;
      });
    });
    return () => cancelAnimationFrame(raf);
  }, [bars]);
  return (
    <div className="aic-tr-chart-wrap">
      <div className="aic-tr-legend">
        <span><i className="aic-lg-green" />正常（均分&lt;2）</span>
        <span><i className="aic-lg-gold" />需关注（2~3）</span>
        <span><i className="aic-lg-orange" />重点（≥3）</span>
      </div>
      <h2>{title}</h2>
      <div className="aic-tr-chart" ref={chartRef}>
        {bars.map((bar) => (
          <div className="aic-tr-col" key={bar.factor}>
            <span className="aic-tr-col-num">{bar.count} 人 / {bar.pct}%</span>
            <div className="aic-tr-col-track">
              <div className={`aic-tr-col-fill lvl-${bar.level}`} data-h={bar.pct} />
            </div>
            <span className="aic-tr-col-name">{bar.factor}</span>
          </div>
        ))}
      </div>
      <p className="aic-tr-chart-tip">偏向标准：该因子均分 ≥ 2 分；柱子颜色按该因子班级均分严重程度着色</p>
    </div>
  );
}

// 列表状态持久化键：跳详情页返回后恢复筛选条件与滚动位置。
const LIST_STATE_KEY = 'list-state:teacher-reports';

function TeacherReportsContent() {
  const router = useRouter();
  const [savedState] = useState(() => {
    try {
      return JSON.parse(sessionStorage.getItem(LIST_STATE_KEY) ?? '{}') as
        { classFilter?: string; keyword?: string };
    } catch {
      return {};
    }
  });
  const [classFilter, setClassFilter] = useState(savedState.classFilter ?? ALL_CLASSES);
  const [keyword, setKeyword] = useState(savedState.keyword ?? '');
  const [days, setDays] = useState('7');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  useEffect(() => {
    sessionStorage.setItem(LIST_STATE_KEY, JSON.stringify({ classFilter, keyword }));
  }, [classFilter, keyword]);
  useScrollRestore('scroll:teacher-reports');

  const classesQuery = useQuery({
    queryKey: ['teacher', 'classes'],
    queryFn: async () =>
      pickArray<string>(await getJson<unknown>('/api/teacher/classes'), 'classes'),
  });

  const reportsQuery = useQuery({
    queryKey: ['teacher', 'reports', classFilter],
    queryFn: async () => {
      const query = classFilter ? `?class=${encodeURIComponent(classFilter)}` : '';
      return pickArray<TextReportSummary>(
        await getJson<unknown>(`/api/teacher/reports${query}`),
        'reports',
      );
    },
  });

  const classes = classesQuery.data ?? [];
  const allReports = reportsQuery.data ?? [];

  // 天数 + 起止日期 + 关键字联合筛选，统计/图表/列表全部联动（旧版 applyFilter 口径）。
  const filteredReports = useMemo(() => {
    const keywordLower = keyword.trim().toLowerCase();
    const list = filterByDateRange(filterByDays(allReports, days), dateFrom, dateTo);
    if (!keywordLower) {
      return list;
    }
    return list.filter(
      (report) =>
        report.student_name.toLowerCase().includes(keywordLower) ||
        report.student_id.toLowerCase().includes(keywordLower) ||
        scenarioName(report.scenario).toLowerCase().includes(keywordLower),
    );
  }, [allReports, days, dateFrom, dateTo, keyword]);

  const latestReports = useMemo(() => latestPerStudent(filteredReports), [filteredReports]);

  const stats = useMemo(() => buildStats(filteredReports), [filteredReports]);

  const factorBars = useMemo(() => buildFactorBars(filteredReports), [filteredReports]);

  const statCards: { label: string; value: number; focus?: boolean }[] = [
    { label: '总人数', value: stats.students },
    { label: '今日检测人数', value: stats.todayStudents },
    { label: '总检测次数', value: stats.reports },
    { label: '今日检测次数', value: stats.todayReports },
    { label: '重点关注人数（危机或总分>300）', value: stats.focus, focus: true },
  ];

  const classLabel = classFilter || (classes.length ? `全部班级（${classes.length}）` : '全部班级');

  const loadError = classesQuery.isError || reportsQuery.isError;

  return (
    <AppShell
      role="teacher"
      pageClassName="min-h-screen px-[24px] pb-[70px] pt-[20px]"
      headNavClassName="mb-[12px] flex flex-wrap items-center gap-[10px]"
    >
      <h1 className="aic-page-title mb-[8px]">📋 本班级同学心理测试报告</h1>
      <p className="aic-tr-sub">{classLabel}</p>

      <div className="aic-glass aic-tr-toolbar">
        <label className="aic-tr-label">
          统计天数：
          <select
            className="aic-tr-select"
            value={days}
            onChange={(event) => setDays(event.target.value)}
            aria-label="统计天数"
          >
            {DAY_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="aic-tr-label">
          起
          <input
            type="date"
            className="aic-tr-date"
            value={dateFrom}
            onChange={(event) => setDateFrom(event.target.value)}
            aria-label="起始日期"
          />
        </label>
        <label className="aic-tr-label">
          止
          <input
            type="date"
            className="aic-tr-date"
            value={dateTo}
            onChange={(event) => setDateTo(event.target.value)}
            aria-label="截止日期"
          />
        </label>
        <label className="aic-tr-label">
          班级：
          <select
            className="aic-tr-select"
            value={classFilter}
            onChange={(event) => setClassFilter(event.target.value)}
            aria-label="选择班级"
          >
            <option value={ALL_CLASSES}>📍 我绑定的全部班级</option>
            {classes.map((className) => (
              <option key={className} value={className}>
                {className}
              </option>
            ))}
          </select>
        </label>
        <input
          className="aic-tr-search"
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          placeholder="搜索学生姓名 / 场景…"
        />
        <span className="aic-tr-count">共 {filteredReports.length} 份报告</span>
      </div>

      {/* 统计卡片（数据大屏 5 卡，随筛选联动）：口径同旧版 renderStats */}
      <div className="aic-tr-stat-cards">
        {statCards.map((card) => (
          <div
            key={card.label}
            className={`aic-glass aic-tr-stat-card${card.focus ? ' focus' : ''}`}
          >
            <div className="aic-tr-num aic-tr-hl-num">{card.value}</div>
            <div className="aic-tr-lbl"><span className="aic-txt-hl">{card.label}</span></div>
          </div>
        ))}
      </div>

      {loadError ? (
        <Alert variant="destructive" className="mb-4">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription className="flex items-center justify-between gap-3">
            {classesQuery.isError ? '班级列表' : '测评报告'}加载失败，请稍后重试。
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void classesQuery.refetch();
                void reportsQuery.refetch();
              }}
            >
              <RefreshCw className="h-3.5 w-3.5" />
              重试
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {reportsQuery.isLoading ? <LoadingSkeleton rows={3} /> : null}

      <div className="aic-tr-table-wrap">
        {/* 表头（固定在顶部，不参与滚动） */}
        <table className="aic-tr-table-head">
          <thead>
            <tr>
              <th>学生姓名</th><th>测评场景</th><th>总分</th><th>阳性项目数</th>
              <th>危机信号</th><th>状态</th><th>提交时间</th><th>操作</th>
            </tr>
          </thead>
        </table>
        {/* 滚动容器（只包 tbody，滚动条从表头下方开始） */}
        <div className="aic-tr-scroll-list">
          <table className="aic-tr-table-body">
            <tbody>
              {latestReports.map((report) => {
                const id = reportId(report);
                const level = riskLevel(report);
                return (
                  <tr
                    key={id || `${report.student_id}-${report.created_at}`}
                    className={
                      level === 'high' ? 'row-focus' : level === 'watch' ? 'row-watch' : 'row-ok'
                    }
                  >
                    <td><span className="aic-txt-hl">{report.student_name}</span></td>
                    <td><span className="aic-txt-hl">{scenarioName(report.scenario)}</span></td>
                    <td><span className="aic-txt-hl">{report.total_score != null ? report.total_score : '-'}</span></td>
                    <td>
                      <span className="aic-txt-hl">
                        {(report.positive_count ?? report.pos_item_count) != null
                          ? (report.positive_count ?? report.pos_item_count)
                          : '-'}
                      </span>
                    </td>
                    <td>
                      {report.crisis
                        ? <span className="aic-tr-tag-crisis">⚠️ 有</span>
                        : <span className="aic-tr-tag-ok">无</span>}
                    </td>
                    <td>
                      <span
                        className={
                          level === 'high'
                            ? 'aic-tr-tag-status focus'
                            : level === 'watch'
                              ? 'aic-tr-tag-status watch'
                              : 'aic-tr-tag-status ok'
                        }
                      >
                        {level === 'high' ? '重点关注' : level === 'watch' ? '需关注' : '正常'}
                      </span>
                    </td>
                    <td><span className="aic-txt-hl">{formatTimestamp(report.created_at)}</span></td>
                    <td>
                      <button
                        type="button"
                        className="aic-tr-btn-view"
                        disabled={!id}
                        onClick={() =>
                          router.push(`/teacher/report/detail/${encodeURIComponent(id)}`)
                        }
                      >
                        查看报告
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {!reportsQuery.isLoading && latestReports.length === 0 ? (
          <p className="aic-tr-empty-tip">所选时间范围内暂无学生提交测评报告。</p>
        ) : null}
      </div>

      {/* 因子偏向柱状图：标题随统计天数联动（旧版 dayLabel + renderChart） */}
      <FactorBiasChart title={`${dayLabel(days)}内偏向各个因子的人数`} bars={factorBars} />
    </AppShell>
  );
}

export default function TeacherReportsPage() {
  return (
    <AuthGuard role="teacher">
      <TeacherReportsContent />
    </AuthGuard>
  );
}
