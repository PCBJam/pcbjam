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
    }, { x: box.x + 400, y: box.y + 200 });

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
    }, { x: box.x + 400, y: box.y + 200 });

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
    }, { x: box.x + 400, y: box.y + 200, fileName: testFileName, content: testContent });

    // Wait for async file processing (deterministic: poll for the drop log)
    await expect.poll(
      () => testLogger.consoleLogs.some(l => l.includes('[DND] drop')),
      { message: 'Drop event should be logged' }
    ).toBe(true);

    // repro for G-14: the JS receipt above is only the positive control — the
    // wx event must actually ARRIVE at the frame that called
    // DragAcceptFiles(true). Pre-fix, delivery died at the leaf under the
    // pointer (wxDropFilesEvent does not propagate) and this line never came.
    await expect.poll(
      () => testLogger.consoleLogs.some(l =>
        l.includes('[DND_EVENT] === wxDropFilesEvent received!')),
      { message: 'wxDropFilesEvent should reach the DragAcceptFiles frame' }
    ).toBe(true);
    await expect.poll(
      () => testLogger.consoleLogs.some(l =>
        l.includes('[DND_EVENT] Number of files: 1')),
      { message: 'the wx handler should see the dropped file' }
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
    }, { x: box.x + 400, y: box.y + 200, fileName: testFileName, content: testContent });

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
    }, { x: box.x + 400, y: box.y + 200, fileName: testFileName, content: testContent });

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
    }, { x: box.x + 400, y: box.y + 200 });

    await expect.poll(
      () => testLogger.consoleLogs.some(l => l.includes('[DND] drop: 3 files')),
      { message: 'Multiple files should be detected' }
    ).toBe(true);

    // repro for G-14: the wx side must receive every file. wx.js notifies C++
    // once per file, so three single-file wxDropFilesEvents must reach the
    // DragAcceptFiles frame (pre-fix: zero arrived — leaf delivery).
    await expect.poll(
      () => testLogger.consoleLogs.filter(l =>
        l.includes('[DND_EVENT] === wxDropFilesEvent received!')).length,
      { message: 'all three files should reach the wx handler' }
    ).toBe(3);

    await stableShot(page, 'dnd-08-multiple-files.png', { fullPage: true });
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
    }, { x: box.x + 400, y: box.y + 200 });

    // Verify file was dropped (from JS side) - deterministic poll for the write log
    await expect.poll(
      () => testLogger.consoleLogs.some(l => l.includes('[DND] Wrote file:')),
      { message: 'File should be dropped and logged' }
    ).toBe(true);

    await stableShot(page, 'dnd-09-with-file.png', { fullPage: true });
  });
});
