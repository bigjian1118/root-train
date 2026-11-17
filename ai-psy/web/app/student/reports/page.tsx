'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  CalendarDays,
  ChevronDown,
  ChevronUp,
  FileText,
  Loader2,
  RefreshCw,
  Sparkles,
  Trash2,
  Video,
} from 'lucide-react';
import Link from 'next/link';
import { useState, useEffect } from 'react';

import { AppShell } from '@/components/business/app-shell';
import { AuthGuard } from '@/components/business/auth-guard';
import { EmptyState } from '@/components/business/empty-state';
import { LoadingSkeleton } from '@/components/business/loading-skeleton';
import { MarkdownText } from '@/components/business/markdown-text';
import { PageHeader } from '@/components/business/page-header';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useToast } from '@/components/ui/toast';
import { ApiError, del, getJson, postJson } from '@/lib/api';
import { clearReportUnread } from '@/lib/report-notice';
import type {
  AiAnalysis,
  AiAnalysisRetryResponse,
  AnalysesResponse,
  FaceReportDetail,
  FaceReportSummary,
  FaceReportsResponse,
  ReportsResponse,
  TextReportDetail,
  TextReportSummary,
} from '@/lib/types';
import { formatTimestamp, formatShortDate } from '@/lib/utils';

const PAGE_SIZE = 6;
const STORAGE_LIST_LIMIT = 60;
// 列表里存在生成中报告时的刷新间隔
const LIST_POLL_MS = 8000;

const SCENARIO_LABELS: Record<string, string> = {
  primary_student: '小学生',
  junior_student: '中学生',
  college_student: '大学生',
};

type RowKind = 'text' | 'video';

interface DeleteTarget {
  kind: RowKind;
  id: string;
  label: string;
}

function textId(report: TextReportSummary): string {
  return report.id ?? report.report_id ?? '';
}

function videoId(report: FaceReportSummary): string {
  return report.id ?? report.video_report_id ?? '';
}

function analysisId(analysis: AiAnalysis): string {
  return String(analysis.seq_id ?? analysis.id ?? '');
}

function textDate(report: TextReportSummary): number | null | undefined {
  return report.created_at ?? report.submit_timestamp;
}

function faceDate(report: FaceReportSummary): number | null | undefined {
  return report.created_at ?? report.create_timestamp;
}

function aiDate(analysis: AiAnalysis): number | null | undefined {
  return analysis.created_at ?? analysis.create_timestamp;
}

function reportScenarioLabel(report: TextReportSummary): string {
  const key = report.scenario;
  if (key && SCENARIO_LABELS[key]) {
    return SCENARIO_LABELS[key];
  }
  return report.crowd_tag ?? '文字测评';
}

function hasCrisis(report: TextReportSummary): boolean {
  return Boolean(report.risk_signal ?? report.crisis);
}

/** 列表内是否仍有后台生成中的报告；用于决定是否继续轮询。 */
function hasProcessing(items: { status?: string }[] | undefined): boolean {
  return (items ?? []).some(
    (item) => item.status === 'processing' || item.status === 'pending',
  );
}

function TextDetailPanel({ reportId }: { reportId: string }) {
  const query = useQuery({
    queryKey: ['student', 'report', reportId],
    queryFn: () => getJson<TextReportDetail>(`/api/student/report/${reportId}`),
    enabled: Boolean(reportId),
  });

  if (query.isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-52 w-full" />
      </div>
    );
  }
  if (query.isError) {
    return (
      <Alert variant="destructive">
        <AlertDescription className="flex items-center justify-between gap-3">
          详情加载失败
          <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
            重试
          </Button>
        </AlertDescription>
      </Alert>
    );
  }
  const detail = query.data;
  if (!detail || !detail.scores) {
    return <p className="text-sm text-muted-foreground">该报告缺少因子数据。</p>;
  }

  return (
    <div className="space-y-4">
      {/* 学生端不展示得分/因子等测试数据，仅展示 AI 解读建议 */}
      {detail.report ? (
        <div>
          <p className="mb-2 text-sm font-medium">心理状态调适建议</p>
          <MarkdownText content={detail.report} />
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">本次暂无文字解读。</p>
      )}
    </div>
  );
}

function FaceDetailPanel({ reportId }: { reportId: string }) {
  const query = useQuery({
    queryKey: ['student', 'face-report', reportId],
    queryFn: () => getJson<FaceReportDetail>(`/api/face/report/${reportId}`),
    enabled: Boolean(reportId),
  });

  if (query.isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  if (query.isError) {
    return (
      <Alert variant="destructive">
        <AlertDescription className="flex items-center justify-between gap-3">
          详情加载失败
          <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
            重试
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-4">
      {/* 学生端不展示表情占比等测试数据，仅展示 AI 状态解读 */}
      {query.data?.report ? (
        <div>
          <p className="mb-2 text-sm font-medium">视频状态解读</p>
          <MarkdownText content={query.data.report} />
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">本次暂无视频状态解读。</p>
      )}
    </div>
  );
}

function ExpandedPanel({ detailKey }: { detailKey: string }) {
  const [kind, id] = detailKey.split(':');
  if (!id) {
    return null;
  }
  return (
    <div className="mt-4 rounded-xl border border-border/70 bg-muted/20 p-4">
      {kind === 'text' ? <TextDetailPanel reportId={id} /> : null}
      {kind === 'video' ? <FaceDetailPanel reportId={id} /> : null}
    </div>
  );
}

function TextReportCard({
  report,
  expanded,
  onToggle,
  onDelete,
}: {
  report: TextReportSummary;
  expanded: boolean;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const id = textId(report);
  const crisis = hasCrisis(report);
  // 异步生成：未完成的报告不提供详情入口
  const status = report.status ?? 'completed';
  const locked = status !== 'completed';
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle className="text-base">{reportScenarioLabel(report)}</CardTitle>
            {status === 'processing' ? (
              <Badge variant="info">生成中</Badge>
            ) : status === 'failed' ? (
              <Badge variant="destructive">生成失败</Badge>
            ) : (
              <Badge variant={crisis ? 'destructive' : 'success'}>{crisis ? '危机信号' : '平稳'}</Badge>
            )}
          </div>
          <CardDescription className="mt-1 flex items-center gap-1.5">
            <CalendarDays className="h-3.5 w-3.5" />
            {formatTimestamp(textDate(report))}
          </CardDescription>
        </div>
        <div className="flex shrink-0 gap-1">
          <Button variant="ghost" size="sm" onClick={onToggle} disabled={locked}>
            {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            {status === 'processing' ? '生成中' : status === 'failed' ? '失败' : expanded ? '收起' : '详情'}
          </Button>
          <Button variant="ghost" size="sm" onClick={onDelete} disabled={!id} aria-label="删除报告">
            <Trash2 className="h-4 w-4 text-destructive" />
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {/* 学生端不展示测试数据（得分/因子/占比），仅展示基本信息与危机状态 */}
        <p className="text-sm text-muted-foreground">
          {status === 'processing'
            ? '报告正在后台生成，完成后即可查看，您可以先去做其他事情。'
            : status === 'failed'
              ? (report.error_message || '报告生成失败，请重新完成一次测评。')
              : '点击「详情」查看你的心理状态调适建议。'}
        </p>
        {!locked && expanded && id ? <ExpandedPanel detailKey={`text:${id}`} /> : null}
      </CardContent>
    </Card>
  );
}

function VideoReportCard({
  report,
  expanded,
  onToggle,
  onDelete,
}: {
  report: FaceReportSummary;
  expanded: boolean;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const id = videoId(report);
  // 异步生成：未完成的视频报告不提供详情入口
  const status = report.status ?? 'completed';
  const locked = status !== 'completed';
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle className="text-base">视频状态检测</CardTitle>
            {status === 'processing' ? (
              <Badge variant="info">生成中</Badge>
            ) : status === 'failed' ? (
              <Badge variant="destructive">生成失败</Badge>
            ) : report.prominent_dimension || report.top_factor ? (
              <Badge variant="info">{report.prominent_dimension ?? report.top_factor}</Badge>
            ) : null}
          </div>
          <CardDescription className="mt-1 flex items-center gap-1.5">
            <CalendarDays className="h-3.5 w-3.5" />
            {formatTimestamp(faceDate(report))}
          </CardDescription>
        </div>
        <div className="flex shrink-0 gap-1">
          <Button variant="ghost" size="sm" onClick={onToggle} disabled={locked}>
            {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            {status === 'processing' ? '生成中' : status === 'failed' ? '失败' : expanded ? '收起' : '详情'}
          </Button>
          <Button variant="ghost" size="sm" onClick={onDelete} disabled={!id} aria-label="删除视频报告">
            <Trash2 className="h-4 w-4 text-destructive" />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* 学生端不展示表情占比数据，仅提示查看详情 */}
        <p className="text-sm text-muted-foreground">
          {status === 'processing'
            ? '视频报告正在后台生成，完成后即可查看。'
            : status === 'failed'
              ? (report.error_message || '视频分析失败，请重新录制一段视频。')
              : '点击「详情」查看视频状态解读与调整方向。'}
        </p>
        {!locked && expanded && id ? <ExpandedPanel detailKey={`video:${id}`} /> : null}
      </CardContent>
    </Card>
  );
}

function AiAnalysisCard({
  analysis,
  retrying,
  onRetry,
}: {
  analysis: AiAnalysis;
  retrying: boolean;
  onRetry: () => void;
}) {
  const id = analysisId(analysis);
  const status = analysis.status ?? 'completed';
  const processing = status === 'processing' || status === 'pending';
  const failed = status === 'failed';
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle className="text-base">AI 综合分析</CardTitle>
            {processing ? (
              <Badge variant="info">生成中</Badge>
            ) : failed ? (
              <Badge variant="destructive">生成失败</Badge>
            ) : (
              <Badge variant="success">已完成</Badge>
            )}
          </div>
          <CardDescription className="mt-1 flex items-center gap-1.5">
            <CalendarDays className="h-3.5 w-3.5" />
            {formatTimestamp(aiDate(analysis))}
            {analysis.text_report_id ? ' · 关联文字测评' : ''}
            {analysis.video_report_id ? ' · 关联视频报告' : ''}
          </CardDescription>
        </div>
        {processing ? (
          <Button variant="ghost" size="sm" disabled>
            <Loader2 className="h-4 w-4 animate-spin" />
            生成中
          </Button>
        ) : failed ? (
          // 失败兜底：复用原归档行重跑，不新增记录
          <Button variant="ghost" size="sm" onClick={onRetry} disabled={retrying}>
            {retrying ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            重新生成
          </Button>
        ) : (
          <Link
            href={`/student/reports/ai/${encodeURIComponent(id)}`}
            className={buttonVariants({ variant: 'ghost', size: 'sm' })}
          >
            查看详情
          </Link>
        )}
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">
          {processing
            ? 'AI 综合报告正在后台生成，完成后可查看通俗版解读与调适建议。'
            : failed
              ? (analysis.error_message || '生成失败，可点击「重新生成」再次尝试。')
              : '点击「查看详情」阅读双模态综合解读与调适建议。'}
        </p>
      </CardContent>
    </Card>
  );
}

function ReportsContent() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [tab, setTab] = useState<'text' | 'video' | 'ai'>('text');
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [retryingAiId, setRetryingAiId] = useState('');
  // 最后一份报告生成完成后，后端还需创建综合报告任务：
  // 保留一小段轮询窗口，避免刚好错过创建瞬间而要重新进页面才看到
  const [aiGracePoll, setAiGracePoll] = useState(false);

  // 进入报告中心即视为已读，清除侧边栏新报告红点
  useEffect(() => {
    clearReportUnread();
  }, []);

  // 进入页面强制刷新，保证列表状态与后端一致；有生成中报告时继续轮询
  const textQuery = useQuery({
    queryKey: ['student', 'reports'],
    queryFn: () => getJson<ReportsResponse>('/api/student/reports'),
    refetchOnMount: 'always',
    refetchInterval: (query) => (hasProcessing(query.state.data?.reports) ? LIST_POLL_MS : false),
  });
  const videoQuery = useQuery({
    queryKey: ['student', 'face-reports'],
    queryFn: () => getJson<FaceReportsResponse>('/api/face/reports'),
    refetchOnMount: 'always',
    refetchInterval: (query) => (hasProcessing(query.state.data?.reports) ? LIST_POLL_MS : false),
  });
  const aiQuery = useQuery({
    queryKey: ['student', 'ai-analyses'],
    queryFn: () => getJson<AnalysesResponse>('/api/ai/analyses'),
    // 进入页面强制刷新，保证与后端生成状态一致；
    // 综合报告生成中、或双报告刚完成时继续轮询
    refetchOnMount: 'always',
    refetchInterval: (query) => (
      hasProcessing(query.state.data?.analyses) || aiGracePoll ? LIST_POLL_MS : false
    ),
  });

  // 双报告任一在生成 → 保持窗口；最后一份完成后延长 3 个轮询周期再停止
  useEffect(() => {
    if (!textQuery.data || !videoQuery.data) {
      return;
    }
    if (hasProcessing(textQuery.data.reports) || hasProcessing(videoQuery.data.reports)) {
      setAiGracePoll(true);
      return;
    }
    const timer = setTimeout(() => setAiGracePoll(false), LIST_POLL_MS * 3);
    return () => clearTimeout(timer);
  }, [textQuery.data, videoQuery.data]);

  const textReports = (textQuery.data?.reports ?? []).slice(0, STORAGE_LIST_LIMIT);
  const videoReports = (videoQuery.data?.reports ?? []).slice(0, STORAGE_LIST_LIMIT);
  const analyses = (aiQuery.data?.analyses ?? []).slice(0, STORAGE_LIST_LIMIT);

  const toggleExpanded = (key: string) => {
    setExpandedKey((current) => (current === key ? null : key));
  };

  const switchTab = (value: string) => {
    setTab(value as 'text' | 'video' | 'ai');
    setExpandedKey(null);
    setVisibleCount(PAGE_SIZE);
  };

  const handleDelete = async () => {
    if (!deleteTarget) {
      return;
    }
    setDeleting(true);
    try {
      const path =
        deleteTarget.kind === 'text'
          ? `/api/student/report/${deleteTarget.id}`
          : `/api/face/report/${deleteTarget.id}`;
      await del<{ ok: boolean }>(path);
      await queryClient.invalidateQueries({
        queryKey: deleteTarget.kind === 'text' ? ['student', 'reports'] : ['student', 'face-reports'],
      });
      if (expandedKey?.endsWith(deleteTarget.id)) {
        setExpandedKey(null);
      }
      toast({ title: '已删除', description: `${deleteTarget.label}已从报告中心移除`, variant: 'success' });
      setDeleteTarget(null);
    } catch (error) {
      toast({
        title: '删除失败',
        description: error instanceof ApiError ? error.message : '网络异常，请稍后重试',
        variant: 'destructive',
      });
    } finally {
      setDeleting(false);
    }
  };

  /** 综合报告失败重跑：后端复用原归档行，前端只刷新状态 */
  const handleRetryAnalysis = async (id: string) => {
    if (!id) {
      return;
    }
    setRetryingAiId(id);
    try {
      await postJson<AiAnalysisRetryResponse>('/api/ai/analysis/retry', {
        report_id: Number(id),
      });
      await queryClient.invalidateQueries({ queryKey: ['student', 'ai-analyses'] });
      toast({ title: '已重新提交', description: 'AI 综合报告正在后台重新生成', variant: 'success' });
    } catch (error) {
      toast({
        title: '重新生成失败',
        description: error instanceof ApiError ? error.message : '网络异常，请稍后重试',
        variant: 'destructive',
      });
    } finally {
      setRetryingAiId('');
    }
  };

  const renderError = (queryError: boolean, retry: () => void) =>
    queryError ? (
      <Alert variant="destructive" className="mb-4">
        <AlertDescription className="flex items-center justify-between gap-3">
          列表加载失败，请稍后重试。
          <Button variant="outline" size="sm" onClick={retry}>
            <RefreshCw className="h-3.5 w-3.5" />
            重试
          </Button>
        </AlertDescription>
      </Alert>
    ) : null;

  const renderTextTab = () => {
    if (textQuery.isLoading) {
      return <LoadingSkeleton rows={3} />;
    }
    if (textQuery.isError) {
      return null;
    }
    if (textReports.length === 0) {
      return (
        <EmptyState
          icon={<FileText className="h-5 w-5" />}
          title="暂无文字测评报告"
          description="完成 SCL-90 测评后，报告会自动归档到这里。"
          action={
            <Link href="/test" className={buttonVariants()}>
              去完成测评
            </Link>
          }
        />
      );
    }
    return (
      <>
        <div className="space-y-3">
          {textReports.slice(0, visibleCount).map((report) => {
            const id = textId(report);
            const key = `text:${id}`;
            return (
              <TextReportCard
                key={key}
                report={report}
                expanded={expandedKey === key}
                onToggle={() => toggleExpanded(key)}
                onDelete={() =>
                  setDeleteTarget({
                    kind: 'text',
                    id,
                    label: `${reportScenarioLabel(report)}测评 ${formatShortDate(textDate(report))}`,
                  })
                }
              />
            );
          })}
        </div>
        {textReports.length > visibleCount ? (
          <div className="mt-4 text-center">
            <Button variant="outline" onClick={() => setVisibleCount((count) => count + PAGE_SIZE)}>
              加载更多
            </Button>
          </div>
        ) : null}
      </>
    );
  };

  const renderVideoTab = () => {
    if (videoQuery.isLoading) {
      return <LoadingSkeleton rows={3} />;
    }
    if (videoQuery.isError) {
      return null;
    }
    if (videoReports.length === 0) {
      return (
        <EmptyState
          icon={<Video className="h-5 w-5" />}
          title="暂无视频状态报告"
          description="上传一段短视频后，系统会生成表情与动作状态摘要。"
          action={
            <Link href="/face" className={buttonVariants()}>
              去视频检测
            </Link>
          }
        />
      );
    }
    return (
      <>
        <div className="space-y-3">
          {videoReports.slice(0, visibleCount).map((report) => {
            const id = videoId(report);
            const key = `video:${id}`;
            return (
              <VideoReportCard
                key={key}
                report={report}
                expanded={expandedKey === key}
                onToggle={() => toggleExpanded(key)}
                onDelete={() =>
                  setDeleteTarget({
                    kind: 'video',
                    id,
                    label: `视频状态报告 ${formatShortDate(faceDate(report))}`,
                  })
                }
              />
            );
          })}
        </div>
        {videoReports.length > visibleCount ? (
          <div className="mt-4 text-center">
            <Button variant="outline" onClick={() => setVisibleCount((count) => count + PAGE_SIZE)}>
              加载更多
            </Button>
          </div>
        ) : null}
      </>
    );
  };

  const renderAiTab = () => {
    if (aiQuery.isLoading) {
      return <LoadingSkeleton rows={3} />;
    }
    if (aiQuery.isError) {
      return null;
    }
    if (analyses.length === 0) {
      return (
        <EmptyState
          icon={<Sparkles className="h-5 w-5" />}
          title="暂无 AI 综合报告"
          description="完成文本测评与视频检测后，系统会自动生成 AI 综合报告，无需手动操作。"
        />
      );
    }
    return (
      <>
        <div className="space-y-3">
          {analyses.slice(0, visibleCount).map((analysis) => {
            const id = analysisId(analysis);
            return (
              <AiAnalysisCard
                key={`ai:${id}`}
                analysis={analysis}
                retrying={retryingAiId === id}
                onRetry={() => void handleRetryAnalysis(id)}
              />
            );
          })}
        </div>
        {analyses.length > visibleCount ? (
          <div className="mt-4 text-center">
            <Button variant="outline" onClick={() => setVisibleCount((count) => count + PAGE_SIZE)}>
              加载更多
            </Button>
          </div>
        ) : null}
      </>
    );
  };

  return (
    <AppShell role="student">
      <PageHeader
        eyebrow="报告中心"
        title="你的心理状态档案"
        description="文字测评、视频状态与 AI 综合分析统一归档。点击卡片可展开详情，敏感数据仅你与授权老师可见。"
        actions={
          <Link href="/test" className={buttonVariants({ size: 'sm' })}>
            新的测评
          </Link>
        }
      />

      <Tabs value={tab} onValueChange={switchTab}>
        <TabsList className="grid w-full grid-cols-3">
          <TabsTrigger value="text">文字测评</TabsTrigger>
          <TabsTrigger value="video">视频状态</TabsTrigger>
          <TabsTrigger value="ai">AI 综合分析</TabsTrigger>
        </TabsList>

        <TabsContent value="text" className="mt-4">
          {renderError(textQuery.isError, () => void textQuery.refetch())}
          {renderTextTab()}
        </TabsContent>
        <TabsContent value="video" className="mt-4">
          {renderError(videoQuery.isError, () => void videoQuery.refetch())}
          {renderVideoTab()}
        </TabsContent>
        <TabsContent value="ai" className="mt-4">
          {renderError(aiQuery.isError, () => void aiQuery.refetch())}
          {renderAiTab()}
        </TabsContent>
      </Tabs>

      <Dialog open={Boolean(deleteTarget)} onOpenChange={(open) => (!open ? setDeleteTarget(null) : null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" />
              确认删除报告？
            </DialogTitle>
            <DialogDescription>
              将删除「{deleteTarget?.label}」及其关联的 AI 解读，删除后不可恢复。确定要继续吗？
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)} disabled={deleting}>
              取消
            </Button>
            <Button variant="destructive" onClick={() => void handleDelete()} disabled={deleting}>
              {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              确认删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppShell>
  );
}

export default function StudentReportsPage() {
  return (
    <AuthGuard role="student">
      <ReportsContent />
    </AuthGuard>
  );
}
