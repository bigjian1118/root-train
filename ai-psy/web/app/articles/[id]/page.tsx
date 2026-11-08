'use client';

import { useRouter } from 'next/navigation';
import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';

import { AppShell } from '@/components/business/app-shell';
import { AuthGuard } from '@/components/business/auth-guard';
import { MarkdownText } from '@/components/business/markdown-text';
import { ApiError, getJson } from '@/lib/api';
import type { Article } from '@/lib/types';

// 1:1 复刻旧版 static/articles.html 详情视图 + articles.js renderDetail：
// 「← 返回列表」按钮 + 来源徽章 / 渐变标题 / 发布日期 / 封面 / 长文排版 / 科普来源 / 说明文案。

interface ArticleDetailPayload {
  article?: Article;
}

/** 后端学生端正文是转好的 HTML，纯文本/Markdown 才交给 MarkdownText。 */
function isHtmlContent(content: string): boolean {
  return /<[a-z][\s\S]*>/i.test(content);
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

function ArticleDetailContent() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const id = decodeURIComponent(params.id ?? '');

  const detailQuery = useQuery({
    queryKey: ['article', id],
    queryFn: () => getJson<ArticleDetailPayload>(`/api/articles/${encodeURIComponent(id)}`),
    enabled: Boolean(id),
  });
  const article = detailQuery.data?.article;
  const is404 = detailQuery.error instanceof ApiError && detailQuery.error.status === 404;

  return (
    <AppShell bare>
      {/* 旧版容器：body 即 .page（全屏宽，padding 20px 24px 60px） */}
      <div className="min-h-screen px-[24px] pb-[60px] pt-[20px]">
        <button type="button" className="aic-back" onClick={() => router.push('/articles')}>
          ← 返回列表
        </button>

        {detailQuery.isLoading ? <div className="aic-loading">加载中…</div> : null}

        {detailQuery.isError && !is404 ? (
          <p className="aic-empty-tip">
            文章详情加载失败，请稍后重试。
            <button
              type="button"
              className="aic-page-btn"
              style={{ marginLeft: 10 }}
              onClick={() => void detailQuery.refetch()}
            >
              重新加载
            </button>
          </p>
        ) : null}

        {is404 ? <p className="aic-empty-tip">文章不存在或已下架。</p> : null}

        {article ? (
          <>
            <div className="aic-source-tag">📌 {article.source || '权威校园心理科普'}</div>
            <h1 className="aic-detail-title">{article.title}</h1>
            <p className="aic-detail-date">📅 发布于 {fmtDate(article.created_at)}</p>

            {article.cover ? (
              <div className="aic-detail-cover">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={article.cover}
                  alt={article.title}
                  onError={(event) => {
                    // 旧版口径：封面加载失败隐藏整个封面块
                    event.currentTarget.closest('.aic-detail-cover')?.setAttribute('hidden', '');
                  }}
                />
              </div>
            ) : null}

            {isHtmlContent(article.content ?? '') ? (
              <article
                className="aic-detail-content"
                dangerouslySetInnerHTML={{ __html: article.content ?? '' }}
              />
            ) : (
              <article className="aic-detail-content">
                <MarkdownText content={article.content ?? ''} />
              </article>
            )}

            <p className="aic-detail-source">📌 科普来源：{article.source || '权威校园心理科普'}</p>
            <p className="aic-detail-doc">
              ⚠️ 本文为校园心理科普内容，供日常生活参考；如有持续困扰，请及时联系学校心理老师或拨打心理援助热线。
            </p>
          </>
        ) : null}
      </div>
    </AppShell>
  );
}

export default function ArticleDetailPage() {
  return (
    <AuthGuard role="student">
      <ArticleDetailContent />
    </AuthGuard>
  );
}
