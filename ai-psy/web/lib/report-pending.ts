// 文本测评异步生成的最小上下文：报告页轮询状态、失败后一键重新生成都依赖它。
// 只存 sessionStorage（随标签页销毁），不落 localStorage，避免长期留存答题内容。
import type { Scl90Answers, Scl90Scores } from './types';

const PENDING_KEY = 'scl90_pending';

export interface PendingTextReport {
  report_id: string;
  scenario: string;
  scene_name: string;
  /** 已算好的计分结果，重试时原样回传，保证与首次提交完全一致 */
  result: Scl90Scores;
  answers: Scl90Answers;
}

export function savePendingTextReport(payload: PendingTextReport): void {
  try {
    sessionStorage.setItem(PENDING_KEY, JSON.stringify(payload));
  } catch {
    // 隐私模式/存储配额不足时忽略：只影响失败重试，不影响正常生成
  }
}

/** 按 report_id 取回上下文；报告 ID 不一致说明是另一份测评，不能复用。 */
export function loadPendingTextReport(reportId: string): PendingTextReport | null {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as PendingTextReport;
    if (!parsed || parsed.report_id !== reportId || !parsed.result) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function clearPendingTextReport(): void {
  try {
    sessionStorage.removeItem(PENDING_KEY);
  } catch {
    // 同上，删除失败无副作用
  }
}
