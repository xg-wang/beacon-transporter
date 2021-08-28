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
  storeName: string;
  headerName?: string;
  attemptLimit: number;
  maxNumber: number;
  batchEvictionNumber: number;
  throttleWait: number;
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
  url: string;
  body: string;
}

/**
 * @public
 */
export interface ResponseRetryRejection {
  type: 'response';
  statusCode: number;
  url: string;
  body: string;
}

/**
 * @public
 */
export type RetryRejection = NetworkRetryRejection | ResponseRetryRejection;

/**
 * @public
 */
export type BeaconFunc = (url: string, body: string) => void;
