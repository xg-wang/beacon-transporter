import createTestServer, { Server } from '@xg-wang/create-test-server';
import fs from 'fs';
import path from 'path';
import type { Browser, BrowserContext, BrowserType, Page } from 'playwright';
import playwright from 'playwright';
import waitForExpect from 'wait-for-expect';

import type { createBeacon } from '../src/';
import { log } from './utils';

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
${fs.readFileSync(path.join(__dirname, '..', 'dist', 'bundle.esm.js'), 'utf8')}
self.createBeacon = createBeacon;
self.__DEBUG_BEACON_TRANSPORTER = true;
`,
};

describe.each(['chromium', 'webkit', 'firefox'].map((t) => [t]))(
  '[%s] XHR',
  (name) => {
    const browserType: BrowserType<Browser> = playwright[name];
    let browser: Browser;
    let context: BrowserContext;
    let page: Page;
    let server: Server;

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
      context = await browser.newContext({ ignoreHTTPSErrors: true });
      page = await context.newPage();
      server = await createTestServer();
      server.get('/', (_, response) => {
        response.end('hello!');
      });
      await page.goto(server.url);
      await page.addScriptTag(script);
      await page.waitForFunction(
        () => typeof window.createBeacon !== 'undefined'
      );
    });

    afterEach(async () => {
      await context.close();
      await server.close();
    });

    it('should use XHR to fire beacon when fetch is missing', async () => {
      const results = [];
      server.post('/api', (request, response) => {
        results.push(request.body);
        response.end('hello');
      });
      const result = await page.evaluate((url) => {
        const originalFetch = window.fetch;
        const originalPromise = window.Promise;
        const { beacon } = window.createBeacon();
        const response = beacon(`${url}/api`, 'hello');
        window.fetch = originalFetch;
        window.Promise = originalPromise;
        return response;
      }, server.url);
      expect(result).toBeUndefined;
      await waitForExpect(() => {
        expect(results).toEqual(['hello']);
      });
    });
  }
);
