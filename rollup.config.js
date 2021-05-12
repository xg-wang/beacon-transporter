import sourcemaps from 'rollup-plugin-sourcemaps';
import commonjs from '@rollup/plugin-commonjs';
import resolve from '@rollup/plugin-node-resolve';

export default {
  input: 'dist/index.js',
  plugins: [sourcemaps(), commonjs(), resolve()],
  output: {
    file: 'dist/index.js',
    format: 'es',
    sourcemap: true,
    sourcemapExcludeSources: true,
  },
};
