import { BeaconConfig, RetryRejection } from './interfaces';
import { throttleRetry, notifyBeaconSuccess } from './storage';

const supportFetch = typeof self !== 'undefined' && 'fetch' in self;

const supportSendBeacon =
  typeof navigator !== 'undefined' && 'sendBeacon' in navigator;
const supportKeepaliveFetch = supportFetch && 'keepalive' in new Request('');

const defaultInMemoryRetryStatusCodes = [502, 504];
const defaultPersistRetryStatusCodes = [429, 503];

function createRequestInit({
  body,
  keepalive,
}: {
  body: string;
  keepalive: boolean;
}): RequestInit {
  return {
    body,
    keepalive,
    credentials: 'same-origin',
    headers: [['content-type', 'text/plain;charset=UTF-8']],
    method: 'POST',
    mode: 'cors',
  };
}

class Beacon {
  private timestamp: number;
  constructor(
    private url: string,
    private body: string,
    private config?: BeaconConfig
  ) {
    this.timestamp = Date.now();
    const retryCountLeft = config?.retry?.limit ?? 0;

    if (supportKeepaliveFetch) {
      this.retry(
        () => this.keepaliveFetch(url, body),
        retryCountLeft
      ).catch((reason) => console.error(reason));
    } else {
      this.retry(
        () => this.fallbackFetch(url, body),
        retryCountLeft
      ).catch((reason) => console.error(reason));
    }
  }

  private keepaliveFetch(url: string, body: string): Promise<Response> {
    return new Promise((resolve, reject) => {
      fetch(url, createRequestInit({ body, keepalive: true }))
        .catch(() => {
          // keepalive true fetch can throw error if body exceeds 64kb
          return fetch(url, createRequestInit({ body, keepalive: false }));
        })
        .then(
          (response) => {
            if (response.ok) {
              resolve(response);
            } else {
              reject({ type: 'response', statusCode: response.status });
            }
          },
          () => reject({ type: 'network' })
        );
    });
  }

  private fallbackFetch(url: string, body: string): Promise<Response | null> {
    return new Promise((resolve, reject) => {
      if (supportSendBeacon) {
        let result = false;
        try {
          result = navigator.sendBeacon(url, body);
        } catch (_e) {
          // silent any error due to any browser issue
        }
        // if the user agent is not able to successfully queue the data for transfer,
        // send the payload with fetch api instead
        if (result) {
          this.debug('sendBeacon => true');
          resolve(null);
          return;
        }
      }
      this.debug('sendBeacon => fetch');
      fetch(url, createRequestInit({ body, keepalive: false })).then(
        (response) => {
          if (response.ok) {
            resolve(response);
          } else {
            reject({
              type: 'response',
              statusCode: response.status,
            });
          }
        },
        () => reject({ type: 'network' })
      );
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
    this.debug(`retry ${retryCountLeft}`);
    return fn()
      .catch((error: RetryRejection) => {
        this.debug(JSON.stringify(error));
        if (this.shouldPersist(error)) {
          // do stuff with db
          throttleRetry(this.url, this.body, this.timestamp);
        } else if (retryCountLeft > 0 && this.isRetryableError(error)) {
          return sleep(this.getRetryDelay(retryCountLeft)).then(() =>
            this.retry(fn, retryCountLeft - 1)
          );
        }
        throw error;
      })
      .then(() => {
        notifyBeaconSuccess();
        return true;
      });
  }

  private getRetryDelay(countLeft: number): number {
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

  private shouldPersist(error: RetryRejection): boolean {
    const configEnabled = this.config?.retry?.persist;
    if (!configEnabled) {
      return false;
    }
    const fromStatusCode =
      error.type === 'response' &&
      (
        this.config?.retry?.persistRetryStatusCodes ??
        defaultPersistRetryStatusCodes
      ).includes(error.statusCode);
    if (fromStatusCode || !navigator.onLine) {
      return true;
    }
    return false;
  }

  protected debug(message: string): void {
    if (this.config?.debug) {
      console.log(`[beacon] ${message}`);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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
