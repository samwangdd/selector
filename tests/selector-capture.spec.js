const { test, expect } = require('@playwright/test');
const { injectSelector } = require('./helpers/inject');

const copyButton = (page) => page.getByRole('button', { name: 'Copy Prompt' });
const checkbox = (page) => page.getByRole('checkbox', { name: 'Include screenshot of active selection' });
const status = (page) => page.locator('.ai-editor-screenshot-status');

async function setup(page, mode = 'ok') {
  await page.route('https://selector.test/', (route) => route.fulfill({ contentType: 'text/html', body: `
    <style>
      body { margin: 0; min-height: 1600px; background: #d80000; }
      #target, #neighbor { position: absolute; top: 690px; height: 36px; }
      #target { left: 24px; width: 72px; background: rgb(3, 117, 229); }
      #neighbor { left: 99px; width: 52px; background: rgb(216, 0, 0); }
    </style>
    <div id="target">Selected tile</div><div id="neighbor">Neighbor</div>
  ` }));
  await page.goto('https://selector.test/');
  await page.evaluate((mode) => {
    const state = { calls: [], options: null, clipboard: 'original' };
    Object.defineProperty(navigator, 'clipboard', { value: {
      async writeText(text) { state.clipboard = text; state.calls.push(['text']); },
      async write(items) {
        state.calls.push(['write', items.length]);
        if (mode === 'clipboard-denied') throw new DOMException('Denied', 'NotAllowedError');
        const [item] = items;
        const [text, png] = await Promise.all([item.getType('text/plain'), item.getType('image/png')]);
        if (mode === 'clipboard-pending') await new Promise((resolve) => { window.__finishClipboard = resolve; });
        state.clipboard = { types: item.types, text: await text.text(), bytes: Array.from(new Uint8Array(await png.arrayBuffer())) };
      }
    } });
    window.__captureState = state;
    const track = {
      getSettings: () => ({ displaySurface: mode === 'monitor' ? 'monitor' : 'browser' }),
      cropTo(target) {
        state.calls.push([ 'crop', target.id ]);
        if (mode === 'wrong-tab') return Promise.reject(new DOMException('Wrong surface', 'OperationError'));
        state.target = target;
        return Promise.resolve();
      },
      stop() { state.calls.push([ 'stop' ]); }
    };
    const stream = { getVideoTracks: () => [ track ], getTracks: () => [ track ] };
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getDisplayMedia(options) {
          state.calls.push([ 'request' ]);
          state.options = options;
          if (mode === 'denied') return Promise.reject(new DOMException('Dismissed', 'NotAllowedError'));
          if (mode === 'delayed' || mode === 'clipboard-denied') return new Promise((resolve) => { window.__grantCapture = () => resolve(stream); });
          return Promise.resolve(stream);
        }
      }
    });
    window.CropTarget = {
      fromElement(element) {
        state.calls.push([ 'target', element.id, getComputedStyle(document.querySelector('.ai-editor-sel-box')).visibility ]);
        const r = element.getBoundingClientRect();
        const vw = window.visualViewport?.width ?? window.innerWidth;
        const vh = window.visualViewport?.height ?? window.innerHeight;
        return Promise.resolve({
          id: element.id,
          width: Math.round((Math.min(r.right, vw) - Math.max(0, r.left)) * devicePixelRatio),
          height: Math.round((Math.min(r.bottom, vh) - Math.max(0, r.top)) * devicePixelRatio),
          color: getComputedStyle(element).backgroundColor
        });
      }
    };
    window.ImageCapture = class {
      grabFrame() {
        state.calls.push([ 'frame', state.target?.id ]);
        const canvas = document.createElement('canvas');
        const { width, height, color } = state.target;
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, width, height);
        return createImageBitmap(canvas);
      }
    };
  }, mode);
  await injectSelector(page);
  await page.locator('.ai-editor-launcher').click();
  await page.evaluate(() => scrollTo(0, 600));
}

async function readPng(page, bytes) {
  return page.evaluate(async (bytes) => {
    const image = await createImageBitmap(new Blob([new Uint8Array(bytes)], {type: 'image/png'}));
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    image.close();
    return { width: canvas.width, height: canvas.height, pixel: Array.from(context.getImageData(0, 0, 1, 1).data) };
  }, bytes);
}

test.describe('Opt-in screenshot clipboard', () => {
  test('aligns the checkbox and status with Copy Prompt on a dark host page', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 560 });
    await setup(page, 'wrong-tab');
    await page.addStyleTag({ content: 'body { background: #202020; color: #fff; }' });
    await page.locator('#target').click();
    const option = checkbox(page).locator('..');
    const dot = page.locator('.ai-editor-status-dot');
    const button = copyButton(page);
    const buttonBox = await button.boundingBox();
    const contentEdges = (locator) => locator.evaluate((element) => {
      const { left, right } = element.getBoundingClientRect();
      const { paddingLeft, paddingRight } = getComputedStyle(element);
      return { left: left + parseFloat(paddingLeft), right: right - parseFloat(paddingRight) };
    });

    await expect(status(page)).toBeHidden();
    await expect(option).toHaveCSS('color', 'rgb(51, 51, 51)');
    expect(await contentEdges(option)).toEqual({ left: buttonBox.x, right: buttonBox.x + buttonBox.width });
    await checkbox(page).press('Space');
    await expect(checkbox(page)).toBeChecked();
    await expect(checkbox(page)).toHaveCSS('accent-color', await dot.evaluate((element) => getComputedStyle(element).backgroundColor));

    await checkbox(page).blur();
    await page.keyboard.press('Space');
    await expect(page.getByText('Paused', { exact: true })).toBeVisible();
    await page.keyboard.press('Space');
    await expect(page.getByText('Selecting', { exact: true })).toBeVisible();
    await expect(dot).toHaveCSS('background-color', 'rgb(74, 222, 128)');

    await button.click();
    await expect(status(page)).toHaveText(/could not crop/i);
    await expect(status(page)).toHaveCSS('color', 'rgb(102, 102, 102)');
    expect(await contentEdges(status(page))).toEqual({ left: buttonBox.x, right: buttonBox.x + buttonBox.width });
    expect(await status(page).evaluate((element) => element.offsetHeight > parseFloat(getComputedStyle(element).lineHeight))).toBe(true);
  });
  test('default copy uses text only without opening the media chooser', async ({ page }) => {
    await setup(page);
    await expect(checkbox(page)).not.toBeChecked();
    await page.locator('#target').click();
    await copyButton(page).click();
    const result = await page.evaluate(() => window.__captureState);
    expect(result.calls).toEqual([['text']]);
    expect(result.clipboard).toContain('Selected tile');
  });

  test('keeps the copy shortcut text-only when screenshots are enabled', async ({ page }) => {
    await setup(page);
    await page.locator('#target').click();
    await checkbox(page).check();

    await copyButton(page).press('ControlOrMeta+c');
    const { calls, clipboard } = await page.evaluate(() => window.__captureState);
    expect(calls).toEqual([['text']]);
    expect(clipboard).toContain('Selected tile');
    await expect(checkbox(page)).toBeChecked();
  });

  test('does not share an area overlapping a cross-origin frame', async ({ page }) => {
    await setup(page);
    await page.locator('#target').click();
    await page.locator('#target').evaluate((target) => {
      const frame = document.createElement('iframe');
      frame.title = 'Opaque frame';
      frame.setAttribute('sandbox', '');
      frame.srcdoc = '<body>Frame content</body>';
      frame.style.cssText = 'position: absolute; inset: 0; width: 48px; height: 28px; border: 0';
      target.appendChild(frame);
    });
    await expect(page.frameLocator('iframe[title="Opaque frame"]').getByText('Frame content')).toBeVisible();
    await checkbox(page).check();
    await copyButton(page).click();

    await expect(status(page)).toHaveText(/cross-origin frame/i);
    const { calls, clipboard } = await page.evaluate(() => window.__captureState);
    expect(calls).toEqual([]);
    expect(clipboard).toBe('original');
  });

  for (const { width, height, deviceScaleFactor } of [
    { width: 800, height: 600, deviceScaleFactor: 1 },
    { width: 390, height: 560, deviceScaleFactor: 2 }
  ]) {
    test(`copies text and selected area at ${width}px / DPR ${deviceScaleFactor}`, async ({ browser }) => {
      const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor, acceptDownloads: true });
      try {
        const page = await context.newPage();
        const downloads = [];
        page.on('download', (download) => downloads.push(download));
        await setup(page);
        await expect(copyButton(page)).toBeDisabled();
        await page.locator('#neighbor').click();
        await page.locator('#target').click({ modifiers: [ 'Shift' ] });

        // A page script dispatching a click cannot request browser capture.
        await checkbox(page).check();
        await copyButton(page).evaluate((button) => button.click());
        expect(await page.evaluate(() => window.__captureState.calls)).toEqual([]);

        if (width === 390) {
          await copyButton(page).press('Space');
        } else {
          await copyButton(page).click();
        }
        await expect(status(page)).toHaveText('Prompt and screenshot copied.');
        await expect(checkbox(page)).not.toBeChecked();
        const result = await page.evaluate(() => window.__captureState);
        expect(result.clipboard.types).toEqual(['text/plain', 'image/png']);
        expect(result.clipboard.text).toContain('Neighbor');
        expect(result.clipboard.text).toContain('Selected tile');
        expect(await readPng(page, result.clipboard.bytes)).toEqual({
          width: 72 * deviceScaleFactor,
          height: 36 * deviceScaleFactor,
          pixel: [ 3, 117, 229, 255 ]
        });
        expect(result.calls).toEqual([
          ['write', 1], ['request'], ['target', 'target', 'hidden'], ['crop', 'target'], ['frame', 'target'], ['stop']
        ]);
        expect(result.options.audio).toBe(false);
        expect(downloads).toEqual([]);
        await expect(page.locator('.ai-editor-sel-box').last()).toBeVisible();
      } finally {
        await context.close();
      }
    });
  }

  for (const mode of [ 'denied', 'wrong-tab', 'monitor' ]) {
    test(`fails closed on ${mode} without changing clipboard or leaving hidden overlays`, async ({ page }) => {
      await setup(page, mode);
      await page.locator('#target').click();
      await checkbox(page).check();
      await copyButton(page).click();
      await expect(status(page)).toHaveText(mode === 'denied' ? /cancelled/i : /could not crop/i);
      const calls = await page.evaluate(() => window.__captureState.calls);
      expect(calls.some(([step]) => step === 'frame')).toBe(false);
      expect(calls.filter(([step]) => step === 'stop')).toHaveLength(mode === 'denied' ? 0 : 1);
      expect(await page.evaluate(() => window.__captureState.clipboard)).toBe('original');
      await expect(page.locator('.ai-editor-sel-box')).toBeVisible();
      await expect(page.locator('.ai-editor-copy-btn')).toBeEnabled();
    });
  }

  test('stops a granted stream when Selector closed before the chooser resolved', async ({ page }) => {
    await setup(page, 'delayed');
    await page.locator('#target').click();
    await checkbox(page).check();
    await copyButton(page).click();
    await expect(status(page)).toHaveText(/choose this tab/i);
    await page.locator('[data-action="close"]').click();
    await page.evaluate(() => window.__grantCapture());
    await expect.poll(() => page.evaluate(() => window.__captureState.calls)).toEqual([['write', 1], ['request'], ['stop']]);
    expect(await page.evaluate(() => window.__captureState.clipboard)).toBe('original');
    await expect(page.locator('html')).not.toHaveClass(/ai-editor-capturing/);
  });
  test('clipboard denial stops a late chooser grant without fallback', async ({ page }) => {
    await setup(page, 'clipboard-denied');
    await page.locator('#target').click();
    await checkbox(page).check();
    await copyButton(page).click();
    await expect(status(page)).toHaveText(/could not write the clipboard/i);
    await page.evaluate(() => window.__grantCapture());
    await expect.poll(() => page.evaluate(() => window.__captureState.calls)).toEqual([['write', 1], ['request'], ['stop']]);
    expect(await page.evaluate(() => window.__captureState.clipboard)).toBe('original');
    await expect(checkbox(page)).toBeChecked();
    await expect(copyButton(page)).toBeEnabled();
  });
  test('an OS write already holding the PNG settles without false cancellation or a second copy', async ({ page }) => {
    await setup(page, 'clipboard-pending');
    await page.locator('#target').click();
    await checkbox(page).check();
    await copyButton(page).click();
    await expect(status(page)).toHaveText('Waiting for the clipboard to finish.');
    await expect.poll(() => page.evaluate(() => typeof window.__finishClipboard)).toBe('function');
    await expect(page.locator('html')).not.toHaveClass(/ai-editor-capturing/);
    await page.locator('[data-action="close"]').click();
    await page.locator('.ai-editor-launcher').click();
    await page.locator('#neighbor').click();
    await expect(copyButton(page)).toBeDisabled();
    expect(await page.evaluate(() => window.__captureState.clipboard)).toBe('original');
    await page.evaluate(() => window.__finishClipboard());
    await expect(copyButton(page)).toBeEnabled();
    await expect(status(page)).toHaveText('');
    expect(await page.evaluate(() => window.__captureState.clipboard.text)).toContain('Selected tile');
  });
});
