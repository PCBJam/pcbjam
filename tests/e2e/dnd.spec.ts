// wxDragDrop Tests - HTML5 file drop support for KiCad
// Tests external file drops via HTML5 drag and drop API
import { test, expect, getCanvasBox, waitForCanvasApp } from './utils/fixtures';
import * as path from 'path';
import * as fs from 'fs';
import { stableShot } from './utils/element-tracker';

test.describe('wxDragDrop Tests', () => {

  test('DnD test app loads successfully', async ({ page, testLogger }) => {
    await page.goto('/standalone/dnd/dnd_test.html');
    await waitForCanvasApp(page);

    await stableShot(page, 'dnd-01-loaded.png', { fullPage: true });

    const hasStartup = testLogger.consoleLogs.some(l => l.includes('DND_TEST'));

    expect(testLogger.errors.filter(e => !e.includes('favicon'))).toHaveLength(0);
  });

  test('DnD handlers are registered', async ({ page, testLogger }) => {
    await page.goto('/standalone/dnd/dnd_test.html');
    await waitForCanvasApp(page);

    await expect.poll(
      () => testLogger.consoleLogs.some(l => l.includes('[DND] Drag and drop handlers registered')),
      { message: 'DnD handlers should be registered' }
    ).toBe(true);

    await stableShot(page, 'dnd-02-handlers.png', { fullPage: true });
  });

  test('DragEnter event is detected', async ({ page, testLogger }) => {
    await page.goto('/standalone/dnd/dnd_test.html');
    await waitForCanvasApp(page);

    const canvas = page.locator('#canvas');
    const box = await canvas.boundingBox();
    expect(box, 'Canvas should have bounding box').not.toBeNull();

    // Simulate dragenter event
    await page.evaluate(({ x, y }) => {
      const canvas = document.getElementById('canvas');
      if (canvas) {
        const event = new DragEvent('dragenter', {
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: y,
          dataTransfer: new DataTransfer()
        });
        canvas.dispatchEvent(event);
      }
    }, { x: box!.x + 400, y: box!.y + 200 });

    await expect.poll(
      () => testLogger.consoleLogs.some(l => l.includes('[DND] dragenter')),
      { message: 'DragEnter event should be logged' }
    ).toBe(true);

    await stableShot(page, 'dnd-03-dragenter.png', { fullPage: true });
  });

  test('DragLeave event is detected', async ({ page, testLogger }) => {
    await page.goto('/standalone/dnd/dnd_test.html');
    await waitForCanvasApp(page);

    const canvas = page.locator('#canvas');
    const box = await canvas.boundingBox();
    expect(box, 'Canvas should have bounding box').not.toBeNull();

    // Simulate dragenter then dragleave
    await page.evaluate(({ x, y }) => {
      const canvas = document.getElementById('canvas');
      if (canvas) {
        const enterEvent = new DragEvent('dragenter', {
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: y,
          dataTransfer: new DataTransfer()
        });
        canvas.dispatchEvent(enterEvent);

        const leaveEvent = new DragEvent('dragleave', {
          bubbles: true,
          cancelable: true,
          dataTransfer: new DataTransfer()
        });
        canvas.dispatchEvent(leaveEvent);
      }
    }, { x: box!.x + 400, y: box!.y + 200 });

    await expect.poll(
      () => testLogger.consoleLogs.some(l => l.includes('[DND] dragleave')),
      { message: 'DragLeave event should be logged' }
    ).toBe(true);

    await stableShot(page, 'dnd-04-dragleave.png', { fullPage: true });
  });

  test('Drop event triggers file processing', async ({ page, testLogger }) => {
    await page.goto('/standalone/dnd/dnd_test.html');
    await waitForCanvasApp(page);

    const canvas = page.locator('#canvas');
    const box = await canvas.boundingBox();
    expect(box, 'Canvas should have bounding box').not.toBeNull();

    // Create a test file and simulate drop
    const testContent = 'Test file content for DnD';
    const testFileName = 'test-drop-file.txt';

    await page.evaluate(({ x, y, fileName, content }) => {
      const canvas = document.getElementById('canvas');
      if (canvas) {
        const dataTransfer = new DataTransfer();
        const file = new File([content], fileName, { type: 'text/plain' });
        dataTransfer.items.add(file);

        const event = new DragEvent('drop', {
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: y,
          dataTransfer: dataTransfer
        });
        canvas.dispatchEvent(event);
      }
    }, { x: box!.x + 400, y: box!.y + 200, fileName: testFileName, content: testContent });

    // Wait for async file processing (deterministic: poll for the drop log)
    await expect.poll(
      () => testLogger.consoleLogs.some(l => l.includes('[DND] drop')),
      { message: 'Drop event should be logged' }
    ).toBe(true);

    await stableShot(page, 'dnd-05-drop.png', { fullPage: true });
  });

  test('Dropped file is written to WASM filesystem', async ({ page, testLogger }) => {
    await page.goto('/standalone/dnd/dnd_test.html');
    await waitForCanvasApp(page);

    const canvas = page.locator('#canvas');
    const box = await canvas.boundingBox();
    expect(box, 'Canvas should have bounding box').not.toBeNull();

    const testFileName = 'wasm-test-file.txt';
    const testContent = 'Content written via DnD';

    await page.evaluate(({ x, y, fileName, content }) => {
      const canvas = document.getElementById('canvas');
      if (canvas) {
        const dataTransfer = new DataTransfer();
        const file = new File([content], fileName, { type: 'text/plain' });
        dataTransfer.items.add(file);

        const event = new DragEvent('drop', {
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: y,
          dataTransfer: dataTransfer
        });
        canvas.dispatchEvent(event);
      }
    }, { x: box!.x + 400, y: box!.y + 200, fileName: testFileName, content: testContent });

    // Wait for file to be written (deterministic: poll for the write log)
    await expect.poll(
      () => testLogger.consoleLogs.some(l =>
        l.includes('[DND] Wrote file:') && l.includes(testFileName)),
      { message: 'File should be written to WASM filesystem' }
    ).toBe(true);

    await stableShot(page, 'dnd-06-file-written.png', { fullPage: true });
  });

  test('wxDropFilesEvent is fired after drop', async ({ page, testLogger }) => {
    await page.goto('/standalone/dnd/dnd_test.html');
    await waitForCanvasApp(page);

    const canvas = page.locator('#canvas');
    const box = await canvas.boundingBox();
    expect(box, 'Canvas should have bounding box').not.toBeNull();

    const testFileName = 'event-test.kicad_pcb';
    const testContent = '(kicad_pcb (version 20230121))';

    await page.evaluate(({ x, y, fileName, content }) => {
      const canvas = document.getElementById('canvas');
      if (canvas) {
        const dataTransfer = new DataTransfer();
        const file = new File([content], fileName, { type: 'application/octet-stream' });
        dataTransfer.items.add(file);

        const event = new DragEvent('drop', {
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: y,
          dataTransfer: dataTransfer
        });
        canvas.dispatchEvent(event);
      }
    }, { x: box!.x + 400, y: box!.y + 200, fileName: testFileName, content: testContent });

    // Wait for wxDropFilesEvent processing (deterministic: poll for the [DND_EVENT] log).
    // The app logs "=== wxDropFilesEvent received! ===" which includes DND_EVENT prefix.
    await expect.poll(
      () => testLogger.consoleLogs.some(l => l.includes('[DND_EVENT]')),
      { message: 'wxDropFilesEvent should be fired' }
    ).toBe(true);

    await stableShot(page, 'dnd-07-event-fired.png', { fullPage: true });
  });

  test('Multiple files can be dropped', async ({ page, testLogger }) => {
    await page.goto('/standalone/dnd/dnd_test.html');
    await waitForCanvasApp(page);

    const canvas = page.locator('#canvas');
    const box = await canvas.boundingBox();
    expect(box, 'Canvas should have bounding box').not.toBeNull();

    await page.evaluate(({ x, y }) => {
      const canvas = document.getElementById('canvas');
      if (canvas) {
        const dataTransfer = new DataTransfer();
        const file1 = new File(['content1'], 'file1.txt', { type: 'text/plain' });
        const file2 = new File(['content2'], 'file2.txt', { type: 'text/plain' });
        const file3 = new File(['content3'], 'file3.txt', { type: 'text/plain' });
        dataTransfer.items.add(file1);
        dataTransfer.items.add(file2);
        dataTransfer.items.add(file3);

        const event = new DragEvent('drop', {
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: y,
          dataTransfer: dataTransfer
        });
        canvas.dispatchEvent(event);
      }
    }, { x: box!.x + 400, y: box!.y + 200 });

    await expect.poll(
      () => testLogger.consoleLogs.some(l => l.includes('[DND] drop: 3 files')),
      { message: 'Multiple files should be detected' }
    ).toBe(true);

    await stableShot(page, 'dnd-08-multiple-files.png', { fullPage: true });
  });

  test('Overlapping asynchronous drops retain their exact file batches', async ({
    page,
    testLogger,
  }) => {
    await page.goto('/standalone/dnd/dnd_test.html');
    await waitForCanvasApp(page);

    const canvas = page.locator('#canvas');
    const box = await canvas.boundingBox();
    expect(box, 'Canvas should have bounding box').not.toBeNull();

    await page.evaluate(({ x, y }) => {
      type DelayedFile = { name: string; content: string; delay: number };
      const target = document.getElementById('canvas');
      if (!target) throw new Error('canvas is missing');

      const dispatchDrop = (specs: DelayedFile[], offset: number) => {
        const files = specs.map((spec) => {
          const bytes = new TextEncoder().encode(spec.content);
          return {
            name: spec.name,
            size: bytes.byteLength,
            arrayBuffer: () =>
              new Promise<ArrayBuffer>((resolve) => {
                setTimeout(() => resolve(bytes.buffer.slice(0)), spec.delay);
              }),
          };
        });
        const event = new DragEvent('drop', {
          bubbles: true,
          cancelable: true,
          clientX: x + offset,
          clientY: y + offset,
        });
        Object.defineProperty(event, 'dataTransfer', { value: { files } });
        target.dispatchEvent(event);
      };

      // A1 enters the old shared array, then B completes and clears it before
      // A2 finishes. A shared pending-drop state therefore emits three
      // one-file events. Immutable transactions emit B as [1], then A as [2].
      dispatchDrop(
        [
          { name: 'overlap-a1.txt', content: 'a1', delay: 20 },
          { name: 'overlap-a2.txt', content: 'a2', delay: 160 },
        ],
        0,
      );
      dispatchDrop([{ name: 'overlap-b.txt', content: 'b', delay: 80 }], 20);
    }, { x: box!.x + 300, y: box!.y + 200 });

    const deliveredBatchSizes = () =>
      testLogger.consoleLogs
        .map((line) => line.match(/\[DND_EVENT\] Number of files: (\d+)/)?.[1])
        .filter((value): value is string => value !== undefined)
        .map(Number);

    await expect
      .poll(deliveredBatchSizes, {
        timeout: 10000,
        message: 'overlapping file reads must deliver two intact drop transactions',
      })
      .toEqual([1, 2]);

    const fileLines = testLogger.consoleLogs.filter((line) =>
      line.includes('[DND_EVENT] File '),
    );
    expect(fileLines.some((line) => line.includes('overlap-a1.txt'))).toBe(true);
    expect(fileLines.some((line) => line.includes('overlap-a2.txt'))).toBe(true);
    expect(fileLines.some((line) => line.includes('overlap-b.txt'))).toBe(true);

    await expect
      .poll(() =>
        page.evaluate(() => {
          const runtime = globalThis as unknown as {
            Module?: { wxFileDropPendingBytes?: () => number };
          };
          return runtime.Module?.wxFileDropPendingBytes?.() ?? -1;
        }), {
        message: 'each exact native release must return its retained-byte reservation',
      })
      .toBe(0);
  });

  test('oversized drop is rejected before reading and does not kill the runtime', async ({
    page,
  }) => {
    await page.goto('/standalone/dnd/dnd_test.html');
    await waitForCanvasApp(page);

    const result = await page.evaluate(() => {
      const target = document.getElementById('canvas');
      if (!target) throw new Error('canvas is missing');

      let readCalls = 0;
      const file = {
        name: 'too-large.kicad_pcb',
        size: 256 * 1024 * 1024 + 1,
        arrayBuffer: async () => {
          readCalls++;
          return new ArrayBuffer(0);
        },
      };
      const event = new DragEvent('drop', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'dataTransfer', { value: { files: [file] } });
      target.dispatchEvent(event);

      const runtime = globalThis as unknown as {
        Module?: { wxFileDropPendingBytes?: () => number };
        __wxScheduler?: { dead?: boolean };
      };
      return {
        readCalls,
        pendingBytes: runtime.Module?.wxFileDropPendingBytes?.() ?? -1,
        schedulerDead: runtime.__wxScheduler?.dead ?? false,
      };
    });

    expect(result.readCalls, 'capacity is checked before File.arrayBuffer()').toBe(0);
    expect(result.pendingBytes, 'a refused transaction owns no byte reservation').toBe(0);
    expect(result.schedulerDead, 'invalid user input is not a native integrity failure').toBe(false);
  });

  test('a failed batch stays reserved until every non-cancellable read settles', async ({
    page,
  }) => {
    await page.goto('/standalone/dnd/dnd_test.html');
    await waitForCanvasApp(page);

    const result = await page.evaluate(async () => {
      const target = document.getElementById('canvas');
      if (!target) throw new Error('canvas is missing');
      const runtime = globalThis as unknown as {
        Module?: { wxFileDropPendingBytes?: () => number };
        __wxScheduler?: { dead?: boolean };
      };
      const mib = 1024 * 1024;
      let settleSlow!: (value: ArrayBuffer) => void;
      const slowRead = new Promise<ArrayBuffer>((resolve) => {
        settleSlow = resolve;
      });
      let bypassReadCalls = 0;
      const dispatch = (files: unknown[]) => {
        const event = new DragEvent('drop', { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'dataTransfer', { value: { files } });
        target.dispatchEvent(event);
      };

      dispatch([
        {
          name: 'slow.bin',
          size: 200 * mib,
          arrayBuffer: () => slowRead,
        },
        {
          name: 'failed.bin',
          size: 1,
          arrayBuffer: () => Promise.reject(new Error('deterministic read failure')),
        },
      ]);
      for (let i = 0; i < 4; ++i) await Promise.resolve();
      const pendingWhileSlow = runtime.Module?.wxFileDropPendingBytes?.() ?? -1;

      dispatch([{
        name: 'must-not-start.bin',
        size: 100 * mib,
        arrayBuffer: async () => {
          bypassReadCalls++;
          return new ArrayBuffer(0);
        },
      }]);
      for (let i = 0; i < 4; ++i) await Promise.resolve();
      const pendingAfterRefusal = runtime.Module?.wxFileDropPendingBytes?.() ?? -1;

      settleSlow(new ArrayBuffer(0));
      for (let i = 0; i < 8; ++i) await Promise.resolve();
      return {
        pendingWhileSlow,
        pendingAfterRefusal,
        pendingAfterSettlement: runtime.Module?.wxFileDropPendingBytes?.() ?? -1,
        bypassReadCalls,
        schedulerDead: runtime.__wxScheduler?.dead ?? false,
      };
    });

    expect(result).toEqual({
      pendingWhileSlow: 200 * 1024 * 1024 + 1,
      pendingAfterRefusal: 200 * 1024 * 1024 + 1,
      pendingAfterSettlement: 0,
      bypassReadCalls: 0,
      schedulerDead: false,
    });
  });

  test('Clear files button exists in UI', async ({ page, testLogger }) => {
    await page.goto('/standalone/dnd/dnd_test.html');
    await waitForCanvasApp(page);

    // First drop a file to verify drop works
    const canvas = page.locator('#canvas');
    const box = await canvas.boundingBox();
    expect(box, 'Canvas should have bounding box').not.toBeNull();

    await page.evaluate(({ x, y }) => {
      const canvas = document.getElementById('canvas');
      if (canvas) {
        const dataTransfer = new DataTransfer();
        const file = new File(['test'], 'test.txt', { type: 'text/plain' });
        dataTransfer.items.add(file);

        const event = new DragEvent('drop', {
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: y,
          dataTransfer: dataTransfer
        });
        canvas.dispatchEvent(event);
      }
    }, { x: box!.x + 400, y: box!.y + 200 });

    // Verify file was dropped (from JS side) - deterministic poll for the write log
    await expect.poll(
      () => testLogger.consoleLogs.some(l => l.includes('[DND] Wrote file:')),
      { message: 'File should be dropped and logged' }
    ).toBe(true);

    await stableShot(page, 'dnd-09-with-file.png', { fullPage: true });
  });
});
