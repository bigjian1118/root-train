'use client';

import {
  Loader2, Sparkles, X,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/toast';
import { ApiError, getJson, postJson } from '@/lib/api';
import type { MaterialAiParams, MaterialAiTaskState } from '@/lib/types';
import { cn } from '@/lib/utils';

// 抽屉表单参数持久化：跳结果页返回后恢复上次填写内容。
const PANEL_STATE_KEY = 'material-ai-form';

const PLAN_TYPE_PRESETS = ['活动方案', '班会方案', '教学设计', '实训方案'];
const AUDIENCE_PRESETS = ['小学生', '初中生', '高中生', '中职生', '大学生'];
const STYLE_PRESETS = ['积极活泼', '乐观向上', '严谨认真', '轻松趣味', '思政导向', '实操导向'];
const LENGTH_OPTIONS = [
  { value: 'brief', label: '精简版（约800字）' },
  { value: 'standard', label: '标准版（约1500字）' },
  { value: 'detailed', label: '详细版（约3000字）' },
];

const DEFAULT_PARAMS: MaterialAiParams = {
  plan_type: '活动方案',
  audience: '初中生',
  styles: ['严谨认真'],
  keywords: '',
  description: '',
  length_preset: 'standard',
};

const STATUS_TEXT: Record<string, string> = {
  queued: '任务已排队…',
  recalling: '正在检索校内存量素材…',
  generating: '大模型整合生成方案中（约 1-2 分钟）…',
  saving: '整理生成结果…',
};

/** Chip 快捷选项 + 自定义输入的组合控件。 */
function PresetField({ label, presets, value, onChange, error }: {
  label: string;
  presets: string[];
  value: string;
  onChange: (value: string) => void;
  error?: string | null;
}) {
  const isCustom = value !== '' && !presets.includes(value);
  return (
    <div className="space-y-2">
      <Label>{label}<span className="ml-1 text-destructive">*</span></Label>
      <div className="flex flex-wrap gap-2">
        {presets.map((preset) => (
          <button
            key={preset}
            type="button"
            onClick={() => onChange(preset)}
            className={cn(
              'rounded-pill border px-3 py-1.5 text-xs transition-colors',
              value === preset
                ? 'border-brand-skyDeep bg-brand-sky/20 font-bold text-brand-skyDeep'
                : 'border-brand-sky/35 bg-white/70 hover:bg-brand-sky/10',
            )}
          >
            {preset}
          </button>
        ))}
        <Input
          value={isCustom ? value : ''}
          onChange={(event) => onChange(event.target.value)}
          placeholder={`或自定义${label}`}
          className="h-8 w-36 text-xs"
          maxLength={30}
        />
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

export function MaterialAiPanel({ open, onClose }: {
  open: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const { toast } = useToast();

  const [phase, setPhase] = useState<'form' | 'running'>('form');
  const [params, setParams] = useState<MaterialAiParams>(() => {
    try {
      const saved = sessionStorage.getItem(PANEL_STATE_KEY);
      return saved ? (JSON.parse(saved) as MaterialAiParams) : DEFAULT_PARAMS;
    } catch {
      return DEFAULT_PARAMS;
    }
  });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [lowMatchDialog, setLowMatchDialog] = useState(false);
  const [task, setTask] = useState<MaterialAiTaskState | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const pollRef = useRef<number | null>(null);

  // 关闭面板即停止轮询并复位；结果展示已页面化（/teacher/ai/result/[taskId]）。
  useEffect(() => {
    if (!open) {
      if (pollRef.current) {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
      }
      setPhase('form');
      setTask(null);
      setLowMatchDialog(false);
    }
    return () => {
      if (pollRef.current) {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [open]);

  const validate = (): boolean => {
    const errors: Record<string, string> = {};
    if (!params.plan_type.trim()) {
      errors.plan_type = '方案类型必填';
    }
    if (!params.audience.trim()) {
      errors.audience = '面向对象必填';
    }
    if (params.styles.length === 0) {
      errors.styles = '内容风格至少选择一项';
    }
    if (!params.keywords.trim()) {
      errors.keywords = '核心关键词必填，多个用空格或逗号分隔';
    }
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const startTask = async (confirmLowMatch: boolean) => {
    setSubmitting(true);
    try {
      sessionStorage.setItem(PANEL_STATE_KEY, JSON.stringify(params));
      const result = await postJson<{ task_id: string }>('/api/teacher/materials/ai/generate', {
        ...params,
        confirm_low_match: confirmLowMatch,
      });
      setLowMatchDialog(false);
      setPhase('running');
      pollTask(result.task_id);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 428) {
        setLowMatchDialog(true);
      } else {
        toast({
          title: '无法开始生成',
          description: caught instanceof ApiError ? caught.message : '网络异常，请稍后重试',
          variant: 'destructive',
        });
      }
    } finally {
      setSubmitting(false);
    }
  };

  const pollTask = (taskId: string) => {
    pollRef.current = window.setInterval(async () => {
      try {
        const state = await getJson<MaterialAiTaskState>(
          `/api/teacher/materials/ai/task/${taskId}`,
        );
        setTask(state);
        if (['completed', 'failed', 'cancelled', 'timeout'].includes(state.status)) {
          if (pollRef.current) {
            window.clearInterval(pollRef.current);
            pollRef.current = null;
          }
          if (state.status === 'completed') {
            // 结果全文改为独立页面展示（支持刷新、新标签页直达、前进后退）
            router.push(`/teacher/ai/result/${encodeURIComponent(taskId)}`);
            onClose();
          } else {
            setPhase('form');
            toast({
              title: '生成未完成',
              description: state.error_message ?? '任务已取消',
              variant: 'destructive',
            });
          }
        }
      } catch {
        // 单次轮询失败忽略，下一轮自动重试
      }
    }, 2000);
  };

  const handleGenerate = () => {
    if (!validate()) {
      return;
    }
    void startTask(false);
  };

  const handleCancel = async () => {
    if (!task) {
      return;
    }
    try {
      await postJson(`/api/teacher/materials/ai/task/${task.task_id}/cancel`);
    } catch {
      // 取消接口失败也切回表单，任务侧以状态标记为准
    }
    if (pollRef.current) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
    setPhase('form');
    setTask(null);
  };

  return (
    <>
      {/* 右侧滑出抽屉：不遮挡左侧素材列表，支持边浏览边调参 */}
      <div
        className={cn(
          'fixed inset-y-0 right-0 z-50 w-full max-w-xl transform bg-white/95 shadow-2xl backdrop-blur transition-transform duration-300',
          open ? 'translate-x-0' : 'translate-x-full',
        )}
        role="dialog"
        aria-label="AI 方案生成配置面板"
      >
        <div className="flex h-full flex-col">
          <div className="flex items-center justify-between border-b border-brand-sky/25 bg-topbar px-6 py-4">
            <h2 className="flex items-center gap-2 text-base font-bold">
              <Sparkles className="h-5 w-5 text-brand-skyDeep" />
              AI 智能生成方案
              <span className="text-xs font-normal text-muted-foreground">基于校内存量素材整合生成</span>
            </h2>
            <Button variant="ghost" size="sm" onClick={onClose}>
              <X className="h-4 w-4" />
            </Button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-6">
            {phase === 'form' ? (
              <div className="space-y-5">
                <PresetField
                  label="方案类型"
                  presets={PLAN_TYPE_PRESETS}
                  value={params.plan_type}
                  onChange={(value) => setParams((c) => ({ ...c, plan_type: value }))}
                  error={fieldErrors.plan_type}
                />
                <PresetField
                  label="面向对象"
                  presets={AUDIENCE_PRESETS}
                  value={params.audience}
                  onChange={(value) => setParams((c) => ({ ...c, audience: value }))}
                  error={fieldErrors.audience}
                />

                <div className="space-y-2">
                  <Label>内容风格（可多选）<span className="ml-1 text-destructive">*</span></Label>
                  <div className="flex flex-wrap gap-2">
                    {STYLE_PRESETS.map((style) => {
                      const active = params.styles.includes(style);
                      return (
                        <button
                          key={style}
                          type="button"
                          onClick={() => setParams((c) => ({
                            ...c,
                            styles: active
                              ? c.styles.filter((item) => item !== style)
                              : [...c.styles, style],
                          }))}
                          className={cn(
                            'rounded-pill border px-3 py-1.5 text-xs transition-colors',
                            active
                              ? 'border-brand-greenDeep bg-brand-green/40 font-bold text-[#3f8f66]'
                              : 'border-brand-sky/35 bg-white/70 hover:bg-brand-sky/10',
                          )}
                        >
                          {style}
                        </button>
                      );
                    })}
                  </div>
                  {fieldErrors.styles ? <p className="text-xs text-destructive">{fieldErrors.styles}</p> : null}
                </div>

                <div className="space-y-2">
                  <Label htmlFor="ai-keywords">核心关键词<span className="ml-1 text-destructive">*</span></Label>
                  <Input
                    id="ai-keywords"
                    value={params.keywords}
                    maxLength={100}
                    onChange={(event) => setParams((c) => ({ ...c, keywords: event.target.value }))}
                    placeholder="多个关键词用空格或逗号分隔，如：学雷锋 志愿服务 三月"
                  />
                  {fieldErrors.keywords ? <p className="text-xs text-destructive">{fieldErrors.keywords}</p> : null}
                </div>

                <div className="space-y-2">
                  <Label htmlFor="ai-desc">补充描述（选填）</Label>
                  <Textarea
                    id="ai-desc"
                    rows={3}
                    maxLength={500}
                    value={params.description}
                    onChange={(event) => setParams((c) => ({ ...c, description: event.target.value }))}
                    placeholder="方案背景、核心目标、特殊要求等，用于细化生成方向"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="ai-length">预期篇幅（选填）</Label>
                  <Select
                    id="ai-length"
                    value={params.length_preset}
                    onChange={(event) => setParams((c) => ({
                      ...c, length_preset: event.target.value as MaterialAiParams['length_preset'],
                    }))}
                  >
                    {LENGTH_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </Select>
                </div>

                {task && ['failed', 'timeout'].includes(task.status) ? (
                  <Alert variant="destructive">
                    <AlertDescription>{task.error_message ?? '生成失败，请重试'}</AlertDescription>
                  </Alert>
                ) : null}
              </div>
            ) : null}

            {phase === 'running' && task ? (
              <div className="space-y-4 py-8">
                <p className="text-sm font-medium">{STATUS_TEXT[task.status] ?? '处理中…'}</p>
                <Progress value={task.progress} />
                <p className="text-xs text-muted-foreground">
                  进度 {task.progress}% · 已召回素材 {task.recall_count || '检索中'} 份 · 可随时取消
                </p>
                <Button variant="outline" onClick={() => void handleCancel()}>
                  <X className="h-4 w-4" />
                  取消生成
                </Button>
              </div>
            ) : null}
          </div>

          <div className="border-t border-brand-sky/25 px-6 py-4">
            {phase === 'form' ? (
              <Button className="w-full" onClick={handleGenerate} disabled={submitting}>
                {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                开始生成
              </Button>
            ) : null}
          </div>
        </div>
      </div>

      {/* 遮罩：点击收起面板 */}
      <div
        className={cn(
          'fixed inset-0 z-40 bg-black/20 transition-opacity',
          open ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
        onClick={onClose}
        aria-hidden
      />

      {/* 低匹配二次确认 */}
      <Dialog open={lowMatchDialog} onOpenChange={setLowMatchDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>相关素材较少</DialogTitle>
            <DialogDescription>
              当前匹配到的相关素材较少，将结合通用教学模板补充生成（生成内容中会明确标注），是否继续？
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setLowMatchDialog(false)} disabled={submitting}>
              返回调整关键词
            </Button>
            <Button onClick={() => void startTask(true)} disabled={submitting}>
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              继续生成
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
