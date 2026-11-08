import { forwardRef, type HTMLAttributes } from 'react';

import { cn } from '@/lib/utils';

interface ProgressProps extends HTMLAttributes<HTMLDivElement> {
  value?: number;
}

export const Progress = forwardRef<HTMLDivElement, ProgressProps>(
  ({ value = 0, className, ...props }, ref) => {
    const percent = Math.min(100, Math.max(0, value));
    return (
      <div
        ref={ref}
        role="progressbar"
        aria-valuenow={Math.round(percent)}
        aria-valuemin={0}
        aria-valuemax={100}
        className={cn('relative h-[10px] w-full overflow-hidden rounded-pill bg-brand-sky/20', className)}
        {...props}
      >
        <div
          className="h-full rounded-pill bg-gradient-to-r from-brand-sky via-brand-green to-brand-gold transition-[width] duration-300 ease-out"
          style={{ width: `${percent}%` }}
        />
      </div>
    );
  },
);
Progress.displayName = 'Progress';
