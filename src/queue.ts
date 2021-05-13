import { createStore, push, shift } from 'idb-queue';

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

interface RetryEntryWithAttemp extends RetryEntry {
  attemptCount: number;
}

interface Queue {
  onNotify(): void;
  push(entry: RetryEntry): void;
  setThrottleWait(wait: number): void;
}

let retryHeaderPath: string | undefined;
export function setRetryHeaderPath(path: string): void {
  debug('Set retry header path to ', path);
  retryHeaderPath = path;
}

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
    shift<RetryEntryWithAttemp>(1, this.withStore)
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
    const entryWithAttemp: RetryEntryWithAttemp = {
      ...entry,
      attemptCount: 0,
    };
    debug('Persisting to DB ' + entry.url);
    push(entryWithAttemp, retryQueueConfig, this.withStore).catch(logError);
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
}

const hasSupport = !!self.indexedDB;
const retryQueue = hasSupport ? new QueueImpl() : new NoopQueue();

export function pushToQueue(entry: RetryEntry): void {
  retryQueue.push(entry);
}
export function notifyQueue(): void {
  retryQueue.onNotify();
}
export function setRetryQueueConfig(config: RetryQueueConfig): void {
  retryQueueConfig = config;
  retryQueue.setThrottleWait(config.throttleWait);
}
