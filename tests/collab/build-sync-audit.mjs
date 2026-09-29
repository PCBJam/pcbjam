import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const tests = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
await build({
  entryPoints: [path.join(tests, 'collab/browser-entry-sync-audit.ts')],
  bundle: true, format: 'iife', target: 'es2020',
  outfile: path.join(tests, 'apps/kicad/collab-sync-audit.js'),
  nodePaths: [path.join(tests, 'node_modules')],
  external: ['y-partyserver/provider', '@hocuspocus/provider'],
  alias: {
    yjs: path.join(tests, 'node_modules/yjs'),
    '@pcbjam/shared': path.join(tests, '../web/pcbjam-shared/src/index.ts'),
    '@': path.join(tests, '../web/standalone/src'),
  },
  logLevel: 'info',
});
