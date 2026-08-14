import * as fs from 'fs';
import * as path from 'path';
import type { Page } from '@playwright/test';

/**
 * Read a host-side file and write it into the page's Emscripten MEMFS.
 *
 * Mirrors the resource-write pattern already in tests/apps/kicad/pcbnew.html
 * (FS.mkdirTree + FS.writeFile) and the DnD writer in tests/apps/kicad/wx.js.
 * Emits a "[KICAD] Wrote …" console line so the per-test log records the
 * injection.
 */
export async function injectFileIntoMemfs(
    page: Page,
    hostPath: string,
    memfsPath: string,
): Promise<void> {
    const bytes = fs.readFileSync(hostPath);
    const memfsDir = memfsPath.replace(/\/[^/]+$/, '') || '/';

    await page.evaluate(
        ({ memfsDir, memfsPath, dataBase64 }) => {
            // Decode base64 → Uint8Array in the page so we don't have to ship
            // megabytes through Playwright's JSON channel as a number array.
            const binary = atob(dataBase64);
            const data = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) {
                data[i] = binary.charCodeAt(i);
            }

            // @ts-expect-error — Emscripten FS lives on window via Module
            const FS = (window as any).FS;
            FS.mkdirTree(memfsDir);
            FS.writeFile(memfsPath, data);
            console.log(`[KICAD] Wrote ${memfsPath} (${data.length} bytes)`);
        },
        {
            memfsDir,
            memfsPath,
            dataBase64: bytes.toString('base64'),
        },
    );
}

/**
 * Fetch a same-origin URL inside the page and write it into MEMFS.
 *
 * For large fixtures (tens of MB) the base64 round-trip through Playwright's
 * JSON channel in injectFileIntoMemfs is the bottleneck — an in-page fetch
 * from the static server (tests/apps is the serve root) keeps the bytes in
 * the browser. Returns the byte count written.
 */
export async function fetchIntoMemfs(
    page: Page,
    url: string,                  // e.g. "/kicad/board/vme-wren.kicad_pcb"
    memfsPath: string,
): Promise<number> {
    const memfsDir = memfsPath.replace(/\/[^/]+$/, '') || '/';
    return await page.evaluate(
        async ({ url, memfsDir, memfsPath }) => {
            const res = await fetch(url);
            if (!res.ok) throw new Error(`fetchIntoMemfs: ${url} -> HTTP ${res.status}`);
            const data = new Uint8Array(await res.arrayBuffer());
            // @ts-expect-error — Emscripten FS lives on window via Module
            const FS = (window as any).FS;
            FS.mkdirTree(memfsDir);
            FS.writeFile(memfsPath, data);
            console.log(`[KICAD] Fetched ${url} -> ${memfsPath} (${data.length} bytes)`);
            return data.length;
        },
        { url, memfsDir, memfsPath },
    );
}

/**
 * Convenience: read a file from the kicad/ submodule and inject it.
 */
export async function injectFromSubmodule(
    page: Page,
    relativePath: string,         // e.g. "kicad/demos/microwave/microwave.kicad_pcb"
    memfsPath: string,
): Promise<void> {
    const projectRoot = path.resolve(__dirname, '..', '..', '..');
    const hostPath = path.join(projectRoot, relativePath);
    await injectFileIntoMemfs(page, hostPath, memfsPath);
}
