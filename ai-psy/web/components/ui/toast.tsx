'use client';

import { AlertTriangle, CheckCircle2, X } from 'lucide-react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

import { cn } from '@/lib/utils';

type ToastVariant = 'default' | 'success' | 'destructive';

interface ToastItem {
  id: string;
  title: string;
  description?: string;
  variant: ToastVariant;
}

interface ToastOptions {
  title: string;
  description?: string;
  variant?: ToastVariant;
}

interface ToastContextValue {
  toast: (options: ToastOptions | string) => void;
  dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const TOAST_DURATION = 3200;

const VARIANT_STYLES: Record<ToastVariant, string> = {
  default: 'border-border bg-card text-foreground',
  success: 'border-emerald-500/30 bg-emerald-50 text-emerald-900',
  destructive: 'border-destructive/40 bg-destructive/10 text-destructive',
};

function ToastIcon({ variant }: { variant: ToastVariant }) {
  if (variant === 'success') {
    return <CheckCircle2 className="h-5 w-5 text-emerald-600" />;
  }
  if (variant === 'destructive') {
    return <AlertTriangle className="h-5 w-5 text-destructive" />;
  }
  return null;
}

/** 轻量消息提示：不引入第三方库，页面用 useToast().toast(...) 调用。 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const dismiss = useCallback((id: string) => {
    setItems((current) => current.filter((item) => item.id !== id));
  }, []);

  const toast = useCallback((options: ToastOptions | string) => {
    const normalized: ToastOptions = typeof options === 'string' ? { title: options } : options;
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    setItems((current) => [
      ...current,
      {
        id,
        title: normalized.title,
        description: normalized.description,
        variant: normalized.variant ?? 'default',
      },
    ]);
    window.setTimeout(() => {
      setItems((current) => current.filter((item) => item.id !== id));
    }, TOAST_DURATION);
  }, []);

  return (
    <ToastContext.Provider value={{ toast, dismiss }}>
      {children}
      {mounted
        ? createPortal(
            <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex flex-col items-center gap-2 px-4">
              {items.map((item) => (
                <div
                  key={item.id}
                  role="status"
                  className={cn(
                    'pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-xl border px-4 py-3 shadow-lg animate-fade-in',
                    VARIANT_STYLES[item.variant],
                  )}
                >
                  <ToastIcon variant={item.variant} />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{item.title}</p>
                    {item.description ? (
                      <p className="mt-1 text-xs leading-5 opacity-80">{item.description}</p>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    aria-label="关闭提示"
                    onClick={() => dismiss(item.id)}
                    className="rounded p-1 opacity-60 transition-opacity hover:opacity-100"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>,
            document.body,
          )
        : null}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast 必须在 ToastProvider 内使用');
  }
  return context;
}
