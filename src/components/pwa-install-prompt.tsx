"use client";

import * as React from "react";
import { Download, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

const DISMISSED_KEY = "prboard:pwa-install-dismissed";

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

function isStandalone() {
  try {
    return (
      window.matchMedia("(display-mode: standalone)").matches ||
      (window.navigator as { standalone?: boolean }).standalone === true
    );
  } catch {
    return false;
  }
}

function safeGetItem(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSetItem(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // storage may be blocked (private mode, enterprise policy, etc.) — no-op
  }
}

export function PwaInstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] =
    React.useState<BeforeInstallPromptEvent | null>(null);
  const [isIOS, setIsIOS] = React.useState(false);
  const [dismissed, setDismissed] = React.useState(true);

  React.useEffect(() => {
    if (isStandalone() || safeGetItem(DISMISSED_KEY)) return;
    // Standalone/localStorage/user-agent are only knowable on the client after
    // mount, so this genuinely can't be derived during render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDismissed(false);
    setIsIOS(
      (/iPad|iPhone|iPod/.test(navigator.userAgent) ||
        // iPadOS 13+ defaults to a desktop UA with no "iPad" token.
        (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)) &&
        !("MSStream" in window),
    );

    const onBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setDeferredPrompt(event as BeforeInstallPromptEvent);
    };
    const onInstalled = () => dismiss();

    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  function dismiss() {
    safeSetItem(DISMISSED_KEY, "1");
    setDismissed(true);
  }

  async function install() {
    if (!deferredPrompt) return;
    await deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    setDeferredPrompt(null);
    // Only persist a permanent dismissal when the user actually accepts —
    // cancelling the native dialog shouldn't suppress the prompt forever.
    if (outcome === "accepted") dismiss();
  }

  if (dismissed || (!deferredPrompt && !isIOS)) return null;

  return (
    <Card className="fixed inset-x-4 bottom-4 z-50 mx-auto max-w-sm shadow-lg sm:inset-x-auto sm:left-4">
      <CardContent className="flex items-start gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <Download className="size-4" />
        </div>
        <div className="flex-1 space-y-1">
          <p className="text-sm font-medium">安装 PRboard</p>
          {isIOS ? (
            <p className="text-sm text-muted-foreground">
              点击分享按钮 <span aria-hidden>⎋</span>，选择「添加到主屏幕」
              <span aria-hidden>➕</span>，即可像 App 一样使用。
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              安装到桌面/主屏幕，获得更快启动和独立窗口体验。
            </p>
          )}
          {!isIOS && (
            <Button size="sm" className="mt-2" onClick={install}>
              安装
            </Button>
          )}
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          className="-mt-1 -mr-1"
          onClick={dismiss}
          aria-label="关闭"
        >
          <X className="size-3.5" />
        </Button>
      </CardContent>
    </Card>
  );
}
