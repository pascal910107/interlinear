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
} from 'interlinear/vite';

import config from './interlinear.config';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname);
const docsRoot = resolve(projectRoot, config.docsDir ?? 'docs');

// injectSourceAttrs stamps data-src-{file,line,col} onto every JSX element.
// It runs in BOTH dev and prod: the inspector reads those attrs in dev, and
// the static reader's search uses them to resolve a hit back to its DOM node
// and scroll/flash it. The __apply_* / __list_comments / __search / __doc_qa
// endpoints stay dev-only — the prod reader is static (search runs off a
// prebuilt per-doc index, no server).
export default defineConfig(({ command }) => {
  const isDev = command === 'serve';
  return {
    plugins: [
      react({
        babel: {
          plugins: [[injectSourceAttrs, { root: docsRoot }]],
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
