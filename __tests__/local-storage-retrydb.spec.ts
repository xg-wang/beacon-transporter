import createTestServer, { Server } from '@xg-wang/create-test-server';
import fs from 'fs';
import path from 'path';
import type { Browser, BrowserContext, BrowserType, Page } from 'playwright';
import playwright from 'playwright';

import type { createBeacon, createLocalStorageRetryDB } from '../src/';
import { log } from './utils';

declare global {
  interface Window {
    createBeacon: typeof createBeacon;
    createLocalStorageRetryDB: typeof createLocalStorageRetryDB;
  }
}

const script = {
  type: 'module',
  content: `
${fs.readFileSync(path.join(__dirname, '..', 'dist', 'bundle.esm.js'), 'utf8')}
window.createLocalStorageRetryDB = createLocalStorageRetryDB;
window.__DEBUG_BEACON_TRANSPORTER = true;
`,
};

describe.each([['chromium'], ['webkit']])(
  '[%s] localStorageDB spec',
  (browserName) => {
    const browserType: BrowserType<Browser> = playwright[browserName];
    let browser: Browser;
    let context: BrowserContext;
    let page: Page;
    let server: Server;

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
      server.get('/', (request, response) => {
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

    it('pushes entry to localStorage', async () => {
      const entry = {
        url: '/api/200',
        body: '',
        statusCode: 888,
        timestamp: Date.now(),
        attemptCount: 1,
      };
      const result = await page.evaluate((entry) => {
        const db = window.createLocalStorageRetryDB({
          keyName: 'beacon-transporter-storage',
          throttleWait: 10,
          maxNumber: 1,
          headerName: 'x-retry-context',
          attemptLimit: 2,
          compressFetch: false,
        });
        // @ts-ignore
        window.__db = db;
        db.pushToQueue(entry);
        return new Promise((res) => setTimeout(res, 1000)).then(() => {
          return db.peekQueue();
        });
      }, entry);
      expect(result).toEqual([entry]);

      const result2 = await page.evaluate((entry) => {
        // @ts-ignore
        const db = window.__db;
        db.pushToQueue(entry);
        return new Promise((res) => setTimeout(res, 1000)).then(() => {
          return db.peekQueue();
        });
      }, entry);
      // Exceeding maxNumber should clear everything
      expect(result2).toEqual([]);
    });

    it('can delete localStorage items', async () => {
      const entry = {
        url: '/api/200',
        body: '',
        statusCode: 888,
        timestamp: Date.now(),
        attemptCount: 1,
      };
      const result = await page.evaluate((entry) => {
        const db = window.createLocalStorageRetryDB({
          keyName: 'beacon-transporter-storage',
          throttleWait: 10,
          maxNumber: 1,
          headerName: 'x-retry-context',
          attemptLimit: 2,
          compressFetch: false,
        });
        db.pushToQueue(entry);
        return new Promise((res) => setTimeout(res, 1000)).then(() => {
          db.clearQueue();
          return localStorage.getItem('beacon-transporter-storage');
        });
      }, entry);
      expect(result).toEqual(null);
    });

    it('retries from localStorage when notified, and push back failed entries', async () => {
      const serverResults = [];
      server.post('/api/:status', ({ params, headers }, res) => {
        const status = +params.status;
        const payload = { header: headers['x-retry-context'] };
        serverResults.push(payload);
        res.status(status).send(`Status: ${status}`);
      });

      const entries = [
        {
          url: '/api/200',
          body: '1',
          statusCode: 200,
          timestamp: Date.now(),
          attemptCount: 1,
        },
        {
          url: '/api/888',
          body: '2',
          statusCode: 888,
          timestamp: Date.now(),
          attemptCount: 1,
        },
        {
          url: '/api/999',
          body: '3',
          statusCode: 999,
          timestamp: Date.now(),
          attemptCount: 1,
        },
      ];

      const result = await page.evaluate((entries) => {
        const db = window.createLocalStorageRetryDB({
          keyName: 'beacon-transporter-storage',
          throttleWait: 10,
          maxNumber: 3,
          headerName: 'x-retry-context',
          attemptLimit: 2,
          compressFetch: false,
        });
        window.localStorage.setItem(
          'beacon-transporter-storage',
          JSON.stringify(entries)
        );
        db.notifyQueue({ allowedPersistRetryStatusCodes: [888] });
        return new Promise((res) => setTimeout(res, 1000)).then(() => {
          return localStorage.getItem('beacon-transporter-storage');
        });
      }, entries);
      entries.shift();
      entries[0].attemptCount++;
      expect(JSON.parse(result)).toEqual(entries);
      expect(serverResults).toEqual([
        {
          header: '{"attempt":1,"errorCode":200}',
        },
        {
          header: '{"attempt":1,"errorCode":888}',
        },
      ]);
    });

    it('does not put back to localStorage response status code is not allowed', async () => {
      const serverResults = [];
      server.post('/api/:status', ({ params, headers }, res) => {
        const status = +params.status;
        const payload = { header: headers['x-retry-context'] };
        serverResults.push(payload);
        res.status(status).send(`Status: ${status}`);
      });

      const entries = [
        {
          url: '/api/999',
          body: '3',
          statusCode: 999,
          timestamp: Date.now(),
          attemptCount: 1,
        },
      ];

      const result = await page.evaluate((entries) => {
        const db = window.createLocalStorageRetryDB({
          keyName: 'beacon-transporter-storage',
          throttleWait: 10,
          maxNumber: 1,
          headerName: 'x-retry-context',
          attemptLimit: 2,
          compressFetch: false,
        });
        window.localStorage.setItem(
          'beacon-transporter-storage',
          JSON.stringify(entries)
        );
        db.notifyQueue({ allowedPersistRetryStatusCodes: [888] });
        return new Promise((res) => setTimeout(res, 1000)).then(() => {
          return localStorage.getItem('beacon-transporter-storage');
        });
      }, entries);
      expect(JSON.parse(result)).toEqual(null);
      expect(serverResults).toEqual([
        {
          header: '{"attempt":1,"errorCode":999}',
        },
      ]);
    });
  }
);
