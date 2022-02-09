import type { WithStore } from 'idb-queue';
import {
  clear,
  createStore,
  peek,
  peekBack,
  pushIfNotClearing,
  shift,
} from 'idb-queue';

import type {
  DisableRetryDBConfig,
  IRetryDB,
  QueueNotificationConfig,
  RetryDBConfig,
  RetryEntry,
} from './interfaces';
import { fetchFn } from './network';
import {
  createHeaders,
  debug,
  logError,
  scheduleTask,
  throttle,
  ThrottleControl,
} from './utils';

interface IQueue {
  onNotify(config: QueueNotificationConfig): void;
  push(entry: RetryEntry): void;
  clear(): Promise<void>;
  peek(count: number): Promise<RetryEntry[]>;
  peekBack(count: number): Promise<RetryEntry[]>;
}

class Queue implements IQueue {
  private throttleControl: ThrottleControl<QueueNotificationConfig>;
  private withStore: WithStore;
  private disablePersistence = false;

  constructor(private config: RetryDBConfig, private compress = false) {
    const measureCreate = config.measureIDB?.create;
    if (measureCreate) {
      performance.mark(measureCreate.createStartMark);
    }
    this.withStore = createStore(config.dbName, 'beacons', 'timestamp', {
      onSuccess: () => {
        if (measureCreate) {
          performance.measure(
            measureCreate.createSuccessMeasure,
            measureCreate.createStartMark
          );
        }
      },
      onError: () => {
        if (measureCreate) {
          performance.measure(
            measureCreate.createFailMeasure,
            measureCreate.createStartMark
          );
        }
        this.disablePersistence = true;
      },
    });
    this.throttleControl = throttle(
      this.replayEntries.bind(this),
      config.throttleWait
    );
  }

  public onNotify(config: QueueNotificationConfig): void {
    if (this.disablePersistence) {
      return;
    }
    this.throttleControl.throttledFn(config);
  }

  public push(entry: RetryEntry): void {
    if (this.disablePersistence) {
      return;
    }
    const runPushTask = (): void => {
      debug(() => 'Persisting to DB ' + entry.url);
      pushIfNotClearing(entry, this.config, this.withStore)
        .then(() => {
          this.throttleControl.resetThrottle();
          debug(() => 'push completed');
        })
        .catch(() => {
          this.disablePersistence = true;
          logError(() => 'push failed');
        });
    };
    const shouldUseIdle = this.config.useIdle?.() ?? false;
    shouldUseIdle ? scheduleTask(runPushTask) : runPushTask();
  }

  public clear(): Promise<void> {
    if (this.disablePersistence) {
      return Promise.resolve();
    }
    return clear(this.withStore).catch(() => {
      this.disablePersistence = true;
      logError(() => 'clear failed');
    });
  }

  public peek(count = 1): Promise<RetryEntry[]> {
    if (this.disablePersistence) {
      return Promise.resolve([]);
    }
    return peek<RetryEntry>(count, this.withStore).catch(() => {
      this.disablePersistence = true;
      logError(() => 'peek failed');
      return [];
    });
  }

  public peekBack(count = 1): Promise<RetryEntry[]> {
    if (this.disablePersistence) {
      return Promise.resolve([]);
    }
    return peekBack<RetryEntry>(count, this.withStore).catch(() => {
      this.disablePersistence = true;
      logError(() => 'peekBack failed');
      return [];
    });
  }

  private replayEntries(config: QueueNotificationConfig): void {
    if (this.disablePersistence) {
      return;
    }
    const runReplayEntriesTask = (): void => {
      debug(() => 'Replaying entry: shift from store');
      shift<RetryEntry>(1, this.withStore)
        .then((entries) => {
          if (entries.length > 0) {
            const { url, body, headers, timestamp, statusCode, attemptCount } =
              entries[0];
            debug(
              () =>
                `header: ${String(
                  this.config.headerName
                )}; attemptCount: ${attemptCount}`
            );
            return fetchFn(
              url,
              body,
              createHeaders(
                headers,
                this.config.headerName,
                attemptCount,
                statusCode
              ),
              this.compress
            ).then((maybeError) => {
              if (!maybeError || maybeError.type === 'success') {
                this.replayEntries(config);
              } else {
                if (attemptCount + 1 > this.config.attemptLimit) {
                  debug(
                    () =>
                      'Exceeded attempt count, dropping the entry: ' +
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
                if (
                  maybeError.type === 'network' ||
                  config.allowedPersistRetryStatusCodes.includes(
                    maybeError.statusCode
                  )
                ) {
                  debug(
                    () =>
                      'Replaying the entry failed, pushing back to IDB: ' +
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
              }
            });
          }
        })
        .catch((reason: DOMException) => {
          this.disablePersistence = true;
          if (reason && reason.message) {
            logError(() => `Replay entry failed: ${reason.message}`);
          }
        });
    };
    const shouldUseIdle = this.config.useIdle?.() ?? false;
    shouldUseIdle ? scheduleTask(runReplayEntriesTask) : runReplayEntriesTask();
  }
}

class NoopQueue implements IQueue {
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
export class RetryDB implements IRetryDB {
  static hasSupport =
    typeof globalThis !== 'undefined' && !!globalThis.indexedDB;

  private queue: IQueue;
  private beaconListeners = new Set<() => void>();

  constructor(config: RetryDBConfig | DisableRetryDBConfig, compress = false) {
    this.queue =
      RetryDB.hasSupport && !config.disabled
        ? new Queue(config, compress)
        : new NoopQueue();
  }

  pushToQueue(entry: RetryEntry): void {
    this.queue.push(entry);
  }

  notifyQueue(config: QueueNotificationConfig): void {
    this.queue.onNotify(config);
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
