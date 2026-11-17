import { expect } from '@playwright/test';

const desktopActions = {
  search: '.person-search-button',
  outputs: '.person-outputs-button',
  inside: '.person-thoughts-button',
  settings: '.person-settings-button',
  refresh: '.person-header-actions > button:first-child',
};

// A desktop split can make just the conversation header compact. Layout tests
// assert that breakpoint explicitly; focus assertions target its visible opener.
export function personActionOpener(page, action) {
  return page.locator(`.person-more-button:visible, ${desktopActions[action]}:visible`);
}

export async function clickPersonAction(page, action) {
  if (!Object.hasOwn(desktopActions, action)) throw new Error(`Unknown Person action: ${action}`);
  const conversation = await page.locator('#person-conversation').boundingBox();
  if (conversation.width <= 600) {
    await page.locator('.person-more-button').click();
    const sheet = page.locator('#person-actions-sheet');
    await expect(sheet).toBeVisible();
    await sheet.locator(`.person-action-${action}`).click();
    await expect(sheet).not.toBeVisible();
  } else {
    await page.locator(desktopActions[action]).click();
  }
}
