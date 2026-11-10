/**
 * Retry and concurrency helpers for calls to AWS Rekognition and AEM.
 */

const RETRYABLE_AWS_ERRORS = new Set([
  'ThrottlingException',
  'ProvisionedThroughputExceededException',
  'TooManyRequestsException',
  'RequestLimitExceeded',
  'InternalServerError',
  'InternalServerErrorException',
  'ServiceUnavailable',
  'ServiceUnavailableException',
  'RequestTimeout',
  'RequestTimeoutException',
  'TimeoutError'
]);

const RETRYABLE_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ENOTFOUND',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT'
]);

const RETRYABLE_HTTP_STATUSES = new Set([429, 502, 503, 504]);

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * True for transient AWS SDK errors: throttling, 5xx, timeouts and network failures.
 */
function isRetryableAwsError(err) {
  if (!err) return false;
  if (RETRYABLE_AWS_ERRORS.has(err.name) || RETRYABLE_AWS_ERRORS.has(err.Code)) return true;
  if (err.$retryable) return true;
  const status = err.$metadata?.httpStatusCode;
  if (status === 429 || (status >= 500 && status <= 599)) return true;
  return isNetworkError(err);
}

function isNetworkError(err) {
  if (!err) return false;
  const code = err.code || err.cause?.code;
  return RETRYABLE_NETWORK_CODES.has(code) || err.name === 'AbortError' || err.name === 'FetchError';
}

/**
 * Exponential backoff with full jitter: random(0, min(maxDelay, base * 2^attempt)).
 */
function computeBackoff(attempt, { baseDelayMs, maxDelayMs, random = Math.random }) {
  const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
  return Math.floor(random() * ceiling);
}

/**
 * Runs `fn` and retries it while `isRetryable(err)` is true.
 *
 * Gives up after `maxAttempts` or once the next delay would exceed `maxTotalDelayMs`,
 * so retries can't push a web request past its gateway timeout. `getRetryAfterMs(err)`
 * lets callers honor server-provided delays (e.g. HTTP Retry-After).
 */
async function withRetry(fn, options = {}) {
  const {
    maxAttempts = 5,
    baseDelayMs = 200,
    maxDelayMs = 3000,
    maxTotalDelayMs = 10000,
    isRetryable = isRetryableAwsError,
    getRetryAfterMs = () => null,
    sleep = defaultSleep,
    random = Math.random,
    onRetry = null
  } = options;

  let totalDelay = 0;
  let lastError;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      const isLast = attempt === maxAttempts - 1;
      if (isLast || !isRetryable(err)) throw err;

      const serverDelay = getRetryAfterMs(err);
      const delay =
        serverDelay !== null && serverDelay !== undefined && serverDelay >= 0
          ? Math.min(serverDelay, maxDelayMs)
          : computeBackoff(attempt, { baseDelayMs, maxDelayMs, random });
      if (totalDelay + delay > maxTotalDelayMs) throw err;
      totalDelay += delay;
      if (onRetry) onRetry(err, attempt + 1, delay);
      await sleep(delay);
    }
  }
  throw lastError;
}

/**
 * Maps `items` through async `fn` with at most `limit` calls in flight.
 * Results keep input order. Rejections propagate (use allSettled-style fns to collect errors).
 */
async function mapWithConcurrency(items, limit, fn) {
  const list = Array.from(items);
  const results = new Array(list.length);
  const workerCount = Math.max(1, Math.min(limit, list.length));
  let next = 0;

  async function worker() {
    while (next < list.length) {
      const idx = next++;
      results[idx] = await fn(list[idx], idx);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

module.exports = {
  withRetry,
  mapWithConcurrency,
  isRetryableAwsError,
  isNetworkError,
  computeBackoff,
  RETRYABLE_HTTP_STATUSES
};
