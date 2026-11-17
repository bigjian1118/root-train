// SCL-90 计分规则：必须与 server/scoring.py、旧 static/js/test.js 完全一致。
// 前端先本地计分，后端再用同一结果归档并做随机森林分级覆盖。

import type { Scl90Answers, Scl90FactorScore, Scl90Scores } from './types';

export const TOTAL_ITEMS = 90;
export const CRISIS_THRESHOLD = 4;

/** 因子 -> 题号；顺序固定，报告页兜底展示依赖此顺序。 */
export const FACTOR_MAP: Record<string, number[]> = {
  躯体化: [1, 4, 12, 27, 40, 42, 48, 49, 52, 53, 56, 58],
  强迫症状: [3, 9, 10, 28, 38, 45, 46, 51, 55, 65],
  人际关系敏感: [6, 21, 34, 36, 37, 41, 61, 69, 73],
  抑郁: [5, 14, 15, 20, 22, 26, 29, 30, 31, 32, 54, 71, 79],
  焦虑: [2, 17, 23, 33, 39, 57, 72, 78, 80, 86],
  敌对: [11, 24, 63, 67, 74, 81],
  恐怖: [13, 25, 47, 50, 70, 75, 82],
  偏执: [8, 18, 43, 68, 76, 83],
  精神病性: [7, 16, 35, 62, 77, 84, 85, 87, 88, 90],
  其他: [19, 44, 59, 60, 64, 66, 89],
};

/** 中国常模（金华等，1986）：[均值, 标准差]。 */
export const CHINA_NORM: Record<string, [number, number]> = {
  躯体化: [1.34, 0.45],
  强迫症状: [1.69, 0.61],
  人际关系敏感: [1.76, 0.67],
  抑郁: [1.57, 0.61],
  焦虑: [1.42, 0.43],
  敌对: [1.50, 0.57],
  恐怖: [1.33, 0.47],
  偏执: [1.52, 0.60],
  精神病性: [1.36, 0.47],
  其他: [1.45, 0.50],
};

/** 自杀/自伤预警题，得分 >= 4 记危机信号。 */
export const CRISIS_QUESTIONS = [15, 54, 59, 79, 89];

export const CRISIS_HOTLINE =
  '全国24小时心理援助热线：400-161-9995\n北京心理危机研究与干预中心：010-82951332';

export const LIKERT_OPTIONS: { value: number; label: string; hint: string }[] = [
  { value: 1, label: '没有', hint: '1 分' },
  { value: 2, label: '一周1~2次', hint: '2 分' },
  { value: 3, label: '一周3~4次', hint: '3 分' },
  { value: 4, label: '一周5~6次', hint: '4 分' },
  { value: 5, label: '几乎每天', hint: '5 分' },
];

const SEVERITY_LEVELS: { threshold: number; label: string; code: number }[] = [
  { threshold: 3.0, label: '极重', code: 4 },
  { threshold: 2.0, label: '重度', code: 3 },
  { threshold: 1.0, label: '中度', code: 2 },
  { threshold: 0.5, label: '轻度', code: 1 },
];

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 常模 Z 分数阈值分级（与后端 rule_severity 一致）。 */
export function ruleSeverity(zScore: number): [string, number] {
  const matched = SEVERITY_LEVELS.find((level) => zScore >= level.threshold);
  return matched ? [matched.label, matched.code] : ['正常', 0];
}

/** 按旧版规则计算总分、因子分与危机信号。 */
export function scoreScl90(answers: Scl90Answers): Scl90Scores {
  let total = 0;
  let positiveCount = 0;
  let positiveSum = 0;

  Object.values(answers).forEach((score) => {
    total += score;
    if (score >= 3) {
      positiveCount += 1;
      positiveSum += score;
    }
  });

  const factors: Record<string, Scl90FactorScore> = {};
  Object.entries(FACTOR_MAP).forEach(([name, ids]) => {
    const sum = ids.reduce((acc, id) => acc + (answers[id] ?? 0), 0);
    const avg = round2(sum / ids.length);
    const [normMean, normStd] = CHINA_NORM[name] ?? [1.5, 0.5];
    const zScore = normStd > 0 ? round2((avg - normMean) / normStd) : 0;
    const [severity, severityCode] = ruleSeverity(zScore);
    factors[name] = {
      均分: avg,
      常模均值: normMean,
      常模标准差: normStd,
      标准差倍数: zScore,
      严重程度: severity,
      严重程度代码: severityCode,
      严重程度来源: '规则',
    };
  });

  // 稳定排序：同 Z 分数保持因子定义顺序。
  const sortedFactors = Object.keys(factors)
    .sort((a, b) => factors[b].标准差倍数 - factors[a].标准差倍数)
    .reduce<Record<string, Scl90FactorScore>>((acc, name) => {
      acc[name] = factors[name];
      return acc;
    }, {});

  const crisis: Record<string, number> = {};
  CRISIS_QUESTIONS.forEach((qid) => {
    const score = answers[qid];
    if (score != null && score >= CRISIS_THRESHOLD) {
      crisis[qid] = score;
    }
  });

  return {
    总分: total,
    总均分: round2(total / TOTAL_ITEMS),
    阳性项目数: positiveCount,
    阳性症状均分: positiveCount > 0 ? round2(positiveSum / positiveCount) : 0,
    因子分: sortedFactors,
    危机信号: crisis,
  };
}

/** 因子名 -> 均分，图表直接消费；缺失按 0 处理，避免 ECharts 空点。 */
export function calculateFactorAverages(scores: Scl90Scores): Record<string, number> {
  const averages: Record<string, number> = {};
  Object.entries(scores.因子分 ?? {}).forEach(([name, factor]) => {
    averages[name] = factor.均分 ?? 0;
  });
  return averages;
}
