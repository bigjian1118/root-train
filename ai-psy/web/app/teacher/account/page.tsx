'use client';

import { Check, Loader2, Pencil, Search, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { AccountSecurityCard } from '@/components/business/account-security-card';
import { AppShell } from '@/components/business/app-shell';
import { AuthGuard } from '@/components/business/auth-guard';
import { LoadingSkeleton } from '@/components/business/loading-skeleton';
import { PageHeader } from '@/components/business/page-header';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { ApiError, getJson, postJson } from '@/lib/api';
import { cn, formatTimestamp } from '@/lib/utils';
import { useAuthStore } from '@/store/use-auth-store';

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

interface ClassOptionsPayload {
  all: string[];
  groups: { grade: string; classes: string[] }[];
  // 可选班级上限（0 表示不限制），与后端 MAX_TEACHER_CLASSES 同源
  max_classes?: number;
}

interface ProfileUpdateResponse {
  ok: boolean;
  user: ProfilePayload;
}

function displayValue(value: string | null | undefined): string {
  return value && value.trim() ? value : '—';
}

/** 任教班级多选编辑器：分组展示 + 名称搜索 + chip 点选。 */
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

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          placeholder="搜索班级名称快速筛选"
          className="pl-9"
        />
      </div>
      {groups.length === 0 ? (
        <p className="text-sm text-muted-foreground">没有匹配的班级。</p>
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

function TeacherAccountContent() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const storeUser = useAuthStore((state) => state.user);
  const setUser = useAuthStore((state) => state.setUser);

  const [editing, setEditing] = useState(false);
  const [draftClasses, setDraftClasses] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const profileQuery = useQuery({
    queryKey: ['auth', 'profile'],
    queryFn: () => getJson<ProfilePayload>('/api/auth/profile'),
  });
  const optionsQuery = useQuery({
    queryKey: ['teacher', 'class-options'],
    queryFn: () => getJson<ClassOptionsPayload>('/api/teacher/class-options'),
    enabled: editing,
  });

  const profile = profileQuery.data;
  const currentClasses = profile?.classes ?? [];

  useEffect(() => {
    if (!editing) {
      setDraftClasses(currentClasses);
    }
  }, [editing, currentClasses]);

  const startEdit = () => {
    setDraftClasses(currentClasses);
    setSaveError(null);
    setEditing(true);
  };

  const handleSave = async () => {
    if (draftClasses.length === 0) {
      setSaveError('请至少选择一个任教班级');
      return;
    }
    setSaving(true); // 点击即置灰，防重复提交
    setSaveError(null);
    try {
      // 后端教师分支要求 name 必传，这里原样回显当前姓名避免误清空
      const response = await postJson<ProfileUpdateResponse>('/api/auth/profile/update', {
        name: profile?.name ?? '',
        phone: profile?.phone ?? '',
        classes: draftClasses,
      });
      if (storeUser) {
        setUser({
          ...storeUser,
          classes: response.user.classes ?? draftClasses,
          class: response.user.class ?? draftClasses[0] ?? '',
        });
      }
      await queryClient.invalidateQueries({ queryKey: ['auth', 'profile'] });
      // 班级范围影响工作台/报告/素材等全部按班查询，统一失效刷新
      queryClient.invalidateQueries({ queryKey: ['teacher'] });
      setEditing(false);
      toast({ title: '班级信息已更新', variant: 'success' });
    } catch (caught) {
      // 失败保留编辑状态并展示具体原因
      setSaveError(
        caught instanceof ApiError ? caught.message : '修改失败，请稍后重试',
      );
    } finally {
      setSaving(false);
    }
  };

  const renderBody = () => {
    if (profileQuery.isLoading) {
      return <LoadingSkeleton rows={2} />;
    }
    if (profileQuery.isError) {
      return (
        <Alert variant="destructive">
          <AlertDescription className="flex items-center justify-between gap-3">
            个人信息加载失败
            <Button variant="outline" size="sm" onClick={() => void profileQuery.refetch()}>
              重试
            </Button>
          </AlertDescription>
        </Alert>
      );
    }
    if (!profile) {
      return <p className="text-sm text-muted-foreground">暂无个人信息。</p>;
    }

    const rows = [
      { label: '姓名', value: displayValue(profile.name) },
      { label: '身份', value: profile.role_name ?? '教师' },
      { label: '工号', value: displayValue(profile.no) },
      { label: '登录手机号', value: displayValue(profile.phone) },
      { label: '系统账号（备用登录）', value: displayValue(profile.account) },
      { label: '最近登录', value: formatTimestamp(profile.created_at) },
    ];

    return (
      <Card>
        <CardContent className="space-y-5 p-6">
          <h2 className="text-base font-semibold">基本资料</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            {rows.map((row) => (
              <div key={row.label} className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground">{row.label}</p>
                <p className="text-sm font-medium">{row.value}</p>
              </div>
            ))}
          </div>

          {/* 任教班级：展示态顿号分隔 + 编辑态多选组件 */}
          <div className="space-y-2 border-t border-border/70 pt-4">
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs font-medium text-muted-foreground">任教班级</p>
              {!editing ? (
                <Button variant="outline" size="sm" onClick={startEdit}>
                  <Pencil className="h-3.5 w-3.5" />
                  编辑
                </Button>
              ) : null}
            </div>
            {editing ? (
              <div className="space-y-3">
                {optionsQuery.isLoading ? (
                  <LoadingSkeleton rows={2} />
                ) : optionsQuery.isError ? (
                  <Alert variant="destructive">
                    <AlertDescription className="flex items-center justify-between gap-3">
                      班级列表加载失败
                      <Button variant="outline" size="sm" onClick={() => void optionsQuery.refetch()}>
                        重试
                      </Button>
                    </AlertDescription>
                  </Alert>
                ) : (
                  <ClassMultiSelect
                    options={optionsQuery.data}
                    selected={draftClasses}
                    maxCount={optionsQuery.data?.max_classes ?? 0}
                    onChange={(next) => {
                      setDraftClasses(next);
                      if (next.length > 0) {
                        setSaveError(null);
                      }
                    }}
                  />
                )}
                {saveError ? <p className="text-xs text-destructive">{saveError}</p> : null}
                <div className="flex gap-2">
                  <Button onClick={() => void handleSave()} disabled={saving || draftClasses.length === 0}>
                    {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                    {saving ? '更新中…' : '保存'}
                  </Button>
                  <Button variant="outline" onClick={() => { setEditing(false); setSaveError(null); }} disabled={saving}>
                    <X className="h-4 w-4" />
                    取消
                  </Button>
                </div>
              </div>
            ) : (
              <p className="text-sm font-medium">
                {currentClasses.length > 0 ? currentClasses.join('、') : '—'}
              </p>
            )}
          </div>
        </CardContent>
      </Card>
    );
  };

  return (
    <AppShell role="teacher">
      <PageHeader
        eyebrow="我的"
        title="个人信息"
        description="以下为你在系统中登记的基本资料。任教班级可自助修改，保存后全系统按最新班级范围实时生效。"
      />
      {renderBody()}
      {/* 教师端账号注销入口：与个人中心共用同一组件（后端教师分支已支持） */}
      <AccountSecurityCard />
    </AppShell>
  );
}

export default function TeacherAccountPage() {
  return (
    <AuthGuard role="teacher">
      <TeacherAccountContent />
    </AuthGuard>
  );
}
