// 新报告红点提示：报告生成完成时置位，进入「我的心理测试报告」后清除。
// 用 localStorage + 自定义事件实现跨页面同步，不引入额外全局状态库。
const UNREAD_KEY = 'xq_report_unread';
const CHANGE_EVENT = 'xq-report-unread-change';

function emitChange(): void {
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function markReportUnread(): void {
  try {
    window.localStorage.setItem(UNREAD_KEY, '1');
  } catch {
    // 隐私模式下 localStorage 不可用：红点降级为不显示，不影响主流程
    return;
  }
  emitChange();
}

export function clearReportUnread(): void {
  try {
    window.localStorage.removeItem(UNREAD_KEY);
  } catch {
    return;
  }
  emitChange();
}

export function isReportUnread(): boolean {
  try {
    return window.localStorage.getItem(UNREAD_KEY) === '1';
  } catch {
    return false;
  }
}

/** 订阅红点状态变化（同标签页自定义事件 + 跨标签页 storage 事件）。 */
export function subscribeReportUnread(handler: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, handler);
  window.addEventListener('storage', handler);
  return () => {
    window.removeEventListener(CHANGE_EVENT, handler);
    window.removeEventListener('storage', handler);
  };
}
