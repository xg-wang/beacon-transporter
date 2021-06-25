/**
 * Reliable beacon API for the browser
 * @packageDocumentation
 */

export { default } from './beacon';
export * from './interfaces';
export {
  clearQueue,
  peekBackQueue,
  peekQueue,
  setRetryQueueConfig,
} from './queue';
export { setRetryHeaderPath } from './utils';
