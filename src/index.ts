/**
 * Reliable beacon API for the browser
 * @packageDocumentation
 */

export { default } from './beacon';
export * from './interfaces';
export {
  clearQueue,
  peekQueue,
  peekBackQueue,
  setRetryHeaderPath,
  setRetryQueueConfig,
} from './queue';
