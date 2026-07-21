import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

import {
  injectSourceAttrs,
  interlinearPlugin,
  applyCommentEndpoint,
  applyEditEndpoint,
  commentsApiEndpoint,
  searchApiEndpoint,
  docQaApiEndpoint,
} from '@interlinear/core/vite';

import config from './interlinear.config';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname);
const docsRoot = resolve(projectRoot, config.docsDir ?? 'docs');

// Dev-only pieces (injectSourceAttrs adds inspector hooks to JSX; the
// __apply_* / __list_comments / __search / __doc_qa endpoints back the
// inspector, search bar, and DocChat via the dev server). Production
// builds ship a static reader — none of these are useful then.
export default defineConfig(({ command }) => {
  const isDev = command === 'serve';
  return {
    plugins: [
      react({
        babel: {
          plugins: isDev ? [[injectSourceAttrs, { root: docsRoot }]] : [],
        },
      }),
      tailwindcss(),
      interlinearPlugin({
        userCwd: projectRoot,
        docsDir: config.docsDir,
        pagesDir: config.pagesDir,
      }),
      ...(isDev
        ? [
            applyCommentEndpoint({ docsRoot }),
            applyEditEndpoint({ docsRoot }),
            commentsApiEndpoint({ docsRoot }),
            searchApiEndpoint({ docsRoot, pagesDir: config.pagesDir }),
            docQaApiEndpoint({ docsRoot }),
          ]
        : []),
    ],
    server: {
      // Pin to IPv4 so a second `pnpm dev` reliably sees 5173 as taken and
      // auto-increments (5174, 5175, …) instead of silently binding the
      // IPv6 [::1]:5173 socket and "stealing" the port from the running one.
      host: '127.0.0.1',
      port: config.port ?? 5173,
      // strictPort stays false (Vite default) so it moves to the next free port.
    },
  };
});
