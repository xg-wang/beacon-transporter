import { createRequestInit, debug } from './utils';

export const supportFetch = typeof self !== 'undefined' && 'fetch' in self;

export const supportKeepaliveFetch =
  supportFetch && 'keepalive' in new Request('');

const supportSendBeacon =
  typeof navigator !== 'undefined' && 'sendBeacon' in navigator;

function keepaliveFetch(
  url: string,
  body: string,
  headers: HeadersInit
): Promise<Response> {
  debug('use keep alive fetch');
  return new Promise((resolve, reject) => {
    fetch(url, createRequestInit({ body, keepalive: true, headers }))
      .catch(() => {
        debug('fallback to keep alive false');
        // keepalive true fetch can throw error if body exceeds 64kb
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
  debug('use sendBeacon');

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
