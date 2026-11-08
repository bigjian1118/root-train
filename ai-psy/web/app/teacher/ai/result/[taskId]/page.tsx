'use client';

import {
  AlertTriangle, FileDown, Loader2, RefreshCw, Save, Sparkles,
} from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { AuthGuard } from '@/components/business/auth-guard';
import { DetailPageShell } from '@/components/business/detail-page-shell';
import { EmptyState } from '@/components/business/empty-state';
import { MarkdownText } from '@/components/business/markdown-text';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { useToast } from '@/components/ui/toast';
import { ApiError, getJson, postJson } from '@/lib/api';
import type { MaterialAiTaskState } from '@/lib/types';

const STATUS_TEXT: Record<string, string> = {
  queued: '任务已排队，等待生成…',
  recalling: '正在检索校内存量素材…',
  generating: '大模型整合生成方案中（约 1-2 分钟）…',
  saving: '整理生成结果…',
};

const TERMINAL = ['completed', 'failed', 'cancelled', 'timeout'];

function AiResultContent() {
  const params = useParams<{ taskId: string }>();
  const taskId = decodeURIComponent(params.taskId ?? '');
  const router = useRouter();
  const { toast } = useToast();

  const [task, setTask] = useState<MaterialAiTaskState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const pollRef = useRef<number | null>(null);

  const fetchOnce = async () => {
    try {
      const state = await getJson<MaterialAiTaskState>(
        `/api/teacher/materials/ai/task/${encodeURIComponent(taskId)}`,
      );
      setTask(state);
      setLoadError(null);
      return state;
    } catch (caught) {
      if (caught instanceof ApiError && (caught.status === 404)) {
        setLoadError('not_found');
      } else if (caught instanceof ApiError && caught.status === 403) {
        setLoadError('forbidden');
      } else {
        setLoadError('error');
      }
      return null;
    }
  };

  // 进入即拉一次；未结束任务 2s 轮询（支持刷新/新标签页直达）。
  useEffect(() => {
    if (!taskId) {
      return;
    }
    void fetchOnce().then((state) => {
      if (state && !TERMINAL.includes(state.status)) {
        pollRef.current = window.setInterval(async () => {
          const next = await fetchOnce();
          if (next && TERMINAL.includes(next.status) && pollRef.current) {
            window.clearInterval(pollRef.current);
            pollRef.current = null;
          }
        }, 2000);
      }
    });
    return () => {
      if (pollRef.current) {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await postJson(`/api/teacher/materials/ai/task/${taskId}/save`);
      toast({ title: '已保存到素材库', description: '已按方案类型自动归类并打上 AI生成 标签。', variant: 'success' });
      void fetchOnce();
    } catch (caught) {
      toast({
        title: '保存失败',
        description: caught instanceof ApiError ? caught.message : '网络异常，请稍后重试',
        variant: 'destructive',
      });
    } finally {
      setSaving(false);
    }
  };

  if (loadError === 'not_found') {
    return (
      <AuthGuard role="teacher">
        <DetailPageShell title="AI 生成方案" fallbackHref="/teacher/materials">
          <EmptyState
            icon={<AlertTriangle className="h-5 w-5" />}
            title="任务不存在"
            description="该生成任务可能已被清理，请返回素材库重新发起生成。"
            action={<Link href="/teacher/materials" className={buttonVariants()}>返回素材库</Link>}
          />
        </DetailPageShell>
      </AuthGuard>
    );
  }
  if (loadError === 'forbidden') {
    return (
      <AuthGuard role="teacher">
        <DetailPageShell title="AI 生成方案" fallbackHref="/teacher/materials">
          <EmptyState
            icon={<AlertTriangle className="h-5 w-5" />}
            title="权限不足"
            description="只能查看自己发起的生成任务。"
            action={<Link href="/teacher/materials" className={buttonVariants()}>返回素材库</Link>}
          />
        </DetailPageShell>
      </AuthGuard>
    );
  }

  const running = task != null && !TERMINAL.includes(task.status);

  return (
    <AuthGuard role="teacher">
      <DetailPageShell
        title={task ? `AI 生成方案 · ${task.plan_type}` : 'AI 生成方案'}
        description={task ? `任务编号 ${taskId}` : undefined}
        fallbackHref="/teacher/materials"
        actions={task?.saved_material_id ? (
          <Link href="/teacher/materials" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            已入素材库
          </Link>
        ) : null}
        footer={task?.status === 'completed' ? (
          <>
            <Button variant="outline" onClick={() => router.push('/teacher/materials')}>
              <RefreshCw className="h-4 w-4" />
              重新生成
            </Button>
            <Button variant="outline"
              onClick={() => window.open(`/api/teacher/materials/ai/task/${taskId}/download`, '_blank')}>
              <FileDown className="h-4 w-4" />
              下载 .docx
            </Button>
            <Button onClick={() => void handleSave()} disabled={saving || Boolean(task.saved_material_id)}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              {task.saved_material_id ? '已保存到素材库' : '保存到素材库'}
            </Button>
          </>
        ) : null}
      >
        {!task && loadError !== 'error' ? (
          <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            正在加载任务…
          </div>
        ) : null}

        {loadError === 'error' ? (
          <Alert variant="destructive">
            <AlertDescription className="flex items-center justify-between gap-3">
              任务状态加载失败
              <Button variant="outline" size="sm" onClick={() => void fetchOnce()}>
                <RefreshCw className="h-3.5 w-3.5" />
                重新加载
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}

        {task && running ? (
          <Card>
            <CardContent className="space-y-4 p-8">
              <p className="flex items-center gap-2 text-sm font-medium">
                <Sparkles className="h-4 w-4 text-brand-skyDeep" />
                {STATUS_TEXT[task.status] ?? '处理中…'}
              </p>
              <Progress value={task.progress} />
              <p className="text-xs text-muted-foreground">
                进度 {task.progress}% · 已召回素材 {task.recall_count || '检索中'} 份
              </p>
            </CardContent>
          </Card>
        ) : null}

        {task && ['failed', 'timeout', 'cancelled'].includes(task.status) ? (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription className="flex items-center justify-between gap-3">
              {task.error_message ?? (task.status === 'cancelled' ? '任务已取消' : '生成失败，请重试')}
              <Button variant="outline" size="sm" onClick={() => router.push('/teacher/materials')}>
                返回重新发起
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}

        {task?.status === 'completed' && task.content ? (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="success">生成完成</Badge>
              <Badge variant="info">引用素材 {task.referenced_materials.length} 份</Badge>
            </div>
            {task.referenced_materials.length > 0 ? (
              <p className="text-xs leading-5 text-muted-foreground">
                参考：{task.referenced_materials.slice(0, 8).map((item) => item.title).join('、')}
                {task.referenced_materials.length > 8 ? ' 等' : ''}
              </p>
            ) : null}
            <Card>
              <CardContent className="p-6">
                <MarkdownText content={task.content} />
              </CardContent>
            </Card>
          </div>
        ) : null}
      </DetailPageShell>
    </AuthGuard>
  );
}

export default function AiResultPage() {
  return <AiResultContent />;
}
