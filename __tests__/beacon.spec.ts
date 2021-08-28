import createTestServer from 'create-test-server';
import fs from 'fs';
import path from 'path';
import type { Browser, BrowserContext, BrowserType, Page } from 'playwright';
import playwright from 'playwright';
import waitForExpect from 'wait-for-expect';

import type { createBeacon } from '../src/';
import { log } from './utils';

expect.extend({
  toBeAround(actual, expected, range = 400) {
    const pass = Math.abs(expected - actual) < range / 2;
    if (pass) {
      return {
        message: () => `expected ${actual} not to be close to ${expected}`,
        pass: true,
      };
    } else {
      return {
        message: () => `expected ${actual} to be close to ${expected}`,
        pass: false,
      };
    }
  },
});

declare global {
  interface Window {
    createBeacon: typeof createBeacon;
  }
  namespace jest {
    interface Matchers<R> {
      toBeAround(expected: number, delta?: number): R;
    }
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

describe.each(['chromium', 'webkit', 'firefox'].map((t) => [t]))(
  '[%s] beacon',
  (name) => {
    const browserType: BrowserType<Browser> = playwright[name];
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
      log(`Launch ${name}`);
      browser = await browserType.launch({});
    });

    afterAll(async () => {
      log(`Close ${name}`);
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

    it('should fetch', async () => {
      const results = [];
      server.post('/api', (request, response) => {
        results.push(request.body);
        response.end('hello');
      });
      const result = await page.evaluate((url) => {
        const { beacon } = window.createBeacon();
        return beacon(`${url}/api`, 'hello');
      }, server.url);
      expect(result).toBeUndefined;
      await waitForExpect(() => {
        expect(results).toEqual(['hello']);
      });
    });

    it('should send payload larger than 64kb', async () => {
      const results = [];
      server.post('/api', (request, response) => {
        results.push(request.body);
        response.end('hello');
      });
      await page.evaluate((url) => {
        return window.createBeacon().beacon(`${url}/api`, 's'.repeat(64_100));
      }, server.url);

      await waitForExpect(() => {
        expect(results[0].length).toEqual(64_100);
      });
    });

    if (
      name !== 'webkit' &&
      !(process.platform === 'linux' && name === 'chromium') &&
      !(process.platform === 'win32' && name === 'chromium')
    ) {
      // see https://bugs.webkit.org/show_bug.cgi?id=194897
      // navigator.sendBeacon does not work on visibilitychange callback for document unload
      // Possibly also playwright bug beforeunload / pagehide aren't firing

      it('should send payload on closing tab', async () => {
        const results = [];
        server.post('/api', (request, response) => {
          results.push(request.body);
          response.end('hello');
        });
        await page.evaluate(
          ([url, eventName]) => {
            document.addEventListener(eventName, function () {
              window.createBeacon().beacon(`${url}/api`, 'closing');
            });
          },
          [server.url, getCloseTabEvent(name)]
        );
        pageClosedForConsoleLog = true;
        await closePage(page);

        await waitForExpect(() => {
          expect(results).toEqual(['closing']);
        });
      });
    }

    it('may not send payload larger than 64kb on closing tab', async () => {
      const results = [];
      server.post('/api', (request, response) => {
        results.push(request.body);
        response.end('hello');
      });
      await page.evaluate(
        ([url, eventName]) => {
          document.addEventListener(eventName, function () {
            window.createBeacon().beacon(`${url}/api`, 's'.repeat(64_100));
          });
        },
        [server.url, getCloseTabEvent(name)]
      );
      pageClosedForConsoleLog = true;
      await closePage(page);

      expect(results.length).toBeLessThanOrEqual(1);
    });

    it('if not firefox, retry configured times before giving up', async () => {
      server.post('/api', (request, response) => {
        response.end('hello');
      });
      let numberOfRetries = 0;
      await page.route('**/api', (route) => {
        numberOfRetries++;
        route.abort();
      });
      // page.on('console', async (msg) => {
      //   for (let i = 0; i < msg.args().length; ++i)
      //     log(`${i}: ${await msg.args()[i].jsonValue()}`);
      // });
      await page.evaluate(
        ([url]) => {
          const { beacon } = window.createBeacon({
            beaconConfig: {
              retry: { limit: 2 },
            },
          });
          return beacon(`${url}/api`, 'hi');
        },
        [server.url]
      );
      await waitForExpect(() => {
        expect(numberOfRetries).toBe(name === 'firefox' ? 1 : (2 + 1) * 2);
      }, 10000);
    });

    it('retry on server response statusCode', async () => {
      const requests1 = [];
      const requests2 = [];
      server.post('/api/retry', ({ headers }, res) => {
        requests1.push({
          header: headers['x-retry-context'],
        });
        res.sendStatus(502);
      });
      server.post('/api/noretry', ({ headers }, res) => {
        requests2.push({
          header: headers['x-retry-context'],
        });
        res.sendStatus(503);
      });
      await page.evaluate(
        ([url]) => {
          window
            .createBeacon({
              beaconConfig: {
                retry: { limit: 2, inMemoryRetryStatusCodes: [502], headerName: 'x-retry-context' },
              },
            })
            .beacon(`${url}/api/retry`, 'hi');
          window
            .createBeacon({
              beaconConfig: {
                retry: { limit: 2 },
              },
            })
            .beacon(`${url}/api/noretry`, 'hi');
        },
        [server.url]
      );
      await waitForExpect(() => {
        if (name !== 'firefox') {
          expect(requests1.length).toBe(2 + 1);
        } else {
          expect(requests1.length).toBe(1);
        }
        expect(requests2.length).toBe(1);
      }, 10000);
      if (name !== 'firefox') {
        expect(requests1).toEqual([
          { header: undefined },
          { header: JSON.stringify({ attempt: 1, errorCode: 502 }) },
          { header: JSON.stringify({ attempt: 2, errorCode: 502 }) },
        ]);
      } else {
        expect(requests1[0]).toEqual({ header: undefined });
      }
    });

    it('can customize retry delay', async () => {
      const requests = [];
      server.post('/api/retry', (request, response) => {
        requests.push(Date.now());
        response.sendStatus(502);
      });
      await page.evaluate(
        ([url]) => {
          const { beacon } = window.createBeacon({
            beaconConfig: {
              retry: {
                limit: 2,
                inMemoryRetryStatusCodes: [502],
                calculateRetryDelay: (countLeft) =>
                  countLeft === 2 ? 1 : 2000,
              },
            },
          });
          beacon(`${url}/api/retry`, 'hi');
        },
        [server.url]
      );
      await waitForExpect(() => {
        expect(requests.length).toEqual(name === 'firefox' ? 1 : 3);
      });
      if (name !== 'firefox') {
        expect(requests[1] - requests[0]).toBeAround(1);
        expect(requests[2] - requests[1]).toBeAround(2000);
      }
    });
  }
);

function getCloseTabEvent(
  browserName: string
): 'pagehide' | 'visibilitychange' {
  return browserName === 'webkit' ? 'pagehide' : 'visibilitychange';
}
