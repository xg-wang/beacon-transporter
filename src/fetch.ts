import { gzipSync } from 'fflate';

import { RequestSuccess, RetryRejection } from './interfaces';

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

function createRequestInit({
  body,
  keepalive,
  headers,
  compress,
}: {
  body: string;
  keepalive: boolean;
  headers: Record<string, string>;
  compress: boolean;
}): RequestInit {
  const finalHeaders = new Headers(headers);
  if (!finalHeaders.get('content-type')) {
    finalHeaders.set('content-type', 'text/plain;charset=UTF-8');
  }

  let finalBody: string | Uint8Array = body;
  if (compress && typeof TextEncoder !== 'undefined') {
    finalBody = gzipSync(new TextEncoder().encode(body));
    finalHeaders.set('content-encoding', 'gzip');
  }

  return {
    body: finalBody,
    keepalive,
    credentials: 'include',
    headers: finalHeaders,
    method: 'POST',
    mode: 'cors',
  };
}

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
