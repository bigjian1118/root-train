import { create } from 'zustand';

import type { User } from '@/lib/types';

interface AuthState {
  user: User | null;
  /** AuthProvider 首次校验 /api/auth/me 期间为 true，AuthGuard 依赖它避免误跳登录页。 */
  isLoading: boolean;
  isTeacher: boolean;
  setUser: (user: User) => void;
  clearUser: () => void;
  setLoading: (loading: boolean) => void;
}

export const useAuthStore = create<AuthState>()((set) => ({
  user: null,
  isLoading: true,
  isTeacher: false,
  setUser: (user) => set({ user, isTeacher: user.role === 'teacher' }),
  clearUser: () => set({ user: null, isTeacher: false }),
  setLoading: (isLoading) => set({ isLoading }),
}));
