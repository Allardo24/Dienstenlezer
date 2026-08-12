type FetchRetryOptions = {
  retries?: number;
  delayMs?: number;
};

const RETRYABLE_SERVER_STATUSES = new Set([502, 503, 504]);

export async function fetchWithRetry(
  input: RequestInfo | URL,
  init?: RequestInit,
  options: FetchRetryOptions = {},
): Promise<Response> {
  const retries = options.retries ?? 1;
  const delayMs = options.delayMs ?? 750;
  const method = (init?.method ?? "GET").toUpperCase();
  const mayRetry = method === "GET" || method === "HEAD";

  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(input, init);
      if (!mayRetry || attempt >= retries || !RETRYABLE_SERVER_STATUSES.has(response.status)) {
        return response;
      }
    } catch (error) {
      if (!mayRetry || attempt >= retries) {
        throw error;
      }
    }

    if (delayMs > 0) {
      await new Promise((resolve) => window.setTimeout(resolve, delayMs));
    }
  }
}
