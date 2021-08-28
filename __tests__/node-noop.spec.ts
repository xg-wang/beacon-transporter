import { createBeacon } from '../src';

describe('Use in node', () => {
  it('Can run noop when called in node', () => {
    expect(() => {
      createBeacon().beacon('/api', 'hello');
    }).not.toThrow();
  });
});
