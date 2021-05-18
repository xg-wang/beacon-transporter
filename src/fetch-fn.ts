import { createRequestInit, debug } from './utils';

export const supportFetch = typeof globalThis !== 'undefined' && 'fetch' in globalThis;

export const supportKeepaliveFetch =
  supportFetch && 'keepalive' in new Request('');

const supportSendBeacon =
  typeof navigator !== 'undefined' && 'sendBeacon' in navigator;

function keepaliveFetch(
  url: string,
  body: string,
  headers: HeadersInit
): Promise<Response> {
  return new Promise((resolve, reject) => {
    fetch(url, createRequestInit({ body, keepalive: true, headers }))
      .catch(() => {
        // keepalive true fetch can throw error if body exceeds 64kb
        debug('fetch failed 1st');
        return fetch(
          url,
          createRequestInit({ body, keepalive: false, headers })
        );
      })
      .then(
        (response) => {
          if (response.ok) {
            resolve(response);
          } else {
            reject({ type: 'response', statusCode: response.status });
          }
        },
        () => reject({ type: 'network' })
      );
  });
}

function fallbackFetch(
  url: string,
  body: string,
  headers: HeadersInit
): Promise<Response | null> {
  return new Promise((resolve, reject) => {
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
        debug(`sendBeacon passed, body length: ${body.length}`);
        resolve(null);
        return;
      }
    }
    fetch(url, createRequestInit({ body, keepalive: false, headers })).then(
      (response) => {
        if (response.ok) {
          resolve(response);
        } else {
          reject({
            type: 'response',
            statusCode: response.status,
          });
        }
      },
      () => reject({ type: 'network' })
    );
  });
}

const fetchFn = supportKeepaliveFetch ? keepaliveFetch : fallbackFetch;

export default fetchFn;
