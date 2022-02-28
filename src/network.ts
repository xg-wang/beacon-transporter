import { gzipSync } from 'fflate';

import type {
  RequestNetworkError,
  RequestPersisted,
  RequestResponseError,
  RequestResponseUnknown,
  RequestResult,
  RequestSuccess,
} from './interfaces';

/**
 * @public
 */
export function isGlobalFetchSupported(): boolean {
  return typeof window !== 'undefined' && typeof window.fetch === 'function';
}

/**
 * @public
 */
export function isKeepaliveFetchSupported(): boolean {
  try {
    return isGlobalFetchSupported() && 'keepalive' in new Request('');
  } catch (_error) {
    return false;
  }
}

/**
 * @public
 */
export function xhr(
  url: string,
  body: string,
  options: {
    headers?: Record<string, string>;
  } = {}
): void {
  if (
    typeof window !== 'undefined' &&
    typeof window.XMLHttpRequest !== 'undefined'
  ) {
    const req = new XMLHttpRequest();
    req.open('POST', url, true);
    req.withCredentials = true;
    if (options.headers) {
      for (const key of Object.keys(options.headers)) {
        req.setRequestHeader(key, options.headers[key]);
      }
    }
    req.send(body);
  }
}

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
  if (!headers['content-type']) {
    headers['content-type'] = 'text/plain;charset=UTF-8';
  }

  let finalBody: string | Uint8Array = body;
  if (compress && typeof TextEncoder !== 'undefined') {
    try {
      finalBody = gzipSync(new TextEncoder().encode(body));
      headers['content-encoding'] = 'gzip';
    } catch (error) {
      // Do nothing if gzip fails
    }
  }

  return {
    body: finalBody,
    keepalive,
    credentials: 'include',
    headers,
    method: 'POST',
    mode: 'cors',
  };
}

function keepaliveFetch(
  url: string,
  body: string,
  headers: Record<string, string>,
  compress: boolean
): Promise<RequestSuccess | RequestNetworkError | RequestResponseError> {
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
            resolve({
              type: 'success',
              drop: false,
              statusCode: response.status,
            });
          } else {
            resolve({
              type: 'response',
              drop: false, // not yet dropped, possible to be re-written
              statusCode: response.status,
              rawError: response.statusText,
            });
          }
        },
        (error: unknown) =>
          resolve({
            type: 'network',
            drop: false, // not yet dropped, possible to be re-written
            rawError: serializeError(error),
          })
      );
  });
}

function serializeError(error: unknown): string {
  if (error && 'message' in (error as Error)) {
    return (error as Error).message;
  } else {
    return 'UNKNOWN_ERROR';
  }
}

const supportSendBeacon =
  typeof navigator !== 'undefined' && 'sendBeacon' in navigator;

function fallbackFetch(
  url: string,
  body: string,
  headers: Record<string, string>,
  compress: boolean
): Promise<
  | RequestSuccess
  | RequestResponseError
  | RequestNetworkError
  | RequestResponseUnknown
> {
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
        resolve({
          type: 'unknown',
          drop: false,
        });
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
            drop: false,
            statusCode: 200,
          });
        } else {
          resolve({
            type: 'response',
            drop: false, // not yet dropped, possible to be re-written
            statusCode: response.status,
            rawError: response.statusText,
          });
        }
      },
      (error: unknown) =>
        resolve({
          type: 'network',
          drop: false, // not yet dropped, possible to be re-written
          rawError: serializeError(error),
        })
    );
  });
}

/**
 * @public
 */
export type FetchFn = (
  url: string,
  body: string,
  headers: Record<string, string>,
  compress: boolean
) => Promise<Exclude<RequestResult, RequestPersisted>>;

/**
 * @public
 */
export const fetchFn: FetchFn = isKeepaliveFetchSupported()
  ? keepaliveFetch
  : fallbackFetch;
