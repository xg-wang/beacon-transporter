import { createBeacon, IRetryDBBase } from '../src';

describe('createBeacon', () => {
  it('Can run noop when called in node', () => {
    expect(() => {
      createBeacon().beacon('/api', 'hello');
    }).not.toThrow();
  });

  it('Can pass in custom retryDB implementation', () => {
    let _pushToQueueCalled = false;
    let _notifyQueueCalled = false;
    let _onClearCalled = false;
    let _removeOnClearCalled = false;
    let _customMethodCalled = false;

    interface MyCustomDB extends IRetryDBBase {
      customMethod(): void;
    }
    const { database } = createBeacon<MyCustomDB>({
      retryDB: {
        pushToQueue(): void {
          _pushToQueueCalled = true;
        },
        notifyQueue(): void {
          _notifyQueueCalled = true;
        },
        onClear(): void {
          _onClearCalled = true;
        },
        removeOnClear(): void {
          _removeOnClearCalled = true;
        },
        customMethod() {
          _customMethodCalled = true;
        },
      },
    });
    database.pushToQueue({
      url: '',
      body: '',
      timestamp: 1,
      attemptCount: 0,
    });
    database.notifyQueue({
      allowedPersistRetryStatusCodes: [123],
    });
    const cb = (): void => {};
    database.onClear(cb);
    database.removeOnClear(cb);
    expect(_pushToQueueCalled).toBe(true);
    expect(_notifyQueueCalled).toBe(true);
    expect(_onClearCalled).toBe(true);
    expect(_removeOnClearCalled).toBe(true);
    expect(_customMethodCalled).toBe(true);
  });
});
