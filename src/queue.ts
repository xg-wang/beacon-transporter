import type { WithStore } from 'idb-queue';
import {
  clear,
  createStore,
  peek,
  peekBack,
  pushIfNotClearing,
  shift,
} from 'idb-queue';

import fetchFn from './fetch-fn';
import { RetryDBConfig } from './interfaces';
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

interface Queue {
  onNotify(): void;
  push(entry: RetryEntry): void;
  clear(): Promise<void>;
  setThrottleWait(wait: number): void;
  peek(count: number): Promise<RetryEntry[]>;
  peekBack(count: number): Promise<RetryEntry[]>;
}

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

class QueueImpl implements Queue {
  private throttledReplay: () => void;
  private withStore: WithStore;

  constructor(private config: RetryDBConfig) {
    this.withStore = createStore(
      'beacon-transporter',
      config.storeName,
      'timestamp'
    );
    this.throttledReplay = throttle(
      this.replayEntries.bind(this),
      config.throttleWait
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
        if (entries.length > 0) {
          const { url, body, timestamp, statusCode, attemptCount } = entries[0];
          return fetchFn(url, body, createHeaders(attemptCount, statusCode))
            .then(() => this.replayEntries())
            .catch(() => {
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
            });
        }
      })
      .catch((reason: DOMException) => {
        if (reason && reason.message) {
          logError(`Replay entry failed: ${reason.message}`);
        }
      });
  }

  // throttle retry timer when pushed
  public push(entry: RetryEntry): void {
    debug('Persisting to DB ' + entry.url);
    pushIfNotClearing(entry, this.config, this.withStore)
      .then(() => debug('push completed'))
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

/**
 * @public
 */
export class RetryDB {
  static hasSupport =
    typeof globalThis !== 'undefined' && !!globalThis.indexedDB;

  private queue: Queue;
  private beaconListeners = new Set<() => void>();

  constructor(
    config: RetryDBConfig = {
      storeName: 'default',
      attemptLimit: 3,
      maxNumber: 1000,
      batchEvictionNumber: 300,
      throttleWait: 5 * 60 * 1000,
    }
  ) {
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
