import {
  clear,
  createStore,
  peek,
  peekBack,
  pushIfNotClearing,
  shift,
} from 'idb-queue';

import fetchFn from './fetch-fn';
import { createHeaders, debug, logError } from './utils';

/**
 * @internal
 */
export interface RetryEntry {
  url: string;
  body: string;
  statusCode?: number;
  timestamp: number;
  attemptCount: number;
}

interface RetryQueueConfig {
  attemptLimit: number;
  maxNumber: number;
  batchEvictionNumber: number;
  throttleWait: number;
}

interface Queue {
  onNotify(): void;
  push(entry: RetryEntry): void;
  clear(): Promise<void>;
  setThrottleWait(wait: number): void;
  peek(count: number): Promise<RetryEntry[]>;
  peekBack(count: number): Promise<RetryEntry[]>;
}

let retryQueueConfig: RetryQueueConfig = {
  attemptLimit: 3,
  maxNumber: 1000,
  batchEvictionNumber: 300,
  throttleWait: 5 * 60 * 1000,
};

function throttle(fn: () => void, timeFrame: number): () => void {
  let lastTime = 0;
  return function () {
    const now = Date.now();
    if (now - lastTime > timeFrame) {
      debug('[throttle] Run fn() at ' + String(now));
      fn();
      lastTime = now;
    }
  };
}

export class QueueImpl implements Queue {
  private throttledReplay: () => void;
  private withStore = createStore('beacon-transporter', 'default', 'timestamp');

  constructor() {
    this.throttledReplay = throttle(
      this.replayEntries.bind(this),
      retryQueueConfig.throttleWait
    );
  }

  public setThrottleWait(wait: number): void {
    this.throttledReplay = throttle(this.replayEntries.bind(this), wait);
  }

  public onNotify(): void {
    this.throttledReplay();
  }

  private replayEntries(): void {
    debug('Replaying entry: shift from store');
    shift<RetryEntry>(1, this.withStore)
      .then((entries) => {
        debug(`Replaying entry: read ${entries.length} entry`);
        if (entries.length > 0) {
          const { url, body, timestamp, statusCode, attemptCount } = entries[0];
          return fetchFn(url, body, createHeaders(attemptCount, statusCode))
            .then(() => this.replayEntries())
            .catch(() => {
              if (attemptCount + 1 > retryQueueConfig.attemptLimit) {
                debug(
                  'Exceeded attempt count, pushing the entry back to store',
                  JSON.stringify(
                    {
                      url,
                      timestamp,
                      statusCode,
                    },
                    null,
                    2
                  )
                );
                return;
              }
              return pushIfNotClearing(
                {
                  url,
                  body,
                  timestamp,
                  statusCode,
                  attemptCount: attemptCount + 1,
                },
                retryQueueConfig,
                this.withStore
              );
            });
        }
      })
      .catch((reason) => {
        logError(JSON.stringify(reason));
      });
  }

  // throttle retry timer when pushed
  public push(entry: RetryEntry): void {
    debug('Persisting to DB ' + entry.url);
    pushIfNotClearing(entry, retryQueueConfig, this.withStore)
      .then(() => debug('push completed'))
      .catch(logError);
  }

  public clear(): Promise<void> {
    return clear(this.withStore);
  }

  public peek(count = 1): Promise<RetryEntry[]> {
    return peek<RetryEntry>(count, this.withStore);
  }

  public peekBack(count = 1): Promise<RetryEntry[]> {
    return peekBack<RetryEntry>(count, this.withStore);
  }
}

class NoopQueue {
  onNotify(): void {
    // noop
  }
  push(): void {
    // noop
  }
  setThrottleWait(): void {
    // noop
  }
  clear(): Promise<void> {
    return Promise.resolve();
  }
  peek(): Promise<RetryEntry[]> {
    return Promise.resolve([]);
  }
  peekBack(): Promise<RetryEntry[]> {
    return Promise.resolve([]);
  }
}

const beaconListeners = new Set<() => void>();
/**
 * @internal
 */
export function onClear(cb: () => void): void {
  beaconListeners.add(cb);
}
export function removeOnClear(cb: () => void): void {
  beaconListeners.delete(cb);
}

const hasSupport = typeof globalThis !== 'undefined' && !!globalThis.indexedDB;
const retryQueue = hasSupport ? new QueueImpl() : new NoopQueue();

export function pushToQueue(entry: RetryEntry): void {
  retryQueue.push(entry);
}
export function notifyQueue(): void {
  retryQueue.onNotify();
}

/**
 * @public
 */
export function setRetryQueueConfig(config: RetryQueueConfig): void {
  retryQueueConfig = config;
  retryQueue.setThrottleWait(config.throttleWait);
}
/**
 * @public
 */
export function clearQueue(): Promise<void> {
  beaconListeners.forEach((cb) => cb());
  return retryQueue.clear();
}
/**
 * @public
 */
export function peekQueue(count: number): Promise<RetryEntry[]> {
  return retryQueue.peek(count);
}
/**
 * @public
 */
export function peekBackQueue(count: number): Promise<RetryEntry[]> {
  return retryQueue.peekBack(count);
}
