'use client';

import {
  AlertTriangle, ChevronRight, FileText, Loader2, RefreshCw,
  Sparkles, Video,
} from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { AuthGuard } from '@/components/business/auth-guard';
import { DetailPageShell } from '@/components/business/detail-page-shell';
import { EmptyState } from '@/components/business/empty-state';
import { FactorRadar } from '@/components/business/factor-radar';
import { LoadingSkeleton } from '@/components/business/loading-skeleton';
import { MarkdownText } from '@/components/business/markdown-text';
import { ReportScorePanel } from '@/components/business/report-score-panel';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { ApiError, getJson, postJson } from '@/lib/api';
import type {
  FaceReportDetail, Scl90Scores, TextReportDetail,
} from '@/lib/types';
import { formatTimestamp } from '@/lib/utils';

type RiskLevel = 'high' | 'watch' | 'normal';

const RISK_LABELS: Record<RiskLevel, string> = {
  high: '高危', watch: '需关注', normal: '正常',
};

const RISK_BADGE_VARIANTS: Record<RiskLevel, 'destructive' | 'warning' | 'success'> = {
  high: 'destructive', watch: 'warning', normal: 'success',
};

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
  }
  return [];
}

/** 风险分级口径与教师列表页一致：危机信号或总分>300 高危，>200 需关注。 */
function riskFromScores(scores: Scl90Scores | undefined): RiskLevel {
  if (!scores) {
    return 'normal';
  }
  const crisisCount = Object.keys(scores.危机信号 ?? {}).length;
  if (crisisCount > 0 || (scores.总分 ?? 0) > 300) {
    return 'high';
  }
  if ((scores.总分 ?? 0) > 200) {
    return 'watch';
  }
  return 'normal';
}

function severityVariant(code: number): 'success' | 'info' | 'warning' | 'destructive' {
  if (code >= 3) {
    return 'destructive';
  }
  if (code === 2) {
    return 'warning';
  }
  if (code === 1) {
    return 'info';
  }
  return 'success';
}

interface AiAnalysisResponse {
  ok?: boolean;
  analysis?: { ai_content?: string };
}

function ReportDetailContent() {
  const params = useParams<{ id: string }>();
  const id = decodeURIComponent(params.id ?? '');
  const { toast } = useToast();
  const [generatedContent, setGeneratedContent] = useState('');
  const [generating, setGenerating] = useState(false);

  const detailQuery = useQuery({
    queryKey: ['teacher', 'report-detail', id],
    queryFn: () => getJson<TextReportDetail>(`/api/teacher/report/${encodeURIComponent(id)}`),
    enabled: Boolean(id),
  });
  const detail = detailQuery.data;
  const studentId = detail?.student_id ?? '';

  const faceQuery = useQuery({
    queryKey: ['teacher', 'student-face-reports', studentId],
    queryFn: () =>
      getJson<unknown>(`/api/teacher/student/${encodeURIComponent(studentId)}/face-reports`),
    enabled: Boolean(studentId),
  });

  const faceReports = pickArray<FaceReportDetail>(faceQuery.data, 'reports');
  const latestFace = faceReports[0];
  const faceMetrics = latestFace?.metrics;
  const factors = detail ? Object.entries(detail.scores?.因子分 ?? {}) : [];
  const aiContent = generatedContent || detail?.ai_content || detail?.report || '';
  const level = riskFromScores(detail?.scores);

  const handleGenerateAnalysis = async () => {
    if (!studentId) {
      toast({ title: '缺少学生标识，无法生成综合分析', variant: 'destructive' });
      return;
    }
    setGenerating(true);
    try {
      const response = await postJson<AiAnalysisResponse>('/api/ai/analysis', {
        student_id: studentId,
        text_report_id: id,
        video_report_id: latestFace?.id ?? latestFace?.video_report_id,
      });
      const content = response.analysis?.ai_content ?? '';
      if (!content) {
        throw new Error('AI 未返回有效内容');
      }
      setGeneratedContent(content);
      toast({ title: 'AI 综合分析已生成', variant: 'success' });
    } catch (error) {
      toast({
        title: '生成失败',
        description: error instanceof Error ? error.message : '网络异常，请稍后重试',
        variant: 'destructive',
      });
    } finally {
      setGenerating(false);
    }
  };

  const titleNode = detail ? (
    <span className="flex flex-wrap items-center gap-2">
      学生个人报告 · {detail.student_name}
      <Badge variant={RISK_BADGE_VARIANTS[level]}>{RISK_LABELS[level]}</Badge>
    </span>
  ) : '学生个人报告';

  return (
    <DetailPageShell
      title={titleNode}
      description={detail
        ? `提交时间 ${formatTimestamp(detail.created_at ?? detail.submitted_at ?? detail.submit_timestamp)} · 报告编号 ${id}`
        : undefined}
      fallbackHref="/teacher/reports"
      actions={studentId ? (
        <Link
          href={`/teacher/intervention?student=${encodeURIComponent(studentId)}`}
          className={buttonVariants({ variant: 'outline', size: 'sm' })}
        >
          <Sparkles className="h-4 w-4" />
          <span className="hidden sm:inline">干预建议</span>
        </Link>
      ) : null}
      footer={detail ? (
        <Button onClick={() => void handleGenerateAnalysis()} disabled={generating}>
          {generating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
          {generating ? '生成中…' : '生成 AI 综合分析'}
        </Button>
      ) : null}
    >
      {detailQuery.isLoading ? <LoadingSkeleton rows={4} /> : null}

      {detailQuery.isError ? (
        (detailQuery.error instanceof ApiError && detailQuery.error.status === 404) ? (
          <EmptyState
            icon={<FileText className="h-5 w-5" />}
            title="报告不存在或已删除"
            description="该报告可能已被学生删除，请返回列表确认。"
            action={
              <Link href="/teacher/reports" className={buttonVariants()}>返回列表</Link>
            }
          />
        ) : (detailQuery.error instanceof ApiError && detailQuery.error.status === 403) ? (
          <EmptyState
            icon={<AlertTriangle className="h-5 w-5" />}
            title="权限不足"
            description="仅可查看自己负责班级的学生报告。"
            action={
              <Link href="/teacher/reports" className={buttonVariants()}>返回列表</Link>
            }
          />
        ) : (
          <Alert variant="destructive">
            <AlertDescription className="flex items-center justify-between gap-3">
              报告详情加载失败
              <Button variant="outline" size="sm" onClick={() => void detailQuery.refetch()}>
                <RefreshCw className="h-3.5 w-3.5" />
                重新加载
              </Button>
            </AlertDescription>
          </Alert>
        )
      ) : null}

      {detail ? (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge variant="outline">{detail.student_id}</Badge>
            <Badge variant="secondary">{detail.class ?? detail.student_class ?? '—'}</Badge>
            <span className="text-xs text-muted-foreground">
              {detail.scenario_name || detail.crowd_tag || 'SCL-90 测评'}
            </span>
          </div>

          <ReportScorePanel scores={detail.scores} />

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">因子雷达</CardTitle>
              </CardHeader>
              <CardContent>
                <FactorRadar scores={detail.scores} height={280} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Video className="h-4 w-4 text-primary" />
                  视频状态摘要
                </CardTitle>
              </CardHeader>
              <CardContent>
                {faceQuery.isLoading ? (
                  <p className="text-sm text-muted-foreground">加载中…</p>
                ) : latestFace ? (
                  <div className="space-y-3">
                    <div className="grid grid-cols-2 gap-2 text-sm">
                      <div className="rounded-lg bg-brand-sky/10 p-3">
                        <p className="text-xs text-muted-foreground">最近检测</p>
                        <p className="mt-1 font-medium">
                          {formatTimestamp(latestFace.created_at ?? latestFace.submitted_at)}
                        </p>
                      </div>
                      <div className="rounded-lg bg-brand-sky/10 p-3">
                        <p className="text-xs text-muted-foreground">主要表情</p>
                        <p className="mt-1 font-medium">
                          {faceMetrics?.dominant_emotion || latestFace.dominant_emotion || '—'}
                        </p>
                      </div>
                      <div className="rounded-lg bg-brand-sky/10 p-3">
                        <p className="text-xs text-muted-foreground">人脸帧 / 总帧</p>
                        <p className="mt-1 font-medium">
                          {faceMetrics?.face_frames ?? 0} / {faceMetrics?.total_frames ?? 0}
                        </p>
                      </div>
                      <div className="rounded-lg bg-brand-sky/10 p-3">
                        <p className="text-xs text-muted-foreground">历史检测次数</p>
                        <p className="mt-1 font-medium">{faceReports.length}</p>
                      </div>
                    </div>
                    {latestFace.report ? (
                      <p className="line-clamp-4 text-sm leading-6 text-muted-foreground">
                        {latestFace.report}
                      </p>
                    ) : null}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">该学生暂无视频状态报告。</p>
                )}
              </CardContent>
            </Card>
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between gap-3">
              <p className="text-sm font-medium">因子明细</p>
              <span className="text-xs text-muted-foreground">
                {detail.scenario_name || 'SCL-90 因子'}
              </span>
            </div>
            <Card>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>因子</TableHead>
                      <TableHead>均分</TableHead>
                      <TableHead>常模均值</TableHead>
                      <TableHead>标准差倍数</TableHead>
                      <TableHead>严重程度</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {factors.map(([name, factor]) => (
                      <TableRow key={name}>
                        <TableCell className="font-medium">{name}</TableCell>
                        <TableCell>{factor.均分.toFixed(2)}</TableCell>
                        <TableCell className="text-muted-foreground">
                          {factor.常模均值.toFixed(2)}
                        </TableCell>
                        <TableCell>{factor.标准差倍数.toFixed(2)}</TableCell>
                        <TableCell>
                          <Badge variant={severityVariant(factor.严重程度代码)}>
                            {factor.严重程度}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <Sparkles className="h-4 w-4 text-primary" />
                AI 综合解读
              </CardTitle>
            </CardHeader>
            <CardContent>
              {aiContent ? (
                <MarkdownText content={aiContent} />
              ) : (
                <p className="text-sm text-muted-foreground">
                  暂无 AI 解读，可点击底部「生成 AI 综合分析」。
                </p>
              )}
            </CardContent>
          </Card>

          <div className="flex justify-end">
            <Link
              href="/teacher/reports"
              className={buttonVariants({ variant: 'ghost' })}
            >
              返回班级列表
              <ChevronRight className="h-4 w-4" />
            </Link>
          </div>
        </div>
      ) : null}
    </DetailPageShell>
  );
}

export default function TeacherReportDetailPage() {
  return (
    <AuthGuard role="teacher">
      <ReportDetailContent />
    </AuthGuard>
  );
}
