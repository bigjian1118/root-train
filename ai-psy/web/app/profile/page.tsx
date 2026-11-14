'use client';

import { Check, Search } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { AccountSecurityCard } from '@/components/business/account-security-card';
import { AuthBadge } from '@/components/business/auth-badge';
import { AuthGuard } from '@/components/business/auth-guard';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { ApiError, getJson, postJson } from '@/lib/api';
import { cn, formatTimestamp } from '@/lib/utils';
import { useAuthStore } from '@/store/use-auth-store';

// 1:1 复刻旧版 static/profile.html + profile.css + profile.js：
// 232px 侧边栏（角色自适应入口 + 未读红点 + 退出登录）与右主区信息卡（字段文案/顺序/编辑态）；
// 手机号支持自助修改（修改后即成为新的登录凭据）；姓名、手机号与任教班级可编辑（班级多选由原「任教班级管理」独立页合并而来），注销卡为已确认新增逻辑，保持不变。

// 手机号格式与登录页/注册接口同口径（大陆 11 位）
const PHONE_PATTERN = /^1[3-9]\d{9}$/;

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

interface ClassOptionsPayload {
  all: string[];
  groups: { grade: string; classes: string[] }[];
  // 可选班级上限（0 表示不限制），与后端 MAX_TEACHER_CLASSES 同源
  max_classes?: number;
}

/** 任教班级多选编辑器：分组展示 + 名称搜索 + chip 点选（原样迁移自任教班级管理页）。 */
function ClassMultiSelect({ options, selected, onChange, maxCount = 0 }: {
  options: ClassOptionsPayload | undefined;
  selected: string[];
  onChange: (classes: string[]) => void;
  maxCount?: number;
}) {
  const [keyword, setKeyword] = useState('');
  // 达到上限后未选中的班级禁选（与后端 MAX_TEACHER_CLASSES 校验同口径）
  const reachedMax = maxCount > 0 && selected.length >= maxCount;
  const groups = useMemo(() => {
    if (!options) {
      return [];
    }
    const lower = keyword.trim().toLowerCase();
    if (!lower) {
      return options.groups;
    }
    return options.groups
      .map((group) => ({
        ...group,
        classes: group.classes.filter((name) => name.toLowerCase().includes(lower)),
      }))
      .filter((group) => group.classes.length > 0);
  }, [options, keyword]);

  const toggle = (name: string) => {
    onChange(selected.includes(name)
      ? selected.filter((item) => item !== name)
      : [...selected, name]);
  };

  const addCustom = () => {
    const name = keyword.trim();
    if (!name || selected.includes(name)) {
      return;
    }
    if (maxCount > 0 && selected.length >= maxCount) {
      return;
    }
    onChange([...selected, name]);
    setKeyword('');
  };

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                addCustom();
              }
            }}
            placeholder="搜索或输入班级名称，回车添加"
            className="pl-9"
          />
        </div>
        <button
          type="button"
          onClick={addCustom}
          disabled={!keyword.trim() || (maxCount > 0 && selected.length >= maxCount)}
          className="inline-flex h-9 items-center rounded-md bg-brand-sky px-3 text-xs font-medium text-white hover:bg-brand-sky/90 disabled:opacity-50"
        >
          添加
        </button>
      </div>
      {groups.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {keyword ? '没有匹配的班级，可点击「添加」创建新班级。' : '暂无可选班级，可直接输入班级名称添加。'}
        </p>
      ) : (
        <div className="max-h-72 space-y-3 overflow-y-auto pr-1">
          {groups.map((group) => (
            <div key={group.grade} className="space-y-1.5">
              <p className="text-xs font-semibold text-brand-skyDeep">{group.grade}</p>
              <div className="flex flex-wrap gap-2">
                {group.classes.map((name) => {
                  const active = selected.includes(name);
                  const disabled = !active && reachedMax;
                  return (
                    <button
                      key={name}
                      type="button"
                      disabled={disabled}
                      onClick={() => toggle(name)}
                      className={cn(
                        'flex items-center gap-1.5 rounded-pill border px-3 py-1.5 text-xs transition-colors',
                        active
                          ? 'border-brand-skyDeep bg-brand-sky/20 font-bold text-brand-skyDeep'
                          : disabled
                            ? 'cursor-not-allowed border-border text-muted-foreground/50'
                            : 'border-brand-sky/35 bg-white/70 hover:bg-brand-sky/10',
                      )}
                    >
                      {active ? <Check className="h-3 w-3" /> : null}
                      {name}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        已选 {selected.length} 个{maxCount > 0 ? ` / 上限 ${maxCount} 个` : ''}
        {reachedMax ? '（达到上限，取消其他班级后可继续选择）' : ''}
      </p>
    </div>
  );
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
  const [phone, setPhone] = useState('');
  const [classesDraft, setClassesDraft] = useState<string[]>([]);
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

  // 可选班级列表：进入编辑态才拉取（与原任教班级管理页同口径）
  const classOptionsQuery = useQuery({
    queryKey: ['teacher', 'class-options'],
    queryFn: () => getJson<ClassOptionsPayload>('/api/teacher/class-options'),
    enabled: editing && isTeacher,
  });

  useEffect(() => {
    if (!profile) {
      return;
    }
    setName(profile.name ?? '');
    setPhone(profile.phone ?? '');
  }, [profile]);

  // 非编辑态下保持草稿与最新绑定同步，避免取消编辑后残留旧勾选
  useEffect(() => {
    if (!editing) {
      setClassesDraft(profile?.classes ?? []);
    }
  }, [editing, profile]);

  const startEdit = () => {
    setName(profile?.name ?? '');
    setPhone(profile?.phone ?? '');
    setClassesDraft(profile?.classes ?? []);
    setEditing(true);
  };

  const handleSave = async () => {
    // 校验文案与旧版 profile.js 一致
    if (!name.trim()) {
      toast({ title: '请填写姓名', variant: 'destructive' });
      return;
    }
    if (!PHONE_PATTERN.test(phone.trim())) {
      toast({ title: '请输入正确的 11 位手机号', variant: 'destructive' });
      return;
    }
    if (isTeacher && classesDraft.length === 0) {
      toast({ title: '请至少选择一个任教班级', variant: 'destructive' });
      return;
    }

    setSaving(true);
    try {
      // 教师提交 classes：后端对 teacher_class 关联表先删后插全量覆盖并同步 session（与原任教班级管理模块一致）。
      // 手机号随资料一并提交：后端校验格式与全局唯一（排除自己），通过后更新登录凭据。
      // 后端学生资料更新会校验 class 非空，这里原样回传当前班级，避免只改姓名时被拒。
      const response = await postJson<ProfileUpdateResponse>('/api/auth/profile/update', isTeacher
        ? { name: name.trim(), phone: phone.trim(), classes: classesDraft }
        : { name: name.trim(), phone: phone.trim(), class: profile?.class ?? '' });
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
      if (isTeacher) {
        // 班级范围影响班级测评报告等全部按班查询，统一失效刷新，保存后权限范围实时生效
        queryClient.invalidateQueries({ queryKey: ['teacher'] });
      }
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
    { label: '登录手机号', key: 'phone', editable: true, value: displayValue(profile?.phone) },
    {
      label: isTeacher ? '绑定班级（多选）' : '班级',
      key: isTeacher ? 'classes' : null,
      editable: isTeacher,
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
            {/* 入口改指学生版专属报告页（左右分栏新版）；原 /student/reports 列表页保留不删 */}
            <Link href="/test/report" className="aic-nav-item">🗂️ 我的心理测试报告</Link>
          </>
        ) : (
          <>
            <Link href="/teacher/reports" className="aic-nav-item">🗂️ 班级测评报告</Link>
            <Link href="/teacher/appointment" className="aic-nav-item">🗓️ 预约管理</Link>
            <Link href="/teacher/materials" className="aic-nav-item">📚 心理活动素材库</Link>
            <Link href="/teacher/articles" className="aic-nav-item">📰 心理推文</Link>
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
                  {editing && row.key === 'classes' ? (
                    <div className="min-w-0 flex-1 space-y-2">
                      {classOptionsQuery.isLoading ? (
                        <p className="aic-loading-tip">班级列表加载中…</p>
                      ) : classOptionsQuery.isError ? (
                        <div className="flex items-center gap-3 text-sm text-destructive">
                          班级列表加载失败
                          <Button variant="outline" size="sm" onClick={() => void classOptionsQuery.refetch()}>
                            重试
                          </Button>
                        </div>
                      ) : (
                        <ClassMultiSelect
                          options={classOptionsQuery.data}
                          selected={classesDraft}
                          maxCount={classOptionsQuery.data?.max_classes ?? 0}
                          onChange={setClassesDraft}
                        />
                      )}
                    </div>
                  ) : editing && row.key === 'name' ? (
                    <input
                      className="aic-edit-input"
                      value={name}
                      placeholder="请输入姓名"
                      onChange={(event) => setName(event.target.value)}
                    />
                  ) : editing && row.key === 'phone' ? (
                    <input
                      className="aic-edit-input"
                      value={phone}
                      placeholder="请输入手机号（登录凭据）"
                      onChange={(event) => setPhone(event.target.value)}
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
