'use client';

import { Eye, EyeOff } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent } from 'react';

import { ApiError, getJson, postJson } from '@/lib/api';
import { validatePassword, validatePasswordMatch } from '@/lib/password-policy';
import type {
  LoginResponse,
  MeResponse,
  RegisterResponse,
  Role,
  User,
} from '@/lib/types';
import { useAuthStore } from '@/store/use-auth-store';

// 1:1 复刻旧版 static/login.html + login.css + login.js 的视觉与文案；
// 登录/注册改用「手机号 + 密码」，系统自动分配账号保留为备用登录方式。
type AuthMode = 'login' | 'register';

const CLASS_FORBIDDEN_RE = /[,，、\n\r\t]/;
// 与后端 server/security.py 的 CN_PHONE_RE 保持一致：11 位、1 开头、第二位 3-9
const PHONE_PATTERN = /^1[3-9]\d{9}$/;

interface PasswordFieldProps {
  label: string;
  placeholder: string;
  value: string;
  visible: boolean;
  onToggle: () => void;
  onChange: (value: string) => void;
  error?: string | null;
}

function PasswordField({
  label, placeholder, value, visible, onToggle, onChange, error,
}: PasswordFieldProps) {
  return (
    <div className="aic-field">
      <label>{label}</label>
      <div className="relative">
        <input
          type={visible ? 'text' : 'password'}
          value={value}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
          className="pr-10"
        />
        {/* 显隐切换独立生效；提交成功/页面卸载自动恢复默认掩码 */}
        <button
          type="button"
          aria-label={visible ? '隐藏密码' : '显示密码'}
          onClick={onToggle}
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-muted-foreground transition-colors hover:text-foreground"
        >
          {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      </div>
      {error ? (
        <p className="aic-class-hint" style={{ color: '#d9534f' }}>{error}</p>
      ) : null}
    </div>
  );
}

function safeNextPath(raw: string | null): string | null {
  // 只允许站内绝对路径，避免 ?next= 被利用成开放重定向。
  if (!raw || !raw.startsWith('/') || raw.startsWith('//')) {
    return null;
  }
  return raw;
}

function AuthPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const setUser = useAuthStore((state) => state.setUser);

  const [mode, setMode] = useState<AuthMode>('login');
  const [role, setRole] = useState<Role>('student');
  // 登录凭据：手机号或系统分配的账号，二者都可登录
  const [loginId, setLoginId] = useState('');
  // 注册必填手机号（登录凭据）
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [name, setName] = useState('');
  const [userNo, setUserNo] = useState('');
  const [clazz, setClazz] = useState('');
  // 教师注册多班级：旧版为动态行输入（第一个 + 新增行），照抄交互
  const [classRows, setClassRows] = useState<string[]>(['']);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  // 两个密码框显隐状态独立；提交成功后统一恢复默认掩码
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  const isRegister = mode === 'register';
  const isTeacherRegister = isRegister && role === 'teacher';
  const passwordError = isRegister && password ? validatePassword(password) : null;
  const confirmError = isRegister
    ? validatePasswordMatch(password, confirmPassword)
    : null;
  const phoneInput = phone.trim();
  const phoneError = isRegister && phoneInput && !PHONE_PATTERN.test(phoneInput)
    ? '请输入正确的 11 位手机号'
    : null;
  const isRegisterInvalid = isRegister
    && Boolean(validatePassword(password) || password !== confirmPassword || phoneError);

  const resolveRedirect = (user: User): string => {
    const nextPath = safeNextPath(searchParams.get('next'));
    if (nextPath) {
      return nextPath;
    }
    return user.role === 'teacher' ? '/teacher/account' : '/';
  };

  const switchMode = (next: AuthMode) => {
    setMode(next);
    setError('');
  };

  const switchRole = (next: Role) => {
    setRole(next);
    // 旧版逻辑：从教师切回学生时多班级只保留第一个
    if (next !== 'teacher') {
      setClassRows((rows) => rows.slice(0, 1));
    }
    setError('');
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError('');
    if (isRegister && isRegisterInvalid) {
      return;
    }

    // 旧版班级校验文案（1:1 保留）
    let classes: string[] = [];
    if (isRegister) {
      if (!phoneInput) {
        setError('请填写手机号');
        return;
      }
      if (!PHONE_PATTERN.test(phoneInput)) {
        setError('请输入正确的 11 位手机号');
        return;
      }
      if (isTeacherRegister) {
        classes = classRows.map((item) => item.trim()).filter(Boolean);
        if (classes.length === 0) {
          setError('请至少填写一个班级');
          return;
        }
        for (const item of classes) {
          if (CLASS_FORBIDDEN_RE.test(item)) {
            setError(`班级名「${item}」不能包含逗号、顿号等分隔符`);
            return;
          }
        }
      } else {
        const cls = clazz.trim();
        if (!cls) {
          setError('请填写班级');
          return;
        }
        if (CLASS_FORBIDDEN_RE.test(cls)) {
          setError('班级名不能包含逗号、顿号等分隔符');
          return;
        }
      }
    }

    setSubmitting(true);
    try {
      if (!isRegister) {
        const data = await postJson<LoginResponse>('/api/auth/login', {
          role,
          identifier: loginId.trim(),
          password,
        });
        if (!data.user) {
          throw new ApiError('登录响应缺少用户信息', 500);
        }
        setUser({ ...data.user, id: data.user.id ?? '' });
        router.replace(resolveRedirect(data.user));
        return;
      }

      const base = {
        role,
        name: name.trim(),
        phone: phoneInput,
        password,
        confirm_password: confirmPassword,
      };
      const body = isTeacherRegister
        ? { ...base, no: userNo.trim(), classes, class: classes[0] }
        : { ...base, no: userNo.trim(), class: clazz.trim() };

      const data = await postJson<RegisterResponse>('/api/auth/register', body);
      let user = data.user ?? null;
      if (!user) {
        // 极少数兼容场景：注册接口只返回 ok，这里再取一次登录态。
        const me = await getJson<MeResponse>('/api/auth/me');
        if (!me.user) {
          throw new ApiError('注册成功但登录态未就绪，请重新登录', 401);
        }
        user = me.user;
      }
      setUser({ ...user, id: user.id ?? '' });
      // 分配账号交给独立结果页展示；sessionStorage 仅存活于本次浏览器会话。
      try {
        sessionStorage.setItem(
          'register_success',
          JSON.stringify({
            account: data.account ?? '',
            phone: data.phone ?? phoneInput,
            role: user.role,
          }),
        );
      } catch {
        // 隐私模式禁用 sessionStorage 时结果页会回退到登录页，不影响账号已创建的事实。
      }
      // 提交成功即清空密码并恢复默认掩码，避免返回本页时残留。
      setPassword('');
      setConfirmPassword('');
      setShowPassword(false);
      setShowConfirm(false);
      router.replace('/register/success');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '网络异常，请稍后重试');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-x-hidden">
      {/* 背景光斑（login.css .bg-glow：左上浅蓝 480px、右下淡金 540px，blur100 透明度 .42） */}
      <div className="pointer-events-none fixed inset-0 z-0">
        <div className="absolute -left-[120px] -top-[140px] h-[480px] w-[480px] rounded-full bg-brand-sky opacity-[0.42] blur-[100px]" />
        <div className="absolute -bottom-[180px] -right-[140px] h-[540px] w-[540px] rounded-full bg-brand-gold opacity-[0.42] blur-[100px]" />
      </div>

      <main className="relative z-10 w-full px-6 pb-10 pt-5">
        <div className="aic-login-brand">
          <h1>
            心晴<span>·</span>AI 心理空间
          </h1>
          <p>看见每一种情绪，陪伴每一段成长</p>
        </div>

        <section className="aic-login-card">
          <div className="aic-auth-tabs">
            <button
              type="button"
              className={mode === 'login' ? 'active' : ''}
              onClick={() => switchMode('login')}
            >
              登 录
            </button>
            <button
              type="button"
              className={mode === 'register' ? 'active' : ''}
              onClick={() => switchMode('register')}
            >
              注 册
            </button>
          </div>

          <div className="aic-role-pick">
            <button
              type="button"
              className={role === 'student' ? 'checked' : ''}
              onClick={() => switchRole('student')}
            >
              🎓 学生端
            </button>
            <button
              type="button"
              className={role === 'teacher' ? 'checked' : ''}
              onClick={() => switchRole('teacher')}
            >
              👩‍🏫 教师端
            </button>
          </div>

          <form onSubmit={handleSubmit} autoComplete="off">
            {isRegister ? (
              <>
                <div className="aic-field">
                  <label>{role === 'student' ? '学号' : '工号'}</label>
                  <input
                    value={userNo}
                    placeholder={role === 'student' ? '请输入学号' : '请输入工号'}
                    onChange={(event) => setUserNo(event.target.value)}
                  />
                </div>
                <div className="aic-field">
                  <label>姓名</label>
                  <input
                    value={name}
                    placeholder="请输入姓名"
                    onChange={(event) => setName(event.target.value)}
                  />
                </div>
                <div className="aic-field">
                  <label>手机号</label>
                  <input
                    value={phone}
                    type="tel"
                    inputMode="numeric"
                    autoComplete="tel"
                    placeholder="请输入 11 位手机号"
                    onChange={(event) => setPhone(event.target.value)}
                  />
                  {phoneError ? (
                    <p className="aic-class-hint" style={{ color: '#d9534f' }}>{phoneError}</p>
                  ) : null}
                </div>
                <div className="aic-field">
                  <label>班级</label>
                  {isTeacherRegister ? (
                    <>
                      <div className="aic-class-wrap">
                        {classRows.map((row, index) => (
                          <div key={index} className={index === 0 ? '' : 'aic-class-row'}>
                            {index === 0 ? (
                              <input
                                value={row}
                                placeholder="请输入班级"
                                onChange={(event) =>
                                  setClassRows((rows) =>
                                    rows.map((item, i) => (i === 0 ? event.target.value : item)),
                                  )
                                }
                              />
                            ) : (
                              <div className="aic-class-row">
                                <input
                                  value={row}
                                  placeholder="请输入另一个班级"
                                  onChange={(event) =>
                                    setClassRows((rows) =>
                                      rows.map((item, i) => (i === index ? event.target.value : item)),
                                    )
                                  }
                                />
                                <button
                                  type="button"
                                  className="aic-class-remove"
                                  title="删除"
                                  onClick={() =>
                                    setClassRows((rows) => rows.filter((_, i) => i !== index))
                                  }
                                >
                                  ×
                                </button>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                      <button
                        type="button"
                        className="aic-class-add-btn"
                        onClick={() => setClassRows((rows) => [...rows, ''])}
                      >
                        ＋ 新增班级
                      </button>
                      <p className="aic-class-hint">班级名不能包含逗号、顿号等分隔符</p>
                    </>
                  ) : (
                    <input
                      value={clazz}
                      placeholder="请输入班级"
                      onChange={(event) => setClazz(event.target.value)}
                    />
                  )}
                </div>
              </>
            ) : (
              <div className="aic-field">
                <label>手机号 / 登录账号</label>
                <input
                  value={loginId}
                  autoComplete="username"
                  placeholder="请输入手机号或登录账号"
                  onChange={(event) => setLoginId(event.target.value)}
                />
              </div>
            )}

            {isRegister ? (
              <>
                <PasswordField
                  label="设置密码"
                  placeholder="请设置登录密码"
                  value={password}
                  visible={showPassword}
                  onToggle={() => setShowPassword((current) => !current)}
                  onChange={setPassword}
                  error={passwordError}
                />
                <PasswordField
                  label="确认密码"
                  placeholder="请再次输入密码"
                  value={confirmPassword}
                  visible={showConfirm}
                  onToggle={() => setShowConfirm((current) => !current)}
                  onChange={setConfirmPassword}
                  error={confirmError}
                />
              </>
            ) : (
              <PasswordField
                label="密码"
                placeholder="至少 6 位"
                value={password}
                visible={showPassword}
                onToggle={() => setShowPassword((current) => !current)}
                onChange={setPassword}
              />
            )}

            <div className="aic-auth-error">{error}</div>

            <button type="submit" className="aic-auth-submit" disabled={submitting || isRegisterInvalid}>
              {isRegister ? '注 册' : '登 录'}
            </button>
          </form>

          <p className="aic-auth-hint">
            {isRegister ? '已有账号？' : '还没有账号？'}
            <button type="button" onClick={() => switchMode(isRegister ? 'login' : 'register')}>
              {isRegister ? '返回登录' : '立即注册'}
            </button>
          </p>
        </section>

        <footer className="aic-login-footer">
          ⚠️ 本平台 AI 分析仅供参考，不能替代专业心理诊断与治疗。
        </footer>
      </main>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">
          正在加载登录页…
        </div>
      }
    >
      <AuthPageInner />
    </Suspense>
  );
}
