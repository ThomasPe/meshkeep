// Takes the Store and website screenshots from the built app in browser mode.
//
//   npm run screenshots        (builds first, then runs this script)
//
// The pictures show the showcase library of the mock backend (`?showcase=en|de`,
// src/lib/backend/showcase.ts): recognizable sample models with titles in the listing's
// language. Outputs:
//   docs/store/screenshots/<en|de>/   four PNGs of 1920x1080 each, in the order of the listing
//   site/assets/                      library.jpg and project.jpg (English) and their -de twins
//
// Browser mode has no window frame, so the pictures show the app's content area. Commit the
// result; rerun after a visible change to the UI. CHROMIUM_PATH overrides the browser binary.
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
if (!existsSync(join(root, 'dist/index.html'))) throw new Error('dist/ is missing: run `npx vite build` first (npm run screenshots does)');

const PORT = 4179;
const base = `http://127.0.0.1:${PORT}`;
const server = spawn(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), 'preview', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], { cwd: root, stdio: 'ignore' });
async function serverUp() {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(base)).ok) return; } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`vite preview did not come up on ${base}`);
}

/** The project every "project page" picture opens: several files, a description, a favourite. */
const PROJECT = { en: 'r1:Projects/Mechanical/Planetary Gearbox', de: 'r1:Projekte/Mechanik/Planetengetriebe' };

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const pageErrors = [];

/**
 * One browser context per picture series: language, theme and tile size are what a user
 * would have chosen, set where the app keeps them.
 */
async function session({ lang, theme, viewport, scale, tile }) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: scale, colorScheme: theme });
  await context.addInitScript(({ lang, theme, tile }) => {
    localStorage.setItem('mm.lang', lang);
    localStorage.setItem('mm.theme', theme);
    localStorage.setItem('mm.ui', JSON.stringify({ tile }));
  }, { lang, theme, tile });
  const page = await context.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));

  const library = async () => {
    await page.goto(`${base}/?showcase=${lang}#/library`);
    await page.getByTestId('project-card').first().waitFor();
    // every card on screen has its rendered preview (a project on an offline drive further
    // down never gets one in browser mode), and the fade-in is over
    await page.waitForFunction(() => {
      const cards = [...document.querySelectorAll('[data-testid="project-card"]')].filter((c) => c.getBoundingClientRect().top < window.innerHeight);
      return cards.length > 0 && cards.every((c) => { const img = c.querySelector('[data-testid="thumb-img"]'); return img instanceof HTMLImageElement && img.complete && img.naturalWidth > 0; });
    }, null, { timeout: 60_000 });
    // the background queue has rendered the previews further down as well
    await page.getByTestId('status-thumbs').waitFor({ state: 'detached', timeout: 120_000 });
    await page.waitForTimeout(600);
  };
  const project = async () => {
    await page.goto(`${base}/?showcase=${lang}#/project/${encodeURIComponent(PROJECT[lang])}`);
    await page.getByTestId('viewer-triangles').waitFor({ timeout: 60_000 });
    // the strip under the viewer has a preview for every model file
    await page.waitForFunction(() => {
      const strip = [...document.querySelectorAll('[data-testid="viewer-model"]')];
      return strip.length > 0 && strip.every((b) => { const img = b.querySelector('img'); return img instanceof HTMLImageElement && img.complete && img.naturalWidth > 0; });
    }, null, { timeout: 60_000 });
    await page.waitForTimeout(800);
  };
  const importDialog = async () => {
    await library();
    await page.getByTestId('import-open').click();
    await page.getByTestId('import-item').nth(2).waitFor();
    await page.waitForTimeout(600);
  };
  return { page, library, project, importDialog, close: () => context.close() };
}

try {
  await serverUp();
  let count = 0;
  const shot = async (page, path, options = {}) => {
    mkdirSync(dirname(path), { recursive: true });
    await page.screenshot({ path, ...options });
    count += 1;
  };

  for (const lang of ['en', 'de']) {
    // Store: 1920x1080, drawn at 1.2 scale: a 1600x900 window, wide enough for the German
    // toolbar on one line, with text as large as on a 125 % display.
    const store = { lang, viewport: { width: 1600, height: 900 }, scale: 1.2, tile: 170 };
    const out = join(root, 'docs/store/screenshots', lang);
    const light = await session({ ...store, theme: 'light' });
    await light.library();
    await shot(light.page, join(out, '1-library.png'));
    await light.project();
    await shot(light.page, join(out, '2-project.png'));
    await light.importDialog();
    await shot(light.page, join(out, '3-import.png'));
    await light.close();
    const dark = await session({ ...store, theme: 'dark' });
    await dark.library();
    await shot(dark.page, join(out, '4-library-dark.png'));
    await dark.close();

    // Website: the 14:9 shape the pages declare (1400x900), from a 1680x1080 window so the
    // German toolbar fits on one line, at 1.5 density so it stays sharp on phones.
    const site = await session({ lang, theme: 'light', viewport: { width: 1680, height: 1080 }, scale: 1.5, tile: 180 });
    const suffix = lang === 'en' ? '' : `-${lang}`;
    await site.library();
    await shot(site.page, join(root, `site/assets/library${suffix}.jpg`), { type: 'jpeg', quality: 82 });
    await site.project();
    await shot(site.page, join(root, `site/assets/project${suffix}.jpg`), { type: 'jpeg', quality: 82 });
    await site.close();
  }
  if (pageErrors.length) throw new Error(`the app reported errors while the pictures were taken:\n${pageErrors.join('\n')}`);
  console.log(`${count} screenshots written`);
} finally {
  await browser.close();
  server.kill();
}
