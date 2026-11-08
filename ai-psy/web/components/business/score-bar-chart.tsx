'use client';

import * as echarts from 'echarts';
import type { EChartsOption } from 'echarts';
import { useEffect, useMemo, useRef } from 'react';

import type { Scl90Scores } from '@/lib/types';
import { cn } from '@/lib/utils';

import { severityColor } from './factor-radar';

interface ScoreBarChartProps {
  scores: Scl90Scores;
  height?: number;
  className?: string;
}

function chartTextColor(): string {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--chart-text').trim();
  return raw ? `hsl(${raw})` : '#334155';
}

/** 因子均分 vs 中国常模均值，便于一眼看出偏离项。 */
export function ScoreBarChart({ scores, height = 360, className }: ScoreBarChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<ReturnType<typeof echarts.init> | null>(null);

  const factors = useMemo(
    () =>
      Object.entries(scores.因子分 ?? {}).map(([name, factor]) => ({
        name,
        average: factor.均分,
        norm: factor.常模均值,
        severityCode: factor.严重程度代码,
      })),
    [scores],
  );

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
      grid: { left: 18, right: 18, top: 44, bottom: 56, containLabel: true },
      legend: {
        top: 8,
        right: 8,
        itemWidth: 12,
        itemHeight: 8,
        textStyle: { color: textColor, fontSize: 11 },
        data: ['因子均分', '常模均值'],
      },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        backgroundColor: 'rgba(43, 74, 94, 0.92)',
        borderWidth: 0,
        textStyle: { color: '#f8fafc', fontSize: 12 },
      },
      xAxis: {
        type: 'category',
        data: factors.map((factor) => factor.name),
        axisLabel: { color: textColor, fontSize: 11, interval: 0, rotate: 32 },
        axisLine: { lineStyle: { color: 'rgba(126, 200, 242, 0.4)' } },
        axisTick: { show: false },
      },
      yAxis: {
        type: 'value',
        max: 5,
        axisLabel: { color: textColor, fontSize: 11 },
        splitLine: { lineStyle: { color: 'rgba(126, 200, 242, 0.25)' } },
        axisLine: { lineStyle: { color: 'rgba(126, 200, 242, 0.4)' } },
      },
      series: [
        {
          name: '因子均分',
          type: 'bar',
          barMaxWidth: 18,
          data: factors.map((factor) => ({
            value: factor.average,
            itemStyle: { color: severityColor(factor.severityCode), borderRadius: [4, 4, 0, 0] },
          })),
        },
        {
          name: '常模均值',
          type: 'bar',
          barMaxWidth: 18,
          data: factors.map((factor) => factor.norm),
          itemStyle: { color: 'rgba(126, 200, 242, 0.65)', borderRadius: [4, 4, 0, 0] },
        },
      ],
    };
    chart.setOption(option, true);
  }, [factors]);

  if (factors.length === 0) {
    return <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">暂无因子数据</div>;
  }

  return <div ref={containerRef} className={cn('w-full', className)} style={{ height }} />;
}
