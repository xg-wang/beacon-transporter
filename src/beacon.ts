import { fetchFn, supportFetch } from './fetch';
import type {
  BeaconConfig,
  BeaconFunc,
  BeaconInit,
  RequestSuccess,
  RetryRejection,
} from './interfaces';
import { RetryDB } from './queue';
import { createHeaders, debug, sleep } from './utils';

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
  private calculateRetryDelay: (retryCountLeft: number) => number;

  constructor(
    private url: string,
    private body: string,
    private config: BeaconConfig,
    private db: RetryDB
  ) {
    this.timestamp = Date.now();
    this.onClearCallback = () => (this.isClearQueuePending = true);
    this.calculateRetryDelay =
      config.retry.calculateRetryDelay ??
      ((retryCountLeft) => this.getAttemptCount(retryCountLeft) * 2000);
  }

  send(): Promise<RetryRejection | RequestSuccess | undefined> {
    this.db.onClear(this.onClearCallback);
    const initialRetryCountLeft = this.retryLimit;
    return this.retry(
      (headers: HeadersInit) => fetchFn(this.url, this.body, headers),
      initialRetryCountLeft
    ).finally(() => {
      debug('beacon finished');
      this.db.removeOnClear(this.onClearCallback);
    });
  }

  private get retryLimit(): number {
    return this.config.retry.limit;
  }

  private getAttemptCount(retryCountLeft: number): number {
    return this.retryLimit - retryCountLeft + 1;
  }

  /**
   * Retry executing a function
   *
   * @param fn - The function to retry, should return a promise that rejects with error as retry instruction or resolves if finished
   * @returns result of the retry operation, true if fn ever resolved during retry, false if all retry failed
   */
  private retry(
    fn: (
      headers: HeadersInit
    ) => Promise<RetryRejection | RequestSuccess | undefined>,
    retryCountLeft: number,
    errorCode?: number
  ): Promise<RetryRejection | RequestSuccess | undefined> {
    const attemptCount = this.getAttemptCount(retryCountLeft) - 1;
    return fn(
      createHeaders(this.config.retry.headerName, attemptCount, errorCode)
    ).then((maybeError) => {
      if (typeof maybeError === 'undefined' || maybeError.type === 'success') {
        if (!this.isClearQueuePending && this.config.retry.persist) {
          this.db.notifyQueue();
        }
      } else if (typeof maybeError !== 'undefined') {
        debug('retry rejected ' + JSON.stringify(maybeError));
        if (this.shouldPersist(retryCountLeft, maybeError)) {
          this.db.pushToQueue({
            url: this.url,
            body: this.body,
            statusCode: maybeError.statusCode,
            timestamp: this.timestamp,
            attemptCount: this.getAttemptCount(retryCountLeft),
          });
        } else if (retryCountLeft > 0 && this.isRetryableError(maybeError)) {
          const waitMs = this.calculateRetryDelay(retryCountLeft);
          debug(`in memory retry in ${waitMs}ms`);
          return sleep(waitMs).then(() =>
            this.retry(fn, retryCountLeft - 1, maybeError.statusCode)
          );
        }
      }
      return maybeError;
    });
  }

  private isRetryableError(error: RetryRejection): boolean {
    if (
      error.type === 'network' ||
      (
        this.config.retry.inMemoryRetryStatusCodes ??
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
    if (this.isClearQueuePending || !this.config.retry.persist) {
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
        this.config.retry.persistRetryStatusCodes ??
        defaultPersistRetryStatusCodes
      ).includes(error.statusCode);
    if (fromStatusCode) {
      return true;
    }
    return false;
  }
}

/**
 * @public
 */
export function createBeacon(init: BeaconInit = {}): {
  beacon: BeaconFunc;
  database: RetryDB;
} {
  const { beaconConfig, retryDBConfig } = prepareConfig(init);
  const database = new RetryDB(retryDBConfig);
  const beacon: BeaconFunc = (url, body) => {
    if (!supportFetch) {
      return Promise.resolve(undefined);
    }
    return new Beacon(url, body, beaconConfig, database).send();
  };
  return { beacon, database };
}

function prepareConfig(init: BeaconInit): Required<BeaconInit> {
  const beaconConfig = init.beaconConfig || {
    retry: {
      limit: 0,
    },
  };
  const retryDBConfig = init.retryDBConfig || {
    dbName: 'beacon-transporter',
    attemptLimit: 3,
    maxNumber: 1000,
    batchEvictionNumber: 300,
    throttleWait: 5 * 60 * 1000,
  };
  const retryHeader = beaconConfig.retry.headerName;
  if (retryHeader && !retryDBConfig.headerName) {
    retryDBConfig.headerName = retryHeader;
  }
  return { beaconConfig, retryDBConfig };
}
