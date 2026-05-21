import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { Plugin } from 'vite';

const STORE_REL = '.interlinear/conversation.json';

type Entry = {
  id: string;
  askedAt: string;
  question: string;
  answer: string | null;
  answeredAt: string | null;
};

type Store = {
  version: 1;
  entries: Entry[];
};

const EMPTY_STORE: Store = { version: 1, entries: [] };

function newId(): string {
  return `q-${randomUUID().replace(/-/g, '').slice(0, 8)}`;
}

function isStore(x: unknown): x is Store {
  if (!x || typeof x !== 'object') return false;
  const s = x as Record<string, unknown>;
  return s.version === 1 && Array.isArray(s.entries);
}

async function readStore(file: string): Promise<Store> {
  try {
    const raw = await readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (isStore(parsed)) return parsed;
    return { ...EMPTY_STORE };
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return { ...EMPTY_STORE };
    throw e;
  }
}

async function writeStore(file: string, store: Store): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
}

function reqBody(req: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((res, rej) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => res(body));
    req.on('error', rej);
  });
}

function json(
  res: import('node:http').ServerResponse,
  status: number,
  payload: unknown,
): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(payload));
}

export type DocQaApiOptions = {
  /** Root containing all docs; each doc gets its own conversation.json. */
  docsRoot: string;
};

/**
 * Per-doc persisted Q&A. The DocChat sidebar posts to `/__doc_qa/<sub>?doc=<id>`;
 * the entry is stored at `<docsRoot>/<docId>/.interlinear/conversation.json`,
 * and changes broadcast via WS so the open sidebar refreshes.
 */
export function docQaApiEndpoint({ docsRoot }: DocQaApiOptions): Plugin {
  function storeFileFor(docId: string): string | null {
    if (!docId || /[\/\\]/.test(docId)) return null;
    const dir = resolve(docsRoot, docId);
    if (!dir.startsWith(`${docsRoot}/`) && dir !== docsRoot) return null;
    return resolve(dir, STORE_REL);
  }

  const watchedStores = new Set<string>();

  return {
    name: 'interlinear-doc-qa-api',
    configureServer(server) {
      server.middlewares.use('/__doc_qa', async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://x');
          const sub = url.pathname;
          const docId = url.searchParams.get('doc') ?? '';
          const storeFile = storeFileFor(docId);
          if (!storeFile) {
            json(res, 400, { ok: false, error: 'doc query param required' });
            return;
          }

          // Lazily watch each store file on first use.
          if (!watchedStores.has(storeFile)) {
            watchedStores.add(storeFile);
            server.watcher.add(storeFile);
          }

          if ((sub === '/' || sub === '') && req.method === 'GET') {
            const store = await readStore(storeFile);
            json(res, 200, { ok: true, ...store });
            return;
          }

          if (sub === '/ask' && req.method === 'POST') {
            const body = await reqBody(req);
            const { question } = JSON.parse(body) as { question: string };
            const q = (question ?? '').trim();
            if (!q) {
              json(res, 400, { ok: false, error: 'question required' });
              return;
            }
            const store = await readStore(storeFile);
            const entry: Entry = {
              id: newId(),
              askedAt: new Date().toISOString(),
              question: q,
              answer: null,
              answeredAt: null,
            };
            store.entries.push(entry);
            await writeStore(storeFile, store);
            server.ws.send({
              type: 'custom',
              event: 'interlinear:doc-qa-changed',
              data: { reason: 'ask', docId, id: entry.id },
            });
            json(res, 200, { ok: true, entry });
            return;
          }

          if (sub === '/delete' && req.method === 'POST') {
            const body = await reqBody(req);
            const { id } = JSON.parse(body) as { id: string };
            const store = await readStore(storeFile);
            const before = store.entries.length;
            store.entries = store.entries.filter((e) => e.id !== id);
            if (store.entries.length === before) {
              json(res, 404, { ok: false, error: 'entry not found' });
              return;
            }
            await writeStore(storeFile, store);
            server.ws.send({
              type: 'custom',
              event: 'interlinear:doc-qa-changed',
              data: { reason: 'delete', docId, id },
            });
            json(res, 200, { ok: true, id });
            return;
          }

          json(res, 404, { ok: false, error: 'unknown route' });
        } catch (e) {
          json(res, 500, { ok: false, error: String(e) });
        }
      });

      const onFsChange = (p: string) => {
        const abs = resolve(p);
        if (!watchedStores.has(abs)) return;
        // Recover docId from path: <docsRoot>/<docId>/.interlinear/conversation.json
        const rel = abs.startsWith(`${docsRoot}/`) ? abs.slice(docsRoot.length + 1) : '';
        const docId = rel.split('/')[0] ?? '';
        server.ws.send({
          type: 'custom',
          event: 'interlinear:doc-qa-changed',
          data: { reason: 'fs', docId },
        });
      };
      server.watcher.on('add', onFsChange);
      server.watcher.on('change', onFsChange);
    },
  };
}
