import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defineConfig } from 'vite';
import type { Connect, Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { z } from 'zod';
import { namedParts } from './server/named.mjs';

// Serves a local file at the path the published site uses for it. Only the
// one fixed file is ever read by the local servers.
function localJson(
  name: string,
  route: string,
  relative: string[],
  loopbackOnly = false,
): Plugin {
  let file = '';
  let remote = false;
  const serve: Connect.NextHandleFunction = (request, response, next) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (request.method !== 'GET' || path !== route) return next();
    if (
      loopbackOnly &&
      (remote ||
        !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(
          request.socket.remoteAddress ?? '',
        ))
    )
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
    name,
    configResolved(config) {
      file = join(config.root, ...relative);
      remote = config.env.VITE_RESTRICTED === 'remote';
    },
    configureServer(server) {
      server.middlewares.use(serve);
    },
    configurePreviewServer(server) {
      if (!loopbackOnly) server.middlewares.use(serve);
    },
  };
}

// The records build's search index, at the paths the published site serves
// it from (dist/search/). Only its own file names are answered: the manifest
// and numbered shard, fact and record files.
function searchIndex(): Plugin {
  const file = /^\/search\/(index|[tar]\/[0-9]{1,5})\.json$/;
  let root = '';
  const serve: Connect.NextHandleFunction = (request, response, next) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    const match = request.method === 'GET' ? file.exec(path) : null;
    if (!match?.[1]) return next();
    response.setHeader('Cache-Control', 'no-store');
    readFile(join(root, `${match[1]}.json`)).then(
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
    name: 'search-index',
    configResolved(config) {
      root = join(config.root, 'build', 'records', 'search');
    },
    configureServer(server) {
      server.middlewares.use(serve);
    },
  };
}

const loopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];
const NamedFile = z.object({
  version: z.number(),
  review: z.unknown(),
  people: z.unknown(),
  coverage: z.unknown(),
  pending: z.unknown(),
  use: z.unknown(),
  advice: z.unknown(),
});

// Practitioners' named records from the records build, split as the Pages
// Function serves them, for loopback requests to the dev server only. The
// published site serves them to approved accounts.
function localNamed(): Plugin {
  let file = '';
  let remote = false;
  const serve: Connect.NextHandleFunction = (request, response, next) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    const part =
      path === '/api/named'
        ? 'named'
        : path === '/api/named/advice'
          ? 'advice'
          : null;
    if (
      request.method !== 'GET' ||
      part === null ||
      remote ||
      !loopback.includes(request.socket.remoteAddress ?? '')
    )
      return next();
    response.setHeader('Cache-Control', 'no-store');
    readFile(file, 'utf8').then(
      (text) => {
        const parts = namedParts(NamedFile.parse(JSON.parse(text)));
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify(parts[part]));
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
    name: 'local-named',
    configResolved(config) {
      file = join(config.root, 'build', 'records', 'named-private.json');
      remote = config.env.VITE_RESTRICTED === 'remote';
    },
    configureServer(server) {
      server.middlewares.use(serve);
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
    react(),
    // The records build's public output; `npm run build:pages` copies it
    // into dist/.
    localJson('records-core', '/core.json', ['build', 'records', 'core.json']),
    searchIndex(),
    // Benchmarks that cannot be republished; the published site serves them
    // to approved accounts from a Pages Function instead.
    localJson('restricted-payload', '/api/restricted', [
      '.local',
      'restricted',
      'payload.json',
    ]),
    localJson(
      'local-expert-articles',
      '/api/expert-articles',
      ['.local', 'expert-articles', 'catalog.json'],
      true,
    ),
    localNamed(),
    thirdPartyLicenses(),
  ],
  server: {
    fs: {
      deny: [
        '.env',
        '.env.*',
        '*.{crt,pem,key,p12,pfx,cer,der}',
        '.npmrc',
        '.yarnrc.yml',
        '**/.git/**',
        '**/.local/**',
      ],
    },
    proxy: {
      '/api/hn': { target: 'http://127.0.0.1:5187', changeOrigin: false },
    },
  },
});
