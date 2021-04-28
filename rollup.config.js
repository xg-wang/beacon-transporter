import sourcemaps from 'rollup-plugin-sourcemaps';

export default {
  input: 'dist/index.js',
  plugins: [sourcemaps()],
  output: {
    file: 'dist/index.js',
    format: 'es',
    sourcemap: true,
    sourcemapExcludeSources: true,
  },
};
