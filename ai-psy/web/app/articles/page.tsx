'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { AppShell } from '@/components/business/app-shell';
import { AuthGuard } from '@/components/business/auth-guard';
import { useScrollRestore } from '@/components/business/detail-page-shell';
import { getJson } from '@/lib/api';
import type { Article, ArticlesResponse } from '@/lib/types';

// 1:1 复刻旧版 static/articles.html + articles.css + articles.js：
// 全屏容器、单列卡片、上一页/下一页分页（pageSize=6，单页隐藏分页）；
// 列表页码记忆与滚动位置恢复为已确认新增特性，保持不变。

// 与旧版 articles.js 一致：每页 6 篇
const PAGE_SIZE = 6;
const LIST_STATE_KEY = 'list-state:articles';
// 与旧版 back-top 一致：滚动超过 420px 显示
const BACK_TOP_THRESHOLD = 420;

// 后端新版返回 {articles,total,...}，任务约定为 {items,...}，两种都兼容。
type ArticleListPayload = Partial<ArticlesResponse> & { items?: Article[]; articles?: Article[] };

function articleListOf(payload?: ArticleListPayload): Article[] {
  if (!payload) {
    return [];
  }
  return payload.items ?? payload.articles ?? [];
}

// 时间戳 -> yyyy-MM-dd（与旧版 fmtDate 一致）
function fmtDate(ts?: number | null): string {
  if (!ts) {
    return '';
  }
  const d = new Date(ts * 1000);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

// 来源长名压缩为短标签（与旧版 shortSource 一致）
function shortSource(source?: string): string {
  if (!source || source.includes('权威校园心理科普')) {
    return '权威校园心理科普';
  }
  return source;
}

function ArticlesContent() {
  const router = useRouter();
  const [savedState] = useState(() => {
    try {
      return JSON.parse(sessionStorage.getItem(LIST_STATE_KEY) ?? '{}') as { page?: number };
    } catch {
      return {};
    }
  });
  const [page, setPage] = useState(Math.max(1, savedState.page ?? 1));
  const [showBackTop, setShowBackTop] = useState(false);

  useScrollRestore('scroll:articles');

  const listQuery = useQuery({
    queryKey: ['articles', page],
    queryFn: () =>
      getJson<ArticleListPayload>(`/api/articles?page=${page}&page_size=${PAGE_SIZE}`),
  });

  useEffect(() => {
    sessionStorage.setItem(LIST_STATE_KEY, JSON.stringify({ page }));
  }, [page]);

  // 旧版 back-top：滚动超过阈值淡入，点击平滑回顶
  useEffect(() => {
    const onScroll = () => setShowBackTop(window.scrollY > BACK_TOP_THRESHOLD);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const articles = articleListOf(listQuery.data);
  const total = listQuery.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const errorText = listQuery.isError ? '加载失败，请稍后重试。' : '';

  const gotoPage = (next: number) => {
    setPage(next);
    window.scrollTo(0, 0);
  };

  return (
    <AppShell
      role="student"
      pageClassName="min-h-screen px-[24px] pb-[60px] pt-[20px]"
      headNavClassName="mb-[12px] flex flex-wrap items-center gap-[10px]"
    >
      <h1 className="aic-page-title">📖 心理科普文章</h1>
      <p className="aic-page-sub" style={{ marginBottom: 26 }}>
        科学 · 正向 · 治愈 · 落地，陪你在成长路上照顾好自己
      </p>

      <div className="aic-art-list">
        {listQuery.isLoading ? <div className="aic-loading">加载中…</div> : null}
        {errorText ? <p className="aic-empty-tip">{errorText}</p> : null}
        {!listQuery.isLoading && !errorText && articles.length === 0 ? (
          <p className="aic-empty-tip">暂无科普文章，教师发布后即可阅读。</p>
        ) : null}
        {articles.map((article) => (
          <a
            key={article.id}
            className="aic-art-card"
            href={`#/article/${article.id}`}
            onClick={(event) => {
              event.preventDefault();
              router.push(`/articles/${encodeURIComponent(article.id)}`);
            }}
          >
            <div className="aic-art-info">
              <h3 className="aic-art-title">{article.title}</h3>
              <p className="aic-art-summary">{article.summary}</p>
              <span className="aic-art-tags">
                <em className="aic-art-src">📌 {shortSource(article.source)}</em>
                <em className="aic-art-date">📅 {fmtDate(article.created_at)}</em>
              </span>
            </div>
          </a>
        ))}
      </div>

      {/* 旧版分页：单页时隐藏整行，首/末页隐藏对应按钮 */}
      {totalPages > 1 ? (
        <div className="aic-pager">
          <button
            type="button"
            className="aic-page-btn"
            hidden={page <= 1}
            onClick={() => gotoPage(page - 1)}
          >
            上一页
          </button>
          <span className="aic-page-info">
            第 {page} / {totalPages} 页
          </span>
          <button
            type="button"
            className="aic-page-btn"
            hidden={page >= totalPages}
            onClick={() => gotoPage(page + 1)}
          >
            下一页
          </button>
        </div>
      ) : null}

      <button
        type="button"
        aria-label="回到顶部"
        className={showBackTop ? 'aic-back-top show' : 'aic-back-top'}
        onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
      >
        <span className="bt-arrow">▲</span>
        <span className="bt-tip">回到顶部</span>
      </button>
    </AppShell>
  );
}

export default function ArticlesPage() {
  return (
    <AuthGuard role="student">
      <ArticlesContent />
    </AuthGuard>
  );
}
