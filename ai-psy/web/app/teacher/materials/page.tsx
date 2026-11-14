'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useRef, useState } from 'react';

import { AppShell } from '@/components/business/app-shell';
import { AuthGuard } from '@/components/business/auth-guard';
import { MaterialAiPanel } from '@/components/business/material-ai-panel';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { apiFetch, getJson } from '@/lib/api';
import type { MaterialItem } from '@/lib/types';

const PAGE_SIZE = 8;

// 素材分类选项：与旧版 teacher_materials.html 的 categoryFilter / matCategory 下拉一致
const MATERIAL_CATEGORIES = ['班会方案', '团体活动方案', '心理科普PPT', '其他'];

interface MaterialListData {
  items: MaterialItem[];
  total: number;
}

function pickArray<T>(raw: unknown, key: string): T[] {
  if (Array.isArray(raw)) {
    return raw as T[];
  }
  if (raw && typeof raw === 'object') {
    const record = raw as Record<string, unknown>;
    if (Array.isArray(record[key])) {
      return record[key] as T[];
    }
    if (Array.isArray(record.items)) {
      return record.items as T[];
    }
    if (Array.isArray(record.data)) {
      return record.data as T[];
    }
  }
  return [];
}

function normalizeMaterialList(raw: unknown): MaterialListData {
  const items = pickArray<MaterialItem>(raw, 'materials');
  const total =
    raw && typeof raw === 'object' && typeof (raw as { total?: unknown }).total === 'number'
      ? (raw as { total: number }).total
      : items.length;
  return { items, total };
}

function formatBytes(size?: number): string {
  if (!size || size <= 0) {
    return '—';
  }
  if (size >= 1024 * 1024) {
    return `${(size / 1024 / 1024).toFixed(2)} MB`;
  }
  if (size >= 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${size} B`;
}

// 分类角标配色：与旧版 catClass 映射一致（团体活动方案绿、心理科普PPT 金，其余默认蓝）。
function categoryClass(category: string): string {
  if (category === '团体活动方案') {
    return 'cat-group';
  }
  if (category === '心理科普PPT') {
    return 'cat-ppt';
  }
  return '';
}

function MaterialsContent() {
  const { toast } = useToast();
  const router = useRouter();
  const queryClient = useQueryClient();

  const [page, setPage] = useState(1);
  const [keywordDraft, setKeywordDraft] = useState('');
  const [keyword, setKeyword] = useState('');
  const [category, setCategory] = useState<string>('');
  const [detailId, setDetailId] = useState<string | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  // 新增功能：AI 智能生成方案抽屉（1:1 还原时保留的入口，勿删）
  const [aiOpen, setAiOpen] = useState(false);
  const [form, setForm] = useState<{
    title: string;
    category: string;
    brief: string;
    file: File | null;
  }>({ title: '', category: MATERIAL_CATEGORIES[0], brief: '', file: null });
  const fileInputRef = useRef<HTMLInputElement>(null);

  const materialsQuery = useQuery({
    queryKey: ['teacher', 'materials', page],
    queryFn: async () =>
      normalizeMaterialList(
        await getJson<unknown>(`/api/teacher/materials?page=${page}&page_size=${PAGE_SIZE}`),
      ),
  });

  const detailQuery = useQuery({
    queryKey: ['teacher', 'materials', 'detail', detailId],
    queryFn: async () =>
      getJson<MaterialItem>(`/api/teacher/materials/${encodeURIComponent(detailId ?? '')}`),
    enabled: Boolean(detailId),
  });

  const upload = useMutation({
    mutationFn: async (payload: FormData) => {
      // apiFetch 已把响应体解析为 JSON 返回（并非 Response 对象）；
      // FormData 不能手动设 Content-Type，multipart 边界由浏览器自动生成
      return apiFetch<{ ok: boolean; material_id: string; title: string }>(
        '/api/teacher/materials/upload',
        { method: 'POST', body: payload },
      );
    },
    onSuccess: () => {
      toast({ title: '素材上传成功', variant: 'success' });
      setUploadOpen(false);
      setForm({ title: '', category: MATERIAL_CATEGORIES[0], brief: '', file: null });
      setPage(1);
      queryClient.invalidateQueries({ queryKey: ['teacher', 'materials'] });
    },
    onError: (error: Error) => {
      toast({ title: '上传失败', description: error.message, variant: 'destructive' });
    },
  });

  const materials = materialsQuery.data?.items ?? [];
  const total = materialsQuery.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const filteredMaterials = useMemo(() => {
    const keywordLower = keyword.trim().toLowerCase();
    return materials.filter((material) => {
      const matchesKeyword =
        !keywordLower ||
        material.title.toLowerCase().includes(keywordLower) ||
        (material.brief ?? '').toLowerCase().includes(keywordLower);
      const matchesCategory = !category || material.category === category;
      return matchesKeyword && matchesCategory;
    });
  }, [materials, keyword, category]);

  const selected = detailQuery.data ?? materials.find((material) => material.material_id === detailId);

  const handleDownload = async (id: string) => {
    try {
      // 下载返回二进制流，apiFetch 会按文本解析破坏内容，必须用原生 fetch 拿 Response
      const res = await fetch(`/api/teacher/materials/${encodeURIComponent(id)}/download`, {
        credentials: 'include',
      });
      if (!res.ok) {
        let message = `下载失败（${res.status}）`;
        try {
          const data = (await res.json()) as { error?: string };
          if (data.error) message = data.error;
        } catch {
          /* 非 JSON 错误体，保留状态码提示 */
        }
        throw new Error(message);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'material';
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      toast({
        title: '下载失败',
        description: error instanceof Error ? error.message : '网络异常，请稍后重试',
        variant: 'destructive',
      });
    }
  };

  const submitUpload = () => {
    if (!form.title.trim()) {
      toast({ title: '请填写素材标题', variant: 'destructive' });
      return;
    }
    if (!form.file) {
      toast({ title: '请选择要上传的文件', variant: 'destructive' });
      return;
    }
    const payload = new FormData();
    payload.append('title', form.title.trim());
    payload.append('category', form.category);
    payload.append('brief', form.brief.trim());
    payload.append('file', form.file);
    upload.mutate(payload);
  };

  return (
    <AppShell role="teacher" bare>
      {/* 旧版 .page 全屏容器（teacher_materials.css：max-width none，padding 20px 24px 70px） */}
      <div className="min-h-screen px-[24px] pb-[70px] pt-[20px]">
        {/* 顶部导航：旧版 back-link 文案为「返回个人中心」，指向 /profile */}
        <div className="mb-[14px] flex flex-wrap items-center gap-[10px]">
          <button type="button" className="aic-back" onClick={() => router.back()}>
            ← 返回上一页
          </button>
          <Link href="/profile" className="aic-back-link">
            返回个人中心
          </Link>
        </div>

        <h1 className="aic-page-title">📚 心理活动素材库</h1>
        <p className="aic-tm-sub">
          班会方案 / 团体活动方案 / 心理科普PPT，全部教师可查看与下载，仅作为心理健康教育工作参考。
        </p>

        {/* 工具栏：搜索框 + 分类筛选 + 上传（旧版一行布局；AI 生成入口为新版新增，置于上传按钮左侧） */}
        <div className="aic-tm-toolbar">
          <div className="aic-tm-search-box">
            <input
              className="aic-tm-search"
              value={keywordDraft}
              onChange={(event) => setKeywordDraft(event.target.value)}
              placeholder="🔍 搜索素材标题…"
              autoComplete="off"
            />
            {keywordDraft ? (
              <button
                type="button"
                className="aic-tm-search-clear"
                title="清空"
                onClick={() => {
                  setKeywordDraft('');
                  setKeyword('');
                }}
              >
                ✕
              </button>
            ) : null}
          </div>
          <select
            className="aic-tm-category"
            value={category}
            onChange={(event) => setCategory(event.target.value)}
            aria-label="筛选分类"
          >
            <option value="">全部分类</option>
            {MATERIAL_CATEGORIES.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
          {/* 新版为本地过滤，需点「搜索」应用关键词（旧版为输入防抖） */}
          <Button size="sm" variant="outline" onClick={() => setKeyword(keywordDraft)}>
            搜索
          </Button>
          <button type="button" className="aic-ta-btn aic-ta-btn-ghost" onClick={() => setAiOpen(true)}>
            ✨ AI 智能生成方案
          </button>
          <button type="button" className="aic-ta-btn aic-ta-btn-primary" onClick={() => setUploadOpen(true)}>
            ⬆ 上传素材
          </button>
        </div>

        {materialsQuery.isError ? (
          <Alert variant="destructive" className="mt-4">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription className="flex items-center justify-between gap-3">
              素材列表加载失败，请稍后重试。
              <Button variant="outline" size="sm" onClick={() => void materialsQuery.refetch()}>
                <RefreshCw className="h-3.5 w-3.5" />
                重试
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}

        {materialsQuery.isLoading ? <div className="aic-tm-loading">加载中…</div> : null}

        {/* 素材卡片网格 */}
        <div className="aic-tm-grid">
          {filteredMaterials.map((material) => (
            <div key={material.material_id} className="aic-tm-card">
              <div className="aic-tm-top">
                <span className={`aic-tm-cat ${categoryClass(material.category)}`}>
                  {material.category}
                </span>
              </div>
              <div className="aic-tm-title">{material.title}</div>
              {material.brief ? <div className="aic-tm-brief">{material.brief}</div> : null}
              <div className="aic-tm-meta">
                {`📎 ${material.file_name ?? '素材文件'} · 上传：${material.uploader_name ?? material.uploader ?? '—'} · ${material.upload_time ?? '—'}`}
              </div>
              <div className="aic-tm-foot">
                <button
                  type="button"
                  className="aic-ta-btn aic-ta-btn-ghost"
                  onClick={() => setDetailId(material.material_id)}
                >
                  查看详情
                </button>
                <button
                  type="button"
                  className="aic-ta-btn aic-ta-btn-primary"
                  onClick={() => void handleDownload(material.material_id)}
                >
                  ⬇ 下载
                </button>
              </div>
            </div>
          ))}
        </div>

        {/* 空状态 */}
        {!materialsQuery.isLoading && filteredMaterials.length === 0 ? (
          <div className="aic-tm-empty">暂无匹配的素材，点击右上角「上传素材」分享你的第一份方案吧。</div>
        ) : null}

        {/* 分页 */}
        {total > 0 ? (
          <div className="aic-ta-pager">
            <button
              type="button"
              className="aic-ta-page-btn"
              onClick={() => setPage((current) => Math.max(1, current - 1))}
              disabled={page <= 1}
            >
              ← 上一页
            </button>
            <span className="aic-ta-page-info">
              第 {page} / {totalPages} 页 · 共 {total} 份素材
            </span>
            <button
              type="button"
              className="aic-ta-page-btn"
              onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
              disabled={page >= totalPages}
            >
              下一页 →
            </button>
          </div>
        ) : null}
      </div>

      {/* 素材详情弹窗（旧版 modal-mask + modal-panel 620px） */}
      {detailId ? (
        <div
          className="aic-ta-modal-mask"
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              setDetailId(null);
            }
          }}
        >
          <div className="aic-ta-modal-panel aic-tm-panel-detail">
            <div className="aic-ta-modal-head">
              <h3>📄 素材详情</h3>
              <button type="button" className="aic-ta-modal-close" onClick={() => setDetailId(null)}>
                ✕
              </button>
            </div>
            <div className="aic-tm-detail-body">
              {detailQuery.isPending ? (
                <div className="aic-tm-detail-meta">加载中…</div>
              ) : detailQuery.data ? (
                <>
                  <div className="aic-tm-detail-title">{detailQuery.data.title}</div>
                  <span className="aic-tm-detail-chip">{detailQuery.data.category}</span>
                  <div className="aic-tm-detail-meta">
                    {`📎 ${detailQuery.data.file_name ?? '素材文件'}（${formatBytes(detailQuery.data.file_size)}）`}
                    <br />
                    {`上传：${detailQuery.data.uploader_name ?? detailQuery.data.uploader ?? '—'} · ${detailQuery.data.upload_time ?? '—'}`}
                  </div>
                  {detailQuery.data.brief ? (
                    <div className="aic-tm-detail-brief">{detailQuery.data.brief}</div>
                  ) : (
                    <div className="aic-tm-detail-meta">暂无简介</div>
                  )}
                </>
              ) : (
                <div className="aic-tm-detail-meta">素材详情加载失败，请稍后重试。</div>
              )}
            </div>
            <div className="aic-ta-modal-foot">
              <button type="button" className="aic-ta-btn aic-ta-btn-ghost" onClick={() => setDetailId(null)}>
                关闭
              </button>
              <button
                type="button"
                className="aic-ta-btn aic-ta-btn-primary"
                onClick={() => void handleDownload(selected?.material_id ?? detailId)}
              >
                ⬇ 下载文件
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* 上传素材弹窗（旧版 modal-mask + modal-panel 520px） */}
      {uploadOpen ? (
        <div
          className="aic-ta-modal-mask"
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              setUploadOpen(false);
            }
          }}
        >
          <div className="aic-ta-modal-panel aic-tm-panel-upload">
            <div className="aic-ta-modal-head">
              <h3>⬆ 上传素材</h3>
              <button type="button" className="aic-ta-modal-close" onClick={() => setUploadOpen(false)}>
                ✕
              </button>
            </div>
            <div>
              <label className="aic-ta-field">
                <span className="aic-ta-field-label">
                  素材标题 <em>*</em>
                </span>
                <input
                  type="text"
                  value={form.title}
                  onChange={(event) => setForm({ ...form, title: event.target.value })}
                  maxLength={60}
                  placeholder="如：开学季情绪调适主题班会"
                  required
                />
              </label>
              <label className="aic-ta-field">
                <span className="aic-ta-field-label">
                  素材分类 <em>*</em>
                </span>
                <select
                  className="aic-tm-field-select"
                  value={form.category}
                  onChange={(event) => setForm({ ...form, category: event.target.value })}
                  required
                >
                  {MATERIAL_CATEGORIES.map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </select>
              </label>
              <label className="aic-ta-field">
                <span className="aic-ta-field-label">素材简介（选填）</span>
                <textarea
                  rows={3}
                  maxLength={300}
                  value={form.brief}
                  onChange={(event) => setForm({ ...form, brief: event.target.value })}
                  placeholder="简要说明素材的适用场景与使用方法…"
                />
              </label>
              <label className="aic-ta-field">
                <span className="aic-ta-field-label">
                  选择文件 <em>*</em>
                </span>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".pdf,.docx,.pptx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.presentationml.presentation"
                  className="aic-tm-file-input"
                  onChange={(event) =>
                    setForm({ ...form, file: event.target.files?.[0] ?? null })
                  }
                />
                <span
                  className={`aic-tm-file-pick ${form.file ? 'has-file' : ''}`}
                  onClick={() => fileInputRef.current?.click()}
                >
                  {form.file ? `✅ ${form.file.name}` : '📎 点击选择本地文件（支持 pdf / docx / pptx，不限大小）'}
                </span>
              </label>
              <div className="aic-ta-modal-foot">
                <button
                  type="button"
                  className="aic-ta-btn aic-ta-btn-ghost"
                  onClick={() => setUploadOpen(false)}
                  disabled={upload.isPending}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="aic-ta-btn aic-ta-btn-primary"
                  onClick={submitUpload}
                  disabled={upload.isPending}
                >
                  {upload.isPending ? '上传中…' : '提交上传'}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {/* 新增功能：AI 智能生成方案抽屉（召回预览 → 生成 → 轮询 → 结果页/保存入库） */}
      <MaterialAiPanel open={aiOpen} onClose={() => setAiOpen(false)} />
    </AppShell>
  );
}

export default function TeacherMaterialsPage() {
  return (
    <AuthGuard role="teacher">
      <MaterialsContent />
    </AuthGuard>
  );
}
