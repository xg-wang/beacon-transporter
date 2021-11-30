/**
 * Transporting data to the server made easy. Support persistent retry and gzip compression.
 * @packageDocumentation
 */

export { createBeacon } from './beacon';
export * from './interfaces';
export { RetryDB } from './queue';
export { gzipSync } from 'fflate';
