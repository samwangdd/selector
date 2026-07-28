const { test, expect } = require('@playwright/test');
const { injectSelector } = require('./helpers/inject');
const path = require('path');
const fs   = require('fs');

const FIXTURE_HTML = fs.readFileSync(
  path.join(__dirname, 'fixtures/page.html'),
  'utf8'
);

test.beforeEach(async ({ page }) => {
  await page.setContent(FIXTURE_HTML);
  // Install clipboard mock after setContent so it is available when editor.js runs.
  await page.evaluate(() => {
    window.__clipboardText = '';
    const mockClipboard = {
      writeText: (text) => { window.__clipboardText = text; return Promise.resolve(); },
      readText:  ()     => Promise.resolve(window.__clipboardText),
    };
    try {
      Object.defineProperty(navigator, 'clipboard', { value: mockClipboard, writable: true, configurable: true });
    } catch {
      navigator.clipboard = mockClipboard;
    }
  });
  await injectSelector(page);
});

// ── Helpers ──────────────────────────────────────────────
const launcher = (page) => page.locator('.ai-editor-launcher');
const activate  = (page) => launcher(page).click();

// ── Launcher ─────────────────────────────────────────────
test.describe('Launcher', () => {
  test('is visible after injection', async ({ page }) => {
    await expect(launcher(page)).toBeVisible();
  });

  test('activates on first click', async ({ page }) => {
    await activate(page);
    await expect(launcher(page)).toHaveClass(/ai-editor-launcher-active/);
  });

  test('deactivates via close button', async ({ page }) => {
    await activate(page);
    await page.locator('[data-action="close"]').click();
    await expect(launcher(page)).not.toHaveClass(/ai-editor-launcher-active/);
  });

  test('close button clears a selected element with an instruction', async ({ page }) => {
    await activate(page);
    await page.locator('#intro-para').click();
    await page.locator('.ai-editor-annotate-btn').click({ force: true });
    await page.locator('.ai-editor-annotate-input').fill('Discard this instruction');
    await page.locator('.ai-editor-annotate-done').click({ force: true });

    await page.locator('[data-action="close"]').click();

    await expect(page.locator('.ai-editor-sel-box')).toHaveCount(0);
    await expect(page.locator('.ai-editor-chat-panel')).toHaveCount(0);
  });
});

// ── Selection ─────────────────────────────────────────────
test.describe('Selection', () => {
  test('click selects element — overlay and tag appear', async ({ page }) => {
    await activate(page);
    await page.locator('#intro-para').click();

    await expect(page.locator('.ai-editor-sel-box')).toBeVisible();
    await expect(page.locator('.ai-editor-chat-tags .ai-editor-tag')).toHaveCount(1);
  });

  test('clicking a different element replaces selection', async ({ page }) => {
    await activate(page);
    await page.locator('#intro-para').click();
    await page.locator('#action-btn').click();

    await expect(page.locator('.ai-editor-tag')).toHaveCount(1);
    await expect(page.locator('.ai-editor-tag-label')).toContainText('action-btn');
  });

  test('shift+click adds to selection', async ({ page }) => {
    await activate(page);
    await page.locator('#intro-para').click();
    await page.locator('#action-btn').click({ modifiers: ['Shift'] });

    await expect(page.locator('.ai-editor-tag')).toHaveCount(2);
    await expect(page.locator('.ai-editor-sel-box')).toHaveCount(2);
  });

  test('the last selected element has the active selection treatment', async ({ page }) => {
    await activate(page);
    await page.locator('#intro-para').click();
    await page.locator('#action-btn').click({ modifiers: ['Shift'] });

    await expect(page.locator('.ai-editor-sel-box.ai-editor-active')).toHaveCount(1);
    await expect(page.locator('.ai-editor-sel-label.ai-editor-active')).toHaveCount(1);
  });
});

// ── Clear / deselect ──────────────────────────────────────
test.describe('Clear', () => {
  test('Escape clears all selected elements', async ({ page }) => {
    await activate(page);
    await page.locator('#intro-para').click();
    await page.locator('#action-btn').click({ modifiers: ['Shift'] });

    await page.keyboard.press('Escape');

    await expect(page.locator('.ai-editor-tag')).toHaveCount(0);
    await expect(page.locator('.ai-editor-sel-box')).toHaveCount(0);
  });

  test('Clear button removes all selected elements, including instructions', async ({ page }) => {
    await activate(page);
    await page.locator('#intro-para').click();
    await page.locator('.ai-editor-annotate-btn').click({ force: true });
    await page.locator('.ai-editor-annotate-input').fill('Discard this instruction');
    await page.locator('.ai-editor-annotate-done').click({ force: true });
    await page.locator('#action-btn').click({ modifiers: ['Shift'] });

    await page.locator('.ai-editor-tags-action').click({ force: true });

    await expect(page.locator('.ai-editor-tag')).toHaveCount(0);
    await expect(page.locator('.ai-editor-sel-box')).toHaveCount(0);
  });

  test('tag X button removes only that element', async ({ page }) => {
    await activate(page);
    await page.locator('#intro-para').click();
    await page.locator('#action-btn').click({ modifiers: ['Shift'] });

    await page.locator('.ai-editor-tag-x').first().click({ force: true });

    await expect(page.locator('.ai-editor-tag')).toHaveCount(1);
    await expect(page.locator('.ai-editor-sel-box')).toHaveCount(1);
  });

  test('Escape retains a selected element with an instruction', async ({ page }) => {
    await activate(page);
    await page.locator('#intro-para').click();
    await page.locator('.ai-editor-annotate-btn').click({ force: true });
    await page.locator('.ai-editor-annotate-input').fill('Keep this instruction');
    await page.locator('.ai-editor-annotate-done').click({ force: true });

    await page.keyboard.press('Escape');

    await expect(page.locator('.ai-editor-tag')).toHaveCount(1);
    await expect(page.locator('.ai-editor-tag-label')).toContainText('intro-para');
  });

  test('tag remove clears a selected element and its instruction', async ({ page }) => {
    await activate(page);
    await page.locator('#intro-para').click();
    await page.locator('.ai-editor-annotate-btn').click({ force: true });
    await page.locator('.ai-editor-annotate-input').fill('Keep this instruction');
    await page.locator('.ai-editor-annotate-done').click({ force: true });

    await page.locator('.ai-editor-tag-x').click({ force: true });

    await expect(page.locator('.ai-editor-tag')).toHaveCount(0);
    await expect(page.locator('.ai-editor-sel-box')).toHaveCount(0);
  });

  test('clearing an instruction makes its selection removable', async ({ page }) => {
    await activate(page);
    await page.locator('#intro-para').click();
    await page.locator('.ai-editor-annotate-btn').click({ force: true });
    await page.locator('.ai-editor-annotate-input').fill('Temporary instruction');
    await page.locator('.ai-editor-annotate-done').click({ force: true });

    await page.locator('.ai-editor-annotate-btn').click({ force: true });
    await page.locator('.ai-editor-annotate-clear').click({ force: true });
    await page.locator('.ai-editor-tag-x').click({ force: true });

    await expect(page.locator('.ai-editor-tag')).toHaveCount(0);
  });

  test('Shift+click retains a selected element with an instruction', async ({ page }) => {
    await activate(page);
    await page.locator('#intro-para').click();
    await page.locator('.ai-editor-annotate-btn').click({ force: true });
    await page.locator('.ai-editor-annotate-input').fill('Keep this instruction');
    await page.locator('.ai-editor-annotate-done').click({ force: true });

    await page.locator('#intro-para').click({ modifiers: ['Shift'] });

    await expect(page.locator('.ai-editor-tag')).toHaveCount(1);
  });
});

// ── Copy prompt ───────────────────────────────────────────
test.describe('Copy Prompt', () => {
  test('Copy button is disabled with no selection', async ({ page }) => {
    await activate(page);
    await expect(page.locator('.ai-editor-copy-btn')).toBeDisabled();
  });

  test('Copy button is enabled after selection', async ({ page }) => {
    await activate(page);
    await page.locator('#intro-para').click();
    await expect(page.locator('.ai-editor-copy-btn')).toBeEnabled();
  });

  test('Copy button writes formatted prompt to clipboard', async ({ page }) => {
    await activate(page);
    await page.locator('#intro-para').click();
    await page.locator('.ai-editor-copy-btn').click();

    const text = await page.evaluate(() => window.__clipboardText);
    expect(text).toMatch(/^Page:/m);
    expect(text).toMatch(/#intro-para|intro-para/);
    expect(text).toMatch(/selector:/);
  });

  test('Cmd+C copies prompt when element is selected', async ({ page }) => {
    await activate(page);
    await page.locator('#intro-para').click();
    await page.locator('body').focus();
    await page.keyboard.press('Meta+c');
    await page.waitForFunction(() => window.__clipboardText !== '');
    const text = await page.evaluate(() => window.__clipboardText);
    expect(text).toMatch(/^Page:/m);
  });
});

// ── Keyboard navigation ───────────────────────────────────
test.describe('Keyboard Navigation', () => {
  test('ArrowUp navigates to parent element', async ({ page }) => {
    await activate(page);
    await page.locator('#item-1').click();

    await page.keyboard.press('ArrowUp');

    await expect(page.locator('.ai-editor-tag-label').filter({ hasText: '#container' })).toHaveCount(1);
  });

  test('ArrowDown navigates to first child element', async ({ page }) => {
    await activate(page);
    await page.locator('#container').click({ position: { x: 5, y: 5 } });

    await page.keyboard.press('ArrowDown');

    await expect(page.locator('.ai-editor-tag-label').filter({ hasText: '#item-1' })).toHaveCount(1);
  });

  test('ArrowRight navigates to next sibling', async ({ page }) => {
    await activate(page);
    await page.locator('#item-1').click();

    await page.keyboard.press('ArrowRight');

    await expect(page.locator('.ai-editor-tag-label').filter({ hasText: '#item-2' })).toHaveCount(1);
  });

  test('ArrowLeft navigates to previous sibling', async ({ page }) => {
    await activate(page);
    await page.locator('#item-2').click();

    await page.keyboard.press('ArrowLeft');

    await expect(page.locator('.ai-editor-tag-label').filter({ hasText: '#item-1' })).toHaveCount(1);
  });

  test('ArrowRight replaces the active selection while retaining earlier Shift selections', async ({ page }) => {
    await activate(page);
    await page.locator('#intro-para').click();
    await page.locator('#item-1').click({ modifiers: ['Shift'] });

    await page.keyboard.press('ArrowRight');

    await expect(page.locator('.ai-editor-tag')).toHaveCount(2);
    await expect(page.locator('.ai-editor-tag-label').nth(0)).toContainText('intro-para');
    await expect(page.locator('.ai-editor-tag-label').nth(1)).toContainText('item-2');
  });

  test('navigation to an earlier selection replaces the active element without duplicates', async ({ page }) => {
    await activate(page);
    await page.locator('#item-1').click();
    await page.locator('#item-2').click({ modifiers: ['Shift'] });

    await page.keyboard.press('ArrowLeft');

    await expect(page.locator('.ai-editor-tag')).toHaveCount(1);
    await expect(page.locator('.ai-editor-tag-label').nth(0)).toContainText('item-1');
    const activeTop = await page.locator('.ai-editor-sel-box.ai-editor-active').evaluate((el) => el.getBoundingClientRect().top);
    const itemOneTop = await page.locator('#item-1').evaluate((el) => el.getBoundingClientRect().top);
    expect(activeTop).toBeLessThanOrEqual(itemOneTop);
  });

  test('navigation retains an active selection with an instruction', async ({ page }) => {
    await activate(page);
    await page.locator('#item-1').click();
    await page.locator('.ai-editor-annotate-btn').click({ force: true });
    await page.locator('.ai-editor-annotate-input').fill('Keep this instruction');
    await page.locator('.ai-editor-annotate-done').click({ force: true });

    await page.keyboard.press('ArrowRight');

    await expect(page.locator('.ai-editor-tag')).toHaveCount(2);
    await expect(page.locator('.ai-editor-tag-label').nth(0)).toContainText('item-1');
    await expect(page.locator('.ai-editor-tag-label').nth(1)).toContainText('item-2');
  });
});

// ── Pause ─────────────────────────────────────────────────
test.describe('Pause', () => {
  test('Space toggles status between Selecting and Paused', async ({ page }) => {
    await activate(page);

    const label = page.locator('.ai-editor-status-label');
    await expect(label).toHaveText('Selecting');

    await page.keyboard.press(' ');
    await expect(label).toHaveText('Paused');

    await page.keyboard.press(' ');
    await expect(label).toHaveText('Selecting');
  });
});

// ── Annotation ────────────────────────────────────────────
test.describe('Annotation', () => {
  test('pencil button opens annotation popover with focused textarea', async ({ page }) => {
    await activate(page);
    await page.locator('#intro-para').click();

    await page.locator('.ai-editor-annotate-btn').click({ force: true });

    await expect(page.locator('.ai-editor-annotate-popover')).toBeVisible();
    await expect(page.locator('.ai-editor-annotate-input')).toBeFocused();
  });

  test('saved annotation appears in copied prompt', async ({ page }) => {
    await activate(page);
    await page.locator('#intro-para').click();

    await page.locator('.ai-editor-annotate-btn').click({ force: true });
    await page.locator('.ai-editor-annotate-input').fill('Change font size to 24px');
    await page.locator('.ai-editor-annotate-done').click({ force: true });

    await page.locator('.ai-editor-copy-btn').click();
    const text = await page.evaluate(() => window.__clipboardText);
    expect(text).toContain('instruction: Change font size to 24px');
  });

  test('an annotated selection survives a normal click on another element', async ({ page }) => {
    await activate(page);
    await page.locator('#intro-para').click();
    await page.locator('.ai-editor-annotate-btn').click({ force: true });
    await page.locator('.ai-editor-annotate-input').fill('Keep this instruction');
    await page.locator('.ai-editor-annotate-done').click({ force: true });

    await page.locator('#action-btn').click();

    await expect(page.locator('.ai-editor-tag')).toHaveCount(2);
    await expect(page.locator('.ai-editor-tag-label').first()).toContainText('intro-para');
    await expect(page.locator('.ai-editor-tag-label').nth(1)).toContainText('action-btn');
  });

  test('the annotation button stays visible when the selected element reaches the viewport edge', async ({ page }) => {
    await page.setViewportSize({ width: 400, height: 400 });
    await page.locator('#container').evaluate((el) => {
      Object.assign(el.style, {
        position: 'fixed', top: '120px', left: '0', width: '100vw', margin: '0', boxSizing: 'border-box',
      });
    });
    await activate(page);
    await page.locator('#container').click({ position: { x: 5, y: 5 } });

    const button = page.locator('.ai-editor-annotate-btn');
    const bounds = await button.boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(400);
  });

  test('the annotation button moves to the left when the right side lacks space', async ({ page }) => {
    await page.setViewportSize({ width: 400, height: 400 });
    await page.locator('#container').evaluate((el) => {
      Object.assign(el.style, {
        position: 'fixed', top: '120px', left: '360px', width: '32px', margin: '0', boxSizing: 'border-box',
      });
    });
    await activate(page);
    await page.locator('#container').click({ position: { x: 2, y: 2 } });

    const buttonBounds = await page.locator('.ai-editor-annotate-btn').boundingBox();
    const elementBounds = await page.locator('#container').boundingBox();
    expect(buttonBounds.x + buttonBounds.width).toBeLessThan(elementBounds.x);
  });
});
