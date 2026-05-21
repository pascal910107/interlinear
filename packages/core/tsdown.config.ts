import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'vite/index': 'src/vite/index.ts',
    config: 'src/config.ts',
  },
  format: 'esm',
  target: 'node18',
  platform: 'node',
  clean: true,
  dts: true,
  shims: false,
  external: [
    'react',
    'react-dom',
    'vite',
    '@babel/parser',
    '@babel/types',
    'fast-glob',
    /^virtual:/,
  ],
});
