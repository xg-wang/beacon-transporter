/**
 * @public
 */
export interface BeaconInit {
  beaconConfig?: BeaconConfig;
  retryDBConfig?: RetryDBConfig;
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
export type BeaconFunc = (url: string, body: string) => Promise<RetryRejection | RequestSuccess | undefined>;
