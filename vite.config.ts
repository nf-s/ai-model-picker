import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defineConfig } from 'vite';
import type { Connect, Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { z } from 'zod';

// Serves the local arXiv snapshot at the path the published build uses.
// Only this one fixed file is ever read.
function arxivSnapshot(): Plugin {
  let file = '';
  const serve: Connect.NextHandleFunction = (request, response, next) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (request.method !== 'GET' || path !== '/arxiv-snapshot.json')
      return next();
    response.setHeader('Cache-Control', 'no-store');
    readFile(file).then(
      (body) => {
        response.setHeader('Content-Type', 'application/json');
        response.end(body);
      },
      (error: unknown) => {
        if (!(error instanceof Error && 'code' in error)) return next(error);
        if (error.code !== 'ENOENT') return next(error);
        response.statusCode = 404;
        response.end();
      },
    );
  };
  return {
    name: 'arxiv-snapshot',
    configResolved(config) {
      file = join(config.root, '.local', 'arxiv', 'papers.json');
    },
    configureServer(server) {
      server.middlewares.use(serve);
    },
    configurePreviewServer(server) {
      server.middlewares.use(serve);
    },
  };
}

const SnapshotResults = z.looseObject({
  results: z.array(z.looseObject({})),
});

// Results whose source terms do not allow republishing are kept outside Git
// in .local/restricted/. Local builds merge them into the snapshot; the
// published build leaves them out and signed-in users load them from
// /api/restricted.
function restrictedResults(): Plugin {
  let merge = false;
  let snapshotFile = '';
  let restrictedFile = '';
  return {
    name: 'restricted-results',
    enforce: 'pre',
    configResolved(config) {
      merge = config.env.VITE_RESTRICTED !== 'remote';
      snapshotFile = join(config.root, 'src', 'lib', 'snapshot.json');
      restrictedFile = join(
        config.root,
        '.local',
        'restricted',
        'results.json',
      );
    },
    async transform(code, id) {
      if (!merge || id.split('?')[0] !== snapshotFile) return null;
      let restricted: string;
      try {
        restricted = await readFile(restrictedFile, 'utf8');
      } catch (error) {
        if (
          error instanceof Error &&
          'code' in error &&
          error.code === 'ENOENT'
        )
          return null;
        throw error;
      }
      const snapshot = SnapshotResults.parse(JSON.parse(code));
      return {
        code: JSON.stringify({
          ...snapshot,
          results: [
            ...snapshot.results,
            ...SnapshotResults.parse(JSON.parse(restricted)).results,
          ],
        }),
        map: null,
      };
    },
  };
}

const Dependencies = z.object({
  dependencies: z.record(z.string(), z.string()).optional(),
});
const PackageJson = Dependencies.extend({
  name: z.string(),
  version: z.string(),
  license: z.string(),
});

// Emits the licence text of every bundled runtime package, which the
// minified bundle does not carry.
function thirdPartyLicenses(): Plugin {
  let root = '';
  async function collect(name: string, seen: Map<string, string>) {
    if (seen.has(name)) return;
    const dir = join(root, 'node_modules', name);
    const manifest = PackageJson.parse(
      JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')),
    );
    const files = (await readdir(dir)).filter((file) =>
      /^licen[cs]e(\.(md|txt))?$/i.test(file),
    );
    const [file, ...extra] = files;
    if (file === undefined || extra.length > 0)
      throw new Error(`Expected one licence file in ${name}`);
    const text = await readFile(join(dir, file), 'utf8');
    seen.set(
      name,
      `${manifest.name} ${manifest.version} (${manifest.license})\n\n${text.trim()}\n`,
    );
    for (const dependency of Object.keys(manifest.dependencies ?? {}))
      await collect(dependency, seen);
  }
  return {
    name: 'third-party-licenses',
    apply: 'build',
    configResolved(config) {
      root = config.root;
    },
    async generateBundle() {
      const app = Dependencies.parse(
        JSON.parse(await readFile(join(root, 'package.json'), 'utf8')),
      );
      const seen = new Map<string, string>();
      for (const name of Object.keys(app.dependencies ?? {}))
        await collect(name, seen);
      const notices = [...seen.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([, notice]) => notice);
      this.emitFile({
        type: 'asset',
        fileName: 'third-party-licenses.txt',
        source: [
          'Software bundled in this site and its licences. Font licences are in /fonts/.\n',
          ...notices,
        ].join(`\n${'-'.repeat(72)}\n\n`),
      });
    },
  };
}

export default defineConfig({
  plugins: [
    restrictedResults(),
    react(),
    arxivSnapshot(),
    thirdPartyLicenses(),
  ],
  server: {
    proxy: {
      '/api/hn': { target: 'http://127.0.0.1:5187', changeOrigin: false },
    },
  },
});
