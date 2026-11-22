import { expect, test, type Page } from '@playwright/test';

// #69: update several projects from their source pages in one go. Browser mode against the
// mock backend: the Robotic Arm links to Printables, the vase copy to Thingiverse, the
// baseplates to Thangs; the Decorative Vase has no link at all.

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem('mm.lang', 'en'); localStorage.setItem('mm.theme', 'light'); });
  await page.goto('/#/library');
  await expect(page.getByTestId('library')).toBeVisible();
});

const card = (page: Page, title: string) => page.getByTestId('project-card').filter({ hasText: title });
async function selectFour(page: Page, first = 'Robotic Arm v4') {
  await card(page, first).click();
  for (const title of ['Twisted vase backup', 'Gridfinity Baseplates', 'Decorative Vase']) await card(page, title).click({ modifiers: ['Control'] });
  await expect(page.getByTestId('status-selected')).toHaveText('4 selected');
}

test('batch update from source pages: one choice up front, progress, and a summary per project', async ({ page }) => {
  const dialog = page.getByTestId('source-update-dialog');
  // off by default: the dialog explains it and does not start
  await selectFour(page);
  await card(page, 'Decorative Vase').click({ button: 'right' });
  await expect(page.getByTestId('project-menu')).toHaveAttribute('data-count', '4');
  await page.getByTestId('menu-source-update').click();
  await expect(dialog).toContainText('Update 4 projects from their source pages');
  await expect(dialog.getByTestId('source-update-setup')).toContainText('Loading model pages is off');
  await expect(dialog.getByTestId('source-update-start')).toBeDisabled();
  await dialog.getByTestId('source-update-open-settings').click();
  await expect(page.getByTestId('settings')).toHaveAttribute('data-section', 'ai');
  await page.getByTestId('fetch-pages-toggle').click();
  await expect(page.getByTestId('fetch-pages-status')).toHaveAttribute('data-state', 'on');
  await page.getByTestId('nav-library').click();

  // one page is unreachable
  await page.evaluate(() => { (window as unknown as { __mockPageFail?: Set<string> }).__mockPageFail = new Set(['r1:Projects/Gridfinity/Baseplates']); });
  await selectFour(page);
  await page.getByTestId('multi-source-update').click();
  await expect(dialog.getByTestId('source-update-setup')).toHaveCount(0);
  // the non-destructive choice is the default
  await expect(dialog.getByTestId('source-update-metadata')).toBeChecked();
  await expect(dialog.getByTestId('source-update-image')).toBeChecked();
  await expect(dialog.getByTestId('source-update-fill')).toBeChecked();
  await dialog.getByTestId('source-update-start').click();
  await expect(dialog).toHaveAttribute('data-phase', 'running');
  await expect(dialog.getByTestId('source-update-count')).toContainText('of 4');
  await page.keyboard.press('Escape'); // a running update is not dismissed by accident
  await expect(dialog).toBeVisible();

  const totals = dialog.getByTestId('source-update-totals');
  await expect(totals).toHaveText('2 updated · 1 skipped · 1 failed', { timeout: 15_000 });
  const row = (title: string) => dialog.getByTestId('source-update-result').filter({ hasText: title });
  await expect(row('Twisted vase backup')).toHaveAttribute('data-status', 'updated');
  await expect(row('Twisted vase backup')).toContainText('Creator, License, Description');
  // the arm has its metadata already, so only the missing preview is fetched
  await expect(row('Robotic Arm v4')).toHaveAttribute('data-status', 'updated');
  await expect(row('Robotic Arm v4')).toContainText('Preview image');
  await expect(row('Robotic Arm v4')).not.toContainText('Creator');
  await expect(row('Decorative Vase')).toHaveAttribute('data-status', 'skipped');
  await expect(row('Decorative Vase')).toContainText('No source link');
  await expect(row('Gridfinity Baseplates')).toHaveAttribute('data-status', 'failed');
  await expect(row('Gridfinity Baseplates')).toContainText('HTTP 404');
  expect(await page.evaluate(() => (window as unknown as { __mockThumbPicks?: Array<string | null> }).__mockThumbPicks)).toEqual(['.meshkeep/cover.jpg']);
  await dialog.getByTestId('source-update-close').click();
  await expect(dialog).toBeHidden();

  // the metadata is there; what the arm had was not overwritten
  await card(page, 'Twisted vase backup').click();
  await expect(page.getByTestId('inspector')).toContainText('zackfreedman');
  await expect(page.getByTestId('inspector')).toContainText('CC-BY-4.0');
  await card(page, 'Robotic Arm v4').click();
  await expect(page.getByTestId('inspector')).toContainText('ExampleCreator');
  await expect(page.getByTestId('inspector')).toContainText('GPL-3.0');
});

test('batch update from source pages: overwrite replaces values, a changed project.yaml is left alone, cancel stops the rest', async ({ page }) => {
  const dialog = page.getByTestId('source-update-dialog');
  await page.getByTestId('nav-settings').click();
  await page.getByTestId('settings-nav-ai').click();
  await page.getByTestId('fetch-pages-toggle').click();
  await expect(page.getByTestId('fetch-pages-status')).toHaveAttribute('data-state', 'on');
  await page.getByTestId('nav-library').click();

  // an external editor touches the vase copy's sidecar between the read and the write
  await page.evaluate(() => { const w = window as unknown as { __mockTouched?: Set<string> }; (w.__mockTouched ??= new Set()).add('r1:Projects/Misc/Twisted vase backup'); });
  await card(page, 'Robotic Arm v4').click();
  await card(page, 'Twisted vase backup').click({ modifiers: ['Control'] });
  await page.getByTestId('multi-source-update').click();
  await dialog.getByTestId('source-update-image').uncheck();
  await dialog.getByTestId('source-update-overwrite').check();
  await dialog.getByTestId('source-update-start').click();
  await expect(dialog.getByTestId('source-update-totals')).toHaveText('1 updated · 0 skipped · 1 failed', { timeout: 15_000 });
  const row = (title: string) => dialog.getByTestId('source-update-result').filter({ hasText: title });
  await expect(row('Twisted vase backup')).toContainText('changed on disk in the meantime; nothing was overwritten');
  await expect(row('Robotic Arm v4')).toContainText('Title, Creator, License, Description, Tags');
  await dialog.getByTestId('source-update-close').click();
  await card(page, 'Baby Jellyfish Dragon').click();
  await expect(page.getByTestId('inspector')).toContainText('Cinderwing3D');

  // cancel: the project in work is finished, the others are not touched
  await selectFour(page, 'Baby Jellyfish Dragon'); // the arm's new title
  await page.getByTestId('multi-source-update').click();
  await dialog.getByTestId('source-update-start').click();
  await dialog.getByTestId('source-update-cancel').click();
  await expect(dialog).toHaveAttribute('data-phase', 'done', { timeout: 15_000 });
  await expect(dialog.getByTestId('source-update-result').filter({ hasText: 'Cancelled before its turn' })).not.toHaveCount(0);
  await expect(dialog.getByTestId('source-update-totals')).not.toHaveAttribute('data-skipped', '0');
});
