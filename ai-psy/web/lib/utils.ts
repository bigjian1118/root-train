import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

// 后端列表接口返回秒级时间戳，详情接口返回毫秒；按量级自动识别，避免各页面各写一套。
const MILLISECOND_THRESHOLD = 1e12;

function toMilliseconds(value: number): number {
  return value < MILLISECOND_THRESHOLD ? value * 1000 : value;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** 统一格式化为 YYYY-MM-DD HH:mm；传入毫秒时间戳（也兼容秒级旧数据）。 */
export function formatTimestamp(value: number | null | undefined): string {
  if (value == null || value === 0 || Number.isNaN(value)) {
    return '—';
  }
  const date = new Date(toMilliseconds(value));
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(
    date.getHours(),
  )}:${pad2(date.getMinutes())}`;
}

/** 列表卡片用短日期 MM-DD；同年内容无需展示年份。 */
export function formatShortDate(value: number | null | undefined): string {
  if (value == null || value === 0 || Number.isNaN(value)) {
    return '—';
  }
  const date = new Date(toMilliseconds(value));
  return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}
