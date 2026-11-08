import { Skeleton } from '@/components/ui/skeleton';

interface LoadingSkeletonProps {
  rows?: number;
}

export function LoadingSkeleton({ rows = 3 }: LoadingSkeletonProps) {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="加载中">
      <Skeleton className="h-9 w-2/5" />
      {Array.from({ length: rows }).map((_, index) => (
        <div key={index} className="rounded-lg border border-border p-5">
          <Skeleton className="mb-3 h-5 w-1/3" />
          <Skeleton className="mb-2 h-4 w-full" />
          <Skeleton className="h-4 w-4/5" />
        </div>
      ))}
    </div>
  );
}
