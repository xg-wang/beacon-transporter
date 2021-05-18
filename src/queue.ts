import { clear, createStore, peek, peekBack, push, shift } from 'idb-queue';

import fetchFn from './fetch-fn';
import { debug, logError } from './utils';

export interface RetryEntry {
  url: string;
  body: string;
  statusCode?: number;
  timestamp: number;
}

export interface RetryQueueConfig {
  attemptLimit: number;
  maxNumber: number;
  batchEvictionNumber: number;
  throttleWait: number;
}

interface RetryEntryWithAttempt extends RetryEntry {
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

let retryHeaderPath: string | undefined;

function createHeaders(attempt: number, errorCode?: number): HeadersInit {
  if (!retryHeaderPath) return {};
  const headersInit = {
    [retryHeaderPath]: JSON.stringify({ attempt, errorCode }),
  };
  return headersInit;
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
      debug('[throttle] Run fn()');
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
    debug('Replaying entry');
    shift<RetryEntryWithAttempt>(1, this.withStore)
      .then((entries) => {
        debug(`Replaying entry: ${entries.length}`);
        if (entries.length > 0) {
          const { url, body, timestamp, statusCode, attemptCount } = entries[0];
          return fetchFn(url, body, createHeaders(attemptCount, statusCode))
            .then(() => this.replayEntries())
            .catch(() => {
              if (attemptCount + 1 >= retryQueueConfig.attemptLimit) {
                debug(
                  'Exceeded attempt count',
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
              return push(
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
    const entryWithAttempt: RetryEntryWithAttempt = {
      ...entry,
      attemptCount: 0,
    };
    debug('Persisting to DB ' + entry.url);
    push(entryWithAttempt, retryQueueConfig, this.withStore).catch(logError);
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

const hasSupport = !!globalThis.indexedDB;
const retryQueue = hasSupport ? new QueueImpl() : new NoopQueue();

export function pushToQueue(entry: RetryEntry): void {
  retryQueue.push(entry);
}
export function notifyQueue(): void {
  retryQueue.onNotify();
}

export function setRetryHeaderPath(path: string): void {
  debug('Set retry header path to ', path);
  retryHeaderPath = path;
}
export function setRetryQueueConfig(config: RetryQueueConfig): void {
  retryQueueConfig = config;
  retryQueue.setThrottleWait(config.throttleWait);
}
export function clearQueue(): Promise<void> {
  return retryQueue.clear();
}
export function peekQueue(count: number): Promise<RetryEntry[]> {
  return retryQueue.peek(count);
}
export function peekBackQueue(count: number): Promise<RetryEntry[]> {
  return retryQueue.peekBack(count);
}
