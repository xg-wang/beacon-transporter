import { mutex } from 'webstorage-mutex';

import type {
  IRetryDBBase,
  LocalStorageRetryDBConfig,
  QueueNotificationConfig,
  RetryEntry,
} from './interfaces';
import { fetchFn } from './network';
import { createHeaders, logError, scheduleTask, throttle } from './utils';

/**
 * @public
 */
export interface LocalStorageRetryDB extends IRetryDBBase {
  clearQueue: () => void;
  peekQueue: (count?: number) => RetryEntry[];
}

/**
 * @public
 */
export function createLocalStorageRetryDB({
  keyName,
  maxNumber,
  throttleWait,
  headerName,
  attemptLimit,
  compressFetch,
}: LocalStorageRetryDBConfig): LocalStorageRetryDB {
  const isSupported = supportLocalStorage();
  const onClearListeners = new Set<() => void>();

  const replayEntries = ({
    allowedPersistRetryStatusCodes,
  }: QueueNotificationConfig): void => {
    scheduleTask(() => {
      mutex(() => {
        const storageItem = window.localStorage.getItem(keyName);
        window.localStorage.removeItem(keyName);
        return storageItem;
      })
        .then((storageItem) => {
          const persistedEntries = storageItem
            ? (JSON.parse(storageItem) as RetryEntry[])
            : [];
          const loopFetcher = (): Promise<void> => {
            const firstEntry = persistedEntries.shift();
            if (!firstEntry) {
              return Promise.resolve();
            }
            const { url, body, headers, statusCode, attemptCount } = firstEntry;
            return fetchFn(
              url,
              body,
              createHeaders(headers, headerName, attemptCount, statusCode),
              compressFetch
            ).then((maybeError) => {
              if (!maybeError || maybeError.type === 'success') {
                return loopFetcher();
              }
              if (attemptCount + 1 > attemptLimit) {
                return;
              }
              if (
                maybeError.type === 'network' ||
                allowedPersistRetryStatusCodes.includes(maybeError.statusCode)
              ) {
                firstEntry.attemptCount++;
                return mutex(() => {
                  const potentialNewStorageItem =
                    window.localStorage.getItem(keyName);
                  const entries = potentialNewStorageItem
                    ? (JSON.parse(potentialNewStorageItem) as RetryEntry[])
                    : [];
                  persistedEntries.unshift(firstEntry);
                  persistedEntries.push(...entries);
                  window.localStorage.setItem(
                    keyName,
                    JSON.stringify(persistedEntries)
                  );
                }).catch((reason: Error) => {
                  if (reason && reason.message) {
                    logError(() => reason.message);
                  }
                });
              }
            });
          };
          return loopFetcher();
        })
        .catch((reason: Error) => {
          if (reason && reason.message) {
            logError(() => `Replay entry failed: ${reason.message}`);
          }
        });
    });
  };
  const throttleControl = throttle(replayEntries, throttleWait);

  return {
    pushToQueue: (entry: RetryEntry) => {
      if (!isSupported) {
        return;
      }
      scheduleTask(() => {
        mutex(() => {
          const storageItem = window.localStorage.getItem(keyName);
          try {
            const persistedEntries: RetryEntry[] = storageItem
              ? (JSON.parse(storageItem) as RetryEntry[])
              : [];
            if (
              Array.isArray(persistedEntries) &&
              persistedEntries.length + 1 <= maxNumber
            ) {
              persistedEntries.push(entry);
              window.localStorage.setItem(
                keyName,
                JSON.stringify(persistedEntries)
              );
            } else {
              window.localStorage.removeItem(keyName);
            }
          } catch (error) {
            if (error instanceof Error) {
              logError(() => (error as Error).message);
            }
            window.localStorage.removeItem(keyName);
          }
        })
          .then(() => throttleControl.resetThrottle())
          .catch((reason) => {
            logError(() => (reason as unknown as Error)?.message);
          });
      });
    },
    notifyQueue: (config: QueueNotificationConfig) => {
      if (!isSupported) {
        return;
      }
      throttleControl.throttledFn(config);
    },
    clearQueue: () => {
      onClearListeners.forEach((cb) => cb());
      if (!isSupported) {
        return;
      }
      window.localStorage.removeItem(keyName);
    },
    peekQueue(count): RetryEntry[] {
      if (!isSupported) {
        return [];
      }
      try {
        const items = window.localStorage.getItem(keyName);
        if (!items) return [];
        const persistedEntries = JSON.parse(items) as RetryEntry[];
        return Array.isArray(persistedEntries)
          ? persistedEntries.slice(0, count)
          : [];
      } catch (error: unknown) {
        if (error instanceof Error) {
          logError(() => (error as Error).message);
        }
        return [];
      }
    },
    onClear: (cb: () => void) => {
      onClearListeners.add(cb);
    },
    removeOnClear: (cb: () => void) => {
      onClearListeners.delete(cb);
    },
  };
}

/**
 * Detect localStorage access
 * {@link https://github.com/Modernizr/Modernizr/blob/28d969e85cd8ebe5854f6296fd6aace241f6bdf7/feature-detects/storage/localstorage.js}
 */
function supportLocalStorage(): boolean {
  try {
    const tester = '__test_local_storage_support__';
    localStorage.setItem(tester, tester);
    localStorage.removeItem(tester);
    return true;
  } catch (e) {
    return false;
  }
}
