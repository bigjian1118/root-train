'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { AuthGuard } from '@/components/business/auth-guard';
import { getJson, postJson } from '@/lib/api';
import type { Article, ArticlesResponse } from '@/lib/types';
import { useAuthStore } from '@/store/use-auth-store';

// 1:1 复刻旧版 static/js/index.js：pageSize=12、标题本地过滤（防抖 250ms）、
// 搜索时隐藏分页、上一页/下一页按页码隐藏、来源长名压缩为短标签。
const PAGE_SIZE = 12;

interface UnreadResponse {
  role?: string;
  total?: number;
}

function shortSource(source?: string | null): string {
  if (!source || source.indexOf('权威校园心理科普') !== -1) return '权威校园心理科普';
  return source;
}

function fmtDate(ts: number | null): string {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  return (
    d.getFullYear() +
    '-' +
    String(d.getMonth() + 1).padStart(2, '0') +
    '-' +
    String(d.getDate()).padStart(2, '0')
  );
}

// ===== 顶栏（index.html header.topbar + auth.js 身份徽章 + msg_entries.js 红点） =====
function HomeTopbar() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const user = useAuthStore((state) => state.user);
  const clearUser = useAuthStore((state) => state.clearUser);
  const [loggingOut, setLoggingOut] = useState(false);

  const unreadQuery = useQuery({
    queryKey: ['msg', 'unread'],
    queryFn: () => getJson<UnreadResponse>('/api/msg/unread'),
  });
  const isTeacher = user?.role === 'teacher';
  const unreadTotal = unreadQuery.data?.total ?? 0;

  const handleLogout = async () => {
    if (loggingOut) return;
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

  return (
    <header className="aic-topbar">
      <Link href="/" className="aic-logo">
        心晴<span>·</span>AI 心理空间
      </Link>
      <nav className="aic-nav">
        {/* 旧版 auth.js：.student-feature 入口对教师隐藏（点进去会被学生角色守卫弹回） */}
        {isTeacher ? null : (
          <>
            <Link href="/chat">聊天助手</Link>
            <Link href="/face">视频分析</Link>
            <Link href="/test">心理测评</Link>
            <Link href="/appointment">预约咨询</Link>
            <Link href="/articles">心理科普</Link>
          </>
        )}
        {isTeacher ? <Link href="/teacher/materials">素材库</Link> : null}
        {/* 旧版逻辑：/api/msg/unread 返回后才显示入口；请求失败也放行入口、不加红点 */}
        {!unreadQuery.isLoading ? (
          <Link href={isTeacher ? '/teacher/msg' : '/msg'} className="aic-msg-entry">
            师生倾诉
            {unreadTotal > 0 ? (
              <span className="aic-msg-badge">{unreadTotal > 99 ? '99+' : String(unreadTotal)}</span>
            ) : null}
          </Link>
        ) : null}
        {user ? (
          <span className="aic-auth-badge">
            <span className="who">
              你好，<b>{user.name}</b>
            </span>
            <button type="button" className="profile-btn" onClick={() => router.push('/profile')}>
              🏠 个人中心
            </button>
            <button type="button" className="auth-logout" onClick={handleLogout} disabled={loggingOut}>
              退出
            </button>
          </span>
        ) : null}
      </nav>
    </header>
  );
}

// ===== 悬浮回到顶部（index.js scrollThreshold=420） =====
function BackToTop() {
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const onScroll = () => setShown(window.scrollY > 420);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <button
      type="button"
      className={`aic-back-top${shown ? ' show' : ''}`}
      aria-label="回到顶部"
      onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
    >
      <span className="bt-arrow">▲</span>
      <span className="bt-tip">回到顶部</span>
    </button>
  );
}

// ===== 首页文章区（index.js loadList/renderList/搜索防抖） =====
function HomeArticles() {
  const [page, setPage] = useState(1);
  const [keyword, setKeyword] = useState('');
  const [debouncedKeyword, setDebouncedKeyword] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  // 旧版防抖 250ms
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedKeyword(keyword.trim().toLowerCase()), 250);
    return () => clearTimeout(timer);
  }, [keyword]);

  const listQuery = useQuery<ArticlesResponse>({
    queryKey: ['articles', 'home', page],
    queryFn: () => getJson<ArticlesResponse>(`/api/articles?page=${page}&page_size=${PAGE_SIZE}`),
  });

  const articles = listQuery.data?.articles ?? [];
  const totalPages = Math.max(1, Math.ceil((listQuery.data?.total ?? 0) / PAGE_SIZE));
  const searching = Boolean(debouncedKeyword);
  const visibleArticles = searching
    ? articles.filter((a: Article) => String(a.title || '').toLowerCase().includes(debouncedKeyword))
    : articles;

  const gotoPage = (next: number) => {
    setPage(next);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <div className="aic-article-wrap">
      <div className="mb-5 px-2">
        <h2>心理科普文章</h2>
        <p className="aic-arc-sub">科学 · 正向 · 治愈 · 落地，陪你在成长路上照顾好自己</p>
      </div>

      <div className="aic-arc-search">
        <input
          ref={searchRef}
          type="text"
          id="arcSearch"
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          placeholder="搜索标题或正文关键词，如：焦虑、睡眠、考试…"
          aria-label="搜索心理科普文章"
        />
        <button
          type="button"
          id="arcSearchClear"
          hidden={!keyword}
          aria-label="清空搜索"
          onClick={() => {
            setKeyword('');
            searchRef.current?.focus();
          }}
        >
          ✕
        </button>
      </div>

      {listQuery.isLoading ? <div className="aic-loading">加载中…</div> : null}

      {listQuery.isError ? <p className="aic-empty-tip">加载失败，请稍后重试。</p> : null}

      {!listQuery.isLoading && !listQuery.isError ? (
        visibleArticles.length === 0 ? (
          <p className="aic-empty-tip">
            未找到相关科普文章 😶‍🌫️
            <br />
            <span style={{ fontSize: 12, color: '#9cb0bd' }}>换个关键词试试吧~</span>
          </p>
        ) : (
          <div className="aic-article-list">
            {visibleArticles.map((article) => (
              <Link key={article.id} href={`/articles/${article.id}`} className="aic-arc-card">
                <div className="aic-arc-info">
                  <h3 className="aic-arc-title">{article.title}</h3>
                  <p className="aic-arc-summary">{article.summary}</p>
                  <span className="aic-arc-tags">
                    <em className="aic-arc-src">📌 {shortSource(article.source)}</em>
                    <em className="aic-arc-date">📅 {fmtDate(article.created_at)}</em>
                  </span>
                </div>
                <span className="aic-arc-go">阅读全文 →</span>
              </Link>
            ))}
          </div>
        )
      ) : null}

      {/* 旧版逻辑：搜索状态隐藏分页；仅一页时隐藏分页；首末页隐藏对应按钮 */}
      {!searching && !listQuery.isLoading && !listQuery.isError && totalPages > 1 ? (
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
    </div>
  );
}

function HomeContent() {
  const router = useRouter();
  const user = useAuthStore((state) => state.user);

  // 教师不使用师生共用首页，直接跳转个人中心
  useEffect(() => {
    if (user?.role === 'teacher') {
      router.replace('/teacher/account');
    }
  }, [user?.role, router]);

  if (user?.role === 'teacher') {
    return null;
  }

  return (
    <div className="relative flex min-h-screen flex-col overflow-hidden">
      <HomeTopbar />

      <main className="aic-hero">
        <div className="hero-glow glow-a" />
        <div className="hero-glow glow-b" />
        <h1 className="aic-title">
          看见每一种情绪
          <br />
          <em>陪伴每一段成长</em>
        </h1>
        <p className="aic-subtitle">AI 驱动 · 温暖治愈 · 科学量表 · 守护青少年心灵</p>

        <div className="w-full">
          <HomeArticles />
        </div>
      </main>

      <footer className="aic-footer">
        ⚠️ 本平台 AI 分析仅供参考，不能替代专业心理诊断与治疗。 如需帮助请拨打心理援助热线
        400-161-9995。
      </footer>

      <BackToTop />
    </div>
  );
}

export default function HomePage() {
  // 旧版 index.html 为师生共用首页（顶栏按角色显示素材库/倾诉入口），不限定角色。
  return (
    <AuthGuard>
      <HomeContent />
    </AuthGuard>
  );
}
