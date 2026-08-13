import { test, expect } from './fixtures';
import { waitForPcbnew } from './utils/pcbnew-ready';

const KICAD_SETTINGS = '/home/kicad/.config/kicad/kicad/10.0/kicad.json';

test.describe('WASM-only KiCad configuration', () => {
    test('disables unavailable PCM table maintenance before editor startup', async ({
        page,
        testLogger,
    }) => {
        await page.goto('/kicad/pcbnew.html');
        await waitForPcbnew(page);

        const config = await page.evaluate((path) => {
            const runtime = window as typeof window & {
                FS: {
                    readFile(name: string, options: { encoding: string }): string;
                    readdir(name: string): string[];
                };
            };
            const walk = (dir: string, depth = 0): string[] => {
                if (depth > 4) return [];
                try {
                    return runtime.FS.readdir(dir)
                        .filter((name) => name !== '.' && name !== '..')
                        .flatMap((name) => {
                            const child = `${dir}/${name}`;
                            try {
                                return [child, ...walk(child, depth + 1)];
                            } catch {
                                return [child];
                            }
                        });
                } catch {
                    return [];
                }
            };
            const parsed = JSON.parse(runtime.FS.readFile(path, { encoding: 'utf8' }));
            return { pcm: parsed.pcm, configTree: walk('/home/kicad/.config') };
        }, KICAD_SETTINGS);

        expect(config.pcm).toEqual({
            check_for_updates: false,
            lib_auto_add: false,
            lib_auto_remove: false,
        });

        const tableAssertions = [...testLogger.consoleLogs, ...testLogger.errors]
            .filter((line) => /library_manager\.cpp\(594\).*table/i.test(line));
        expect(tableAssertions,
            `unavailable PCM maintenance must not walk unloaded table kinds; config tree=${config.configTree.join(', ')}:\n${tableAssertions.join('\n')}`)
            .toEqual([]);
    });
});
