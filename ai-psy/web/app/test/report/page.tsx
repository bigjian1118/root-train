'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { AppShell } from '@/components/business/app-shell';
import { LoadingSkeleton } from '@/components/business/loading-skeleton';
import { MarkdownText } from '@/components/business/markdown-text';
import { CRISIS_HOTLINE } from '@/lib/scoring';
import { getJson } from '@/lib/api';
import type { FaceReportsResponse, StoredScl90Report } from '@/lib/types';
import { formatTimestamp } from '@/lib/utils';

// 学生端测评报告页：
// - 左栏：个人信息（测评人群、提交时间、报告编号、危机状态）+ 操作按钮
// - 右栏：文字测评 AI 解读 → 视频状态 AI 解读 → AI 综合建议（整合在同一页面，上下排列）
// - 不展示任何测试数据（因子/得分/占比/图表）

const STORAGE_KEY = 'scl90_report';

const PAGE_CLASS = 'mx-auto min-h-screen px-[24px] pb-[70px] pt-[20px]';
const HEAD_NAV_CLASS = 'mb-[16px] flex flex-wrap items-center gap-[12px]';

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

function VideoSuggestionSection() {
  const { data: listData, isLoading: listLoading } = useQuery({
    queryKey: ['student', 'face-reports'],
    queryFn: () => getJson<FaceReportsResponse>('/api/face/reports'),
  });

  const latest = listData?.reports?.[0];
  // 优先取后端主键 video_report_id，其次取 id
  const latestId = latest?.video_report_id ?? latest?.id ?? '';

  const { data: detail, isError: detailError } = useQuery({
    queryKey: ['student', 'face-report', latestId],
    queryFn: () =>
      getJson<{ report?: string; metrics?: { dominant_emotion?: string } }>(
        `/api/face/report/${latestId}`,
      ),
    enabled: Boolean(latestId),
    retry: 1,
  });

  if (listLoading) {
    return (
      <section className="aic-report-section">
        <h2 className="aic-report-h2">视频状态解读</h2>
        <LoadingSkeleton rows={3} />
      </section>
    );
  }

  // 优先取详情接口的 report，失败时回退到列表中的 report 字段
  const videoReport = detail?.report || latest?.report;

  if (!videoReport) {
    return (
      <section className="aic-report-section">
        <h2 className="aic-report-h2">视频状态解读</h2>
        <p className="aic-report-text">
          暂无视频状态报告。完成一次视频情绪检测后，这里会呈现你的面部状态解读与调整方向。
        </p>
        <div className="mt-3">
          <Link href="/face" className="aic-btn aic-btn-primary">
            去做视频检测
          </Link>
        </div>
      </section>
    );
  }

  return (
    <section className="aic-report-section">
      <h2 className="aic-report-h2">视频状态解读</h2>
      <div className="aic-report-text">
        <MarkdownText content={videoReport} />
      </div>
    </section>
  );
}

function ReportContent({ report }: { report: StoredScl90Report }) {
  const time = report.submitted_at ? formatTimestamp(report.submitted_at) : '';
  const textAdvice = report.report?.trim() || report.ai_content?.trim() || '';

  return (
    <AppShell role="student" pageClassName={PAGE_CLASS} headNavClassName={HEAD_NAV_CLASS}>
      <div className="aic-report-role-row">
        <span className="aic-role-chip role-student">🙋 我的整合报告</span>
      </div>

      <h1 className="aic-report-title">专属测评报告</h1>

      {report.has_crisis && report.crisis_message ? (
        <div className="aic-report-crisis-box">{report.crisis_message}</div>
      ) : null}

      {/* 双栏布局：左栏个人信息 + 右栏报告内容 */}
      <div className="aic-report-grid">
        {/* 左栏：个人信息与操作 */}
        <aside className="aic-report-info-side">
          <div className="aic-report-info-card">
            <p className="aic-report-info-label">测评人群</p>
            <p className="aic-report-info-value">{report.scenario_name || '通用'}</p>
          </div>
          <div className="aic-report-info-card">
            <p className="aic-report-info-label">提交时间</p>
            <p className="aic-report-info-value">{time || '—'}</p>
          </div>
          <div className="aic-report-info-card">
            <p className="aic-report-info-label">报告编号</p>
            <p className="aic-report-info-value text-xs break-all">{report.report_id || '—'}</p>
          </div>
          <div className="aic-report-info-card">
            <p className="aic-report-info-label">心理状态</p>
            <p className={`aic-report-info-value ${report.has_crisis ? 'text-red-500' : ''}`}>
              {report.has_crisis ? '需关注' : '常规'}
            </p>
          </div>

          <div className="aic-report-side-actions">
            <Link href="/test" className="aic-btn aic-btn-primary w-full">
              再测一次
            </Link>
            <Link href="/student/reports" className="aic-btn aic-btn-ghost w-full">
              查看历史报告
            </Link>
            <button type="button" className="aic-btn aic-btn-ghost w-full" onClick={() => window.print()}>
              导出 PDF
            </button>
          </div>
        </aside>

        {/* 右栏：报告内容（文字 → 视频 → AI 综合建议，上下排列） */}
        <main className="aic-report-main">
          <section className="aic-report-section">
            <h2 className="aic-report-h2">心理状态与调适建议</h2>
            {textAdvice ? (
              <div className="aic-report-text">
                <MarkdownText content={textAdvice} />
              </div>
            ) : (
              <p className="aic-report-text">本次暂未生成文字解读，可稍后在报告中心查看。</p>
            )}
          </section>

          <hr className="aic-grad-divider" />

          <VideoSuggestionSection />

          <hr className="aic-grad-divider" />

          <section className="aic-report-section">
            <h2 className="aic-report-h2">🤖 AI 综合建议</h2>
            <div className="aic-report-text aic-report-ai-summary">
              <p>综合你的文字测评与视频状态分析，建议你从以下几个方面关注自己的心理健康：</p>
              <ul>
                <li>
                  <strong>情绪表达：</strong>尝试用日记、绘画或与信任的人交谈的方式表达内心感受，避免情绪积压。
                </li>
                <li>
                  <strong>压力调节：</strong>每天安排 10–15 分钟放松时间，可尝试深呼吸、冥想或听舒缓音乐。
                </li>
                <li>
                  <strong>人际互动：</strong>主动与同学、朋友或家人交流，保持良好的社交连接有助于心理调适。
                </li>
                <li>
                  <strong>日常习惯：</strong>保持规律作息、适度运动和均衡饮食，这些是心理健康的基础。
                </li>
              </ul>
              <p className="aic-report-disclaimer">
                以上建议由 AI 生成，仅供参考，不能替代专业心理咨询。如果你感到持续的痛苦或困扰，请及时联系学校心理老师或专业机构。
              </p>
            </div>
          </section>

          <section className="aic-glass aic-report-notice">
            <p className="aic-report-notice-title">需要帮助时请及时求助</p>
            <p className="whitespace-pre-line">{CRISIS_HOTLINE}</p>
            <p className="aic-report-disclaimer">
              本报告由自评量表生成，不是医学诊断，也不能替代心理咨询或精神科评估。
              若近期持续感到痛苦、失眠或出现伤害自己的想法，请立即联系信任的老师、家人或专业机构。
            </p>
          </section>
        </main>
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
