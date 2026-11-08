'use client';

import * as echarts from 'echarts';
import type { EChartsOption } from 'echarts';
import { useEffect, useMemo, useRef } from 'react';

import type { Scl90Scores } from '@/lib/types';
import { cn } from '@/lib/utils';

const MAX_FACTOR_SCORE = 5;

// 严重程度色板：仅色值对齐旧版 static/css（ok=green-deep / warn=hl-num / focus=橙 / bad=danger），
// 五档与「正常/轻度/中度/重度/极重」的映射顺序保持不变
const SEVERITY_COLORS = ['#6fc297', '#3a9bd8', '#d9a520', '#e8935a', '#d9534f'];
const SEVERITY_LABELS = ['正常', '轻度', '中度', '重度', '极重'];

interface FactorRadarProps {
  scores: Scl90Scores;
  height?: number;
  showLegend?: boolean;
  className?: string;
}

interface RadarFactor {
  name: string;
  value: number;
  severityCode: number;
  severity: string;
}

function severityColor(code: number): string {
  return SEVERITY_COLORS[Math.min(Math.max(code, 0), SEVERITY_COLORS.length - 1)];
}

function chartTextColor(): string {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--chart-text').trim();
  return raw ? `hsl(${raw})` : '#334155';
}

/** 10 因子雷达图：面积颜色取最高严重程度，悬停显示每一项的均分与分级。 */
export function FactorRadar({ scores, height = 320, showLegend = true, className }: FactorRadarProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<ReturnType<typeof echarts.init> | null>(null);

  const factors = useMemo<RadarFactor[]>(
    () =>
      Object.entries(scores.因子分 ?? {}).map(([name, factor]) => ({
        name,
        value: factor.均分,
        severityCode: factor.严重程度代码,
        severity: factor.严重程度,
      })),
    [scores],
  );

  const accentColor = factors.length
    ? severityColor(Math.max(...factors.map((factor) => factor.severityCode)))
    : SEVERITY_COLORS[0];

  useEffect(() => {
    if (!containerRef.current) {
      return;
    }
    const chart = echarts.init(containerRef.current);
    chartRef.current = chart;

    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || factors.length === 0) {
      return;
    }
    const textColor = chartTextColor();
    const option: EChartsOption = {
      animationDuration: 600,
      tooltip: {
        trigger: 'item',
        backgroundColor: 'rgba(43, 74, 94, 0.92)',
        borderWidth: 0,
        textStyle: { color: '#f8fafc', fontSize: 12 },
        formatter: () =>
          factors
            .map(
              (factor) =>
                `${factor.name}：${factor.value.toFixed(2)}（${factor.severity}）`,
            )
            .join('<br/>'),
      },
      radar: {
        indicator: factors.map((factor) => ({ name: factor.name, max: MAX_FACTOR_SCORE })),
        radius: '66%',
        splitNumber: 4,
        axisName: { color: textColor, fontSize: 12 },
        axisLine: { lineStyle: { color: 'rgba(126, 200, 242, 0.4)' } },
        splitLine: { lineStyle: { color: 'rgba(126, 200, 242, 0.3)' } },
        splitArea: {
          areaStyle: {
            color: ['rgba(126, 200, 242, 0.05)', 'rgba(126, 200, 242, 0.12)'],
          },
        },
      },
      series: [
        {
          type: 'radar',
          name: '因子均分',
          symbolSize: 5,
          lineStyle: { color: accentColor, width: 2 },
          itemStyle: { color: accentColor },
          areaStyle: { color: `${accentColor}2e` },
          data: [{ value: factors.map((factor) => factor.value), name: '因子均分' }],
        },
      ],
    };
    chart.setOption(option, true);
  }, [accentColor, factors]);

  if (factors.length === 0) {
    return <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">暂无因子数据</div>;
  }

  return (
    <div className={cn('space-y-3', className)}>
      <div ref={containerRef} style={{ height, width: '100%' }} />
      {showLegend ? (
        <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground sm:grid-cols-5">
          {factors.map((factor) => (
            <span key={factor.name} className="flex items-center gap-1.5">
              <span
                className="h-2 w-2 rounded-full"
                style={{ backgroundColor: severityColor(factor.severityCode) }}
              />
              {factor.name}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export { SEVERITY_COLORS, SEVERITY_LABELS, severityColor };
