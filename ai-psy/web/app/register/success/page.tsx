'use client';

import { CheckCircle2, Copy, Loader2, LogIn } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import type { Role } from '@/lib/types';

interface RegisterSuccessData {
  /** 系统账号：仍可作为备用登录方式 */
  account: string;
  /** 注册手机号：主登录凭据 */
  phone?: string;
  role: Role;
}

const STORAGE_KEY = 'register_success';

/** 复制账号：优先 Clipboard API，非安全上下文回退临时 textarea + execCommand。 */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 落入回退分支
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

export default function RegisterSuccessPage() {
  const router = useRouter();
  const [data, setData] = useState<RegisterSuccessData | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as RegisterSuccessData;
        if (parsed?.phone || parsed?.account) {
          setData(parsed);
        }
      }
    } catch {
      // 数据损坏按缺失处理
    } finally {
      setLoading(false);
    }
  }, []);

  // 直接访问或数据已失效：回登录页重新注册。
  useEffect(() => {
    if (!loading && !data) {
      router.replace('/login');
    }
  }, [loading, data, router]);

  const handleEnter = () => {
    try {
      sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      // 忽略清理失败，跳转本身不受影响
    }
    router.replace(data?.role === 'teacher' ? '/teacher/reports' : '/');
  };

  const primaryLogin = data?.phone || data?.account || '';

  const handleCopy = async () => {
    if (!primaryLogin) {
      return;
    }
    if (await copyText(primaryLogin)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    }
  };

  if (loading || !data) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        正在加载注册结果…
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4 sm:p-6">
      <Card className="w-full max-w-md">
        <CardContent className="space-y-6 p-8 text-center">
          <div className="flex flex-col items-center gap-3">
            <span className="flex h-14 w-14 items-center justify-center rounded-pill bg-btn-grad text-white shadow-btn">
              <CheckCircle2 className="h-7 w-7" />
            </span>
            <h1 className="text-grad-accent text-2xl font-extrabold">注册成功</h1>
            <p className="text-sm text-muted-foreground">注册成功，请使用手机号 + 密码登录</p>
          </div>

          {/* 醒目展示主登录凭据（手机号）+ 一键复制 */}
          <div className="flex items-center justify-center gap-3 rounded-card border border-brand-sky/40 bg-brand-sky/10 px-6 py-5">
            <span className="text-3xl font-extrabold tracking-[0.2em] text-brand-skyDeep">
              {primaryLogin}
            </span>
            <Button variant="outline" size="sm" onClick={() => void handleCopy()}>
              <Copy className="h-4 w-4" />
              {copied ? '已复制' : '复制'}
            </Button>
          </div>

          {data.phone && data.account ? (
            <p className="text-xs text-muted-foreground">
              系统账号（备用登录）：
              <span className="font-semibold text-foreground">{data.account}</span>
            </p>
          ) : null}

          <Alert variant="warning">
            <AlertDescription className="text-sm font-medium leading-6">
              请牢记登录手机号，后续可使用手机号或系统账号 + 密码登录。手机号作为登录凭据，不支持自行修改。
            </AlertDescription>
          </Alert>

          <Button className="w-full" size="lg" onClick={handleEnter}>
            <LogIn className="h-4 w-4" />
            进入系统
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
