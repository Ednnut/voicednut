import { expect, test } from '@playwright/test';

test('renders the admin dashboard using local fixtures', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'VOICEDNUT' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Overview status' })).toBeVisible();

  await page.keyboard.press('Tab');
  const skipLink = page.getByRole('link', { name: 'Skip to active content' });
  await expect(skipLink).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#va-view-stage-root')).toBeFocused();

  for (const viewport of [
    { width: 390, height: 844 },
    { width: 768, height: 1024 },
    { width: 1280, height: 800 },
  ]) {
    await page.setViewportSize(viewport);
    await expect(page.getByRole('heading', { name: 'VOICEDNUT' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Overview status' })).toBeVisible();
    const dimensions = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      document: document.documentElement.scrollWidth,
    }));
    expect(dimensions.document, `Horizontal overflow at ${viewport.width}px`).toBeLessThanOrEqual(dimensions.viewport + 1);
    await page.screenshot({ path: `test-results/dashboard-${viewport.width}.png`, fullPage: true });
  }

  await page.goto('/#/provider');
  await expect(page.getByRole('heading', { name: 'Vapi web call test' })).toBeVisible();
  await expect(page.getByText('No live templates', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start browser call' })).toBeDisabled();
});

test('exposes CALL-E status lookup only after a local call ID is supplied', async ({ page }) => {
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1280, height: 800 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto('/#/content');
    await expect(page.locator('#va-view-stage-root').getByRole('heading', { name: 'Script Designer' })).toBeVisible();
    const deploymentDisclosure = page.locator('details.va-disclosure').filter({ hasText: 'CALL-E deployment status' });
    await deploymentDisclosure.evaluate((element) => { (element as HTMLDetailsElement).open = true; });
    await expect(page.getByRole('heading', { name: 'Dispatch unavailable' })).toBeVisible();
    await expect(page.getByText('VOICEDNUT has no CALL-E dispatch route. Configuration status does not enable or place calls.')).toBeVisible();
    await page.getByRole('button', { name: 'Refresh CALL-E availability' }).click();
    await expect(page.getByText('Integration flag:')).toContainText('disabled');
    await expect(page.getByText('Provider access readiness:')).toContainText('disabled or incomplete');
    await expect(page.getByText('Destination allowlist:')).toContainText('empty');
    await expect(page.getByText('Call dispatch:')).toContainText('unavailable');
    await expect(page.getByText('Pilot readiness:')).toContainText('blocked');
    const dispatchBlockers = page.getByRole('list', { name: 'CALL-E dispatch blockers' });
    await expect(dispatchBlockers.getByRole('listitem')).toHaveCount(6);
    await expect(dispatchBlockers).toContainText('Tenant scoped authorization is not implemented');
    await expect(dispatchBlockers).toContainText('Consent and opt out controls are not implemented');
    await expect(dispatchBlockers).toContainText('The durable one call pilot cap is not connected to dispatch');
    await expect(dispatchBlockers).toContainText('The durable concurrency guard is not connected to dispatch');
    const previewDisclosure = page.locator('details.va-disclosure').filter({ hasText: 'CALL-E compatibility preview' });
    await previewDisclosure.evaluate((element) => { (element as HTMLDetailsElement).open = true; });
    await expect(page.getByLabel('Destination in E.164 format')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Preview CALL-E mapping' })).toBeVisible();
    const statusDisclosure = page.locator('details.va-disclosure').filter({ hasText: 'CALL-E call status' });
    await statusDisclosure.evaluate((element) => { (element as HTMLDetailsElement).open = true; });
    const localCallId = page.getByLabel('VOICEDNUT local Call ID');
    const refreshButton = page.getByRole('button', { name: 'Refresh CALL-E status' });
    await localCallId.fill('');
    await expect(refreshButton).toBeDisabled();

    await localCallId.fill('call_e_123e4567-e89b-12d3-a456-426614174000');
    await expect(refreshButton).toBeEnabled();
    await expect(page.getByText('This never creates or cancels a call.')).toBeVisible();

    const dimensions = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      document: document.documentElement.scrollWidth,
    }));
    expect(dimensions.document, `Horizontal overflow at ${viewport.width}px`).toBeLessThanOrEqual(dimensions.viewport + 1);
  }
});
