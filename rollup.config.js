import commonjs from '@rollup/plugin-commonjs';
import resolve from '@rollup/plugin-node-resolve';
import sourcemaps from 'rollup-plugin-sourcemaps';

/**
 * @type {import('rollup').RollupOptions}
 */
const config = {
  input: 'dist/index.js',
  plugins: [sourcemaps(), commonjs(), resolve()],
  output: [
    {
      file: 'dist/bundle.cjs.js',
      format: 'cjs',
      sourcemap: true,
    },
    {
      file: 'dist/bundle.esm.js',
      format: 'es',
      sourcemap: true,
    },
  ],
};

export default config;
