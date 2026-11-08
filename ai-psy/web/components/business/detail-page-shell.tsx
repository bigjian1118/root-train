'use client';

import { ArrowLeft } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface DetailPageShellProps {
  /** 顶部标题（与功能一致，如「学生个人报告」）。 */
  title: ReactNode;
  /** 标题下方的副标题/元信息行。 */
  description?: ReactNode;
  /** 顶部右侧核心操作按钮区。 */
  actions?: ReactNode;
  /** 底部固定操作栏（有主操作时传入）。 */
  footer?: ReactNode;
  /** 无浏览器历史（新标签页直达）时的兜底返回地址。 */
  fallbackHref?: string;
  children: ReactNode;
  className?: string;
}

/**
 * 内容详情页统一布局：顶部固定导航（返回+标题+操作）+ 中间滚动区 + 可选底部操作栏。
 * 返回优先 router.back() 保留列表页状态；新标签页直达无历史时走 fallbackHref。
 */
export function DetailPageShell({
  title, description, actions, footer, fallbackHref = '/', children, className,
}: DetailPageShellProps) {
  const router = useRouter();

  // 直达链接（history.state.idx 为空）时 back() 无效，需回退到固定列表路径。
  const hasHistory = typeof window !== 'undefined' && (window.history.state?.idx ?? 0) > 0;

  const handleBack = () => {
    if (hasHistory) {
      router.back();
      return;
    }
    router.replace(fallbackHref);
  };

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-40 border-b border-brand-sky/15 bg-topbar backdrop-blur-[4px]">
        <div className="mx-auto flex min-h-16 max-w-6xl items-center gap-3 px-4 py-3 sm:px-6">
          <Button variant="outline" size="sm" onClick={handleBack} className="shrink-0">
            <ArrowLeft className="h-4 w-4" />
            返回
          </Button>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-base font-bold tracking-tight sm:text-lg">{title}</h1>
            {description ? (
              <p className="mt-0.5 truncate text-xs text-muted-foreground">{description}</p>
            ) : null}
          </div>
          {actions ? (
            <div className="flex shrink-0 items-center gap-2">{actions}</div>
          ) : null}
        </div>
      </header>

      <main className={cn('mx-auto max-w-6xl px-4 py-6 pb-8 sm:px-6', footer && 'pb-24', className)}>
        {children}
      </main>

      {footer ? (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-brand-sky/20 bg-white/85 backdrop-blur">
          <div className="mx-auto flex max-w-6xl items-center justify-end gap-2 px-4 py-3 sm:px-6">
            {footer}
          </div>
        </div>
      ) : null}
    </div>
  );
}

// 供各详情页复用：滚动位置恢复（列表跳详情返回后还原）。
export function useScrollRestore(storageKey: string) {
  useEffect(() => {
    const saved = sessionStorage.getItem(storageKey);
    if (saved) {
      const target = Number(saved);
      // 等一帧让骨架屏/内容先渲染，再恢复滚动
      requestAnimationFrame(() => window.scrollTo(0, target));
    }
    return () => {
      sessionStorage.setItem(storageKey, String(window.scrollY));
    };
  }, [storageKey]);
}
