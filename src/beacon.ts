const supportFetch = typeof self !== 'undefined' && 'fetch' in self;

const supportSendBeacon =
  typeof navigator !== 'undefined' && 'sendBeacon' in navigator;

const supportKeepaliveFetch = supportFetch && 'keepalive' in new Request('');

function createRequestInit({
  body,
  keepalive,
}: {
  body: string;
  keepalive: boolean;
}): RequestInit {
  return {
    body,
    keepalive,
    credentials: 'same-origin',
    headers: [['content-type', 'text/plain']],
    method: 'POST',
    mode: 'cors',
  };
}

class BeaconTransporter {
  constructor(url: string, body: string, private config?: BeaconConfig) {
    const retryCount = config?.retryCount ?? 0;

    if (supportKeepaliveFetch) {
      this.retry(
        () => this.keepaliveFetch(url, body),
        retryCount
      ).catch((reason) => console.error(reason));
    } else {
      this.retry(
        () => this.fallbackFetch(url, body),
        retryCount
      ).catch((reason) => console.error(reason));
    }
  }

  private keepaliveFetch(url: string, body: string): Promise<Response> {
    return new Promise((resolve, reject) => {
      fetch(url, createRequestInit({ body, keepalive: true }))
        .catch(() => {
          // keepalive true fetch can throw error if body exceeds 64kb
          return fetch(url, createRequestInit({ body, keepalive: false }));
        })
        .then(
          (response) => resolve(response),
          (reason) => reject(reason)
        );
    });
  }

  private fallbackFetch(url: string, body: string): Promise<Response | null> {
    return new Promise((resolve, reject) => {
      if (supportSendBeacon) {
        let result = false;
        try {
          if (this.config?.debug) {
            console.log(`[beacon-transporter] sendBeacon`);
          }
          result = navigator.sendBeacon(url, body);
        } catch (_e) {
          // silent any error due to any browser issue
        }
        // if the user agent is not able to successfully queue the data for transfer,
        // send the payload with fetch api instead
        if (result) {
          if (this.config?.debug) {
            console.log(`[beacon-transporter] sendBeacon => true`);
          }
          resolve(null);
          return;
        }
      }
      if (this.config?.debug) {
        console.log(`[beacon-transporter] sendBeacon => fetch`);
      }
      fetch(url, createRequestInit({ body, keepalive: false })).then(
        (response) => resolve(response),
        (reason) => reject(reason)
      );
    });
  }

  /**
   * Retry executing a function
   *
   * @param fn - The function to retry, should return a promise that rejects with error as retry instruction or resolves if finished
   * @returns result of the retry operation, true if fn ever resolved during retry, false if all retry failed
   */
  private retry(fn: () => Promise<unknown>, retryCount: number): Promise<true> {
    if (this.config?.debug) {
      console.log(`[beacon-transporter] retry ${retryCount}`);
    }
    return fn()
      .catch((error) => {
        if (retryCount > 0 && this.isRetryableError(error)) {
          return this.retry(fn, retryCount - 1);
        }
        throw error;
      })
      .then(() => true);
  }

  private isRetryableError(_error: any): boolean {
    return true;
  }
}

export interface BeaconConfig {
  debug?: boolean;
  retryCount: number;
}

const createBeaconInstance = () => {
  return (url: string, body: string, config?: BeaconConfig) => {
    if (!supportFetch) {
      return;
    }
    new BeaconTransporter(url, body, config);
  };
};

/**
 * @example
 * ```
 * import beacon from 'beacon-transporter';
 * beacon(`/api`, 'hi', { retryCount: 3 })
 * ```
 * @public
 */
const beacon = createBeaconInstance();

export default beacon;
