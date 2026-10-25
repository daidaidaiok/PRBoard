"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

/**
 * Route-level error boundary. Without this, any server component throw
 * (a DB hiccup in the page shell, a bad redirect) renders Next's default
 * error page — jarring and unbranded — with no way to retry in place.
 * `retry` (stable since Next 16.3) re-fetches the server tree, which is
 * the only thing that can clear a server-side failure; `reset` would just
 * re-render the same failed payload.
 */
export default function Error({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error("[app] route error boundary hit", error);
  }, [error]);

  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <Card className="max-w-lg border-destructive/50">
        <CardHeader>
          <h2 className="text-xl font-semibold">页面加载失败</h2>
        </CardHeader>
        <CardContent className="space-y-4 text-sm text-muted-foreground">
          <p>{error.message || "发生未知错误。"}</p>
          <Button onClick={retry}>重试</Button>
        </CardContent>
      </Card>
    </main>
  );
}
