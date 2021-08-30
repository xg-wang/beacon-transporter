import createTestServer from 'create-test-server';
import fs from 'fs';
import path from 'path';
import type { Browser, BrowserContext, BrowserType, Page } from 'playwright';
import playwright from 'playwright';
import waitForExpect from 'wait-for-expect';

import type { createBeacon } from '../src/';
import type { RetryEntry } from '../src/queue';
import { log } from './utils';

declare global {
  interface Window {
    createBeacon: typeof createBeacon;
  }
}

const script = {
  type: 'module',
  content: `
${fs.readFileSync(path.join(__dirname, '..', 'dist', 'index.js'), 'utf8')}
self.createBeacon = createBeacon;
self.__DEBUG_BEACON_TRANSPORTER = true;
`,
};

function createBody(lengthMode: string): string {
  return lengthMode === '>64kb' ? 's'.repeat(70000) : 'hi';
}

// FireFox doesn't cap sendBeacon / keepalive fetch string limit
// https://github.com/xg-wang/fetch-keepalive
describe.each([
  ['chromium', '<64kb'],
  ['chromium', '>64kb'],
  ['webkit', '<64kb'],
  ['webkit', '>64kb'],
])('[%s %s] beacon persistence', (browserName, contentLength) => {
  const browserType: BrowserType<Browser> = playwright[browserName];
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let pageClosedForConsoleLog = false;
  let server: any;

  function closePage(page: Page): Promise<void> {
    pageClosedForConsoleLog = true;
    return page.close({ runBeforeUnload: true });
  }

  beforeAll(async () => {
    log(`Launch ${browserName}`);
    browser = await browserType.launch({});
  });

  afterAll(async () => {
    log(`Close ${browserName}`);
    await browser.close();
  });

  beforeEach(async () => {
    log(expect.getState().currentTestName);
    pageClosedForConsoleLog = false;
    context = await browser.newContext({ ignoreHTTPSErrors: true });
    page = await context.newPage();
    server = await createTestServer();
    server.get('/', (request, response) => {
      response.end('hello!');
    });
    page.on('console', async (msg) => {
      const msgs = [];
      for (let i = 0; i < msg.args().length; ++i) {
        if (pageClosedForConsoleLog) break;
        msgs.push(await msg.args()[i].jsonValue());
      }
      log(`[console.${msg.type()}]\t=> ${msg.text()}`);
    });
    await page.goto(server.url);
    await page.addScriptTag(script);
    await page.waitForFunction(
      () => window.__DEBUG_BEACON_TRANSPORTER === true
    );
  });

  afterEach(async () => {
    pageClosedForConsoleLog = true;
    await context.close();
    await server.close();
  });

  it('stores beacon data if network having issue after all in-memory retires fail, retry on next successful response', async () => {
    const results = [];
    server.post('/api/:status', ({ params, headers }, res) => {
      const status = +params.status;
      const payload = { header: headers['x-retry-context'] };
      results.push(payload);
      res.status(status).send(`Status: ${status}`);
    });

    let numberOfBeacons = 0;
    await page.route('**/api/*', (route) => {
      // fetch will fallback to keepalive false and try 2nd time
      if (++numberOfBeacons > (contentLength === '>64kb' ? 3 : 2 * 3)) {
        log('Continue route request');
        return route.continue();
      } else {
        log('Abort route request');
        return route.abort();
      }
    });
    await page.evaluate(
      ([url, bodyPayload]) => {
        const { beacon } = window.createBeacon({
          beaconConfig: {
            retry: { limit: 2, persist: true, headerName: 'x-retry-context' },
          },
        });
        beacon(`${url}/api/200`, bodyPayload);
        setTimeout(() => {
          beacon(`${url}/api/200`, bodyPayload);
        }, 2000 + 4000 + 500);
      },
      [server.url, createBody(contentLength)]
    );
    await waitForExpect(() => {
      expect(results.length).toBe(2);
    }, 7500);
    expect(numberOfBeacons).toBe(contentLength === '>64kb' ? 3 + 2 : 2 * 3 + 2);
    // attempt count includes in-memory attempts
    expect(results[1].header).toEqual(JSON.stringify({ attempt: 3 }));
  });

  it('retry with reading IDB skipped if retry.persist=false', async () => {
    const results = [];
    server.post('/api/:status', ({ params, headers }, res) => {
      const status = +params.status;
      const payload = { status, header: headers['x-retry-context'] };
      results.push(payload);
      res.status(status).send(`Status: ${status}`);
    });

    await page.evaluate(
      ([url, bodyPayload]) => {
        const { beacon } = window.createBeacon({
          beaconConfig: {
            retry: { limit: 0, persist: false, headerName: 'x-retry-context' },
          },
          retryDBConfig: {
            storeName: 'default',
            attemptLimit: 2,
            maxNumber: 10,
            batchEvictionNumber: 3,
            throttleWait: 2000,
          },
        });
        beacon(`${url}/api/429`, bodyPayload);
        setTimeout(() => {
          beacon(`${url}/api/200`, bodyPayload);
        }, 1000);
      },
      [server.url, createBody(contentLength)]
    );
    await waitForExpect(() => {
      expect(results.length).toBe(2);
    });
    await page.waitForTimeout(1000);
    // There is no retry from idb
    expect(results.length).toBe(2);
    expect(results[0].status).toBe(429);
    expect(results[0].header).toBeUndefined;
    expect(results[1].status).toBe(200);
  });

  it('retry with reading IDB is throttled with every successful response', async () => {
    const results = [];
    server.post('/api/:status', ({ params, headers }, res) => {
      const status = +params.status;
      const payload = { status, header: headers['x-retry-context'] };
      results.push(payload);
      res.status(status).send(`Status: ${status}`);
    });

    await page.evaluate(
      ([url, bodyPayload]) => {
        const { beacon } = window.createBeacon({
          beaconConfig: {
            retry: { limit: 0, persist: true, headerName: 'x-retry-context' },
          },
          retryDBConfig: {
            storeName: 'default',
            attemptLimit: 2,
            maxNumber: 10,
            batchEvictionNumber: 3,
            throttleWait: 2000,
          },
        });
        beacon(`${url}/api/429`, bodyPayload);
        setTimeout(() => {
          beacon(`${url}/api/200`, bodyPayload);
        }, 1000);
        // waiting, will not trigger retry
        setTimeout(() => {
          beacon(`${url}/api/200`, bodyPayload);
        }, 2000);
        // throttling finished, will trigger retry
        // 1000 + 2000 (throttle wait) + grace period
        setTimeout(() => {
          beacon(`${url}/api/200`, bodyPayload);
        }, 3100);
      },
      [server.url, createBody(contentLength)]
    );
    await waitForExpect(() => {
      expect(results.length).toBe(6);
    });
    expect(results[0].status).toBe(429);
    expect(results[0].header).toBeUndefined;
    expect(results[1].status).toBe(200);
    expect(results[2].header).toEqual(
      JSON.stringify({ attempt: 1, errorCode: 429 })
    );
    expect(results[5].header).toEqual(
      JSON.stringify({ attempt: 2, errorCode: 429 })
    );
  });

  it('in memory retry statusCode response will not retry', async () => {
    const results = [];
    server.post('/api/:status', ({ params, headers }, res) => {
      const status = +params.status;
      const payload = { status, header: headers['x-retry-context'] };
      results.push(payload);
      res.status(status).send(`Status: ${status}`);
    });

    await page.evaluate(
      ([url, bodyPayload]) => {
        const { beacon } = window.createBeacon({
          beaconConfig: {
            retry: {
              limit: 1,
              persist: true,
              inMemoryRetryStatusCodes: [502],
              headerName: 'x-retry-context',
            },
          },
          retryDBConfig: {
            storeName: 'default',
            attemptLimit: 1,
            maxNumber: 10,
            batchEvictionNumber: 3,
            throttleWait: 200,
          },
        });
        beacon(`${url}/api/502`, bodyPayload);
        setTimeout(() => {
          beacon(`${url}/api/200`, bodyPayload);
        }, 2500);
      },
      [server.url, createBody(contentLength)]
    );
    await waitForExpect(() => {
      expect(results.length).toBe(3);
    });
    await page.waitForTimeout(1000); // give extra 1s to confirm no retries fired
    expect(results.length).toBe(3);
    expect(results[0].status).toBe(502);
    expect(results[0].header).toBeUndefined;
    expect(results[1].status).toBe(502);
    expect(results[1].header).toBeUndefined;
    expect(results[2].status).toBe(200);
  });

  it('Storage can be manually cleared', async () => {
    const results = [];
    server.post('/api/:status', ({ params, headers }, res) => {
      const status = +params.status;
      const payload = { status, header: headers['x-retry-context'] };
      results.push(payload);
      res.status(status).send(`Status: ${status}`);
    });

    await page.evaluate(
      ([url, bodyPayload]) => {
        const { beacon, database } = window.createBeacon({
          beaconConfig: {
            retry: {
              limit: 1,
              persist: true,
              inMemoryRetryStatusCodes: [429],
              headerName: 'x-retry-context',
            },
          },
          retryDBConfig: {
            storeName: 'default',
            attemptLimit: 1,
            maxNumber: 10,
            batchEvictionNumber: 3,
            throttleWait: 200,
          },
        });
        beacon(`${url}/api/429`, bodyPayload);
        setTimeout(async () => {
          await database.clearQueue();
          beacon(`${url}/api/200`, bodyPayload);
        }, 2500);
      },
      [server.url, createBody(contentLength)]
    );
    await waitForExpect(() => {
      expect(results.length).toBe(2);
    });
    await page.waitForTimeout(1000); // give extra 1s to confirm no retries fired
    expect(results.length).toBe(2);
    expect(results[0].status).toBe(429);
    expect(results[0].header).toBeUndefined;
    expect(results[1].status).toBe(200);
  });

  it('persisting retryable statusCode has attempt limitation', async () => {
    const results = [];
    server.post('/api/:status', ({ params, headers }, res) => {
      const status = +params.status;
      const payload = { status, header: headers['x-retry-context'] };
      results.push(payload);
      res.status(status).send(`Status: ${status}`);
    });

    await page.evaluate(
      ([url, bodyPayload]) => {
        const { beacon } = window.createBeacon({
          beaconConfig: {
            retry: {
              limit: 0,
              persist: true,
              inMemoryRetryStatusCodes: [429],
              headerName: 'x-retry-context',
            },
          },
          retryDBConfig: {
            storeName: 'default',
            attemptLimit: 2,
            maxNumber: 10,
            batchEvictionNumber: 3,
            throttleWait: 200,
          },
        });
        beacon(`${url}/api/429`, bodyPayload);
        setTimeout(() => {
          beacon(`${url}/api/200`, bodyPayload);
        }, 1000);
        setTimeout(() => {
          beacon(`${url}/api/200`, bodyPayload);
        }, 2000);
        setTimeout(() => {
          beacon(`${url}/api/200`, bodyPayload);
        }, 3000);
      },
      [server.url, createBody(contentLength)]
    );
    await waitForExpect(() => {
      expect(results.length).toBe(6);
    });
    await page.waitForTimeout(1000); // give extra 1s to confirm no retries fired
    expect(results.length).toBe(6);
    expect(results.map((r) => r.status)).toEqual([
      429, 200, 429, 200, 429, 200,
    ]);
  });

  it('persistent data can be retried on another page', async () => {
    const results = [];
    server.post('/api/:status', ({ params, headers }, res) => {
      const status = +params.status;
      const payload = { status, header: headers['x-retry-context'] };
      results.push(payload);
      res.status(status).send(`Status: ${status}`);
    });

    await page.evaluate(
      ([url, bodyPayload]) => {
        const { beacon } = window.createBeacon({
          beaconConfig: {
            retry: {
              limit: 0,
              persist: true,
              inMemoryRetryStatusCodes: [429],
              headerName: 'x-retry-context',
            },
          },
          retryDBConfig: {
            storeName: 'default',
            attemptLimit: 2,
            maxNumber: 10,
            batchEvictionNumber: 3,
            throttleWait: 200,
          },
        });
        beacon(`${url}/api/429`, bodyPayload);
      },
      [server.url, createBody(contentLength)]
    );

    const page2 = await context.newPage();
    await page2.goto(server.url);
    await page2.addScriptTag(script);
    page2.on('console', async (msg) => {
      const msgs = [];
      for (let i = 0; i < msg.args().length; ++i) {
        if (pageClosedForConsoleLog) break;
        msgs.push(await msg.args()[i].jsonValue());
      }
      log(`[page-2][console.${msg.type()}]\t=> ${msg.text()}`);
    });
    await page2.waitForFunction(
      () => window.__DEBUG_BEACON_TRANSPORTER === true
    );
    await page2.evaluate(
      ([url, bodyPayload]) => {
        const { beacon } = window.createBeacon({
          beaconConfig: {
            retry: {
              limit: 0,
              persist: true,
              inMemoryRetryStatusCodes: [429],
              headerName: 'x-retry-context',
            },
          },
          retryDBConfig: {
            storeName: 'default',
            attemptLimit: 2,
            maxNumber: 10,
            batchEvictionNumber: 3,
            throttleWait: 200,
          },
        });
        beacon(`${url}/api/200`, bodyPayload);
      },
      [server.url, createBody(contentLength)]
    );

    await waitForExpect(() => {
      expect(results.length).toBe(3);
    });
    await page2.waitForTimeout(1000); // give extra 1s to confirm no retries fired
    expect(results.length).toBe(3);
    expect(results.map((r) => r.status)).toEqual([429, 200, 429]);
    await closePage(page2);
  });

  it('sequential retry which writes to db do not race with clear', async () => {
    server.post('/api/:status', ({ params }, res) => {
      const status = +params.status;
      res.status(status).send(`Status: ${status}`);
    });

    await page.evaluate(
      ([url, bodyPayload]) => {
        const { beacon, database } = window.createBeacon({
          beaconConfig: {
            retry: { limit: 0, persist: true },
          },
        });
        // @ts-ignore
        window.beacon = beacon;
        // @ts-ignore
        window.database = database;
        beacon(`${url}/api/429`, bodyPayload);
      },
      [server.url, createBody(contentLength)]
    );
    await page.waitForTimeout(1000);
    const storage = await page.evaluate<RetryEntry[]>(`database.peekQueue(1)`);
    expect(storage.length).toBe(1);

    await page.evaluate(
      ([url, bodyPayload]) => {
        return Promise.all([
          // @ts-ignore
          beacon(`${url}/api/429`, bodyPayload),
          // @ts-ignore
          beacon(`${url}/api/429`, bodyPayload),
          // @ts-ignore
          database.clearQueue(),
        ]);
      },
      [server.url, createBody(contentLength)]
    );
    await page.waitForTimeout(1000);

    const storageAfterClear = await page.evaluate<RetryEntry[]>(
      `database.peekQueue(1)`
    );
    expect(storageAfterClear.length).toBe(0);
  });
});
