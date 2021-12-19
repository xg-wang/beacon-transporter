/**
 * Transporting data to the server made easy. Support persistent retry and gzip compression.
 * @packageDocumentation
 */

export { createBeacon } from './beacon';
export * from './interfaces';
export {
  createLocalStorageRetryDB,
  LocalStorageRetryDB,
} from './local-storage-retrydb';
export { RetryDB } from './queue';
export { gzipSync } from 'fflate';
