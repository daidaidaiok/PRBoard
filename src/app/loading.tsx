import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Route-level loading shell, shown while the page's server component is
 * awaiting the session and installation checks. Mirrors the dashboard's
 * header + first-card silhouette so the swap-in doesn't jump.
 */
export default function Loading() {
  return (
    <div className="flex flex-1 flex-col" aria-busy="true">
      <header className="sticky top-0 z-30 flex items-center justify-between border-b border-white/40 bg-white/35 px-6 py-3.5 backdrop-blur-[28px] dark:border-white/10 dark:bg-[#0b1220]/55">
        <Skeleton className="h-7 w-36" />
        <Skeleton className="size-7 rounded-full" />
      </header>
      <div className="flex flex-1 flex-col gap-4 p-4 sm:p-6">
        <div className="flex items-center justify-between">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-8 w-16 rounded-md" />
        </div>
        <div className="flex flex-col gap-3">
          {Array.from({ length: 3 }, (_, i) => (
            <Card key={i} aria-hidden="true">
              <CardContent className="flex flex-col gap-2 py-5">
                <Skeleton className="h-3 w-28" />
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-3 w-44" />
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}
