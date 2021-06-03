import createTestServer from 'create-test-server';
import fs from 'fs';
import path from 'path';
import type { Browser, BrowserContext, BrowserType, Page } from 'playwright';
import playwright from 'playwright';

import type beaconType from '../src/';

declare global {
  interface Window {
    beacon: typeof beaconType;
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
`,
};

describe.each(['chromium', 'webkit', 'firefox'].map((t) => [t]))(
  '[%s] beacon',
  (name) => {
    const browserType: BrowserType<Browser> = playwright[name];
    let browser: Browser;
    let context: BrowserContext;
    let page: Page;
    let pageClosed = false;
    let server: any;

    beforeAll(async () => {
      console.log(`Launch ${name}`);
      browser = await browserType.launch({});
    });

    afterAll(async () => {
      console.log(`Close ${name}`);
      await browser.close();
    });

    beforeEach(async () => {
      pageClosed = false;
      context = await browser.newContext({ ignoreHTTPSErrors: true });
      page = await context.newPage();
      server = await createTestServer();
      server.get('/', (request, response) => {
        response.end('hello!');
      });
      page.on('console', async (msg) => {
        const msgs = [];
        for (let i = 0; i < msg.args().length; ++i) {
          if (pageClosed) break;
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
      pageClosed = true;
      await context.close();
      await server.close();
    });

    it('should fetch', async () => {
      const results = [];
      const [serverPromise, serverResolver] = defer();
      server.post('/api', (request, response) => {
        results.push(request.body);
        serverResolver(null);
        response.end('hello');
      });
      const [, result] = await Promise.all([
        serverPromise,
        page.evaluate((url) => {
          return window.beacon(`${url}/api`, 'hello');
        }, server.url),
      ]);

      expect(result).toBeUndefined;
      expect(results).toEqual(['hello']);
    });

    it('should send payload larger than 64kb', async () => {
      const results = [];
      const [serverPromise, serverResolver] = defer();
      server.post('/api', (request, response) => {
        results.push(request.body);
        serverResolver(null);
        response.end('hello');
      });
      await Promise.all([
        serverPromise,
        page.evaluate((url) => {
          return window.beacon(`${url}/api`, 's'.repeat(64_100));
        }, server.url),
      ]);

      expect(results[0].length).toEqual(64_100);
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
        const [serverPromise, serverResolver] = defer();
        server.post('/api', (request, response) => {
          results.push(request.body);
          serverResolver(null);
          response.end('hello');
        });
        await page.evaluate(
          ([url, eventName]) => {
            document.addEventListener(eventName, function () {
              window.beacon(`${url}/api`, 'closing');
            });
          },
          [server.url, getCloseTabEvent(name)]
        );
        await Promise.all([
          serverPromise,
          page.close({ runBeforeUnload: true }),
        ]);

        expect(results).toEqual(['closing']);
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
            window.beacon(`${url}/api`, 's'.repeat(64_100));
          });
        },
        [server.url, getCloseTabEvent(name)]
      );
      await page.close({ runBeforeUnload: true });

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
      //     console.log(`${i}: ${await msg.args()[i].jsonValue()}`);
      // });
      await page.evaluate(
        ([url]) => {
          return window.beacon(`${url}/api`, 'hi', {
            retry: { limit: 2 },
          });
        },
        [server.url]
      );
      await page.waitForTimeout(7000);
      expect(numberOfRetries).toBe(name === 'firefox' ? 1 : (2 + 1) * 2);
    });

    it('retry on server response statusCode', async () => {
      const requests1 = [];
      const requests2 = [];
      server.post('/api/retry', (request, response) => {
        requests1.push(request.body);
        response.sendStatus(502);
      });
      server.post('/api/noretry', (request, response) => {
        requests2.push(request.body);
        response.sendStatus(503);
      });
      await page.evaluate(
        ([url]) => {
          window.beacon(`${url}/api/retry`, 'hi', {
            retry: { limit: 2, inMemoryRetryStatusCodes: [502] },
          });
          window.beacon(`${url}/api/noretry`, 'hi', {
            retry: { limit: 2 },
          });
        },
        [server.url]
      );
      await page.waitForTimeout(7000);
      expect(requests1.length).toBe(name === 'firefox' ? 1 : 2 + 1);
      expect(requests2.length).toBe(1);
    });

    it('can customize retry delay', async () => {
      const requests = [];
      server.post('/api/retry', (request, response) => {
        requests.push(request.body);
        response.sendStatus(502);
      });
      await page.evaluate(
        ([url]) => {
          window.beacon(`${url}/api/retry`, 'hi', {
            retry: { limit: 2, inMemoryRetryStatusCodes: [502], calculateRetryDelay: (countLeft) => countLeft === 2 ? 1 : 2000 },
          });
        },
        [server.url]
      );
      await page.waitForTimeout(100);
      expect(requests.length).toBe(name === 'firefox' ? 1 : 2);
      await page.waitForTimeout(1900);
      expect(requests.length).toBe(name === 'firefox' ? 1 : 2);
      await page.waitForTimeout(100);
      expect(requests.length).toBe(name === 'firefox' ? 1 : 3);
    })
  }
);

function getCloseTabEvent(
  browserName: string
): 'pagehide' | 'visibilitychange' {
  return browserName === 'webkit' ? 'pagehide' : 'visibilitychange';
}
