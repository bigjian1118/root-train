'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { AccountSecurityCard } from '@/components/business/account-security-card';
import { AuthBadge } from '@/components/business/auth-badge';
import { AuthGuard } from '@/components/business/auth-guard';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { ApiError, getJson, postJson } from '@/lib/api';
import { formatTimestamp } from '@/lib/utils';
import { useAuthStore } from '@/store/use-auth-store';

// 1:1 复刻旧版 static/profile.html + profile.css + profile.js：
// 232px 侧边栏（角色自适应入口 + 未读红点 + 退出登录）与右主区信息卡（字段文案/顺序/编辑态）；
// 手机号已是登录凭据，改为只读；仅姓名可编辑，注销卡为已确认新增逻辑，保持不变。

interface UnreadResponse {
  role?: string;
  total?: number;
}

/** /api/auth/profile 的返回结构；id 不下发，故不放进共享 User 类型。 */
interface ProfilePayload {
  role: string;
  role_name?: string;
  name?: string;
  account?: string;
  class?: string;
  classes?: string[];
  no?: string | null;
  phone?: string | null;
  created_at?: number | null;
}

interface ProfileUpdateResponse {
  ok: boolean;
  user: ProfilePayload;
}

function displayValue(value: string | null | undefined): string {
  return value && value.trim() ? value : '—';
}

function ProfileContent() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const storeUser = useAuthStore((state) => state.user);
  const setUser = useAuthStore((state) => state.setUser);
  const clearUser = useAuthStore((state) => state.clearUser);

  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  const profileQuery = useQuery({
    queryKey: ['auth', 'profile'],
    queryFn: () => getJson<ProfilePayload>('/api/auth/profile'),
  });

  // 旧版逻辑：/api/msg/unread 返回后才显示师生倾诉入口；失败也放行入口、不加红点
  const unreadQuery = useQuery({
    queryKey: ['msg', 'unread'],
    queryFn: () => getJson<UnreadResponse>('/api/msg/unread'),
  });

  const profile = profileQuery.data;
  const isTeacher = profile?.role === 'teacher' || storeUser?.role === 'teacher';
  const unreadTotal = unreadQuery.data?.total ?? 0;

  useEffect(() => {
    if (!profile) {
      return;
    }
    setName(profile.name ?? '');
  }, [profile]);

  const startEdit = () => {
    setName(profile?.name ?? '');
    setEditing(true);
  };

  const handleSave = async () => {
    // 校验文案与旧版 profile.js 一致
    if (!name.trim()) {
      toast({ title: '请填写姓名', variant: 'destructive' });
      return;
    }

    setSaving(true);
    try {
      // 后端学生资料更新会校验 class 非空，这里原样回传当前班级，避免只改姓名时被拒。
      const response = await postJson<ProfileUpdateResponse>('/api/auth/profile/update', {
        name: name.trim(),
        class: profile?.class ?? '',
      });
      const updated = response.user;
      // 同步顶栏与全局登录态，避免保存后姓名仍是旧值。
      if (storeUser) {
        setUser({
          ...storeUser,
          name: updated.name ?? storeUser.name,
          account: updated.account ?? storeUser.account,
          class: updated.class ?? storeUser.class,
          classes: updated.classes ?? storeUser.classes,
        });
      }
      await queryClient.invalidateQueries({ queryKey: ['auth', 'profile'] });
      setEditing(false);
      toast({ title: '保存成功', variant: 'success' });
    } catch (caught) {
      toast({
        title: caught instanceof ApiError ? caught.message : '网络异常，请稍后重试',
        variant: 'destructive',
      });
    } finally {
      setSaving(false);
    }
  };

  const handleLogout = async () => {
    if (loggingOut) {
      return;
    }
    setLoggingOut(true);
    try {
      await postJson<{ ok: boolean }>('/api/auth/logout');
    } catch {
      // 退出接口失败也继续清理本地状态，避免退出按钮看起来失效。
    } finally {
      clearUser();
      queryClient.clear();
      router.replace('/login');
    }
  };

  // 字段顺序与旧版 buildRows 一致：姓名/身份/学号(工号)/登录手机号/班级/系统账号/注册时间
  const classDisplay = isTeacher
    ? (profile?.classes ?? []).length
      ? (profile?.classes ?? []).join(' / ')
      : '—'
    : displayValue(profile?.class);

  const rows = [
    { label: '姓名', key: 'name', editable: true, value: displayValue(profile?.name) },
    {
      label: '身份',
      key: null,
      editable: false,
      value: displayValue(profile?.role_name ?? (profile?.role === 'teacher' ? '教师' : '学生')),
    },
    {
      label: isTeacher ? '工号' : '学号',
      key: null,
      editable: false,
      value: displayValue(profile?.no),
    },
    { label: '登录手机号', key: null, editable: false, value: displayValue(profile?.phone) },
    {
      label: isTeacher ? '绑定班级（多选）' : '班级',
      key: null,
      editable: false,
      value: classDisplay,
    },
    {
      label: '系统账号（备用登录）',
      key: null,
      editable: false,
      value: displayValue(profile?.account),
    },
    {
      label: '注册时间',
      key: null,
      editable: false,
      value: profile?.created_at ? formatTimestamp(profile.created_at) : '—',
    },
  ];

  return (
    <div className="aic-profile-layout">
      <aside className="aic-sidebar">
        <Link href="/" className="aic-side-brand">
          🌿 心晴 · 个人中心
        </Link>
        <button type="button" className="aic-nav-item active">
          👤 个人信息
        </button>
        {!isTeacher ? (
          <>
            <Link href="/chat" className="aic-nav-item">💬 AI 聊天助手</Link>
            <Link href="/face" className="aic-nav-item">📷 人脸视频分析</Link>
            <Link href="/test" className="aic-nav-item">📋 场景化心理测评</Link>
            <Link href="/appointment" className="aic-nav-item">🗓️ 心理咨询预约</Link>
            <Link href="/articles" className="aic-nav-item">📖 心理科普文章</Link>
            <Link href="/student/reports" className="aic-nav-item">🗂️ 我的心理测试报告</Link>
          </>
        ) : (
          <>
            <Link href="/teacher/reports" className="aic-nav-item">🗂️ 班级测评报告</Link>
            <Link href="/teacher/appointment" className="aic-nav-item">🗓️ 预约管理</Link>
            <Link href="/teacher/materials" className="aic-nav-item">📚 心理活动素材库</Link>
            <Link href="/teacher/articles" className="aic-nav-item">📰 心理推文</Link>
            {/* 新增功能入口：任教班级自助修改（旧版无此页，1:1 还原时保留） */}
            <Link href="/teacher/account" className="aic-nav-item">👩‍🏫 任教班级管理</Link>
          </>
        )}
        {!unreadQuery.isLoading ? (
          <Link
            href={isTeacher ? '/teacher/msg' : '/msg'}
            className="aic-nav-item"
            style={{ position: 'relative' }}
          >
            💌 师生倾诉
            {unreadTotal > 0 ? (
              <span className="aic-msg-badge">
                {unreadTotal > 99 ? '99+' : String(unreadTotal)}
              </span>
            ) : null}
          </Link>
        ) : null}
        <button
          type="button"
          className="aic-nav-item aic-nav-logout"
          onClick={() => void handleLogout()}
          disabled={loggingOut}
        >
          🚪 退出登录
        </button>
      </aside>

      <main className="aic-profile-main">
        <h1>个人信息</h1>
        <p className="sub">以下展示你注册时填写的全部信息（内部编号 id 不对外显示）。</p>

        {profileQuery.isLoading ? (
          <div className="aic-info-card">
            <div className="aic-info-fields">
              <p className="aic-loading-tip">加载中…</p>
            </div>
          </div>
        ) : null}

        {profileQuery.isError ? (
          <Alert variant="destructive">
            <AlertDescription className="flex items-center justify-between gap-3">
              个人信息加载失败
              <Button variant="outline" size="sm" onClick={() => void profileQuery.refetch()}>
                重试
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}

        {profile ? (
          <div className="aic-info-card">
            <div className="aic-info-fields">
              {rows.map((row) => (
                <div key={row.label} className="aic-field-row">
                  <span className="aic-fk">{row.label}</span>
                  {editing && row.key === 'name' ? (
                    <input
                      className="aic-edit-input"
                      value={name}
                      placeholder="请输入姓名"
                      onChange={(event) => setName(event.target.value)}
                    />
                  ) : (
                    <span className="aic-fv">{row.value}</span>
                  )}
                </div>
              ))}
              {editing ? (
                <div className="aic-edit-actions">
                  <button
                    type="button"
                    className="aic-btn-save"
                    disabled={saving}
                    onClick={() => void handleSave()}
                  >
                    💾 保存
                  </button>
                  <button
                    type="button"
                    className="aic-btn-cancel-plain"
                    disabled={saving}
                    onClick={() => setEditing(false)}
                  >
                    取消
                  </button>
                </div>
              ) : null}
            </div>
            {!editing ? (
              <button type="button" className="aic-btn-edit" onClick={startEdit}>
                ✏️ 编辑
              </button>
            ) : null}
          </div>
        ) : null}

        {/* 新增功能保持：账号安全（改密/注销） */}
        <div style={{ marginTop: 22 }}>
          <AccountSecurityCard />
        </div>
      </main>
      {/* 旧版 profile.html 同样由 auth.js 注入悬浮身份徽章（个人中心页自动隐藏回跳按钮） */}
      <AuthBadge />
    </div>
  );
}

export default function ProfilePage() {
  // 旧版 profile.html 为师生共用（侧边栏按角色切换入口），不限定角色。
  return (
    <AuthGuard>
      <ProfileContent />
    </AuthGuard>
  );
}
