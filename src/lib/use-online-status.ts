import { useEffect, useState } from "react";

/**
 * `navigator.onLine` synced to the browser's online/offline events. Starts
 * optimistically `true` so server render and hydration agree (no mismatch);
 * the effect corrects it immediately after mount — an offline user sees the
 * banner one commit later, which is the best a client-only signal can do.
 * Note `onLine` is heuristic (it can't see captive portals); it decides
 * whether we *pause polling*, never whether data is trusted.
 */
export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState(true);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOnline(navigator.onLine);
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  return online;
}
