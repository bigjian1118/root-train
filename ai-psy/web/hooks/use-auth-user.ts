'use client';

import { useAuthStore } from '@/store/use-auth-store';

// AuthProvider 已在首屏完成 /api/auth/me 注入；此 hook 只暴露 store 状态，
// 需要强制刷新登录态时再自行触发全页刷新即可。
export function useAuthUser() {
  const user = useAuthStore((state) => state.user);
  const isLoading = useAuthStore((state) => state.isLoading);

  return {
    user,
    isLoading,
    isError: false,
    error: null,
  };
}

export const AUTH_ME_QUERY_KEY = ['auth', 'me'] as const;
