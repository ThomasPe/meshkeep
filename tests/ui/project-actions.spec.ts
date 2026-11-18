import { expect, test, type Locator, type Page } from '@playwright/test';

// #70: one list of project actions (`projectActionItems`) feeds the context menu, the
// inspector and the details page. Every control carries `data-action`, so the sets compare.

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem('mm.lang', 'en'); localStorage.setItem('mm.theme', 'light'); });
  await page.goto('/#/library');
  await expect(page.getByTestId('library')).toBeVisible();
});

const actionsIn = async (scope: Locator) => [...new Set(await scope.locator('[data-action]').evaluateAll((els) => els.map((e) => e.getAttribute('data-action')!)))].sort();

/** Buttons of a bar plus the entries of its "more" menu. */
async function barActions(page: Page, scope: Locator, prefix: string) {
  const inline = await actionsIn(scope);
  await page.getByTestId(`${prefix}-more`).click();
  const more = await actionsIn(page.getByTestId(`${prefix}-more-menu`));
  await page.keyboard.press('Escape');
  await expect(page.getByTestId(`${prefix}-more-menu`)).toBeHidden();
  return [...new Set([...inline, ...more])].sort();
}

async function menuActions(page: Page, card: Locator) {
  await card.click({ button: 'right' });
  const menu = page.getByTestId('project-menu');
  await expect(menu).toBeVisible();
  const ids = await actionsIn(menu);
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  return ids;
}

test('context menu and inspector offer the same project actions', async ({ page }) => {
  const card = page.getByTestId('project-card').filter({ hasText: 'Decorative Vase' });
  const menu = await menuActions(page, card);
  expect(menu).toEqual(['addToCollection', 'delete', 'favorite', 'fetchPage', 'move', 'open', 'pack', 'rename', 'rerenderThumbnail', 'reveal', 'suggest']);
  await expect(page.getByTestId('inspector-title')).toHaveText('Decorative Vase');
  expect(await barActions(page, page.getByTestId('inspector'), 'inspector')).toEqual(menu);

  // inside a collection both gain "remove from this collection"
  await page.getByTestId('filter-collection').click();
  const inCollection = page.getByTestId('project-card').filter({ hasText: 'Cable Clips' });
  const menu2 = await menuActions(page, inCollection);
  expect(menu2).toContain('removeFromCollection');
  await expect(page.getByTestId('inspector-title')).toHaveText('Cable Clips');
  expect(await barActions(page, page.getByTestId('inspector'), 'inspector')).toEqual(menu2);

  // actions that used to be on one side only work from the other one
  await page.getByTestId('inspector-more').click();
  await page.getByTestId('inspector-remove-from-collection').click();
  await expect(page.getByTestId('project-card').filter({ hasText: 'Cable Clips' })).toHaveCount(0);
  await page.getByTestId('project-card').filter({ hasText: 'Phone Stand' }).click({ button: 'right' });
  await page.getByTestId('menu-fetch-page').click();
  await expect(page.getByTestId('suggest-dialog')).toHaveAttribute('data-mode', 'page');
});

test('the details page offers every project action, and they work from there', async ({ page }) => {
  const card = page.getByTestId('project-card').filter({ hasText: 'Decorative Vase' });
  const menu = await menuActions(page, card);
  await page.getByTestId('inspector-open').click();
  const details = page.getByTestId('project-page');
  await expect(details).toBeVisible();
  await expect(page.getByTestId('project-title')).toHaveText('Decorative Vase');
  // everything the context menu has, except "open": this is the opened project
  expect(await barActions(page, details, 'project')).toEqual(menu.filter((a) => a !== 'open'));

  // add to a collection
  await page.getByTestId('project-more').click();
  await page.getByTestId('project-add-to-collection').hover();
  // at the window's edge the sub-menu opens to the left; walk the pointer over like a hand
  // does (a jump across the gap closes it)
  const entry = page.getByTestId('project-collection').filter({ hasText: 'Desk setup' });
  const box = (await entry.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });
  await entry.click();
  await expect(page.getByText('Added to “Desk setup”')).toBeVisible();

  // the suggestion dialog opens here as well
  await page.getByTestId('project-more').click();
  await page.getByTestId('project-suggest').click();
  await expect(page.getByTestId('suggest-dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('suggest-dialog')).toBeHidden();

  // move: the page follows the project to its new place, and back again on undo
  const before = page.url();
  await page.getByTestId('project-more').click();
  await page.getByTestId('project-move').click();
  await page.getByTestId('move-dialog').getByTestId('move-folder').filter({ hasText: 'Desk' }).click();
  await page.getByTestId('move-confirm').click();
  await expect(page.getByText('1 project moved to 3D Models / Projects / Desk')).toBeVisible();
  await expect(page).toHaveURL(/Projects%2FDesk%2F/);
  await expect(page.getByTestId('project-title')).toHaveText('Decorative Vase');
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByText('1 project moved back')).toBeVisible();
  await expect(page).toHaveURL(before);
  await expect(page.getByTestId('project-title')).toHaveText('Decorative Vase');

  // rename: the page shows the project under its new folder name
  await page.getByTestId('project-rename').click();
  await page.getByTestId('rename-input').fill('Vase Two');
  await page.getByTestId('rename-confirm').click();
  await expect(page.getByText('Renamed to Vase Two')).toBeVisible();
  await expect(page).toHaveURL(/Vase%20Two$/);
  // no project.yaml, so the folder name is the title
  await expect(page.getByTestId('project-title')).toHaveText('Vase Two');

  // delete: back in the library, the project is gone
  await page.getByTestId('project-delete').click();
  await expect(page.getByTestId('delete-dialog')).toContainText('Vase Two');
  await page.getByTestId('delete-confirm').click();
  await expect(page.getByTestId('library')).toBeVisible();
  await expect(page.getByTestId('project-card').first()).toBeVisible();
  await expect(page.getByTestId('project-card').filter({ hasText: /Vase/ })).toHaveCount(0);
});
