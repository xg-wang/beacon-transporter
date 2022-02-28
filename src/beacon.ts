import type {
  BeaconFunc,
  BeaconInit,
  IRetryDBBase,
  RequestNetworkError,
  RequestPersisted,
  RequestResponseError,
  RequestResult,
  RequiredInMemoryRetryConfig,
  RequiredPersistenceRetryConfig,
} from './interfaces';
import { fetchFn, isGlobalFetchSupported } from './network';
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

class Beacon<RetryDBType extends IRetryDBBase> {
  private timestamp: number;
  private isClearQueuePending = false;
  private onClearCallback: () => void;

  constructor(
    private url: string,
    private body: string,
    private config: RequiredInMemoryRetryConfig,
    private persistenceConfig: {
      db: RetryDBType;
      disabled: boolean;
      statusCodes: number[];
    },
    private compress: boolean = false
  ) {
    this.timestamp = Date.now();
    this.onClearCallback = () => (this.isClearQueuePending = true);
  }

  send(headers: Record<string, string> = {}): Promise<RequestResult> {
    this.persistenceConfig.db.onClear(this.onClearCallback);
    const initialRetryCountLeft = this.retryLimit;
    return this.retry(
      (fetchHeaders: Record<string, string>) =>
        fetchFn(this.url, this.body, fetchHeaders, this.compress),
      initialRetryCountLeft,
      headers
    ).finally(() => {
      debug(() => 'beacon finished');
      this.persistenceConfig.db.removeOnClear(this.onClearCallback);
    });
  }

  private get retryLimit(): number {
    return this.config.attemptLimit;
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
    fn: (fetchHeaders: Record<string, string>) => ReturnType<typeof fetchFn>,
    retryCountLeft: number,
    headers: Record<string, string>,
    errorCode?: number
  ): Promise<RequestResult> {
    const attemptCount = this.getAttemptCount(retryCountLeft) - 1;
    return fn(
      createHeaders(headers, this.config.headerName, attemptCount, errorCode)
    ).then((fetchResult) => {
      if (fetchResult.type === 'unknown' || fetchResult.type === 'success') {
        if (!this.isClearQueuePending && !this.persistenceConfig.disabled) {
          this.persistenceConfig.db.notifyQueue();
        }
        return fetchResult;
      } else {
        debug(() => 'retry rejected ' + JSON.stringify(fetchResult));
        if (this.shouldPersist(retryCountLeft, fetchResult)) {
          this.persistenceConfig.db.pushToQueue({
            url: this.url,
            body: this.body,
            headers,
            statusCode: fetchResult.statusCode,
            timestamp: this.timestamp,
            attemptCount: this.getAttemptCount(retryCountLeft),
          });
          const persistedResult: RequestPersisted = {
            type: 'persisted',
            drop: false,
            statusCode: fetchResult.statusCode,
          };
          return persistedResult;
        } else if (retryCountLeft > 0 && this.isRetryableError(fetchResult)) {
          const waitMs = this.config.calculateRetryDelay(
            this.getAttemptCount(retryCountLeft),
            retryCountLeft
          );
          debug(() => `in memory retry in ${waitMs}ms`);
          return sleep(waitMs).then(() =>
            this.retry(fn, retryCountLeft - 1, headers, fetchResult.statusCode)
          );
        }
      }
      fetchResult.drop = true;
      return fetchResult;
    });
  }

  private isRetryableError(
    error: RequestNetworkError | RequestResponseError
  ): boolean {
    if (
      error.type === 'network' ||
      this.config.statusCodes.includes(error.statusCode)
    ) {
      return true;
    }
    return false;
  }

  private shouldPersist(
    retryCountLeft: number,
    error: RequestNetworkError | RequestResponseError
  ): boolean {
    if (this.isClearQueuePending || this.persistenceConfig.disabled) {
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
      this.persistenceConfig.statusCodes.includes(error.statusCode);
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
  init?: BeaconInit<CustomRetryDBType>
): {
  beacon: BeaconFunc;
  database: CustomRetryDBType;
};
/**
 * @public
 */
export function createBeacon<CustomRetryDB extends IRetryDBBase = IRetryDBBase>(
  init: BeaconInit<CustomRetryDB> = {}
): {
  beacon: BeaconFunc;
  database: RetryDB | CustomRetryDB;
} {
  const compress = Boolean(init.compress);
  const inMemoryRetryConfig: RequiredInMemoryRetryConfig = Object.assign(
    {
      attemptLimit: 0,
      statusCodes: defaultInMemoryRetryStatusCodes,
      calculateRetryDelay: (_retryCountLeft: number, attemptCount: number) =>
        attemptCount * 2000,
    },
    init.inMemoryRetry
  );
  let retryDB: CustomRetryDB | RetryDB;
  if (init.retryDB) {
    retryDB = init.retryDB;
  } else {
    const retryDBConfig: RequiredPersistenceRetryConfig = Object.assign(
      {
        idbName: 'beacon-transporter',
        attemptLimit: 3,
        statusCodes: defaultPersistRetryStatusCodes,
        maxNumber: 1000,
        batchEvictionNumber: 300,
        throttleWait: 5 * 60 * 1000,
      },
      init.persistenceRetry
    );
    retryDBConfig.headerName =
      retryDBConfig.headerName || inMemoryRetryConfig.headerName;
    retryDB = new RetryDB(retryDBConfig, {
      compress: init.compress,
      disablePersistenceRetry: init.disablePersistenceRetry,
    });
  }

  const beacon: BeaconFunc = (url, body, headers) => {
    if (!isGlobalFetchSupported()) {
      return Promise.resolve({ type: 'unknown', drop: true });
    }
    return new Beacon(
      url,
      body,
      inMemoryRetryConfig,
      {
        db: retryDB,
        disabled: Boolean(init.disablePersistenceRetry),
        statusCodes:
          init.persistenceRetry?.statusCodes || defaultPersistRetryStatusCodes,
      },
      compress
    ).send(headers);
  };
  return { beacon, database: retryDB };
}
