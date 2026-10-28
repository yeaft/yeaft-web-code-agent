import { expect } from '@playwright/test';

const desktopActions = {
  search: '.person-search-button',
  outputs: '.person-outputs-button',
  inside: '.person-thoughts-button',
  settings: '.person-settings-button',
  refresh: '.person-header-actions > button:first-child',
};

// Choose from the viewport contract, not element visibility: a missing mobile
// trigger or an accidentally visible desktop icon should fail the regression.
export function personActionOpener(page, action) {
  return page.locator(page.viewportSize().width <= 600 ? '.person-more-button' : desktopActions[action]);
}

export async function clickPersonAction(page, action) {
  if (!Object.hasOwn(desktopActions, action)) throw new Error(`Unknown Person action: ${action}`);
  if (page.viewportSize().width <= 600) {
    await page.locator('.person-more-button').click();
    const sheet = page.locator('#person-actions-sheet');
    await expect(sheet).toBeVisible();
    await sheet.locator(`.person-action-${action}`).click();
    await expect(sheet).not.toBeVisible();
  } else {
    await page.locator(desktopActions[action]).click();
  }
}
