export interface BeaconConfig {
  debug?: boolean;
  retry?: {
    limit: number;
    inMemoryRetryStatusCodes?: number[];
    persist: boolean;
    persistRetryStatusCodes?: number[];
  };
}

export interface NetworkRetryRejection {
  type: 'network';
  url: string;
  body: string;
}
export interface ResponseRetryRejection {
  type: 'response';
  statusCode: number;
  url: string;
  body: string;
}
export type RetryRejection = NetworkRetryRejection | ResponseRetryRejection;

