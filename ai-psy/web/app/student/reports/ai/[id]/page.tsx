'use client';

import { ArrowLeft, RefreshCw } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { AuthGuard } from '@/components/business/auth-guard';
import { AppShell } from '@/components/business/app-shell';
import { LoadingSkeleton } from '@/components/business/loading-skeleton';
import { MarkdownText } from '@/components/business/markdown-text';
import { Button } from '@/components/ui/button';
import { useAuthStore } from '@/store/use-auth-store';
import { ApiError, getJson, postJson } from '@/lib/api';
import { CRISIS_HOTLINE } from '@/lib/scoring';
import type {
  AiAnalysis,
  AiAnalysisDetailResponse,
  AiAnalysisRetryResponse,
  AnalysesResponse,
} from '@/lib/types';
import { formatTimestamp } from '@/lib/utils';

// 综合报告详情轮询间隔：生成中每 3s 同步一次，完成后自动停止
const STATUS_POLL_MS = 3000;

// 与学生端专属报告页保持同一版式（全屏左右分栏）
const PAGE_CLASS = 'min-h-screen px-0 pb-0 pt-[12px]';
const HEAD_NAV_CLASS = 'mb-[12px] flex flex-wrap items-center gap-[12px] px-[24px]';

function analysisId(analysis: AiAnalysis): string {
  return String(analysis.seq_id ?? analysis.id ?? '');
}

function analysisDate(analysis: AiAnalysis): number | null | undefined {
  return analysis.created_at ?? analysis.create_timestamp;
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="aic-report-info-row">
      <span className="ik">{label}</span>
      <span className="iv">{value}</span>
    </div>
  );
}

/** 生成中 / 生成失败占位卡片：学生端只说明状态与后续动作 */
function StatusPanel({
  failed,
  errorText,
  retrying,
  onRetry,
  onRefresh,
}: {
  failed: boolean;
  errorText: string;
  retrying: boolean;
  onRetry: () => void;
  onRefresh: () => void;
}) {
  return (
    <section className="aic-glass aic-rpt-card" style={{ textAlign: 'center', padding: '40px 24px' }}>
      {failed ? (
        <>
          <h2 style={{ fontSize: 20, fontWeight: 700, color: '#b03a34', marginBottom: 10 }}>
            ⚠️ 综合报告生成失败
          </h2>
          <p style={{ fontSize: 13.5, color: '#5b7688', marginBottom: 14 }}>
            报告未生成完成，可点击「重新生成」再次尝试。
          </p>
          {errorText ? (
            <p style={{ fontSize: 13, color: '#b03a34', marginBottom: 16 }}>{errorText}</p>
          ) : null}
          <div style={{ display: 'flex', justifyContent: 'center', gap: 12 }}>
            <button type="button" className="aic-btn aic-btn-primary" onClick={onRetry} disabled={retrying}>
              {retrying ? '正在重新提交…' : '重新生成'}
            </button>
            <button type="button" className="aic-btn aic-btn-ghost" onClick={onRefresh}>
              刷新状态
            </button>
          </div>
        </>
      ) : (
        <>
          <span className="aic-spinner" style={{ margin: '0 auto 18px' }} />
          <h2 style={{ fontSize: 20, fontWeight: 700, color: '#2b4a5e', marginBottom: 10 }}>
            AI 综合报告生成中…
          </h2>
          <p style={{ fontSize: 13.5, color: '#5b7688', lineHeight: 1.9 }}>
            系统正在融合文本测评与视频情绪数据，生成过程在后台运行，
            <br />
            你可以关闭或切换页面，稍后回到这里即可查看结果。
          </p>
        </>
      )}
    </section>
  );
}

function AiReportDetailContent() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const user = useAuthStore((state) => state.user);

  const reportId = decodeURIComponent(params.id ?? '');

  const handleBack = () => {
    const hasHistory = typeof window !== 'undefined' && (window.history.state?.idx ?? 0) > 0;
    if (hasHistory) {
      router.back();
      return;
    }
    router.replace('/student/reports');
  };

  const detailQuery = useQuery({
    queryKey: ['student', 'ai-analysis', reportId],
    queryFn: () => getJson<AiAnalysisDetailResponse>(
      `/api/ai/analysis/${encodeURIComponent(reportId)}`,
    ),
    enabled: Boolean(reportId),
    refetchOnMount: 'always',
    // 生成中持续同步状态，完成/失败后自动停止
    refetchInterval: (query) => (
      query.state.data?.analysis.status === 'processing' ? STATUS_POLL_MS : false
    ),
  });

  // 历史综合报告：左侧列表切换，与文本/视频报告详情页交互一致
  const historyQuery = useQuery({
    queryKey: ['student', 'ai-analyses'],
    queryFn: () => getJson<AnalysesResponse>('/api/ai/analyses'),
    refetchOnMount: 'always',
  });

  const analysis = detailQuery.data?.analysis;
  const status = analysis?.status ?? 'completed';
  const processing = status === 'processing' || status === 'pending';
  const failed = status === 'failed';
  const history = historyQuery.data?.analyses ?? [];

  const handleRetry = async () => {
    try {
      await postJson<AiAnalysisRetryResponse>('/api/ai/analysis/retry', {
        report_id: Number(reportId),
      });
      await detailQuery.refetch();
      await queryClient.invalidateQueries({ queryKey: ['student', 'ai-analyses'] });
    } catch {
      await detailQuery.refetch();
    }
  };

  const handleSelectHistory = (id: string) => {
    if (!id || id === reportId) {
      return;
    }
    router.push(`/student/reports/ai/${encodeURIComponent(id)}`);
  };

  const generatedAt = analysis
    ? formatTimestamp(analysis.finished_at ?? analysisDate(analysis))
    : '';

  const renderBody = () => {
    if (detailQuery.isLoading) {
      return <LoadingSkeleton rows={6} />;
    }
    if (detailQuery.isError) {
      const notFoundOrForbidden = detailQuery.error instanceof ApiError
        && (detailQuery.error.status === 404 || detailQuery.error.status === 403);
      return (
        <section className="aic-empty-panel">
          <h1 className="aic-report-title">{notFoundOrForbidden ? '报告不可查看' : '报告加载失败'}</h1>
          <p className="sub">
            {detailQuery.error instanceof ApiError
              ? detailQuery.error.message
              : '网络异常，请稍后重试。'}
          </p>
          <div className="flex flex-wrap justify-center gap-3">
            <button type="button" className="aic-btn aic-btn-primary" onClick={() => void detailQuery.refetch()}>
              重新加载
            </button>
            <Link href="/student/reports" className="aic-btn aic-btn-ghost">
              返回报告中心
            </Link>
          </div>
        </section>
      );
    }
    if (!analysis) {
      return null;
    }
    if (processing || failed) {
      return (
        <StatusPanel
          failed={failed}
          errorText={analysis.error_message || ''}
          retrying={false}
          onRetry={() => void handleRetry()}
          onRefresh={() => void detailQuery.refetch()}
        />
      );
    }
    return (
      <section
        className="aic-glass aic-rpt-card"
        style={{ borderLeft: '5px solid #3a9bd8', borderRadius: '0 18px 18px 0' }}
      >
        <h2 className="aic-report-h2">🌿 综合状态解读与调适建议</h2>
        <div className="aic-report-text aic-rpt-advice">
          <MarkdownText content={analysis.ai_content} />
        </div>
        <div className="aic-rpt-notice-bar">
          <p className="aic-rpt-notice-title">需要帮助时请及时求助</p>
          <p className="whitespace-pre-line">{CRISIS_HOTLINE}</p>
          <p>本报告为 AI 辅助生成，仅供参考，不能替代专业心理诊断与治疗。</p>
        </div>
      </section>
    );
  };

  return (
    <div className="aic-rpt-full">
      {/* 左侧：基础信息 + 综合报告历史记录（无额外操作按钮） */}
      <aside className="aic-rpt-side aic-glass">
        <div className="aic-report-info-rows">
          <InfoRow label="姓名" value={user?.name || '—'} />
          <InfoRow label="性别" value="—" />
          <InfoRow label="年龄" value="—" />
          <InfoRow label="身份" value="学生" />
          <InfoRow label="班级" value={user?.class || '—'} />
          <InfoRow label="生成时间" value={generatedAt || '—'} />
        </div>

        <hr className="aic-grad-divider" style={{ alignSelf: 'stretch' }} />

        <h3 style={{ fontSize: 15, color: '#5b7688', alignSelf: 'flex-start', marginBottom: 8 }}>
          综合报告记录
        </h3>
        <ul className="aic-report-history-list">
          {history.length === 0 ? (
            <li className="h-empty">暂无综合报告</li>
          ) : (
            history.map((item: AiAnalysis, index: number) => {
              const id = analysisId(item);
              const ts = analysisDate(item);
              const day = ts ? formatTimestamp(ts).slice(0, 10) : '';
              const itemStatus = item.status ?? 'completed';
              const locked = itemStatus !== 'completed';
              return (
                <li key={id}>
                  <button
                    type="button"
                    className={id === reportId ? 'h-item active' : 'h-item'}
                    onClick={() => handleSelectHistory(id)}
                    disabled={locked}
                    title={
                      itemStatus === 'processing'
                        ? '报告生成中，完成后可查看'
                        : itemStatus === 'failed'
                          ? (item.error_message || '生成失败，可重新生成')
                          : undefined
                    }
                  >
                    <span className="h-date">{day}</span>
                    {itemStatus === 'processing' ? (
                      <span className="h-score" style={{ color: '#3a9bd8', fontSize: 12 }}>生成中</span>
                    ) : itemStatus === 'failed' ? (
                      <span className="h-score" style={{ color: '#d9534f', fontSize: 12 }}>生成失败</span>
                    ) : (
                      <span className="h-score" style={{ color: '#3a9bd8', fontSize: 12 }}>已完成</span>
                    )}
                    {index === 0 && itemStatus === 'completed' ? <span className="h-new">NEW</span> : null}
                  </button>
                </li>
              );
            })
          )}
        </ul>
      </aside>

      {/* 右侧：标题栏 + 学生版综合解读 */}
      <div className="aic-rpt-body">
        <section>
          <div className="aic-rpt-titleline" style={{ position: 'relative', justifyContent: 'center' }}>
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
            <h1 style={{ color: '#2f7d52', fontSize: 24 }}>AI 综合分析报告</h1>
          </div>
          <p className="aic-rpt-subline">
            报告类型：文本 + 视频双模态综合 | 生成时间：{generatedAt || '—'}
            {analysis ? ` | 报告编号：${reportId}` : ''}
          </p>
        </section>

        {renderBody()}
      </div>
    </div>
  );
}

export default function StudentAiReportDetailPage() {
  return (
    <AuthGuard role="student">
      <AppShell role="student" pageClassName={PAGE_CLASS} headNavClassName={HEAD_NAV_CLASS}>
        <AiReportDetailContent />
      </AppShell>
    </AuthGuard>
  );
}
