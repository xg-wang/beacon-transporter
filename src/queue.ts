import type { WithStore } from 'idb-queue';
import {
  clear,
  createStore,
  peek,
  peekBack,
  pushIfNotClearing,
  shift,
} from 'idb-queue';

import { fetchFn, idleFetch } from './fetch';
import { RetryDBConfig } from './interfaces';
import { createHeaders, debug, logError } from './utils';

/**
 * @internal
 */
export interface RetryEntry {
  url: string;
  body: BodyInit;
  headers?: Record<string, string>;
  statusCode?: number;
  timestamp: number;
  attemptCount: number;
}

interface Queue {
  onNotify(): void;
  push(entry: RetryEntry): void;
  clear(): Promise<void>;
  peek(count: number): Promise<RetryEntry[]>;
  peekBack(count: number): Promise<RetryEntry[]>;
}

interface ThrottleControl {
  throttledFn: () => void;
  resetThrottle: () => void;
}

/**
 * Create throttle control for executing function that is throttled,
 * and support resetting the throttling time
 */
function throttle(fn: () => void, timeFrame: number): ThrottleControl {
  let lastTime = 0;
  const throttledFn = (): void => {
    const now = Date.now();
    if (now - lastTime > timeFrame) {
      debug('[throttle] Run fn() at ' + String(now));
      fn();
      lastTime = now;
    }
  };
  const resetThrottle = (): void => {
    lastTime = 0;
  };
  return {
    throttledFn,
    resetThrottle,
  };
}

class QueueImpl implements Queue {
  private throttleControl: ThrottleControl;
  private withStore: WithStore;

  constructor(private config: RetryDBConfig) {
    this.withStore = createStore(config.dbName, 'beacons', 'timestamp');
    this.throttleControl = throttle(
      this.replayEntries.bind(this),
      config.throttleWait
    );
  }

  public onNotify(): void {
    this.throttleControl.throttledFn();
  }

  public push(entry: RetryEntry): void {
    debug('Persisting to DB ' + entry.url);
    pushIfNotClearing(entry, this.config, this.withStore)
      .then(() => {
        this.throttleControl.resetThrottle();
        debug('push completed');
      })
      .catch(() => logError('push failed'));
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

  private replayEntries(): void {
    debug('Replaying entry: shift from store');
    shift<RetryEntry>(1, this.withStore)
      .then((entries) => {
        if (entries.length > 0) {
          const { url, body, headers, timestamp, statusCode, attemptCount } = entries[0];
          debug(
            `header: ${String(
              this.config.headerName
            )}; attemptCount: ${attemptCount}`
          );
          const shouldUseIdle = this.config.useIdle?.();
          const fetch = shouldUseIdle ? idleFetch : fetchFn;
          return fetch(
            url,
            body,
            createHeaders(headers, this.config.headerName, attemptCount, statusCode)
          ).then((maybeError) => {
            if (!maybeError || maybeError.type === 'success') {
              this.replayEntries();
            } else {
              const debugInfo = JSON.stringify(
                {
                  url,
                  timestamp,
                  statusCode,
                },
                null,
                2
              );
              if (attemptCount + 1 > this.config.attemptLimit) {
                debug(
                  'Exceeded attempt count, dropping the entry: ' + debugInfo
                );
                return;
              }
              debug(
                'Replaying the entry failed, pushing back to IDB: ' + debugInfo
              );
              return pushIfNotClearing(
                {
                  url,
                  body,
                  timestamp,
                  statusCode,
                  attemptCount: attemptCount + 1,
                },
                this.config,
                this.withStore
              );
            }
          });
        }
      })
      .catch((reason: DOMException) => {
        if (reason && reason.message) {
          logError(`Replay entry failed: ${reason.message}`);
        }
      });
  }
}

class NoopQueue {
  onNotify(): void {
    // noop
  }
  push(): void {
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

/**
 * @public
 */
export class RetryDB {
  static hasSupport =
    typeof globalThis !== 'undefined' && !!globalThis.indexedDB;

  private queue: Queue;
  private beaconListeners = new Set<() => void>();

  constructor(config: RetryDBConfig) {
    this.queue = RetryDB.hasSupport ? new QueueImpl(config) : new NoopQueue();
  }

  pushToQueue(entry: RetryEntry): void {
    this.queue.push(entry);
  }

  notifyQueue(): void {
    this.queue.onNotify();
  }

  clearQueue(): Promise<void> {
    this.beaconListeners.forEach((cb) => cb());
    return this.queue.clear();
  }

  peekQueue(count: number): Promise<RetryEntry[]> {
    return this.queue.peek(count);
  }

  peekBackQueue(count: number): Promise<RetryEntry[]> {
    return this.queue.peekBack(count);
  }

  onClear(cb: () => void): void {
    this.beaconListeners.add(cb);
  }
  removeOnClear(cb: () => void): void {
    this.beaconListeners.delete(cb);
  }
}
