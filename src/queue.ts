import { push, createStore, shift } from 'idb-queue';
import { debug } from './utils';
import fetchFn from './fetch';

export interface RetryEntry {
  url: string;
  body: string;
  statusCode?: number;
  timestamp: number;
}

export interface RetentionConfig {
  attemptLimit: number;
  maxNumber: number;
  batchEvictionNumber: number;
}

interface RetryEntryWithAttemp extends RetryEntry {
  attemptCount: number;
}

interface Queue {
  onNotify(): void;
  push(entry: RetryEntry): void;
}

let retryHeaderPath: string | undefined;
export function setRetryHeaderPath(path: string) {
  retryHeaderPath = path;
}

function createHeaders(attemp: number, errorCode?: number) {
  if (!retryHeaderPath) return;
  const headersInit = {
    [retryHeaderPath]: JSON.stringify({ attemp, errorCode }),
  };
  return headersInit;
}

let retentionConfig: RetentionConfig = {
  attemptLimit: 3,
  maxNumber: 1000,
  batchEvictionNumber: 300,
};
export function setRetentionConfig(config: RetentionConfig) {
  retentionConfig = config;
}

export class QueueImpl implements Queue {
  private withStore = createStore('beacon-transporter', 'default', 'timestamp');
  public onNotify() {
    this.replayEntries();
  }
  private replayEntries() {
    setTimeout(() => {
      shift<RetryEntryWithAttemp>(1, this.withStore)
        .then((entries) => {
          if (entries.length > 0) {
            const {
              url,
              body,
              timestamp,
              statusCode,
              attemptCount,
            } = entries[0];
            debug('Replaying entry: ', entries[0]);
            return fetchFn(url, body, createHeaders(attemptCount, statusCode))
              .then(() => this.replayEntries())
              .catch(() => {
                if (attemptCount >= retentionConfig.attemptLimit) {
                  debug('Exceeded attempt count', { url, body, timestamp, statusCode });
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
                  retentionConfig,
                  this.withStore
                );
              });
          }
        })
        .catch((reason) => {
          console.error(reason);
        });
    }, 1);
  }

  public push(entry: RetryEntry) {
    const entryWithAttemp: RetryEntryWithAttemp = {
      ...entry,
      attemptCount: 0,
    };
    debug('Persisting to DB: ', entry);
    push(entryWithAttemp, retentionConfig, this.withStore);
  }
}

class NoopQueue {
  onNotify() {}
  push() {}
}

const hasSupport = !!self.indexedDB;
const retryQueue = hasSupport ? new QueueImpl() : new NoopQueue();

export function pushToQueue(entry: RetryEntry) {
  retryQueue.push(entry);
}
export function notifyQueue() {
  retryQueue.onNotify();
}
