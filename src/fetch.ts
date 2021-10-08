import { RequestSuccess, RetryRejection } from './interfaces';
import { createRequestInit } from './utils';

export const supportFetch =
  typeof globalThis !== 'undefined' && 'fetch' in globalThis;

export const supportKeepaliveFetch =
  supportFetch && 'keepalive' in new Request('');

const supportSendBeacon =
  typeof navigator !== 'undefined' && 'sendBeacon' in navigator;

function keepaliveFetch(
  url: string,
  body: string,
  headers: HeadersInit
): Promise<RequestSuccess | RetryRejection> {
  return new Promise((resolve) => {
    fetch(url, createRequestInit({ body, keepalive: true, headers }))
      .catch(() => {
        // keepalive true fetch can throw error if body exceeds 64kb
        return fetch(
          url,
          createRequestInit({ body, keepalive: false, headers })
        );
      })
      .then(
        (response) => {
          if (response.ok) {
            resolve({ type: 'success', statusCode: 200 });
          } else {
            resolve({
              type: 'response',
              statusCode: response.status,
            });
          }
        },
        () => resolve({ type: 'network', statusCode: undefined })
      );
  });
}

function fallbackFetch(
  url: string,
  body: string,
  headers: HeadersInit
): Promise<RequestSuccess | RetryRejection | undefined> {
  return new Promise((resolve) => {
    if (supportSendBeacon) {
      let result = false;
      try {
        result = navigator.sendBeacon(url, body);
      } catch (_e) {
        // silent any error due to any browser issue
      }
      // if the user agent is not able to successfully queue the data for transfer,
      // send the payload with fetch api instead
      if (result) {
        resolve(undefined);
        return;
      }
    }
    fetch(url, createRequestInit({ body, keepalive: false, headers })).then(
      (response) => {
        if (response.ok) {
          resolve({
            type: 'success',
            statusCode: 200,
          });
        } else {
          resolve({
            type: 'response',
            statusCode: response.status,
          });
        }
      },
      () => resolve({ type: 'network', statusCode: undefined })
    );
  });
}

export const fetchFn = supportKeepaliveFetch ? keepaliveFetch : fallbackFetch;

/**
 * Fetch when browser is idle so retry does not impact performance
 */
export function idleFetch(
  url: string,
  body: string,
  headers: HeadersInit
): Promise<RequestSuccess | RetryRejection | undefined> {
  if (typeof requestIdleCallback === 'undefined') {
    return fetchFn(url, body, headers);
  }
  return new Promise((resolve) => {
    const runTask = (): void => {
      requestIdleCallback(
        (deadline) => {
          if (deadline.timeRemaining() > 5 || deadline.didTimeout) {
            resolve(fetchFn(url, body, headers));
          } else {
            runTask();
          }
        },
        { timeout: 10000 }
      );
    };
    runTask();
  });
}
