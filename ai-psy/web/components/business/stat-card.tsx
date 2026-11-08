import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';

type StatTone = 'default' | 'primary' | 'warning' | 'danger';

// 数值配色对齐旧版 report.css：关键数字黄 hl-num / 预警柔橙 / 危险红，图标胶囊浅蓝底
const TONE_STYLES: Record<StatTone, { icon: string; value: string }> = {
  default: { icon: 'bg-brand-sky/15 text-brand-skyDeep', value: 'text-brand-hlNum' },
  primary: { icon: 'bg-brand-sky/15 text-brand-skyDeep', value: 'text-brand-skyDeep' },
  warning: { icon: 'bg-brand-gold/40 text-[#b08a1e]', value: 'text-brand-focusOrange' },
  danger: { icon: 'bg-destructive/10 text-destructive', value: 'text-destructive' },
};

interface StatCardProps {
  title: string;
  value: ReactNode;
  description?: string;
  icon?: LucideIcon;
  tone?: StatTone;
  className?: string;
}

export function StatCard({
  title,
  value,
  description,
  icon: Icon,
  tone = 'default',
  className,
}: StatCardProps) {
  const styles = TONE_STYLES[tone];

  return (
    <Card className={cn('overflow-hidden', className)}>
      <CardContent className="flex items-start gap-4 p-5">
        {Icon ? (
          <span className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-pill', styles.icon)}>
            <Icon className="h-5 w-5" />
          </span>
        ) : null}
        <div className="min-w-0">
          <p className="text-xs font-medium tracking-wide text-muted-foreground">{title}</p>
          <p className={cn('mt-1 text-2xl font-semibold tracking-tight', styles.value)}>{value}</p>
          {description ? (
            <p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
