'use client';

import {
  AlertTriangle, ChevronRight, FileText, RefreshCw, Sparkles, Video,
} from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';

import { AuthGuard } from '@/components/business/auth-guard';
import { DetailPageShell } from '@/components/business/detail-page-shell';
import { EmptyState } from '@/components/business/empty-state';
import { FactorHistoryChart } from '@/components/business/factor-history-chart';
import { FactorRadar } from '@/components/business/factor-radar';
import { LoadingSkeleton } from '@/components/business/loading-skeleton';
import { MarkdownText } from '@/components/business/markdown-text';
import { ReportScorePanel } from '@/components/business/report-score-panel';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { ApiError, getJson } from '@/lib/api';
import type {
  FaceReportDetail, FactorHistoryPoint, Scl90Scores, TextReportDetail, VideoAuMetric,
} from '@/lib/types';
import { formatTimestamp } from '@/lib/utils';

type RiskLevel = 'high' | 'watch' | 'normal';

const RISK_LABELS: Record<RiskLevel, string> = {
  high: '高危', watch: '需关注', normal: '正常',
};

const RISK_BADGE_VARIANTS: Record<RiskLevel, 'destructive' | 'warning' | 'success'> = {
  high: 'destructive', watch: 'warning', normal: 'success',
};

const EMOTION_LABELS: Record<string, string> = {
  anger: '愤怒', disgust: '厌恶', fear: '恐惧', happiness: '快乐',
  sadness: '悲伤', surprise: '惊讶', neutral: '中性',
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

function factorPercent(avg: number): number {
  return Math.max(4, Math.min(100, ((avg - 1) / 4) * 100));
}

function ReportDetailContent() {
  const params = useParams<{ id: string }>();
  const id = decodeURIComponent(params.id ?? '');

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

  const historyQuery = useQuery({
    queryKey: ['teacher', 'factor-history', studentId],
    queryFn: () => getJson<{
      factor_names: string[];
      history: FactorHistoryPoint[];
    }>(`/api/teacher/student/${encodeURIComponent(studentId)}/factor-history`),
    enabled: Boolean(studentId),
  });

  const faceReports = pickArray<FaceReportDetail>(faceQuery.data, 'reports');
  const latestFace = faceReports[0];
  const faceMetrics = latestFace?.metrics;
  const factors = detail ? Object.entries(detail.scores?.因子分 ?? {}) : [];
  const aiContent = detail?.ai_content || detail?.report || '';
  const level = riskFromScores(detail?.scores);

  const emotions = faceMetrics?.emotions ?? latestFace?.emotions ?? {};
  const emotionEntries = Object.entries(emotions).filter(
    (entry): entry is [string, number] => typeof entry[1] === 'number',
  );
  const auEntries = Object.entries(faceMetrics?.au ?? {}).filter(
    (entry): entry is [string, VideoAuMetric] => Boolean(entry[1]),
  );

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
              <button
                type="button"
                className="inline-flex h-8 items-center rounded-md border px-3 text-xs"
                onClick={() => void detailQuery.refetch()}
              >
                <RefreshCw className="mr-1 h-3.5 w-3.5" />
                重新加载
              </button>
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

          {/* 核心指标概览 */}
          <ReportScorePanel scores={detail.scores} />

          {/* 因子雷达 + 视频摘要 */}
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

          {/* 因子历史趋势折线图 */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">各因子历史趋势（按测评时间）</CardTitle>
            </CardHeader>
            <CardContent>
              {historyQuery.isLoading ? (
                <p className="text-sm text-muted-foreground">加载中…</p>
              ) : (
                <FactorHistoryChart
                  factorNames={historyQuery.data?.factor_names ?? []}
                  history={historyQuery.data?.history ?? []}
                  height={340}
                />
              )}
            </CardContent>
          </Card>

          {/* 因子明细表（含得分与占比） */}
          <div>
            <div className="mb-2 flex items-center justify-between gap-3">
              <p className="text-sm font-medium">因子明细（得分 + 占比）</p>
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
                      <TableHead>占比</TableHead>
                      <TableHead>常模均值</TableHead>
                      <TableHead>标准差倍数</TableHead>
                      <TableHead>严重程度</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {factors.map(([name, factor]) => {
                      const pct = factorPercent(factor.均分);
                      return (
                        <TableRow key={name}>
                          <TableCell className="font-medium">{name}</TableCell>
                          <TableCell>{factor.均分.toFixed(2)}</TableCell>
                          <TableCell className="min-w-[140px]">
                            <div className="flex items-center gap-2">
                              <Progress value={pct} className="h-2 flex-1" />
                              <span className="w-10 text-right text-xs tabular-nums">
                                {pct.toFixed(0)}%
                              </span>
                            </div>
                          </TableCell>
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
                      );
                    })}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </div>

          {/* 视频情绪占比（全部六种情绪） */}
          {emotionEntries.length > 0 ? (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">视频情绪占比</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {emotionEntries.map(([key, value]) => {
                  const pct = Math.min(100, value <= 1 ? value * 100 : value);
                  return (
                    <div key={key} className="space-y-1">
                      <div className="flex justify-between text-xs">
                        <span className="text-muted-foreground">
                          {EMOTION_LABELS[key] ?? key}
                        </span>
                        <span className="tabular-nums">{pct.toFixed(1)}%</span>
                      </div>
                      <Progress value={pct} className="h-2" />
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          ) : null}

          {/* 视频 AU 激活指标 */}
          {auEntries.length > 0 ? (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">面部动作单元（AU）激活强度</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>AU</TableHead>
                      <TableHead>均值</TableHead>
                      <TableHead>最大值</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {auEntries.map(([au, metric]) => (
                      <TableRow key={au}>
                        <TableCell className="font-medium">{metric.label ?? au}</TableCell>
                        <TableCell>{metric.mean?.toFixed(3) ?? '—'}</TableCell>
                        <TableCell>{metric.max?.toFixed(3) ?? '—'}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          ) : null}

          {/* AI 综合解读（教师端仅展示已有解读，不提供生成按钮） */}
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
                <p className="text-sm text-muted-foreground">暂无 AI 综合解读。</p>
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
