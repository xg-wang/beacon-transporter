/**
 * @public
 */
export interface BeaconConfig {
  retry?: {
    limit: number;
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
