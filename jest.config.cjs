module.exports = {
  preset: 'ts-jest',
  globals: {
    'ts-jest': {
      tsconfig: '__tests__/tsconfig.json',
    },
  },
  testMatch: ['**/__tests__/**/*.spec.ts'],
  testTimeout: 30_000,
};
