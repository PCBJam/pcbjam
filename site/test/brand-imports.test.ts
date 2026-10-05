import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// src/brand is read by the docs site in the private repo through a path alias.
// That build never installs this site's node_modules (npm, outside the pnpm
// workspace), so brand files may import only each other: relative paths.
const BRAND = path.resolve(__dirname, '../src/brand');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? files(full) : [full];
  });
}

const IMPORT = /(?:^|\n)\s*import\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]|@import\s+(?:url\()?['"]([^'"]+)['"]/g;

describe('src/brand', () => {
  it('imports nothing but relative paths', () => {
    const bad: string[] = [];
    for (const file of files(BRAND)) {
      if (!/\.(astro|css|ts|js)$/.test(file)) continue;
      for (const m of readFileSync(file, 'utf8').matchAll(IMPORT)) {
        const spec = m[1] ?? m[2];
        if (!spec.startsWith('./') && !spec.startsWith('../')) bad.push(`${path.relative(BRAND, file)}: ${spec}`);
        if (spec.startsWith('../')) bad.push(`${path.relative(BRAND, file)}: ${spec} (leaves the folder)`);
      }
    }
    expect(bad).toEqual([]);
  });
});
