import createTestServer from 'create-test-server';
import fs from 'fs';
import path from 'path';
import type { Browser, BrowserContext, BrowserType, Page } from 'playwright';
import playwright from 'playwright';

import type beaconType from '../src/';
import type {
  clearQueue,
  setRetryHeaderPath,
  setRetryQueueConfig,
} from '../src/';
import type { peekQueue, RetryEntry } from '../src/queue';

declare global {
  interface Window {
    beacon: typeof beaconType;
    clearQueue: typeof clearQueue;
    setRetryHeaderPath: typeof setRetryHeaderPath;
    setRetryQueueConfig: typeof setRetryQueueConfig;
    peekQueue: typeof peekQueue;
  }
}

function defer(): [Promise<unknown>, (value: unknown) => void] {
  let resolver: (value: unknown) => void;
  const runningPromise = new Promise((res) => (resolver = res));
  return [runningPromise, resolver];
}

const script = {
  type: 'module',
  content: `
${fs.readFileSync(path.join(__dirname, '..', 'dist', 'index.js'), 'utf8')}
window.beacon = beacon;
window.__DEBUG_BEACON_TRANSPORTER = true;
window.clearQueue = clearQueue;
window.peekQueue = peekQueue;
window.setRetryHeaderPath = setRetryHeaderPath;
window.setRetryQueueConfig = setRetryQueueConfig;
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
    console.log(`Launch ${browserName}`);
    browser = await browserType.launch({});
  });

  afterAll(async () => {
    console.log(`Close ${browserName}`);
    await browser.close();
  });

  beforeEach(async () => {
    console.log(expect.getState().currentTestName);
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
      console.log(`[console.${msg.type()}]\t=> ${msg.text()}`);
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
    const [serverPromise, resolver] = defer();
    const results = [];
    let serverCount = 0;
    server.post('/api/:status', ({ params, headers }, res) => {
      const status = +params.status;
      const payload = { header: headers['x-retry-context'] };
      results.push(payload);
      console.log(`Received ${++serverCount} request`, payload);
      if (serverCount === 2) {
        resolver(null);
      }
      res.status(status).send(`Status: ${status}`);
    });

    let numberOfBeacons = 0;
    await page.route('**/api/*', (route) => {
      // fetch will fallback to keepalive false and try 2nd time
      if (++numberOfBeacons > (contentLength === '>64kb' ? 3 : 2 * 3)) {
        console.log('Continue route request');
        return route.continue();
      } else {
        console.log('Abort route request');
        return route.abort();
      }
    });
    await page.evaluate(
      ([url, bodyPayload]) => {
        window.setRetryHeaderPath('x-retry-context');
        window.beacon(`${url}/api/200`, bodyPayload, {
          retry: { limit: 2, persist: true },
        });
        setTimeout(() => {
          window.beacon(`${url}/api/200`, bodyPayload, {
            retry: { limit: 0, persist: true },
          });
        }, 2000 + 4000 + 500);
      },
      [server.url, createBody(contentLength)]
    );
    await serverPromise;
    expect(numberOfBeacons).toBe(contentLength === '>64kb' ? 3 + 2 : 2 * 3 + 2);
    expect(results.length).toBe(2);
    // attempt count includes in-memory attempts
    expect(results[1].header).toEqual(JSON.stringify({ attempt: 3 }));
  });

  it('retry with reading IDB skipped if retry.persist=false', async () => {
    const [serverPromise, resolver] = defer();
    const results = [];
    let serverCount = 0;
    server.post('/api/:status', ({ params, headers }, res) => {
      const status = +params.status;
      const payload = { status, header: headers['x-retry-context'] };
      results.push(payload);
      console.log(`Received ${++serverCount} request`, payload);
      if (serverCount === 2) {
        resolver(null);
      }
      res.status(status).send(`Status: ${status}`);
    });

    await page.evaluate(
      ([url, bodyPayload]) => {
        window.setRetryHeaderPath('x-retry-context');
        window.setRetryQueueConfig({
          attemptLimit: 2,
          maxNumber: 10,
          batchEvictionNumber: 3,
          throttleWait: 2000,
        });
        window.beacon(`${url}/api/429`, bodyPayload, {
          retry: { limit: 0, persist: true },
        });
        setTimeout(() => {
          window.beacon(`${url}/api/200`, bodyPayload, {
            retry: { limit: 0, persist: false },
          });
        }, 1000);
      },
      [server.url, createBody(contentLength)]
    );
    await serverPromise;
    expect(results.length).toBe(2);
    await page.waitForTimeout(1000);
    // There is no retry from idb
    expect(results.length).toBe(2);
    expect(results[0].status).toBe(429);
    expect(results[0].header).toBeUndefined;
    expect(results[1].status).toBe(200);
  });

  it('retry with reading IDB is throttled with every successful response', async () => {
    const [serverPromise, resolver] = defer();
    const results = [];
    let serverCount = 0;
    server.post('/api/:status', ({ params, headers }, res) => {
      const status = +params.status;
      const payload = { status, header: headers['x-retry-context'] };
      results.push(payload);
      console.log(`Received ${++serverCount} request`, payload);
      if (serverCount === 6) {
        resolver(null);
      }
      res.status(status).send(`Status: ${status}`);
    });

    await page.evaluate(
      ([url, bodyPayload]) => {
        window.setRetryHeaderPath('x-retry-context');
        window.setRetryQueueConfig({
          attemptLimit: 2,
          maxNumber: 10,
          batchEvictionNumber: 3,
          throttleWait: 2000,
        });
        window.beacon(`${url}/api/429`, bodyPayload, {
          retry: { limit: 0, persist: true },
        });
        setTimeout(() => {
          window.beacon(`${url}/api/200`, bodyPayload, {
            retry: { limit: 0, persist: true },
          });
        }, 1000);
        // waiting, will not trigger retry
        setTimeout(() => {
          window.beacon(`${url}/api/200`, bodyPayload, {
            retry: { limit: 0, persist: true },
          });
        }, 2000);
        // throttling finished, will trigger retry
        // 1000 + 2000 (throttle wait) + grace period
        setTimeout(() => {
          window.beacon(`${url}/api/200`, bodyPayload, {
            retry: { limit: 0, persist: true },
          });
        }, 3100);
      },
      [server.url, createBody(contentLength)]
    );
    await serverPromise;
    expect(results.length).toBe(6);
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
    const [serverPromise, resolver] = defer();
    const results = [];
    let serverCount = 0;
    server.post('/api/:status', ({ params, headers }, res) => {
      const status = +params.status;
      const payload = { status, header: headers['x-retry-context'] };
      results.push(payload);
      console.log(`Received ${++serverCount} request`, payload);
      if (serverCount === 3) {
        resolver(null);
      }
      res.status(status).send(`Status: ${status}`);
    });

    await page.evaluate(
      ([url, bodyPayload]) => {
        window.setRetryHeaderPath('x-retry-context');
        window.setRetryQueueConfig({
          attemptLimit: 1,
          maxNumber: 10,
          batchEvictionNumber: 3,
          throttleWait: 200,
        });
        window.beacon(`${url}/api/502`, bodyPayload, {
          retry: {
            limit: 1,
            persist: true,
            inMemoryRetryStatusCodes: [502],
          },
        });
        setTimeout(() => {
          window.beacon(`${url}/api/200`, bodyPayload, {
            retry: { limit: 0, persist: true },
          });
        }, 2500);
      },
      [server.url, createBody(contentLength)]
    );
    await serverPromise;
    await page.waitForTimeout(1000); // give extra 1s to confirm no retries fired
    expect(results.length).toBe(3);
    expect(results[0].status).toBe(502);
    expect(results[0].header).toBeUndefined;
    expect(results[1].status).toBe(502);
    expect(results[1].header).toBeUndefined;
    expect(results[2].status).toBe(200);
  });

  it('Storage can be manually cleared', async () => {
    const [serverPromise, resolver] = defer();
    const results = [];
    let serverCount = 0;
    server.post('/api/:status', ({ params, headers }, res) => {
      const status = +params.status;
      const payload = { status, header: headers['x-retry-context'] };
      results.push(payload);
      console.log(`Received ${++serverCount} request`, payload);
      if (serverCount === 2) {
        resolver(null);
      }
      res.status(status).send(`Status: ${status}`);
    });

    await page.evaluate(
      ([url, bodyPayload]) => {
        window.setRetryHeaderPath('x-retry-context');
        window.setRetryQueueConfig({
          attemptLimit: 1,
          maxNumber: 10,
          batchEvictionNumber: 3,
          throttleWait: 200,
        });
        window.beacon(`${url}/api/429`, bodyPayload, {
          retry: {
            limit: 1,
            persist: true,
            persistRetryStatusCodes: [429],
          },
        });
        setTimeout(async () => {
          await window.clearQueue();
          window.beacon(`${url}/api/200`, bodyPayload, {
            retry: { limit: 0, persist: true },
          });
        }, 2500);
      },
      [server.url, createBody(contentLength)]
    );
    await serverPromise;
    await page.waitForTimeout(1000); // give extra 1s to confirm no retries fired
    expect(results.length).toBe(2);
    expect(results[0].status).toBe(429);
    expect(results[0].header).toBeUndefined;
    expect(results[1].status).toBe(200);
  });

  it('persisting retryable statusCode has attempt limitation', async () => {
    const [serverPromise, resolver] = defer();
    const results = [];
    let serverCount = 0;
    server.post('/api/:status', ({ params, headers }, res) => {
      const status = +params.status;
      const payload = { status, header: headers['x-retry-context'] };
      results.push(payload);
      console.log(`Received ${++serverCount} request`, payload);
      if (serverCount === 6) {
        resolver(null);
      }
      res.status(status).send(`Status: ${status}`);
    });

    await page.evaluate(
      ([url, bodyPayload]) => {
        window.setRetryHeaderPath('x-retry-context');
        window.setRetryQueueConfig({
          attemptLimit: 2,
          maxNumber: 10,
          batchEvictionNumber: 3,
          throttleWait: 200,
        });
        window.beacon(`${url}/api/429`, bodyPayload, {
          retry: {
            limit: 0,
            persist: true,
            persistRetryStatusCodes: [429], // default is [429, 503]
          },
        });
        setTimeout(() => {
          window.beacon(`${url}/api/200`, bodyPayload, {
            retry: { limit: 0, persist: true },
          });
        }, 1000);
        setTimeout(() => {
          window.beacon(`${url}/api/200`, bodyPayload, {
            retry: { limit: 0, persist: true },
          });
        }, 2000);
        setTimeout(() => {
          window.beacon(`${url}/api/200`, bodyPayload, {
            retry: { limit: 0, persist: true },
          });
        }, 3000);
      },
      [server.url, createBody(contentLength)]
    );
    await serverPromise;
    await page.waitForTimeout(1000); // give extra 1s to confirm no retries fired
    expect(results.length).toBe(6);
    expect(results.map((r) => r.status)).toEqual([
      429, 200, 429, 200, 429, 200,
    ]);
  });

  it('persistent data can be retried on another page', async () => {
    const [serverPromise, resolver] = defer();
    const results = [];
    let serverCount = 0;
    server.post('/api/:status', ({ params, headers }, res) => {
      const status = +params.status;
      const payload = { status, header: headers['x-retry-context'] };
      results.push(payload);
      console.log(`Received ${++serverCount} request`, payload);
      if (serverCount === 3) {
        resolver(null);
      }
      res.status(status).send(`Status: ${status}`);
    });

    await page.evaluate(
      ([url, bodyPayload]) => {
        window.setRetryHeaderPath('x-retry-context');
        window.setRetryQueueConfig({
          attemptLimit: 2,
          maxNumber: 10,
          batchEvictionNumber: 3,
          throttleWait: 200,
        });
        window.beacon(`${url}/api/429`, bodyPayload, {
          retry: {
            limit: 0,
            persist: true,
            persistRetryStatusCodes: [429], // default is [429, 503]
          },
        });
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
      console.log(`[page-2][console.${msg.type()}]\t=> ${msg.text()}`);
    });
    await page2.waitForFunction(
      () => window.__DEBUG_BEACON_TRANSPORTER === true
    );
    await page2.evaluate(
      ([url, bodyPayload]) => {
        window.setRetryHeaderPath('x-retry-context');
        window.setRetryQueueConfig({
          attemptLimit: 2,
          maxNumber: 10,
          batchEvictionNumber: 3,
          throttleWait: 200,
        });
        window.beacon(`${url}/api/200`, bodyPayload, {
          retry: {
            limit: 0,
            persist: true,
          },
        });
      },
      [server.url, createBody(contentLength)]
    );

    await serverPromise;
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
        window.beacon(`${url}/api/429`, bodyPayload, {
          retry: { limit: 0, persist: true },
        });
      },
      [server.url, createBody(contentLength)]
    );
    await page.waitForTimeout(1000);
    const storage = await page.evaluate<RetryEntry[]>(`window.peekQueue(1)`);
    expect(storage.length).toBe(1);

    await page.evaluate(
      ([url, bodyPayload]) => {
        return Promise.all([
          window.beacon(`${url}/api/429`, bodyPayload, {
            retry: { limit: 0, persist: true },
          }),
          window.beacon(`${url}/api/429`, bodyPayload, {
            retry: { limit: 0, persist: true },
          }),
          window.clearQueue(),
        ]);
      },
      [server.url, createBody(contentLength)]
    );
    await page.waitForTimeout(1000);

    const storageAfterClear = await page.evaluate<RetryEntry[]>(
      `window.peekQueue(1)`
    );
    expect(storageAfterClear.length).toBe(0);
  });
});
