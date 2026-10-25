/**
 * Client-side fetch with a hard wall-clock bound. Without it, a hung request
 * (dead Wi-Fi, stalled proxy) leaves the UI spinning until the browser gives
 * up on its own — which can be minutes — and the fallback poll never learns
 * anything went wrong. Returns the Response or throws; timeout surfaces as a
 * DOMException named "TimeoutError" (via AbortSignal.timeout), while a
 * caller-aborted signal still surfaces as "AbortError", so superseded
 * requests and timed-out requests stay distinguishable.
 */
export const DEFAULT_FETCH_TIMEOUT_MS = 20_000;

export function fetchWithTimeout(
  input: string,
  init?: Omit<RequestInit, "signal"> & { signal?: AbortSignal; timeoutMs?: number },
): Promise<Response> {
  const { timeoutMs = DEFAULT_FETCH_TIMEOUT_MS, signal, ...rest } = init ?? {};
  const signals: AbortSignal[] = [AbortSignal.timeout(timeoutMs)];
  if (signal) signals.push(signal);
  return fetch(input, { ...rest, signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals) });
}

/**
 * True when the error came from the timeout bound (not a caller abort).
 * Callers that pass their own signal should ALSO treat "AbortError with an
 * un-aborted controller" as a timeout — WebKit doesn't propagate abort
 * reasons (bugs.webkit.org/show_bug.cgi?id=246069), so there a timeout
 * surfaces as a bare AbortError and this check alone won't fire.
 */
export function isTimeoutError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "TimeoutError";
}
