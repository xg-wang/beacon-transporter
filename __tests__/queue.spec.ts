import createTestServer from 'create-test-server';
import fs from 'fs';
import path from 'path';
import type { Browser, BrowserContext, BrowserType, Page } from 'playwright';
import playwright from 'playwright';

import type beaconType from '../src/';
import type { setRetryHeaderPath, setRetryQueueConfig } from '../src/';

declare global {
  interface Window {
    beacon: typeof beaconType;
    setRetryHeaderPath: typeof setRetryHeaderPath;
    setRetryQueueConfig: typeof setRetryQueueConfig;
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
self.beacon = beacon;
self.__DEBUG_BEACON_TRANSPORTER = true;
self.setRetryHeaderPath = setRetryHeaderPath;
self.setRetryQueueConfig = setRetryQueueConfig;
`,
};

describe.each(['chromium', 'webkit', 'firefox'].map((t) => [t]))(
  '[%s] beacon persistence',
  (browserName) => {
    const browserType: BrowserType<Browser> = playwright[browserName];
    let browser: Browser;
    let context: BrowserContext;
    let page: Page;
    let pageClosed = false;
    let server: any;

    beforeAll(async () => {
      console.log(`Launch ${browserName}`);
      browser = await browserType.launch({});
    });

    afterAll(async () => {
      console.log(`Close ${browserName}`);
      await browser.close();
    });

    beforeEach(async () => {
      pageClosed = false;
      context = await browser.newContext({ ignoreHTTPSErrors: true });
      page = await context.newPage();
      server = await createTestServer();
      server.get('/', (request, response) => {
        response.end('hi');
      });
      page.on('console', async (msg) => {
        const msgs = [];
        for (let i = 0; i < msg.args().length; ++i) {
          if (pageClosed) break;
          msgs.push(await msg.args()[i].jsonValue());
        }
        console.log(`[${msg.type()}]\t=> ${msg.text()}`);
      });
      await page.goto(server.sslUrl);
      await page.addScriptTag(script);
    });

    afterEach(async () => {
      pageClosed = true;
      await context.close();
      await server.close();
    });

    if (browserName !== 'firefox') {
      it('stores beacon data if network having issue, retry on next successful response', async () => {
        const [serverPromise, resolver] = defer();
        const results = [];
        let serverCount = 0;
        server.post('/api/:status', ({ params, body, headers }, res) => {
          const status = +params.status;
          const payload = { body, header: headers['x-retry-context'] };
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
          if (++numberOfBeacons >= 3) {
            console.log('Continue route request');
            return route.continue();
          } else {
            console.log('Abort route request');
            return route.abort();
          }
        });
        await page.evaluate(
          ([url]) => {
            window.setRetryHeaderPath('x-retry-context');
            window.beacon(`${url}/api/200`, 'hi', {
              retry: { limit: 0, persist: true },
            });
            setTimeout(() => {
              window.beacon(`${url}/api/200`, 'hi', {
                retry: { limit: 0, persist: true },
              });
            }, 1000);
          },
          [server.sslUrl]
        );
        await serverPromise;
        expect(numberOfBeacons).toBe(4);
        expect(results.length).toBe(2);
        expect(results[1].header).toEqual(JSON.stringify({ attempt: 0 }));
      });
    }

    if (browserName !== 'firefox') {
      it('retry with reading IDB is throttled with every successful response', async () => { const [serverPromise, resolver] = defer();
        const results = [];
        let serverCount = 0;
        server.post('/api/:status', ({ params, body, headers }, res) => {
          const status = +params.status;
          const payload = { body, status, header: headers['x-retry-context'] };
          results.push(payload);
          console.log(`Received ${++serverCount} request`, payload);
          if (serverCount === 6) {
            resolver(null);
          }
          res.status(status).send(`Status: ${status}`);
        });

        await page.evaluate(
          ([url]) => {
            window.setRetryHeaderPath('x-retry-context');
            window.setRetryQueueConfig({
              attemptLimit: 1,
              maxNumber: 10,
              batchEvictionNumber: 3,
              throttleWait: 2000,
            });
            window.beacon(`${url}/api/429`, 'hi', {
              retry: { limit: 0, persist: true },
            });
            setTimeout(() => {
              window.beacon(`${url}/api/200`, 'hi', {
                retry: { limit: 0, persist: true },
              });
            }, 500);
            setTimeout(() => {
              window.beacon(`${url}/api/200`, 'hi', {
                retry: { limit: 0, persist: true },
              });
            }, 1000);
            setTimeout(() => {
              window.beacon(`${url}/api/200`, 'hi', {
                retry: { limit: 0, persist: true },
              });
            }, 2600); // 500 + 2000 (throttle wait) + grace period
          },
          [server.sslUrl]
        );
        await serverPromise;
        expect(results.length).toBe(6);
        expect(results[0].status).toBe(429);
        expect(results[0].header).toBeUndefined;
        expect(results[1].status).toBe(200);
        expect(results[2].header).toEqual(
          JSON.stringify({ attempt: 0, errorCode: 429 })
        );
        expect(results[5].header).toEqual(
          JSON.stringify({ attempt: 1, errorCode: 429 })
        );
      });
    }

    // it('in memory retry statusCode response will not retry', async () => {});

    // it('persist retryable statusCode has attempt limitation', async () => {});

    // it('persist retryable statusCode beacons can include attempt and errorCode in headers', async () => {});

    // it('persistent data can be retried on another page', async () => {});
  }
);
