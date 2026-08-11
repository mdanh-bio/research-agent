import { expect } from '@playwright/test'
import type { Page } from 'playwright'

import { test } from './fixtures/electron-app'

const createProject = async (page: Page): Promise<void> => {
  await page.getByRole('button', { name: 'New project' }).click()
  const dialog = page.getByRole('dialog', { name: 'New project' })
  await dialog.getByLabel('Name').fill('Routing certification project')
  await dialog.getByLabel('Description').fill('Local fake-provider routing journey.')
  await dialog.getByRole('button', { name: 'Create project' }).click()
  await expect(page.getByRole('heading', { name: 'New conversation' })).toBeVisible()
}

test('certifies an opt-in routed prompt through the Electron fake-agent journey', async ({
  app
}) => {
  let page = await app.completeOnboarding()
  page = await app.configureFakeAgent()

  await page.getByRole('button', { name: 'Model settings' }).click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('button', { name: 'Routing', exact: true })
    .click()
  await settings.getByLabel('Routing profile').selectOption('balanced')
  await expect(settings.getByRole('status')).toContainText('Active')
  await expect(settings.getByText('New routed runs use the effective targets below')).toBeVisible()
  await settings.getByRole('button', { name: 'Close settings' }).click()

  await createProject(page)
  await page.getByRole('textbox', { name: 'Ask anything' }).fill('Route through the fake agent.')
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(
    page.getByText('Deterministic reply: Summarize the deterministic fixture.', { exact: true })
  ).toBeVisible()
})
