'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';

import { ToastProvider } from '@/components/ui/toast';
import { getJson } from '@/lib/api';
import type { MeResponse } from '@/lib/types';
import { useAuthStore } from '@/store/use-auth-store';

// 全局 query 默认 30s 内不重复请求；表单型写操作由调用方自行 invalidate。
function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        retry: 1,
        refetchOnWindowFocus: false,
      },
    },
  });
}

// /api/auth/me 是唯一登录态来源：首屏只请求一次，失败按未登录处理。
function AuthProvider({ children }: { children: ReactNode }) {
  const setUser = useAuthStore((state) => state.setUser);
  const clearUser = useAuthStore((state) => state.clearUser);
  const setLoading = useAuthStore((state) => state.setLoading);

  useEffect(() => {
    let active = true;
    setLoading(true);

    getJson<MeResponse>('/api/auth/me')
      .then((me) => {
        if (!active) {
          return;
        }
        if (me.logged_in && me.user) {
          // /api/auth/me 刻意不下发 id，这里补空串满足 User 契约，业务页不依赖 id。
          setUser({ ...me.user, id: me.user.id ?? '' });
        } else {
          clearUser();
        }
      })
      .catch(() => {
        // 后端未启动或网络异常时按未登录处理，避免页面无限 loading。
        if (active) {
          clearUser();
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [clearUser, setLoading, setUser]);

  return <>{children}</>;
}

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(createQueryClient);

  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <ToastProvider>{children}</ToastProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}
