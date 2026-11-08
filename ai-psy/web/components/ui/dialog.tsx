'use client';

import { X } from 'lucide-react';
import {
  Children,
  cloneElement,
  createContext,
  forwardRef,
  isValidElement,
  useContext,
  useEffect,
  useState,
  type HTMLAttributes,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

import { cn } from '@/lib/utils';

interface DialogContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
}

const DialogContext = createContext<DialogContextValue | null>(null);

function useDialogContext(): DialogContextValue {
  const context = useContext(DialogContext);
  if (!context) {
    throw new Error('Dialog 子组件必须在 <Dialog> 内使用');
  }
  return context;
}

interface DialogProps {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
}

/** 纯 React 对话框：不依赖 radix，受控/非受控都可用。 */
export function Dialog({ open, defaultOpen = false, onOpenChange, children }: DialogProps) {
  const [innerOpen, setInnerOpen] = useState(defaultOpen);
  const currentOpen = open ?? innerOpen;

  const setOpen = (next: boolean) => {
    if (open === undefined) {
      setInnerOpen(next);
    }
    onOpenChange?.(next);
  };

  return (
    <DialogContext.Provider value={{ open: currentOpen, setOpen }}>
      {children}
    </DialogContext.Provider>
  );
}

interface DialogTriggerProps {
  asChild?: boolean;
  children: ReactElement;
}

export function DialogTrigger({ asChild, children }: DialogTriggerProps) {
  const { setOpen } = useDialogContext();

  if (asChild && isValidElement(children)) {
    const child = Children.only(children) as ReactElement<{
      onClick?: (event: MouseEvent<HTMLElement>) => void;
    }>;
    return cloneElement(child, {
      onClick: (event: MouseEvent<HTMLElement>) => {
        child.props.onClick?.(event);
        setOpen(true);
      },
    });
  }

  return (
    <button type="button" onClick={() => setOpen(true)}>
      {children}
    </button>
  );
}

interface DialogContentProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
}

export const DialogContent = forwardRef<HTMLDivElement, DialogContentProps>(
  ({ className, children, ...props }, ref) => {
    const { open, setOpen } = useDialogContext();
    const [mounted, setMounted] = useState(false);

    useEffect(() => {
      setMounted(true);
    }, []);

    useEffect(() => {
      if (!open) {
        return;
      }
      const handleKeyDown = (event: KeyboardEvent) => {
        if (event.key === 'Escape') {
          setOpen(false);
        }
      };
      document.addEventListener('keydown', handleKeyDown);
      const previousOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      return () => {
        document.removeEventListener('keydown', handleKeyDown);
        document.body.style.overflow = previousOverflow;
      };
    }, [open, setOpen]);

    if (!open || !mounted) {
      return null;
    }

    return createPortal(
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div
          className="absolute inset-0 bg-slate-950/45 backdrop-blur-sm"
          onClick={() => setOpen(false)}
          aria-hidden
        />
        <div
          ref={ref}
          role="dialog"
          aria-modal="true"
          className={cn(
            'relative z-10 max-h-[90vh] w-full max-w-lg animate-fade-in overflow-y-auto rounded-2xl border border-border bg-card p-6 shadow-xl',
            className,
          )}
          {...props}
        >
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="关闭"
            className="absolute right-4 top-4 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
          {children}
        </div>
      </div>,
      document.body,
    );
  },
);
DialogContent.displayName = 'DialogContent';

interface DialogCloseProps {
  asChild?: boolean;
  children: ReactElement;
}

export function DialogClose({ asChild, children }: DialogCloseProps) {
  const { setOpen } = useDialogContext();

  if (asChild && isValidElement(children)) {
    const child = Children.only(children) as ReactElement<{
      onClick?: (event: MouseEvent<HTMLElement>) => void;
    }>;
    return cloneElement(child, {
      onClick: (event: MouseEvent<HTMLElement>) => {
        child.props.onClick?.(event);
        setOpen(false);
      },
    });
  }

  return (
    <button type="button" onClick={() => setOpen(false)}>
      {children}
    </button>
  );
}

export const DialogHeader = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('flex flex-col space-y-1.5 pr-8', className)} {...props} />
  ),
);
DialogHeader.displayName = 'DialogHeader';

export const DialogFooter = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn('mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)}
      {...props}
    />
  ),
);
DialogFooter.displayName = 'DialogFooter';

export const DialogTitle = forwardRef<HTMLHeadingElement, HTMLAttributes<HTMLHeadingElement>>(
  ({ className, ...props }, ref) => (
    <h2 ref={ref} className={cn('text-lg font-semibold tracking-tight', className)} {...props} />
  ),
);
DialogTitle.displayName = 'DialogTitle';

export const DialogDescription = forwardRef<
  HTMLParagraphElement,
  HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
  <p ref={ref} className={cn('text-sm leading-6 text-muted-foreground', className)} {...props} />
));
DialogDescription.displayName = 'DialogDescription';
