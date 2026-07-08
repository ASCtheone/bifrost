import { NetworkError } from "./errors.js";

export interface RetryOptions {
  readonly maxRetries: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

const DEFAULT_RETRY: RetryOptions = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 8000,
};

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: Partial<RetryOptions> = {},
): Promise<T> {
  const opts = { ...DEFAULT_RETRY, ...options };
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (!isRetryable(lastError) || attempt === opts.maxRetries) {
        throw lastError;
      }

      const delay = Math.min(
        opts.baseDelayMs * Math.pow(2, attempt),
        opts.maxDelayMs,
      );
      await sleep(delay);
    }
  }

  throw lastError;
}

function isRetryable(error: Error): boolean {
  if (error instanceof NetworkError) return true;


  const message = error.message.toLowerCase();
  return (
    message.includes("econnrefused") ||
    message.includes("etimedout") ||
    message.includes("econnreset") ||
    message.includes("fetch failed")
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
