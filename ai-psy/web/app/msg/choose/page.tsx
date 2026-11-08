'use client';

import { Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { AppShell } from '@/components/business/app-shell';
import { AuthGuard } from '@/components/business/auth-guard';
import { LoadingSkeleton } from '@/components/business/loading-skeleton';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/components/ui/toast';
import { ApiError, getJson, postJson } from '@/lib/api';
import type { TeacherClassOption } from '@/lib/types';

interface TeachersPayload {
  teachers?: TeacherClassOption[];
}

function teachersOf(payload?: TeachersPayload | TeacherClassOption[]): TeacherClassOption[] {
  if (Array.isArray(payload)) {
    return payload;
  }
  return payload?.teachers ?? [];
}

interface CreateConversationResponse {
  conversation: { id: string; teacher_name?: string; created?: boolean };
}

function ChooseTeacherContent() {
  const router = useRouter();
  const { toast } = useToast();
  const [creatingId, setCreatingId] = useState<string | null>(null);

  const teachersQuery = useQuery({
    queryKey: ['student', 'msg', 'teachers'],
    queryFn: () =>
      getJson<TeachersPayload | TeacherClassOption[]>('/api/student/msg/teachers'),
  });

  const teachers = teachersOf(teachersQuery.data);

  const startConversation = async (teacher: TeacherClassOption) => {
    if (creatingId) {
      return;
    }
    setCreatingId(teacher.id);
    try {
      // 后端按 (student_id, teacher_id) 复用已有会话，这里直接用返回 id 打开。
      const response = await postJson<CreateConversationResponse>(
        '/api/student/msg/conversation',
        { teacher_id: teacher.id },
      );
      router.push(
        `/msg/chat?conversationId=${encodeURIComponent(response.conversation.id)}`,
      );
    } catch (caught) {
      // 旧版口径：网络失败提示「发起失败，请重试。」，接口错误直接展示后端 error 文案。
      toast({
        title: caught instanceof ApiError ? caught.message : '发起失败，请重试。',
        variant: 'destructive',
      });
      setCreatingId(null);
    }
  };

  return (
    <AppShell
      role="student"
      pageClassName="aic-msgs-page min-h-screen px-[24px] pb-[60px] pt-[20px]"
      headNavClassName="aic-msgs-head mb-[14px] flex flex-wrap items-center gap-[8px]"
    >
      <h1 className="aic-msgs-h1">🧑‍🏫 选择倾诉老师</h1>
      <p className="aic-msgs-sub">
        选择一位你信任的心理老师，发起点对点私密倾诉，老师会一对一为你答疑疏导。
      </p>

      {teachersQuery.isLoading ? <LoadingSkeleton rows={3} /> : null}

      {teachersQuery.isError ? (
        <div className="text-center">
          <p className="aic-msgs-empty-tip">加载失败，请检查网络。</p>
          <button
            type="button"
            className="aic-msgs-back"
            onClick={() => void teachersQuery.refetch()}
          >
            重试
          </button>
        </div>
      ) : null}

      {!teachersQuery.isLoading && !teachersQuery.isError ? (
        <div className="aic-msgs-teacher-list">
          {teachers.length === 0 ? (
            <p className="aic-msgs-empty-tip">暂无可倾诉的老师，请稍后再试。</p>
          ) : null}
          {teachers.map((teacher) => (
            <button
              key={teacher.id}
              type="button"
              className="aic-msgs-teacher-item"
              disabled={Boolean(creatingId)}
              onClick={() => void startConversation(teacher)}
            >
              <span className="aic-msgs-conv-avatar">👩‍🏫</span>
              <span className="aic-msgs-teacher-main">
                <span className="aic-msgs-teacher-name">{teacher.name}</span>
                <span className="aic-msgs-teacher-class">{teacher.class || ''}</span>
              </span>
              {teacher.class_count > 0 ? (
                <Badge variant="secondary" className="shrink-0">
                  {teacher.class_count} 个班级
                </Badge>
              ) : null}
              <span className="aic-msgs-teacher-go">
                {creatingId === teacher.id ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : null}
                去倾诉 →
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </AppShell>
  );
}

export default function ChooseTeacherPage() {
  return (
    <AuthGuard role="student">
      <ChooseTeacherContent />
    </AuthGuard>
  );
}
