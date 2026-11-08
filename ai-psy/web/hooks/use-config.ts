'use client';

import { useQuery } from '@tanstack/react-query';

import { getJson } from '@/lib/api';
import type { AppConfig } from '@/lib/types';

export const CONFIG_QUERY_KEY = ['config'] as const;

export function useConfig() {
  return useQuery({
    queryKey: CONFIG_QUERY_KEY,
    queryFn: () => getJson<AppConfig>('/api/config'),
    staleTime: 5 * 60_000,
  });
}
