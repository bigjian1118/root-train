'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import { AppShell } from '@/components/business/app-shell';
import { FactorRadar } from '@/components/business/factor-radar';
import { LoadingSkeleton } from '@/components/business/loading-skeleton';
import { MarkdownText } from '@/components/business/markdown-text';
import { ReportScorePanel } from '@/components/business/report-score-panel';
import { ScoreBarChart } from '@/components/business/score-bar-chart';
import { CRISIS_HOTLINE } from '@/lib/scoring';
import type { StoredScl90Report } from '@/lib/types';
import { formatTimestamp } from '@/lib/utils';

// 1:1 复刻旧版 static/report.html + report.css 学生整合视图：
// 居中渐变标题 + 元信息 + 危机红框 + 292px 左信息栏 + 右内容区（因子横条/AI 解读）+ 底部导出 PDF；
// 雷达图、常模对比、热线提示为已确认新增模块，内容与逻辑保持不变。

const STORAGE_KEY = 'scl90_report';

const PAGE_CLASS = 'mx-auto min-h-screen px-[24px] pb-[70px] pt-[20px]';
const HEAD_NAV_CLASS = 'mb-[16px] flex flex-wrap items-center gap-[12px]';

// 因子横条分级：与旧版 report.js sevClass 一致（代码≥3 重点、≥1 需关注、其余正常）
function factorSevClass(code: number): string {
  if (code >= 3) {
    return 'bad';
  }
  if (code >= 1) {
    return 'warn';
  }
  return '';
}

/** 因子分横条列表：数值与宽度公式照抄旧版 report.js（(均分-1)/4，下限 4%）。 */
function FactorBars({ scores }: { scores: StoredScl90Report['scores'] }) {
  const factors = Object.entries(scores.因子分 ?? {});
  if (factors.length === 0) {
    return null;
  }
  return (
    <div className="aic-report-bars">
      {factors.map(([name, factor]) => {
        const pct = Math.max(4, Math.min(100, ((factor.均分 - 1) / 4) * 100));
        const cls = factorSevClass(factor.严重程度代码);
        return (
          <div key={name} className="aic-report-bar-row">
            <span className="aic-report-bar-name aic-txt-hl">{name}</span>
            <div className="aic-report-bar-track">
              <div
                className={`aic-report-bar-fill${cls ? ` ${cls}` : ''}`}
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className="aic-report-bar-val aic-txt-hl">
              <b className={cls}>{factor.均分.toFixed(2)}</b> 常模
              {factor.常模均值.toFixed(2)} · Z={factor.标准差倍数.toFixed(2)} · {factor.严重程度}
            </span>
          </div>
        );
      })}
    </div>
  );
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

function ReportContent({ report }: { report: StoredScl90Report }) {
  const time = report.submitted_at ? formatTimestamp(report.submitted_at) : '';
  return (
    <AppShell role="student" pageClassName={PAGE_CLASS} headNavClassName={HEAD_NAV_CLASS}>
      {/* 旧版角色徽章位于 head-nav 右侧，AppShell 容器不可插入，按既有方案右对齐呈现 */}
      <div className="aic-report-role-row">
        <span className="aic-role-chip role-student">🙋 我的整合报告</span>
      </div>

      <h1 className="aic-report-title">专属测评报告</h1>
      <p className="aic-report-meta">
        测评人群：{report.scenario_name || '通用'}　|　提交时间：{time}
        {report.report_id ? `　|　报告编号：${report.report_id}` : ''}
      </p>

      {report.has_crisis && report.crisis_message ? (
        <div className="aic-report-crisis-box">{report.crisis_message}</div>
      ) : null}

      <div className="aic-report-grid">
        <aside className="aic-glass aic-report-info-side">
          <div className="aic-report-info-rows">
            <div className="aic-report-info-row">
              <span className="ik">测评人群</span>
              <span className="iv">{report.scenario_name || '—'}</span>
            </div>
            <div className="aic-report-info-row">
              <span className="ik">提交时间</span>
              <span className="iv">{time || '—'}</span>
            </div>
            {report.report_id ? (
              <div className="aic-report-info-row">
                <span className="ik">报告编号</span>
                <span className="iv">{report.report_id}</span>
              </div>
            ) : null}
            <div className="aic-report-info-row">
              <span className="ik">状态</span>
              <span className="iv">{report.has_crisis ? '存在危机信号' : '已完成'}</span>
            </div>
          </div>
          <hr className="aic-grad-divider" style={{ alignSelf: 'stretch' }} />
          <div className="flex w-full flex-col gap-3" style={{ marginTop: 14 }}>
            <Link href="/test" className="aic-btn aic-btn-primary">
              再测一次
            </Link>
            <Link href="/student/reports" className="aic-btn aic-btn-ghost">
              查看历史报告
            </Link>
          </div>
        </aside>

        <div className="aic-report-main">
          <ReportScorePanel scores={report.scores} />

          <section className="aic-report-chart-panel">
            <span className="aic-report-legend">
              <span>
                <i className="lg-green" />
                正常
              </span>
              <span>
                <i className="lg-gold" />
                需关注
              </span>
              <span>
                <i className="lg-orange" />
                重点
              </span>
            </span>
            <h4>十个因子得分范围与严重程度</h4>
            <FactorBars scores={report.scores} />
          </section>

          {/* 新增模块保持：因子雷达与常模对比 */}
          <section className="grid gap-4 lg:grid-cols-2">
            <div className="aic-report-chart-panel">
              <h4>因子雷达</h4>
              <p className="aic-report-panel-desc">
                数值为各因子均分，越靠外表示主观困扰越明显。
              </p>
              <FactorRadar scores={report.scores} height={320} />
            </div>
            <div className="aic-report-chart-panel">
              <h4>与常模对比</h4>
              <p className="aic-report-panel-desc">
                柱状图对比你的因子均分与中国常模均值。
              </p>
              <ScoreBarChart scores={report.scores} height={320} />
            </div>
          </section>

          <section>
            <h2 className="aic-report-h2">AI 个性化解读</h2>
            {report.report?.trim() || report.ai_content?.trim() ? (
              <div className="aic-report-text">
                <MarkdownText
                  content={report.report?.trim() ? report.report : (report.ai_content ?? '')}
                />
              </div>
            ) : (
              <div className="aic-report-text">本次暂未生成文字解读，可稍后在报告中心查看。</div>
            )}
          </section>

          {/* 新增模块保持：求助热线提示 */}
          <section className="aic-glass aic-report-notice">
            <p className="aic-report-notice-title">需要帮助时请及时求助</p>
            <p className="whitespace-pre-line">{CRISIS_HOTLINE}</p>
            <p className="aic-report-disclaimer">
              本报告由自评量表生成，不是医学诊断，也不能替代心理咨询或精神科评估。
              若近期持续感到痛苦、失眠或出现伤害自己的想法，请立即联系信任的老师、家人或专业机构。
            </p>
          </section>
        </div>
      </div>

      <div className="aic-report-actions">
        {/* 旧版导出 PDF：浏览器打印，样式由 report.css @media print 口径处理 */}
        <button type="button" className="aic-btn aic-btn-ghost" onClick={() => window.print()}>
          导出 PDF
        </button>
      </div>
    </AppShell>
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

  if (!report) {
    // 旧版 empty-panel 文案与按钮口径（历史报告入口为新增功能，保留）
    return (
      <AppShell
        role="student"
        pageClassName={PAGE_CLASS}
        headNavClassName={HEAD_NAV_CLASS}
      >
        <section className="aic-empty-panel">
          <h1 className="aic-report-title">暂无测评结果</h1>
          <p className="sub">报告数据不存在或已过期，请先完成一次心理测评。</p>
          <div className="flex flex-wrap justify-center gap-3">
            <Link href="/test" className="aic-btn aic-btn-primary">
              去参加测评 →
            </Link>
            <Link href="/student/reports" className="aic-btn aic-btn-ghost">
              历史报告
            </Link>
          </div>
        </section>
      </AppShell>
    );
  }

  return <ReportContent report={report} />;
}
