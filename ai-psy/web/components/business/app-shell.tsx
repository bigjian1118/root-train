'use client';

import { useRouter } from 'next/navigation';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { AuthBadge } from '@/components/business/auth-badge';
import type { Role } from '@/lib/types';

// 1:1 复刻旧版 static 子页结构：无侧边栏/无顶栏，仅 head-nav（返回上一页+返回首页）
// + 1200px 居中容器（common.css body { max-width:1200px; padding:24px }）。
// 首页导航栏/身份徽章/退出登录在首页自身实现（对齐旧版：仅 index.html 有 topbar）。
interface AppShellProps {
  children: ReactNode;
  /** 保留兼容签名：旧版子页布局与角色无关，此参数不再影响渲染。 */
  role?: Role;
  /** 全屏页（聊天/人脸等旧版独立整屏布局）跳过容器与 head-nav，由页面自行复刻。 */
  bare?: boolean;
  /** 旧版部分子页用页面级 .page 覆盖 body 容器（如测评页 780/860px），传入以对齐宽度与内边距。 */
  pageClassName?: string;
  /** 旧版各页 .head-nav 的 gap/margin 数值不一（8~12px），按对应页面 CSS 原值传入覆盖。 */
  headNavClassName?: string;
}

export function AppShell({ children, bare = false, pageClassName, headNavClassName }: AppShellProps) {
  const router = useRouter();

  if (bare) {
    return (
      <div className="min-h-screen">
        {children}
        <AuthBadge />
      </div>
    );
  }

  return (
    <div className={pageClassName ?? 'mx-auto min-h-screen max-w-[1200px] px-6 py-6'}>
      <div className={headNavClassName ?? 'mb-[14px] flex flex-wrap items-center gap-[10px]'}>
        <button type="button" className="aic-back" onClick={() => router.back()}>
          ← 返回上一页
        </button>
        <Link href="/" className="aic-back-link">
          返回首页
        </Link>
      </div>
      <main className="min-w-0">{children}</main>
      {/* 旧版 auth.js 全站注入的悬浮身份徽章（固定右上角） */}
      <AuthBadge />
    </div>
  );
}
