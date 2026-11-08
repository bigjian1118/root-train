'use client';

import { useQueryClient } from '@tanstack/react-query';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';

import { postJson } from '@/lib/api';
import { useAuthStore } from '@/store/use-auth-store';

// 位移超过该阈值才判定为拖动，避免单击被误判为拖拽（旧版 auth.js 同为 3px）。
const DRAG_THRESHOLD_PX = 3;

interface DragState {
  dragging: boolean;
  moved: boolean;
  startX: number;
  startY: number;
  originLeft: number;
  originTop: number;
}

interface BadgePosition {
  left: number;
  top: number;
}

/**
 * 全站悬浮身份徽章：1:1 复刻旧版 static/js/auth.js 注入的 .auth-badge。
 * 固定右上角、可拖动（视口内自由移动，释放不回弹）、个人中心页隐藏「个人中心」回跳按钮。
 * 首页自带 topbar 徽章（不使用 AppShell），因此不会重复出现。
 */
export function AuthBadge() {
  const router = useRouter();
  const pathname = usePathname();
  const queryClient = useQueryClient();
  const user = useAuthStore((state) => state.user);
  const clearUser = useAuthStore((state) => state.clearUser);

  const badgeRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState>({
    dragging: false,
    moved: false,
    startX: 0,
    startY: 0,
    originLeft: 0,
    originTop: 0,
  });
  const [position, setPosition] = useState<BadgePosition | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  useEffect(() => {
    const handleMouseMove = (event: globalThis.MouseEvent) => {
      const drag = dragRef.current;
      if (!drag.dragging) {
        return;
      }
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) > DRAG_THRESHOLD_PX) {
        drag.moved = true;
      }
      if (!drag.moved) {
        return;
      }
      const node = badgeRef.current;
      if (!node) {
        return;
      }
      // 限制在视口内，避免拖出屏幕后无法操作
      const left = Math.min(Math.max(drag.originLeft + dx, 0), window.innerWidth - node.offsetWidth);
      const top = Math.min(Math.max(drag.originTop + dy, 0), window.innerHeight - node.offsetHeight);
      setPosition({ left, top });
    };

    const handleMouseUp = () => {
      const drag = dragRef.current;
      if (!drag.dragging) {
        return;
      }
      drag.dragging = false;
      setIsDragging(false);
      if (!drag.moved) {
        return;
      }
      // 拖动结束时吞掉紧随的 click，防止误触「个人中心 / 退出」
      const node = badgeRef.current;
      const swallowClick = (event: globalThis.MouseEvent) => {
        event.stopPropagation();
        event.preventDefault();
      };
      node?.addEventListener('click', swallowClick, true);
      window.setTimeout(() => node?.removeEventListener('click', swallowClick, true), 0);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  const handleMouseDown = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) {
      return;
    }
    const node = badgeRef.current;
    if (!node) {
      return;
    }
    const rect = node.getBoundingClientRect();
    dragRef.current = {
      dragging: true,
      moved: false,
      startX: event.clientX,
      startY: event.clientY,
      originLeft: rect.left,
      originTop: rect.top,
    };
    // 切换为 left/top 锚定，避免 right 锚定时拖动跳位
    setPosition({ left: rect.left, top: rect.top });
    setIsDragging(true);
    event.preventDefault();
  };

  const handleLogout = async () => {
    if (loggingOut) {
      return;
    }
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

  // 未登录时 AuthGuard 尚未渲染子页，这里兜底不输出任何内容
  if (!user) {
    return null;
  }

  const isProfilePage = pathname === '/profile';

  return (
    <div
      ref={badgeRef}
      className={`aic-float-badge${isDragging ? ' auth-dragging' : ''}`}
      style={position ? { left: position.left, top: position.top, right: 'auto' } : undefined}
      onMouseDown={handleMouseDown}
    >
      <span className="who">
        你好，<b>{user.name}</b>
      </span>
      {isProfilePage ? null : (
        <button type="button" className="profile-btn" onClick={() => router.push('/profile')}>
          🏠 个人中心
        </button>
      )}
      <button
        type="button"
        className="auth-logout"
        onClick={() => void handleLogout()}
        disabled={loggingOut}
      >
        退出
      </button>
    </div>
  );
}
