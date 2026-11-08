'use client';

import { AlertTriangle, Loader2, ShieldOff } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { ApiError, getJson, postJson } from '@/lib/api';
import { useAuthStore } from '@/store/use-auth-store';

// 与后端 deletion_service.CONFIRM_TEXT 完全一致，改动需两侧同步。
const CONFIRM_TEXT = '确认永久注销账号，且知晓无法恢复';

interface EligibilityResponse {
  allowed: boolean;
  blockers: { code: string; message: string }[];
  confirm_text?: string;
}

type DeletionDialog = 'none' | 'blocked' | 'risk' | 'confirm';

/**
 * 账号安全卡（即时永久注销）：学生端个人中心与教师端工作台共用。
 * 流程：准入校验 -> 一级风险告知（勾选）-> 二级确认（输入指定文案+密码）-> 立即执行。
 * 无冷静期、无撤销；确认后不可逆。
 */
export function AccountSecurityCard() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const clearUser = useAuthStore((state) => state.clearUser);

  const [dialog, setDialog] = useState<DeletionDialog>('none');
  const [blockers, setBlockers] = useState<EligibilityResponse['blockers']>([]);
  const [acknowledged, setAcknowledged] = useState(false);
  const [confirmInput, setConfirmInput] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleOpen = async () => {
    setAcknowledged(false);
    setConfirmInput('');
    setPassword('');
    try {
      const result = await getJson<EligibilityResponse>('/api/account/deletion/eligibility');
      if (!result.allowed) {
        setBlockers(result.blockers);
        setDialog('blocked');
        return;
      }
      setDialog('risk');
    } catch (caught) {
      toast({
        title: '无法开始注销流程',
        description: caught instanceof ApiError ? caught.message : '网络异常，请稍后重试',
        variant: 'destructive',
      });
    }
  };

  const handleDelete = async () => {
    setSubmitting(true); // 点击即置灰，防重复提交
    try {
      await postJson('/api/account/deletion/immediate', {
        password,
        confirm_text: confirmInput,
      });
      // 注销成功：清空本地登录态与全部缓存，跳注销结果页（2 秒后自动回登录页）
      clearUser();
      queryClient.clear();
      router.replace('/account/deleted');
    } catch (caught) {
      toast({
        title: '注销未完成',
        description: caught instanceof ApiError ? caught.message : '网络异常，请稍后重试',
        variant: 'destructive',
      });
      // 403 表示账号已被注销（如他端已执行），直接进入结果页
      if (caught instanceof ApiError && caught.status === 403) {
        clearUser();
        queryClient.clear();
        router.replace('/account/deleted');
        return;
      }
      setSubmitting(false); // 仅失败时恢复按钮，成功后页面已跳转
    }
  };

  const confirmReady = confirmInput.trim() === CONFIRM_TEXT && password.length > 0;

  return (
    <Card className="mt-6">
      <CardContent className="space-y-4 p-6">
        <div>
          <h2 className="text-base font-semibold">账号安全</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            如你希望永久停止使用本系统，可以在这里申请注销账号。
          </p>
        </div>

        <Alert variant="warning">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription className="text-sm leading-6">
            本系统注销为<b>即时永久注销</b>：验证通过后立即执行，无冷静期、不可撤销、不可恢复。
          </AlertDescription>
        </Alert>

        <Button variant="destructive" onClick={() => void handleOpen()}>
          <ShieldOff className="h-4 w-4" />
          注销账号
        </Button>
      </CardContent>

      {/* 阻断提示：逐条列出原因与处理路径 */}
      <Dialog open={dialog === 'blocked'} onOpenChange={(open) => !open && setDialog('none')}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>当前暂不可注销</DialogTitle>
            <DialogDescription>
              你的账号存在以下未完成事项，按处理路径完成后即可重新申请注销。
            </DialogDescription>
          </DialogHeader>
          <ul className="list-disc space-y-2 pl-5 text-sm leading-6">
            {blockers.map((blocker) => (
              <li key={blocker.code}>{blocker.message}</li>
            ))}
          </ul>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialog('none')}>我知道了</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 一级：风险告知 + 强制勾选 */}
      <Dialog open={dialog === 'risk'} onOpenChange={(open) => !open && setDialog('none')}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>永久注销账号前，请仔细阅读</DialogTitle>
          </DialogHeader>
          <div className="max-h-[45vh] space-y-3 overflow-y-auto text-sm leading-6 text-foreground/90">
            <p>
              <b>账号注销后永久失效：无法恢复、无法找回、无法重新登录。</b>
              本操作即时生效，没有冷静期，也没有任何撤销途径。
            </p>
            <p><b>将被立即清除：</b>个人昵称、联系方式等绑定信息、站内消息与师生会话、咨询预约记录。</p>
            <p>
              <b>将被匿名化保留（去除身份，不再关联到你本人）：</b>
              SCL-90 测评与视频分析报告（校园心理档案依法规去标识化留存）；
              你创建的公共教学素材保留，创建者显示为「已注销用户」；
              名下班级与学生报告关联自动解除，由同班其他心理老师正常查看。
            </p>
            <p><b>注销后你将无法：</b>使用该账号或绑定手机号登录、查看任何个人数据、恢复任何权益；账号标识永久占用。</p>
          </div>
          <label className="flex cursor-pointer items-start gap-2 rounded-xl border border-brand-sky/30 bg-brand-sky/10 p-3 text-sm">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(event) => setAcknowledged(event.target.checked)}
              className="mt-1 accent-[#3a9bd8]"
            />
            <span>我已知晓注销不可逆，自愿申请永久注销账号</span>
          </label>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialog('none')}>再想想</Button>
            <Button variant="destructive" disabled={!acknowledged} onClick={() => setDialog('confirm')}>
              下一步
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 二级：指定文案确认 + 密码核验；无取消返回修改路径外的入口 */}
      <Dialog open={dialog === 'confirm'} onOpenChange={(open) => !open && !submitting && setDialog('none')}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>最终确认：永久注销</DialogTitle>
            <DialogDescription>
              请逐字输入下方指定文案，并输入登录密码完成身份核验。点击确认后账号<b>立即</b>被永久注销。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <p className="rounded-xl border border-brand-gold/60 bg-brand-gold/15 px-4 py-2.5 text-center text-sm font-bold tracking-wide">
              {CONFIRM_TEXT}
            </p>
            <Input
              value={confirmInput}
              onChange={(event) => setConfirmInput(event.target.value)}
              placeholder="请逐字输入上方文案"
              autoComplete="off"
            />
            {confirmInput && confirmInput.trim() !== CONFIRM_TEXT ? (
              <p className="text-xs text-destructive">确认文案与指定内容不一致</p>
            ) : null}
            <Input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="登录密码"
              autoComplete="current-password"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialog('risk')} disabled={submitting}>
              返回
            </Button>
            <Button variant="destructive" disabled={!confirmReady || submitting} onClick={() => void handleDelete()}>
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              确认永久注销
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
