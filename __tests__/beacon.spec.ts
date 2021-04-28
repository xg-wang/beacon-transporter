import * as createTestServer from 'create-test-server';
import * as fs from 'fs';
import * as path from 'path';
import * as playwright from 'playwright';
import { Browser, BrowserType, Page } from 'playwright';

function defer(): [Promise<unknown>, (value: unknown) => void] {
  let resolver: (value: unknown) => void;
  const runningPromise = new Promise((res) => (resolver = res));
  return [runningPromise, resolver];
}

const script = {
  type: 'module',
  content: `
${fs.readFileSync(path.join(__dirname, '..', 'dist', 'index.js'), 'utf8')}
globalThis.beacon = beacon;
`,
};

describe.each(['chromium', 'webkit', 'firefox'].map((t) => [t]))(
  '%s',
  (name) => {
    const browserType: BrowserType<Browser> = playwright[name];
    let browser: Browser;
    let page: Page;
    let server: any;

    beforeAll(async () => {
      console.log(`Launch ${name}`);
      browser = await browserType.launch({
        logger: {
          isEnabled: (name, severity) => false,
          log: (name, severity, message, args) =>
            console.log(`${name} ${message}`),
        },
      });
    });

    afterAll(async () => {
      console.log(`Close ${name}`);
      await browser.close();
    });

    beforeEach(async () => {
      page = await browser.newPage();
      server = await createTestServer();
    });

    afterEach(async () => {
      await page.close();
      await server.close();
    });

    it('should fetch', async () => {
      const results = [];
      const [serverPromise, serverResolver] = defer();
      server.get('/', (request, response) => {
        response.end('hi');
      });
      server.post('/api', (request, response) => {
        results.push(request.body);
        serverResolver(null);
        response.end('hello');
      });
      await page.goto(server.url);
      await page.addScriptTag(script);
      const [, result] = await Promise.all([
        serverPromise,
        page.evaluate((url) => {
          return (<any>window).beacon(`${url}/api`, 'hello');
        }, server.url),
      ]);

      expect(result).toBeUndefined;
      expect(results).toEqual(['hello']);
    });

    it('should send payload larger than 64kb', async () => {
      const results = [];
      const [serverPromise, serverResolver] = defer();
      server.get('/', (request, response) => {
        response.end('hi');
      });
      server.post('/api', (request, response) => {
        results.push(request.body);
        serverResolver(null);
        response.end('hello');
      });
      await page.goto(server.url);
      await page.addScriptTag(script);
      await Promise.all([
        serverPromise,
        page.evaluate((url) => {
          return (<any>window).beacon(`${url}/api`, 's'.repeat(64_100));
        }, server.url),
      ]);

      expect(results[0].length).toEqual(64_100);
    });

    if (name !== 'webkit') {
      // see https://bugs.webkit.org/show_bug.cgi?id=194897
      // navigator.sendBeacon does not work on visibilitychange callback for document unload
      // Possibly also playwright bug beforeunload / pagehide aren't firing

      it('should send payload on closing tab', async () => {
        const results = [];
        const [serverPromise, serverResolver] = defer();
        server.get('/', (request, response) => {
          response.end('hi');
        });
        server.post('/api', (request, response) => {
          results.push(request.body);
          serverResolver(null);
          response.end('hello');
        });
        await page.goto(server.url);
        await page.addScriptTag(script);
        await page.evaluate(
          ([url, eventName]) => {
            document.addEventListener(eventName, function () {
              return (<any>window).beacon(`${url}/api`, 'closing');
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
      server.get('/', (request, response) => {
        response.end('hi');
      });
      server.post('/api', (request, response) => {
        results.push(request.body);
        response.end('hello');
      });
      await page.goto(server.url);
      await page.addScriptTag(script);
      await page.evaluate(
        ([url, eventName]) => {
          document.addEventListener(eventName, function () {
            return (<any>window).beacon(`${url}/api`, 's'.repeat(64_100));
          });
        },
        [server.url, getCloseTabEvent(name)]
      );
      await Promise.all([page.close({ runBeforeUnload: true })]);

      expect(results.length).toBeLessThan(2);
    });

    it('if not firefox, retry configured times before giving up', async () => {
      server.get('/', (request, response) => {
        response.end('hi');
      });
      server.post('/api', (request, response) => {
        response.end('hello');
      });
      await page.goto(server.url);
      await page.addScriptTag(script);
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
          return (<any>window).beacon(`${url}/api`, 'hi', { retryCount: 3 });
        },
        [server.url]
      );
      await page.waitForTimeout(5000);
      expect(numberOfRetries).toBe(name === 'firefox' ? 1 : (3 + 1) * 2);
    });
  }
);

function getCloseTabEvent(
  browserName: string
): 'beforeunload' | 'visibilitychange' {
  return browserName === 'webkit' ? 'beforeunload' : 'visibilitychange';
}
