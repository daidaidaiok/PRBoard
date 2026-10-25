"use client";

import { useEffect } from "react";

/**
 * Registers the offline-shell service worker. Production only — dev's
 * aggressive recompilation makes a caching service worker actively hostile
 * there, and an unrefreshed stale worker is the classic "why is my dev
 * server broken" trap.
 */
export function SwRegistrar() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch((error) => {
      console.error("[sw] registration failed", error);
    });
  }, []);

  return null;
}
