/**
 * `fetch` with a default request timeout, shared by every service client.
 *
 * A bare `fetch` has no timeout: a hung or slow Unibo host would hang the tool
 * call indefinitely. This attaches an `AbortSignal.timeout` (unless the caller
 * already passed a `signal`) and turns the resulting abort into a clear,
 * actionable error rather than an opaque `AbortError`.
 */

/** Default per-request timeout. Unibo's SSO/servlet stack is occasionally slow,
 * so this is generous rather than aggressive. */
export const DEFAULT_FETCH_TIMEOUT_MS = 20_000;

export async function fetchWithTimeout(
  input: string | URL,
  init: RequestInit & { timeoutMs?: number } = {}
): Promise<Response> {
  const { timeoutMs = DEFAULT_FETCH_TIMEOUT_MS, signal, ...rest } = init;
  try {
    return await fetch(input, { ...rest, signal: signal ?? AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      throw new Error(`Request to ${String(input)} timed out after ${timeoutMs}ms.`);
    }
    throw err;
  }
}
