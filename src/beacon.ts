import fetchFn, { supportFetch } from './fetch-fn';
import { BeaconConfig, RetryRejection } from './interfaces';
import { notifyQueue, onClear, pushToQueue, removeOnClear } from './queue';
import { debug, logError, sleep } from './utils';

/**
 * 502 Bad Gateway
 * 504 Gateway Timeout
 */
const defaultInMemoryRetryStatusCodes = [502, 504];
/**
 * 429 Too Many Requests
 * 503 Service Unavailable
 */
const defaultPersistRetryStatusCodes = [429, 503];

class Beacon {
  private timestamp: number;
  private isClearQueuePending = false;
  private onClearCallback: () => void;
  private calculateRetryDelay: (countLeft: number) => number;

  constructor(
    private url: string,
    private body: string,
    private config?: BeaconConfig
  ) {
    this.timestamp = Date.now();
    const retryCountLeft = config?.retry?.limit ?? 0;
    this.onClearCallback = () => (this.isClearQueuePending = true);
    onClear(this.onClearCallback);
    this.calculateRetryDelay =
      config?.retry?.calculateRetryDelay ??
      ((countLeft) => ((config?.retry?.limit ?? 0) - countLeft + 1) * 2000);
    this.retry(() => fetchFn(url, body, {}), retryCountLeft)
      .catch((reason) =>
        logError('Retry finished with rejection: ' + JSON.stringify(reason))
      )
      .finally(() => {
        debug('beacon finished');
        removeOnClear(this.onClearCallback);
      });
  }

  /**
   * Retry executing a function
   *
   * @param fn - The function to retry, should return a promise that rejects with error as retry instruction or resolves if finished
   * @returns result of the retry operation, true if fn ever resolved during retry, false if all retry failed
   */
  private retry(
    fn: () => Promise<unknown>,
    retryCountLeft: number
  ): Promise<true> {
    debug(`retry ${retryCountLeft}`);
    return fn()
      .catch((error: RetryRejection) => {
        debug('retry rejected', JSON.stringify(error));
        if (this.shouldPersist(retryCountLeft, error)) {
          debug('push entry to db');
          pushToQueue({
            url: this.url,
            body: this.body,
            statusCode: error.statusCode,
            timestamp: this.timestamp,
          });
        } else if (retryCountLeft > 0 && this.isRetryableError(error)) {
          debug('in memory retry');
          return sleep(this.calculateRetryDelay(retryCountLeft)).then(() =>
            this.retry(fn, retryCountLeft - 1)
          );
        }
        throw error;
      })
      .then(() => {
        if (!this.isClearQueuePending && this.config?.retry?.persist) {
          notifyQueue();
        }
        return true;
      });
  }

  private defaultCalculateRetryDelay(countLeft: number): number {
    const count = (this.config?.retry?.limit ?? 0) - countLeft + 1;
    return count * 2000;
  }

  private isRetryableError(error: RetryRejection): boolean {
    if (
      error.type === 'network' ||
      (
        this.config?.retry?.inMemoryRetryStatusCodes ??
        defaultInMemoryRetryStatusCodes
      ).includes(error.statusCode)
    ) {
      return true;
    }
    return false;
  }

  private shouldPersist(
    retryCountLeft: number,
    error: RetryRejection
  ): boolean {
    if (this.isClearQueuePending || !this.config?.retry?.persist) {
      return false;
    }
    // Short-circuit if apparently offline or all back-off retries fail
    if (
      !navigator.onLine ||
      (retryCountLeft === 0 && error.type === 'network')
    ) {
      return true;
    }
    const fromStatusCode =
      error.type === 'response' &&
      (
        this.config?.retry?.persistRetryStatusCodes ??
        defaultPersistRetryStatusCodes
      ).includes(error.statusCode);
    if (fromStatusCode) {
      return true;
    }
    return false;
  }
}

const createBeaconInstance = () => {
  return (url: string, body: string, config?: BeaconConfig) => {
    if (!supportFetch) {
      return;
    }
    new Beacon(url, body, config);
  };
};

/**
 * @example
 * ```
 * import beacon from 'beacon-transporter';
 * beacon(`/api`, 'hi', { retryCount: 3 })
 * ```
 * @public
 */
const beacon = createBeaconInstance();

export default beacon;
