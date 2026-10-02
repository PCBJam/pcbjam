// esbuild writes `outfile` in place, so a reader (page.addScriptTag({ path }))
// racing a rebuild gets a truncated script — a SyntaxError the page swallows,
// leaving the bundle's global undefined. Build next to the target and rename:
// a reader then sees the old file or the new one, never a partial write.
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";

export async function buildAtomic(options) {
  const { outfile } = options;
  // Keeps the .js extension so the temp file stays under the same .gitignore rule.
  const tmp = path.join(path.dirname(outfile), `.${path.basename(outfile, ".js")}.tmp-${process.pid}.js`);
  try {
    await build({ ...options, outfile: tmp });
    fs.renameSync(tmp, outfile);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}
