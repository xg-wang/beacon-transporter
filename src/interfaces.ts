/**
 * @public
 */
export interface BeaconInit {
  beaconConfig?: BeaconConfig;
  retryDBConfig?: RetryDBConfig;
  compress?: boolean;
}
/**
 * @public
 */
export interface BeaconInitWithCustomDB<CustomRetryDBType> {
  beaconConfig?: BeaconConfig;
  retryDB: CustomRetryDBType;
  compress?: boolean;
}

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
  notifyQueue(config: QueueNotificationConfig): void;
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
export interface QueueNotificationConfig {
  allowedPersistRetryStatusCodes: number[];
}

/**
 * @public
 */
export interface RetryDBConfig {
  dbName: string;
  headerName?: string;
  attemptLimit: number;
  maxNumber: number;
  batchEvictionNumber: number;
  throttleWait: number;
  useIdle?: () => boolean;
  measureIDB?: {
    create?: {
      createStartMark: string;
      createSuccessMeasure: string;
      createFailMeasure: string;
    };
  };
}

export interface LocalStorageRetryDBConfig {
  keyName: string;
  maxNumber: number;
  headerName?: string;
  attemptLimit: number;
  throttleWait: number;
  compressFetch: boolean;
}

/**
 * @public
 */
export interface BeaconConfig {
  retry: {
    limit: number;
    /**
     * HTTP header name for the header that contains retry context
     */
    headerName?: string;
    inMemoryRetryStatusCodes?: number[];
    persist?: boolean;
    persistRetryStatusCodes?: number[];
    calculateRetryDelay?: (countLeft: number) => number;
  };
}

/**
 * @public
 */
export interface NetworkRetryRejection {
  type: 'network';
  statusCode: undefined;
}

/**
 * @public
 */
export interface ResponseRetryRejection {
  type: 'response';
  statusCode: number;
}

/**
 * @public
 */
export type RetryRejection = NetworkRetryRejection | ResponseRetryRejection;

/**
 * @public
 */
export interface RequestSuccess {
  type: 'success';
  statusCode: 200;
}

/**
 * @public
 */
export type BeaconFunc = (
  url: string,
  body: string,
  headers?: Record<string, string>
) => Promise<RetryRejection | RequestSuccess | undefined>;
