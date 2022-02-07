import { BeaconInitWithCustomDB, IRetryDBBase } from '.';
import { fetchFn, isGlobalFetchSupported } from './fetch';
import type {
  BeaconConfig,
  BeaconFunc,
  BeaconInit,
  RetryRejection,
  RetryRequestResponse,
} from './interfaces';
import { RetryDB } from './queue';
import { createHeaders, debug, sleep } from './utils';
import { xhr } from './xhr';

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

class Beacon<RetryDBType extends IRetryDBBase> {
  private timestamp: number;
  private persistRetryStatusCodes: number[];
  private inMemoryRetryStatusCodes: number[];
  private isClearQueuePending = false;
  private onClearCallback: () => void;
  private calculateRetryDelay: (retryCountLeft: number) => number;

  constructor(
    private url: string,
    private body: string,
    private config: BeaconConfig,
    private db: RetryDBType,
    private compress: boolean = false
  ) {
    this.timestamp = Date.now();
    this.persistRetryStatusCodes =
      config.retry.persistRetryStatusCodes || defaultPersistRetryStatusCodes;
    this.inMemoryRetryStatusCodes =
      config.retry.inMemoryRetryStatusCodes || defaultInMemoryRetryStatusCodes;
    this.onClearCallback = () => (this.isClearQueuePending = true);
    this.calculateRetryDelay =
      config.retry.calculateRetryDelay ??
      ((retryCountLeft) => this.getAttemptCount(retryCountLeft) * 2000);
  }

  send(headers: Record<string, string> = {}): Promise<RetryRequestResponse> {
    this.db.onClear(this.onClearCallback);
    const initialRetryCountLeft = this.retryLimit;
    return this.retry(
      (fetchHeaders: Record<string, string>) =>
        fetchFn(this.url, this.body, fetchHeaders, this.compress),
      initialRetryCountLeft,
      headers
    ).finally(() => {
      debug(() => 'beacon finished');
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
    fn: (headers: Record<string, string>) => Promise<RetryRequestResponse>,
    retryCountLeft: number,
    headers: Record<string, string>,
    errorCode?: number
  ): Promise<RetryRequestResponse> {
    const attemptCount = this.getAttemptCount(retryCountLeft) - 1;
    return fn(
      createHeaders(
        headers,
        this.config.retry.headerName,
        attemptCount,
        errorCode
      )
    ).then((maybeError) => {
      if (typeof maybeError === 'undefined' || maybeError.type === 'success') {
        if (!this.isClearQueuePending && this.config.retry.persist) {
          this.db.notifyQueue({
            allowedPersistRetryStatusCodes: this.persistRetryStatusCodes,
          });
        }
      } else {
        debug(() => 'retry rejected ' + JSON.stringify(maybeError));
        if (this.shouldPersist(retryCountLeft, maybeError)) {
          this.db.pushToQueue({
            url: this.url,
            body: this.body,
            headers,
            statusCode: maybeError.statusCode,
            timestamp: this.timestamp,
            attemptCount: this.getAttemptCount(retryCountLeft),
          });
        } else if (retryCountLeft > 0 && this.isRetryableError(maybeError)) {
          const waitMs = this.calculateRetryDelay(retryCountLeft);
          debug(() => `in memory retry in ${waitMs}ms`);
          return sleep(waitMs).then(() =>
            this.retry(fn, retryCountLeft - 1, headers, maybeError.statusCode)
          );
        }
      }
      return maybeError;
    });
  }

  private isRetryableError(error: RetryRejection): boolean {
    if (
      error.type === 'network' ||
      this.inMemoryRetryStatusCodes.includes(error.statusCode)
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
      this.persistRetryStatusCodes.includes(error.statusCode);
    if (fromStatusCode) {
      return true;
    }
    return false;
  }
}

/**
 * @public
 */
export function createBeacon(init?: BeaconInit): {
  beacon: BeaconFunc;
  database: RetryDB;
};
/**
 * @public
 */
export function createBeacon<CustomRetryDBType extends IRetryDBBase>(
  init?: BeaconInitWithCustomDB<CustomRetryDBType>
): {
  beacon: BeaconFunc;
  database: CustomRetryDBType;
};
/**
 * @public
 */
export function createBeacon<CustomRetryDBType extends IRetryDBBase>(
  init: BeaconInit | BeaconInitWithCustomDB<CustomRetryDBType> = {}
): {
  beacon: BeaconFunc;
  database: CustomRetryDBType | RetryDB;
} {
  const beaconConfig = init.beaconConfig || {
    retry: {
      limit: 0,
    },
  };
  const compress = init.compress || false;
  let retryDB: CustomRetryDBType | RetryDB;
  if ('retryDB' in init) {
    retryDB = init.retryDB;
  } else {
    const retryDBConfig = init.retryDBConfig || {
      dbName: 'beacon-transporter',
      attemptLimit: 3,
      maxNumber: 1000,
      batchEvictionNumber: 300,
      throttleWait: 5 * 60 * 1000,
    };
    if (
      !retryDBConfig.disabled &&
      !retryDBConfig.headerName &&
      beaconConfig.retry
    ) {
      retryDBConfig.headerName = beaconConfig.retry.headerName;
    }
    retryDB = new RetryDB(retryDBConfig, compress);
  }

  const beacon: BeaconFunc = (url, body, headers) => {
    if (!isGlobalFetchSupported() || typeof Promise === 'undefined') {
      return xhr(url, body, headers);
    }
    return new Beacon(url, body, beaconConfig, retryDB, compress).send(headers);
  };
  return { beacon, database: retryDB };
}
