'use client';

import { ShieldX } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import { Card, CardContent } from '@/components/ui/card';

const REDIRECT_SECONDS = 2;

export default function AccountDeletedPage() {
  const router = useRouter();
  const [remaining, setRemaining] = useState(REDIRECT_SECONDS);

  // 注销结果页：提示后自动跳登录页；此页不校验登录态（会话已随注销销毁）。
  useEffect(() => {
    const timer = window.setInterval(() => {
      setRemaining((current) => {
        if (current <= 1) {
          window.clearInterval(timer);
          router.replace('/login');
          return 0;
        }
        return current - 1;
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [router]);

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardContent className="space-y-5 p-8 text-center">
          <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-pill bg-destructive/10 text-destructive">
            <ShieldX className="h-7 w-7" />
          </span>
          <div className="space-y-2">
            <h1 className="text-2xl font-extrabold text-destructive">账号已永久注销</h1>
            <p className="text-sm leading-6 text-muted-foreground">
              你的账号已即时完成永久注销，无法恢复、无法找回、无法重新登录。
              感谢你曾经的选择，愿你始终心晴。
            </p>
          </div>
          <p className="text-xs text-muted-foreground">
            {remaining} 秒后自动跳转登录页…
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
