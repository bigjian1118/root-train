'use client';

import { useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';

import { LoadingSkeleton } from '@/components/business/loading-skeleton';
import type { Role } from '@/lib/types';
import { useAuthStore } from '@/store/use-auth-store';

const TEACHER_FALLBACK = '/teacher/reports';
const STUDENT_FALLBACK = '/student/reports';

interface AuthGuardProps {
  children: ReactNode;
  /** 限定角色；不传则仅校验登录态（首页等双角色共用页面）。 */
  role?: Role;
}

/** 客户端守卫：等待 AuthProvider 完成 /api/auth/me 后再判断，避免首屏误跳登录页。 */
export function AuthGuard({ children, role }: AuthGuardProps) {
  const router = useRouter();
  const user = useAuthStore((state) => state.user);
  const isLoading = useAuthStore((state) => state.isLoading);
  const allowed = Boolean(user) && (!role || user?.role === role);

  useEffect(() => {
    if (isLoading) {
      return;
    }
    if (!user) {
      const nextPath = window.location.pathname + window.location.search;
      router.replace(`/login?next=${encodeURIComponent(nextPath)}`);
      return;
    }
    if (role && user.role !== role) {
      router.replace(user.role === 'teacher' ? TEACHER_FALLBACK : STUDENT_FALLBACK);
    }
  }, [isLoading, role, router, user]);

  if (isLoading || !allowed) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-10">
        <p className="mb-4 text-sm text-muted-foreground">正在校验登录状态…</p>
        <LoadingSkeleton rows={3} />
      </div>
    );
  }

  return <>{children}</>;
}
