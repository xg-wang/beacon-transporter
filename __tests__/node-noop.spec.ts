import beacon from '../src';

describe('Use in node', () => {
  it('Can run noop when called in node', () => {
    expect(() => {
      beacon('/api', 'hello');
    }).not.toThrow();
  });
});
