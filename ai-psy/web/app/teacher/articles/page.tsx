'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';

import { AppShell } from '@/components/business/app-shell';
import { AuthGuard } from '@/components/business/auth-guard';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { ApiError, apiFetch, del, getJson, postJson } from '@/lib/api';
import type { Article } from '@/lib/types';
import { formatTimestamp } from '@/lib/utils';

const PAGE_SIZE = 10;
const SEED_PREFIX = 'seed-';

interface ArticleListData {
  items: Article[];
  total: number;
}

interface ArticleFormState {
  title: string;
  source: string;
  summary: string;
  content: string;
}

const EMPTY_FORM: ArticleFormState = { title: '', source: '', summary: '', content: '' };

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

function normalizeArticleList(raw: unknown): ArticleListData {
  const items = pickArray<Article>(raw, 'articles');
  const total =
    raw && typeof raw === 'object' && typeof (raw as { total?: unknown }).total === 'number'
      ? (raw as { total: number }).total
      : items.length;
  return { items, total };
}

function isSeedArticle(article: Article): boolean {
  return article.id.startsWith(SEED_PREFIX);
}

function ArticlesContent() {
  const { toast } = useToast();
  const router = useRouter();
  const queryClient = useQueryClient();

  const [page, setPage] = useState(1);
  const [keyword, setKeyword] = useState('');
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<ArticleFormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [deletingArticle, setDeletingArticle] = useState<Article | null>(null);
  const [deleting, setDeleting] = useState(false);

  const articlesQuery = useQuery({
    queryKey: ['teacher', 'articles', page],
    queryFn: async () =>
      normalizeArticleList(
        await getJson<unknown>(`/api/teacher/articles?page=${page}&page_size=${PAGE_SIZE}`),
      ),
  });

  const articles = articlesQuery.data?.items ?? [];
  const total = articlesQuery.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const filteredArticles = useMemo(() => {
    const keywordLower = keyword.trim().toLowerCase();
    if (!keywordLower) {
      return articles;
    }
    return articles.filter(
      (article) =>
        article.title.toLowerCase().includes(keywordLower) ||
        (article.source ?? '').toLowerCase().includes(keywordLower),
    );
  }, [articles, keyword]);

  const openCreate = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setEditorOpen(true);
  };

  const openEdit = (article: Article) => {
    setEditingId(article.id);
    setForm({
      title: article.title,
      source: article.source ?? '',
      summary: article.summary ?? '',
      content: article.content ?? '',
    });
    setEditorOpen(true);
  };

  const handleSave = async () => {
    if (!form.title.trim()) {
      toast({ title: '请填写文章标题', variant: 'destructive' });
      return;
    }
    if (!form.content.trim()) {
      toast({ title: '请填写文章正文', variant: 'destructive' });
      return;
    }
    setSaving(true);
    try {
      const payload = {
        title: form.title.trim(),
        source: form.source.trim(),
        summary: form.summary.trim(),
        content: form.content.trim(),
      };
      if (editingId) {
        // 后端未封装 PUT，保持同一 apiFetch 入口以携带 Cookie。
        await apiFetch(`/api/teacher/articles/${encodeURIComponent(editingId)}`, {
          method: 'PUT',
          body: JSON.stringify(payload),
        });
      } else {
        await postJson('/api/teacher/articles', payload);
      }
      toast({
        title: editingId ? '文章已更新' : '文章已发布',
        description: '学生端刷新后即可看到最新内容',
        variant: 'success',
      });
      setEditorOpen(false);
      setEditingId(null);
      const nextPage = editingId ? page : 1;
      setPage(nextPage);
      await queryClient.invalidateQueries({ queryKey: ['teacher', 'articles'] });
    } catch (error) {
      toast({
        title: '保存失败',
        description: error instanceof ApiError ? error.message : '网络异常，请稍后重试',
        variant: 'destructive',
      });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!deletingArticle) {
      return;
    }
    setDeleting(true);
    try {
      await del(`/api/teacher/articles/${encodeURIComponent(deletingArticle.id)}`);
      toast({ title: '文章已删除', variant: 'success' });
      setDeletingArticle(null);
      // 当前页被删空时回到上一页，避免停在空列表。
      if (articles.length === 1 && page > 1) {
        setPage(page - 1);
      }
      await queryClient.invalidateQueries({ queryKey: ['teacher', 'articles'] });
    } catch (error) {
      toast({
        title: '删除失败',
        description: error instanceof ApiError ? error.message : '网络异常，请稍后重试',
        variant: 'destructive',
      });
    } finally {
      setDeleting(false);
    }
  };

  return (
    <AppShell role="teacher" bare>
      {/* 旧版 .page 全屏容器（teacher_articles.css：max-width none，padding 20px 24px 70px） */}
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

        <div className="aic-ta-page-head">
          <div>
            <h1 className="aic-page-title">📰 心理科普文章管理</h1>
            <p className="aic-ta-sub">
              新增 / 编辑 / 删除心理科普文章，保存后学生端首页与文章页刷新即自动同步。
            </p>
          </div>
          <button type="button" className="aic-ta-btn aic-ta-btn-primary" onClick={openCreate}>
            ＋ 新建文章
          </button>
        </div>

        {/* 新版搜索（旧版无此控件），样式向旧版圆角输入框靠拢 */}
        <div className="mb-[18px] flex flex-wrap items-center gap-[12px]">
          <input
            className="aic-ta-search"
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder="搜索标题 / 来源（当前页）"
          />
          <span className="aic-ta-page-info">
            共 {total} 篇 · 当前页 {filteredArticles.length} 篇
          </span>
        </div>

        {articlesQuery.isError ? (
          <Alert variant="destructive" className="mb-4">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription className="flex items-center justify-between gap-3">
              文章列表加载失败，请稍后重试。
              <Button variant="outline" size="sm" onClick={() => void articlesQuery.refetch()}>
                <RefreshCw className="h-3.5 w-3.5" />
                重试
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}

        {articlesQuery.isLoading ? <div className="aic-ta-loading">加载中…</div> : null}

        {/* 文章列表（行式卡片） */}
        <div className="aic-ta-list">
          {filteredArticles.map((article) => {
            const seed = isSeedArticle(article);
            return (
              <div key={article.id} className="aic-ta-row">
                <div className="aic-ta-info">
                  <div className="aic-ta-title-line">
                    <span className="aic-ta-title">{article.title}</span>
                    {seed ? (
                      <span className="aic-ta-tag builtin">系统内置</span>
                    ) : (
                      <span className="aic-ta-tag">教师发布</span>
                    )}
                  </div>
                  <div className="aic-ta-meta">
                    来源：{article.source || '系统默认权威来源'}
                    {article.author ? ` · 发布人：${article.author}` : ''}
                    {` · 发布于 ${formatTimestamp(article.created_at)}`}
                    {article.updated_at ? ` · 更新于 ${formatTimestamp(article.updated_at)}` : ''}
                  </div>
                </div>
                <div className="aic-ta-ops">
                  <button
                    type="button"
                    className="aic-ta-btn aic-ta-btn-ghost"
                    onClick={() => openEdit(article)}
                    disabled={seed}
                    title={seed ? '内置文章不可编辑' : undefined}
                  >
                    编辑
                  </button>
                  <button
                    type="button"
                    className="aic-ta-btn aic-ta-btn-danger-ghost"
                    onClick={() => setDeletingArticle(article)}
                    disabled={seed}
                    title={seed ? '内置文章不可删除' : undefined}
                  >
                    删除
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        {/* 空状态 */}
        {!articlesQuery.isLoading && filteredArticles.length === 0 ? (
          <div className="aic-ta-empty-tip">
            {keyword
              ? '没有匹配的文章，请调整搜索关键词，或翻页查看其他内容。'
              : '暂无文章，点击右上角「新建文章」发布第一篇心理科普推文吧。'}
          </div>
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
              第 {page} / {totalPages} 页 · 共 {total} 篇文章
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

      {/* 新建/编辑文章弹窗（旧版 modal-mask + modal-panel 结构） */}
      {editorOpen ? (
        <div
          className="aic-ta-modal-mask"
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              setEditorOpen(false);
            }
          }}
        >
          <div className="aic-ta-modal-panel">
            <div className="aic-ta-modal-head">
              <h3>{editingId ? '✏️ 编辑文章' : '＋ 新建文章'}</h3>
              <button
                type="button"
                className="aic-ta-modal-close"
                onClick={() => setEditorOpen(false)}
              >
                ✕
              </button>
            </div>
            <div>
              <label className="aic-ta-field">
                <span className="aic-ta-field-label">
                  文章标题 <em>*</em>
                </span>
                <input
                  type="text"
                  value={form.title}
                  onChange={(event) => setForm({ ...form, title: event.target.value })}
                  maxLength={60}
                  placeholder="如：考前焦虑自救指南"
                  required
                />
              </label>
              <label className="aic-ta-field">
                <span className="aic-ta-field-label">文章来源（选填）</span>
                <input
                  type="text"
                  value={form.source}
                  onChange={(event) => setForm({ ...form, source: event.target.value })}
                  maxLength={60}
                  placeholder="如：校心理健康中心，留空则用系统默认来源"
                />
              </label>
              <label className="aic-ta-field">
                <span className="aic-ta-field-label">文章简介（选填）</span>
                <textarea
                  rows={2}
                  value={form.summary}
                  onChange={(event) => setForm({ ...form, summary: event.target.value })}
                  maxLength={120}
                  placeholder="一句话简介，展示在学生端列表页…"
                />
              </label>
              <label className="aic-ta-field">
                <span className="aic-ta-field-label">
                  文章正文 <em>*</em>
                </span>
                <textarea
                  className="aic-ta-content"
                  rows={10}
                  value={form.content}
                  onChange={(event) => setForm({ ...form, content: event.target.value })}
                  placeholder="支持换行的长文本，保存后学生端详情页按段落展示…"
                  required
                />
              </label>
              <div className="aic-ta-modal-foot">
                <button
                  type="button"
                  className="aic-ta-btn aic-ta-btn-ghost"
                  onClick={() => setEditorOpen(false)}
                  disabled={saving}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="aic-ta-btn aic-ta-btn-primary"
                  onClick={() => void handleSave()}
                  disabled={saving}
                >
                  {saving ? '保存中…' : '保存'}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {/* 删除二次确认弹窗 */}
      {deletingArticle ? (
        <div
          className="aic-ta-modal-mask"
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              setDeletingArticle(null);
            }
          }}
        >
          <div className="aic-ta-modal-panel modal-confirm">
            <div className="aic-ta-modal-head">
              <h3>⚠️ 删除确认</h3>
              <button
                type="button"
                className="aic-ta-modal-close"
                onClick={() => setDeletingArticle(null)}
              >
                ✕
              </button>
            </div>
            <p className="aic-ta-confirm-text">
              确定要删除文章《{deletingArticle.title}》吗？删除后学生端将不再展示，且不可恢复。
            </p>
            <div className="aic-ta-modal-foot">
              <button
                type="button"
                className="aic-ta-btn aic-ta-btn-ghost"
                onClick={() => setDeletingArticle(null)}
                disabled={deleting}
              >
                取消
              </button>
              <button
                type="button"
                className="aic-ta-btn aic-ta-btn-danger"
                onClick={() => void handleDelete()}
                disabled={deleting}
              >
                确认删除
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </AppShell>
  );
}

export default function TeacherArticlesPage() {
  return (
    <AuthGuard role="teacher">
      <ArticlesContent />
    </AuthGuard>
  );
}
