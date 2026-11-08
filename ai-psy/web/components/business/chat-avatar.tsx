'use client';

import { GraduationCap, Presentation } from 'lucide-react';

import { cn } from '@/lib/utils';

// 师生倾诉消息头像：系统内置图标区分身份（不调用真实上传头像）。
// 教师=讲台图标+浅蓝底，学生=学士帽图标+浅绿底，与 AIC 色板一致。
const ROLE_ICONS = {
  student: GraduationCap,
  teacher: Presentation,
} as const;

const ROLE_TONES = {
  student: 'bg-brand-green/50 text-[#3f8f66]',
  teacher: 'bg-brand-sky/25 text-brand-skyDeep',
} as const;

/** 圆形图标头像：基础 40px，移动端等比缩至 36px。 */
export function ChatAvatar({ role, className }: {
  role: 'student' | 'teacher';
  className?: string;
}) {
  const Icon = ROLE_ICONS[role] ?? ROLE_ICONS.student;
  return (
    <span
      aria-hidden
      className={cn(
        'flex h-9 w-9 shrink-0 items-center justify-center rounded-full sm:h-10 sm:w-10',
        ROLE_TONES[role] ?? ROLE_TONES.student,
        className,
      )}
    >
      <Icon className="h-4 w-4 sm:h-5 sm:w-5" />
    </span>
  );
}
