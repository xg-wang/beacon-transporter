import createTestServer, { Server } from '@xg-wang/create-test-server';
import fs from 'fs';
import path from 'path';
import type { Browser, BrowserContext, BrowserType, Page } from 'playwright';
import playwright from 'playwright';
import waitForExpect from 'wait-for-expect';

import type { createBeacon, RetryEntry } from '../dist';
import { log } from './utils';

declare global {
  interface Window {
    createBeacon: typeof createBeacon;
    __DEBUG_BEACON_TRANSPORTER: boolean;
  }
}

const script = {
  type: 'module',
  content: `
${fs.readFileSync(path.join(__dirname, '..', 'dist', 'bundle.esm.js'), 'utf8')}
self.createBeacon = createBeacon;
self.__DEBUG_BEACON_TRANSPORTER = true;
`,
};

function createBody(lengthMode: string): string {
  return lengthMode === '>64kb' ? 's'.repeat(70000) : 'hi';
}

const browsers = process.env.TEST_CHROME_ONLY
  ? ['chromium']
  : ['chromium', 'webkit'];
const table = browsers.flatMap((b) => [
  [b, '<64kb'],
  [b, '>64kb'],
]);

// FireFox doesn't cap sendBeacon / keepalive fetch string limit
// https://github.com/xg-wang/fetch-keepalive
describe.each(table)(
  '[%s %s] beacon persistence',
  (browserName, contentLength) => {
    const browserType: BrowserType<Browser> = playwright[browserName];
    let browser: Browser;
    let context: BrowserContext;
    let page: Page;
    let server: Server;

    function closePage(p: Page): Promise<void> {
      return p.close({ runBeforeUnload: true });
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
      context = await browser.newContext({ ignoreHTTPSErrors: true });
      page = await context.newPage();
      server = await createTestServer();
      server.get('/', (_request, response) => {
        response.end('hello!');
      });
      page.on('console', async (msg) => {
        log(`[console.${msg.type()}]\t=> ${msg.text()}`);
      });
      await page.goto(server.url);
      await page.addScriptTag(script);
      await page.waitForFunction(
        () => window.__DEBUG_BEACON_TRANSPORTER === true
      );
    });

    afterEach(async () => {
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
            inMemoryRetry: {
              attemptLimit: 2,
              headerName: 'x-retry-context',
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
      expect(numberOfBeacons).toBe(
        contentLength === '>64kb' ? 3 + 2 : 2 * 3 + 2
      );
      // attempt count includes in-memory attempts
      expect(results[1].header).toEqual(JSON.stringify({ attempt: 3 }));
    });

    it('can use requestIdleCallback for firing retry requests', async () => {
      const results = [];
      server.post('/api/:status', ({ params, headers }, res) => {
        const status = +params.status;
        const payload = { header: headers['x-retry-context'] };
        results.push(payload);
        res.status(status).send(`Status: ${status}`);
      });

      let numberOfBeacons = 0;
      await page.route('**/api/*', (route) => {
        // if >64kb fetch will fallback to keepalive false and try 2nd time before hitting network
        // if <64kb fetch will also fallback to keepalive false and try 2nd time, both hit network
        // and we need network to fail both attempts
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
            inMemoryRetry: {
              attemptLimit: 2,
              headerName: 'x-retry-context',
            },
            persistenceRetry: {
              idbName: 'beacon-transporter',
              attemptLimit: 3,
              maxNumber: 1000,
              batchEvictionNumber: 300,
              throttleWait: 5 * 60 * 1000,
              useIdle: true,
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
      expect(numberOfBeacons).toBe(
        contentLength === '>64kb' ? 3 + 2 : 2 * 3 + 2
      );
      // attempt count includes in-memory attempts
      expect(results[1].header).toEqual(JSON.stringify({ attempt: 3 }));
    });

    it('retry with reading IDB skipped if disablePersistenceRetry=true', async () => {
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
            inMemoryRetry: {
              attemptLimit: 0,
              headerName: 'x-retry-context',
            },
            disablePersistenceRetry: true,
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
            persistenceRetry: {
              idbName: 'test-database',
              attemptLimit: 2,
              maxNumber: 10,
              batchEvictionNumber: 3,
              throttleWait: 2000,
            },
            inMemoryRetry: {
              attemptLimit: 0,
              headerName: 'x-retry-context',
            },
          });

          beacon(`${url}/api/200`, bodyPayload);
          // push to DB will reset throttle timer
          setTimeout(() => {
            beacon(`${url}/api/429`, bodyPayload);
          }, 500);
          setTimeout(() => {
            beacon(`${url}/api/200`, bodyPayload);
          }, 500 + 1000);
          // waiting, will not trigger retry
          setTimeout(() => {
            beacon(`${url}/api/200`, bodyPayload);
          }, 500 + 1000 + 1000);
          // throttling finished, will trigger retry
          // initial + (throttle wait) + (grace period)
          setTimeout(() => {
            beacon(`${url}/api/200`, bodyPayload);
          }, 500 + 1000 + 2000 + 100);
        },
        [server.url, createBody(contentLength)]
      );
      await waitForExpect(() => {
        expect(results.length).toBe(7);
      });
      expect(results[0].status).toBe(200);
      expect(results[1].status).toBe(429);
      expect(results[1].header).toBeUndefined;
      expect(results[2].status).toBe(200);
      expect(results[3].status).toBe(429);
      expect(results[3].header).toEqual(
        JSON.stringify({ attempt: 1, errorCode: 429 })
      );
      expect(results[4].status).toBe(200);
      expect(results[5].status).toBe(200);
      expect(results[6].status).toBe(429);
      expect(results[6].header).toEqual(
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
            inMemoryRetry: {
              attemptLimit: 1,
              statusCodes: [888],
              headerName: 'x-retry-context',
            },
            persistenceRetry: {
              idbName: 'test-database',
              attemptLimit: 1,
              maxNumber: 10,
              batchEvictionNumber: 3,
              throttleWait: 200,
            },
          });
          beacon(`${url}/api/888`, bodyPayload);
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
      expect(results[0].status).toBe(888);
      expect(results[0].header).toBeUndefined;
      expect(results[1].status).toBe(888);
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
            inMemoryRetry: {
              attemptLimit: 1,
              headerName: 'x-retry-context',
            },
            persistenceRetry: {
              idbName: 'test-database',
              statusCodes: [999],
              attemptLimit: 1,
              maxNumber: 10,
              batchEvictionNumber: 3,
              throttleWait: 200,
            },
          });
          beacon(`${url}/api/999`, bodyPayload);
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
      expect(results[0].status).toBe(999);
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
            inMemoryRetry: {
              attemptLimit: 0,
              headerName: 'x-retry-context',
            },
            persistenceRetry: {
              idbName: 'test-database',
              attemptLimit: 2,
              statusCodes: [999],
              maxNumber: 10,
              batchEvictionNumber: 3,
              throttleWait: 200,
            },
          });
          beacon(`${url}/api/999`, bodyPayload);
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
        999, 200, 999, 200, 999, 200,
      ]);
    });

    it('will not retry again if retrying from IDB failed from response codes not in allowed status codes', async () => {
      const results: { status: number; header: string }[] = [];
      server.post('/api/:status', ({ params, headers }, res) => {
        const status = +params.status;
        const payload = {
          status,
          header: headers['x-retry-context'] as string,
        };
        results.push(payload);
        res.status(status).send(`Status: ${status}`);
      });

      let numberOfBeacons = 0;
      await page.route('**/api/*', (route) => {
        // if >64kb fetch will fallback to keepalive false and try 2nd time before hitting network
        // if <64kb fetch will also fallback to keepalive false and try 2nd time, both hit network
        // and we need network to fail both attempts
        if (++numberOfBeacons > (contentLength === '>64kb' ? 1 : 2)) {
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
            inMemoryRetry: {
              attemptLimit: 0,
              statusCodes: [888],
              headerName: 'x-retry-context',
            },
            persistenceRetry: {
              statusCodes: [999],
              idbName: 'test-database',
              attemptLimit: 2,
              maxNumber: 10,
              batchEvictionNumber: 3,
              throttleWait: 200,
            },
          });
          // This will first fail due to network issue, then response with 888 (inMemoryRetryStatusCodes)
          // but RetryDB will drop when we see 888 which is not in persistRetryStatusCodes
          beacon(`${url}/api/888`, bodyPayload);
          // This will trigger the 888 request
          setTimeout(() => {
            beacon(`${url}/api/200`, bodyPayload);
          }, 2000);
          // This will try to trigger anything left in DB again to verify nothing's there
          setTimeout(() => {
            beacon(`${url}/api/200`, bodyPayload);
          }, 2000 + 2000);
        },
        [server.url, createBody(contentLength)]
      );
      await waitForExpect(() => {
        expect(results.length).toBe(3);
      }, 5000);
      await page.waitForTimeout(1000); // give extra 1s to confirm no retries fired
      expect(numberOfBeacons).toBe(contentLength === '>64kb' ? 1 + 3 : 2 + 3);
      expect(results.map((r) => r.status)).toEqual([200, 888, 200]);
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
            inMemoryRetry: {
              attemptLimit: 0,
              headerName: 'x-retry-context',
            },
            persistenceRetry: {
              statusCodes: [999],
              idbName: 'test-database',
              attemptLimit: 2,
              maxNumber: 10,
              batchEvictionNumber: 3,
              throttleWait: 200,
            },
          });
          beacon(`${url}/api/999`, bodyPayload);
        },
        [server.url, createBody(contentLength)]
      );

      const page2 = await context.newPage();
      await page2.goto(server.url);
      await page2.addScriptTag(script);
      page2.on('console', async (msg) => {
        log(`[page-2][console.${msg.type()}]\t=> ${msg.text()}`);
      });
      await page2.waitForFunction(
        () => window.__DEBUG_BEACON_TRANSPORTER === true
      );
      await page2.evaluate(
        ([url, bodyPayload]) => {
          const { beacon } = window.createBeacon({
            inMemoryRetry: {
              attemptLimit: 0,
              headerName: 'x-retry-context',
            },
            persistenceRetry: {
              statusCodes: [999],
              idbName: 'test-database',
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
      expect(results.map((r) => r.status)).toEqual([999, 200, 999]);
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
            inMemoryRetry: {
              attemptLimit: 0,
            },
            persistenceRetry: {
              statusCodes: [999],
            },
          });
          // @ts-ignore
          window.beacon = beacon;
          // @ts-ignore
          window.database = database;
          beacon(`${url}/api/999`, bodyPayload);
        },
        [server.url, createBody(contentLength)]
      );
      await page.waitForTimeout(1000);
      const storage = await page.evaluate<RetryEntry[]>(
        `database.peekQueue(1)`
      );
      expect(storage.length).toBe(1);

      await page.evaluate(
        ([url, bodyPayload]) => {
          return Promise.all([
            // @ts-ignore
            beacon(`${url}/api/999`, bodyPayload),
            // @ts-ignore
            beacon(`${url}/api/999`, bodyPayload),
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

    it('gzip compress retry requests from previous session', async () => {
      const results = [];
      server.post('/api/:status', ({ params, headers }, res) => {
        const status = +params.status;
        const payload = {
          status,
          header: headers['x-retry-context'],
          encoding: headers['content-encoding'],
        };
        results.push(payload);
        res.status(status).send(`Status: ${status}`);
      });

      await page.evaluate(
        ([url, bodyPayload]) => {
          const { beacon } = window.createBeacon({
            inMemoryRetry: {
              attemptLimit: 0,
              headerName: 'x-retry-context',
            },
            persistenceRetry: {
              statusCodes: [999],
              idbName: 'test-database',
              attemptLimit: 2,
              maxNumber: 10,
              batchEvictionNumber: 3,
              throttleWait: 200,
            },
            compress: false, // explicitly set to false, which is the default
          });
          beacon(`${url}/api/999`, bodyPayload);
        },
        [server.url, createBody(contentLength)]
      );

      const page2 = await context.newPage();
      await page2.goto(server.url);
      await page2.addScriptTag(script);
      page2.on('console', async (msg) => {
        log(`[page-2][console.${msg.type()}]\t=> ${msg.text()}`);
      });
      await page2.waitForFunction(
        () => window.__DEBUG_BEACON_TRANSPORTER === true
      );
      await page2.evaluate(
        ([url, bodyPayload]) => {
          const { beacon } = window.createBeacon({
            inMemoryRetry: {
              attemptLimit: 0,
              headerName: 'x-retry-context',
            },
            persistenceRetry: {
              statusCodes: [999],
              idbName: 'test-database',
              attemptLimit: 2,
              maxNumber: 10,
              batchEvictionNumber: 3,
              throttleWait: 200,
            },
            compress: true,
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
      expect(results.map((r) => r.status)).toEqual([999, 200, 999]);
      expect(results.map((r) => r.encoding)).toEqual([
        undefined,
        'gzip',
        'gzip',
      ]);
      await closePage(page2);
    });

    it('Adds performance measurement for IDB open', async () => {
      const results = [];
      server.post('/api/:status', ({ params, headers }, res) => {
        const status = +params.status;
        const payload = { status, header: headers['x-retry-context'] };
        results.push(payload);
        res.status(status).send(`Status: ${status}`);
      });

      await page.evaluate(() => {
        window.createBeacon({
          inMemoryRetry: {
            attemptLimit: 1,
            headerName: 'x-retry-context',
          },
          persistenceRetry: {
            statusCodes: [999],
            idbName: 'test-database',
            attemptLimit: 1,
            maxNumber: 10,
            batchEvictionNumber: 3,
            throttleWait: 200,
            measureIDB: {
              createStartMark: 'create-start',
              createSuccessMeasure: 'create-success-measure',
              createFailMeasure: 'create-fail-measure',
            },
          },
        });
      });
      await page.waitForTimeout(1000);
      const perfEntries = await page.evaluate(() => {
        return [
          performance
            .getEntriesByName('create-success-measure', 'measure')[0]
            .toJSON(),
          performance.getEntriesByName('create-start', 'mark')[0].toJSON(),
        ];
      });
      expect(perfEntries.length).toEqual(2);
      expect(perfEntries[0].name).toEqual('create-success-measure');
      expect(perfEntries[0].startTime).toEqual(perfEntries[1].startTime);
    });
  }
);
