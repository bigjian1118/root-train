import { Activity, AlertTriangle, BarChart3, Gauge, ListChecks } from 'lucide-react';

import { StatCard } from '@/components/business/stat-card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { CRISIS_HOTLINE } from '@/lib/scoring';
import type { Scl90Scores } from '@/lib/types';
import { cn } from '@/lib/utils';

interface ReportScorePanelProps {
  scores: Scl90Scores;
  className?: string;
}

function severityVariant(code: number): 'success' | 'info' | 'warning' | 'destructive' | 'secondary' {
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

/** 测评结果概览：核心指标 + 最高因子 + 危机信号红色提示。 */
export function ReportScorePanel({ scores, className }: ReportScorePanelProps) {
  const crisisQuestions = Object.keys(scores.危机信号 ?? {});
  const factors = Object.entries(scores.因子分 ?? {});
  const topFactor = factors[0];

  return (
    <div className={cn('space-y-4', className)}>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard title="总分" value={scores.总分} description="90 题合计分" icon={BarChart3} tone="primary" />
        <StatCard title="总均分" value={scores.总均分.toFixed(2)} description="总分 / 90" icon={Gauge} />
        <StatCard
          title="阳性项目数"
          value={scores.阳性项目数}
          description="单项得分 ≥ 3 的题数"
          icon={ListChecks}
          tone={scores.阳性项目数 > 0 ? 'warning' : 'default'}
        />
        <StatCard
          title="阳性症状均分"
          value={scores.阳性症状均分.toFixed(2)}
          description="阳性题目的平均分"
          icon={Activity}
          tone={scores.阳性症状均分 >= 3 ? 'danger' : 'default'}
        />
      </div>

      {topFactor ? (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-brand-sky/30 bg-brand-sky/10 px-4 py-3 text-sm">
          <span className="text-muted-foreground">最需关注的因子：</span>
          <span className="font-medium">{topFactor[0]}</span>
          <Badge variant={severityVariant(topFactor[1].严重程度代码)}>
            {topFactor[1].严重程度} · 均分 {topFactor[1].均分.toFixed(2)}
          </Badge>
          <span className="text-xs text-muted-foreground">（按常模 Z 分数排序的第一项）</span>
        </div>
      ) : null}

      {crisisQuestions.length > 0 ? (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>检测到危机信号</AlertTitle>
          <AlertDescription className="space-y-2">
            <p>部分预警题目得分较高，请尽快联系学校心理老师或专业机构，你并不孤单。</p>
            <p className="whitespace-pre-line font-medium">{CRISIS_HOTLINE}</p>
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
