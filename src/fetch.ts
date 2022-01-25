import { RequestSuccess, RetryRejection } from './interfaces';
import { createRequestInit } from './utils';

export function isGlobalFetchSupported(): boolean {
  return typeof window !== 'undefined' && typeof window.fetch === 'function';
}

export function isKeepaliveFetchSupported(): boolean {
  try {
    return isGlobalFetchSupported() && 'keepalive' in new Request('');
  } catch (_error) {
    return false;
  }
}

const supportSendBeacon =
  typeof navigator !== 'undefined' && 'sendBeacon' in navigator;

function keepaliveFetch(
  url: string,
  body: string,
  headers: Record<string, string>,
  compress: boolean
): Promise<RequestSuccess | RetryRejection> {
  return new Promise((resolve) => {
    fetch(url, createRequestInit({ body, keepalive: true, headers, compress }))
      .catch(() => {
        // keepalive true fetch can throw error if body exceeds 64kb
        return fetch(
          url,
          createRequestInit({ body, keepalive: false, headers, compress })
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
  headers: Record<string, string>,
  compress: boolean
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
    fetch(
      url,
      createRequestInit({ body, keepalive: false, headers, compress })
    ).then(
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

export const fetchFn = isKeepaliveFetchSupported()
  ? keepaliveFetch
  : fallbackFetch;
