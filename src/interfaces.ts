/**
 * @public
 */
export interface BeaconInit<CustomRetryDB = IRetryDBBase> {
  compress?: boolean;
  inMemoryRetry?: {
    attemptLimit?: number;
    statusCodes?: number[];
    headerName?: string;
    calculateRetryDelay?: (attempCount: number, countLeft: number) => number;
  };
  disablePersistenceRetry?: boolean;
  persistenceRetry?: {
    idbName?: string;
    attemptLimit?: number;
    statusCodes?: number[];
    maxNumber?: number;
    batchEvictionNumber?: number;
    throttleWait?: number;
    headerName?: string;
    useIdle?: boolean;
    measureIDB?: {
      createStartMark: string;
      createSuccessMeasure: string;
      createFailMeasure: string;
    };
  };
  retryDB?: CustomRetryDB;
}

/**
 * @internal
 */
export type RequiredInMemoryRetryConfig = Required<
  Pick<
    NonNullable<BeaconInit['inMemoryRetry']>,
    'statusCodes' | 'attemptLimit' | 'calculateRetryDelay'
  >
> &
  NonNullable<BeaconInit['inMemoryRetry']>;

/**
 * @internal
 */
export type RequiredPersistenceRetryConfig = Required<
  Pick<
    NonNullable<BeaconInit['persistenceRetry']>,
    | 'idbName'
    | 'attemptLimit'
    | 'statusCodes'
    | 'maxNumber'
    | 'batchEvictionNumber'
    | 'throttleWait'
  >
> &
  NonNullable<BeaconInit['persistenceRetry']>;

/**
 * @public
 */
export interface RetryEntry {
  url: string;
  body: string;
  headers?: Record<string, string>;
  statusCode?: number;
  timestamp: number;
  attemptCount: number;
}

/**
 * @public
 */
export interface IRetryDBBase {
  pushToQueue(entry: RetryEntry): void;
  notifyQueue(): void;
  onClear(cb: () => void): void;
  removeOnClear(cb: () => void): void;
}

/**
 * @public
 */
export interface IRetryDB extends IRetryDBBase {
  clearQueue(): Promise<void>;
  peekQueue(count: number): Promise<RetryEntry[]>;
  peekBackQueue(count: number): Promise<RetryEntry[]>;
}

/**
 * @public
 */
export interface RequestNetworkError {
  type: 'network';
  statusCode?: undefined;
  rawError: string;
}

/**
 * @public
 */
export interface RequestResponseError {
  type: 'response';
  statusCode: number;
  rawError: string;
}

/**
 * @public
 */
export interface RequestSuccess {
  type: 'success';
  statusCode: number;
}

/**
 * @public
 */
export interface RequestPersisted {
  type: 'persisted';
  statusCode?: number;
}

/**
  * @public
  */
export interface RequestResponseUnknown {
  type: 'unknown';
  statusCode?: undefined;
}

/**
 * @public
 */
export type RequestResult = RequestSuccess | RequestPersisted | RequestNetworkError | RequestResponseError | RequestResponseUnknown;

/**
 * @public
 */
export type BeaconFunc = (
  url: string,
  body: string,
  headers?: Record<string, string>
) => Promise<RequestResult>;
