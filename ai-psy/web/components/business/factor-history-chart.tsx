'use client';

import * as echarts from 'echarts';
import type { EChartsOption } from 'echarts';
import { useEffect, useRef } from 'react';

import { cn } from '@/lib/utils';

interface FactorHistoryPoint {
  submit_time: number;
  total_score: number | null;
  factors: Record<string, number | null>;
}

interface FactorHistoryChartProps {
  factorNames: string[];
  history: FactorHistoryPoint[];
  height?: number;
  className?: string;
}

const FACTOR_COLORS = [
  '#3a9bd8', '#52c41a', '#faad14', '#f5222d', '#722ed1',
  '#13c2c2', '#fa8c16', '#eb2f96', '#a0d911', '#2f54eb',
];

function formatTime(ts: number): string {
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${m}-${day}`;
}

export function FactorHistoryChart({
  factorNames, history, height = 320, className,
}: FactorHistoryChartProps) {
  const chartRef = useRef<HTMLDivElement>(null);
  const instanceRef = useRef<echarts.ECharts | null>(null);

  useEffect(() => {
    if (!chartRef.current) {
      return;
    }
    const chart = echarts.init(chartRef.current);
    instanceRef.current = chart;

    const xAxisData = history.map((p) => formatTime(p.submit_time));
    const series = factorNames.map((name, idx) => ({
      name,
      type: 'line' as const,
      smooth: true,
      symbol: 'circle',
      symbolSize: 6,
      lineStyle: { width: 2 },
      data: history.map((p) => p.factors[name] ?? null),
      itemStyle: { color: FACTOR_COLORS[idx % FACTOR_COLORS.length] },
      emphasis: { focus: 'series' as const },
    }));

    const option: EChartsOption = {
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'cross' },
      },
      legend: {
        type: 'scroll',
        bottom: 0,
        textStyle: { fontSize: 11 },
      },
      grid: { left: 40, right: 20, top: 20, bottom: 50 },
      xAxis: {
        type: 'category',
        data: xAxisData,
        boundaryGap: false,
        axisLabel: { fontSize: 11 },
      },
      yAxis: {
        type: 'value',
        min: 0,
        max: 5,
        axisLabel: { fontSize: 11 },
        splitLine: { lineStyle: { type: 'dashed' } },
      },
      series,
    };
    chart.setOption(option);

    const handleResize = () => chart.resize();
    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
      chart.dispose();
      instanceRef.current = null;
    };
  }, [factorNames, history]);

  if (history.length === 0) {
    return (
      <div className={cn('flex items-center justify-center text-sm text-muted-foreground', className)}
        style={{ height }}>
        该学生暂无历史测评数据，无法绘制趋势图。
      </div>
    );
  }

  return <div ref={chartRef} className={className} style={{ width: '100%', height }} />;
}
