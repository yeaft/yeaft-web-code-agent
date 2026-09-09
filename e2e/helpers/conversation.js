import { expect } from '@playwright/test';

/** Open the catalog's New chat modal for the CLI provider used by MockAgent. */
export async function openConversationModal(chatPage) {
  await chatPage.locator('.sidebar-primary-action').click();
  const modal = chatPage.locator('.yeaft-session-create-modal');
  await expect(modal).toBeVisible();
  await modal.getByRole('combobox', { name: 'Provider', exact: true }).click();
  await chatPage.getByRole('option', { name: 'Claude Code', exact: true }).click();
  return modal;
}

export async function createConversation(chatPage) {
  const beforeCount = await chatPage.locator('.session-item').count();
  const modal = await openConversationModal(chatPage);
  await modal.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(modal).not.toBeVisible();
  await expect(chatPage.locator('.session-item')).toHaveCount(beforeCount + 1);
  await expect(chatPage.locator('.session-item.active')).toHaveCount(1);
}
