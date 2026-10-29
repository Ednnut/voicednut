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
    await expect(page.locator('#va-view-stage-root').getByRole('heading', { name: 'AI Agent Studio' })).toBeVisible();
    const deploymentDisclosure = page.locator('details.va-disclosure').filter({ hasText: 'CALL-E deployment status' });
    await deploymentDisclosure.evaluate((element) => { (element as HTMLDetailsElement).open = true; });
    await expect(page.getByRole('heading', { name: 'Dispatch gated' })).toBeVisible();
    await expect(page.getByText('Dispatch requires both server switches, an unexpired approval for one exact preview, operator confirmation, consent, and an allowlisted destination.')).toBeVisible();
    await page.getByRole('button', { name: 'Refresh CALL-E availability' }).click();
    await expect(page.getByText('Integration flag:')).toContainText('disabled');
    await expect(page.getByText('Provider access readiness:')).toContainText('disabled or incomplete');
    await expect(page.getByText('Destination allowlist:')).toContainText('empty');
    await expect(page.getByText('Call dispatch:')).toContainText('unavailable');
    await expect(page.getByText('Pilot readiness:')).toContainText('blocked');
    const dispatchBlockers = page.getByRole('list', { name: 'CALL-E dispatch blockers' });
    await expect(dispatchBlockers.getByRole('listitem')).toHaveCount(3);
    await expect(dispatchBlockers).toContainText('The independent dispatch kill switch is disabled');
    await expect(dispatchBlockers).toContainText('No current approval is configured for this exact preview');
    await expect(dispatchBlockers).toContainText('Account, destination, consent, and recovery reviews have not been attested');
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
    await expect(statusDisclosure).toContainText('cannot hang up an active call.');

    const dimensions = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      document: document.documentElement.scrollWidth,
    }));
    expect(dimensions.document, `Horizontal overflow at ${viewport.width}px`).toBeLessThanOrEqual(dimensions.viewport + 1);
  }
});

test('rehearses CALL-E preview, confirmation, dispatch and reconciliation with local fixtures only', async ({ page }) => {
  let lastDialogMessage = '';
  page.on('dialog', async (dialog) => {
    lastDialogMessage = dialog.message();
    await dialog.accept();
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?fixtureCallEReady=1#/content');
  await expect(page.locator('#va-view-stage-root').getByRole('heading', { name: 'AI Agent Studio' })).toBeVisible();
  await page.getByRole('button', { name: 'Refresh Scripts' }).click();

  const liveFixture = page.locator('li').filter({ hasText: 'CALL-E QA Fixture' });
  await expect(liveFixture).toBeVisible();
  await liveFixture.getByRole('button', { name: 'Select' }).click();

  const statusDisclosure = page.locator('details.va-disclosure').filter({ hasText: 'CALL-E deployment status' });
  await statusDisclosure.evaluate((element) => { (element as HTMLDetailsElement).open = true; });
  await page.getByRole('button', { name: 'Refresh CALL-E availability' }).click();
  await expect(page.getByText('Call dispatch:')).toContainText('available');

  const previewDisclosure = page.locator('details.va-disclosure').filter({ hasText: 'CALL-E compatibility preview' });
  await previewDisclosure.evaluate((element) => { (element as HTMLDetailsElement).open = true; });
  await page.getByLabel('Destination in E.164 format').fill('+14155550123');
  await page.getByRole('button', { name: 'Preview CALL-E mapping' }).click();
  await expect(page.getByText(/Preview destination: \+1••••••0123/)).toBeVisible();

  await page.getByRole('button', { name: 'Confirm this preview' }).click();
  await expect(page.getByRole('heading', { name: 'Operator confirmation recorded' })).toBeVisible();
  await page.getByRole('button', { name: 'Place approved pilot call' }).click();
  await expect(page.getByLabel('VOICEDNUT local Call ID')).toHaveValue('call_e_123e4567-e89b-12d3-a456-426614174000');

  const reconciliationDisclosure = page.locator('details.va-disclosure').filter({ hasText: 'CALL-E call status' });
  await reconciliationDisclosure.evaluate((element) => { (element as HTMLDetailsElement).open = true; });
  await page.getByRole('button', { name: 'Refresh CALL-E status' }).click();
  await expect(page.getByText('Result:')).toContainText('available');
  await expect(page.getByText('Structured result available: yes. Transcript and result content require a separate review action.')).toBeVisible();
  await page.getByRole('button', { name: 'Review CALL-E result and transcript' }).click();
  expect(lastDialogMessage).toContain('loads private transcript and result content');
  await expect(page.getByRole('region', { name: 'CALL-E private call review' })).toContainText('Synthetic fixture transcript.');
  await expect(page.getByRole('region', { name: 'CALL-E private call review' })).toContainText('completed');

  const queuedLocalCallId = 'call_e_123e4567-e89b-12d3-a456-426614174002';
  await page.getByLabel('VOICEDNUT local Call ID').fill(queuedLocalCallId);
  await page.getByRole('button', { name: 'Refresh CALL-E status' }).click();
  await expect(page.getByText('Execution:')).toContainText('queued');
  await page.getByRole('button', { name: 'Cancel queued CALL-E call' }).click();
  expect(lastDialogMessage).toContain('This cannot hang up an active call.');
  await expect(page.getByText('Execution:')).toContainText('canceled');

  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 800 });
    const dimensions = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      document: document.documentElement.scrollWidth,
    }));
    expect(dimensions.document, `Horizontal overflow at ${width}px`).toBeLessThanOrEqual(dimensions.viewport + 1);
  }
});

test('keeps CALL-E dispatch disabled when server readiness gates are closed', async ({ page }) => {
  await page.goto('/#/content');
  await expect(page.locator('#va-view-stage-root').getByRole('heading', { name: 'AI Agent Studio' })).toBeVisible();
  await page.getByRole('button', { name: 'Refresh Scripts' }).click();
  const liveFixture = page.locator('li').filter({ hasText: 'CALL-E QA Fixture' });
  await liveFixture.getByRole('button', { name: 'Select' }).click();
  const statusDisclosure = page.locator('details.va-disclosure').filter({ hasText: 'CALL-E deployment status' });
  await statusDisclosure.evaluate((element) => { (element as HTMLDetailsElement).open = true; });
  await page.getByRole('button', { name: 'Refresh CALL-E availability' }).click();
  const previewDisclosure = page.locator('details.va-disclosure').filter({ hasText: 'CALL-E compatibility preview' });
  await previewDisclosure.evaluate((element) => { (element as HTMLDetailsElement).open = true; });
  await page.getByLabel('Destination in E.164 format').fill('+14155550123');
  await page.getByRole('button', { name: 'Preview CALL-E mapping' }).click();
  await page.getByRole('button', { name: 'Confirm this preview' }).click();
  await expect(page.getByRole('button', { name: 'Place approved pilot call' })).toBeDisabled();
});

test('opens the Agent Studio version history and confirms restoring a saved version as a draft', async ({ page }) => {
  let restoreConfirmation = '';
  page.on('dialog', async (dialog) => {
    restoreConfirmation = dialog.message();
    await dialog.accept();
  });
  await page.goto('/?fixtureCallEReady=1#/content');
  await expect(page.locator('#va-view-stage-root').getByRole('heading', { name: 'AI Agent Studio' })).toBeVisible();
  await page.getByRole('button', { name: 'Refresh Scripts' }).click();
  const agentRow = page.locator('li').filter({ hasText: 'Welcome Script' });
  await agentRow.getByRole('button', { name: 'Select' }).click();
  const runtimeConfig = page.getByLabel('Agent runtime configuration JSON');
  await expect(runtimeConfig).toBeVisible();
  const speechVoice = page.getByLabel('Deepgram speech voice');
  await expect(speechVoice).toBeVisible();
  await expect(speechVoice).toContainText('aura-2-andromeda-en · balanced');
  const voiceOverride = page.getByLabel('Override Deepgram Voice Agent settings for this script');
  await speechVoice.selectOption('');
  await voiceOverride.check();
  await expect(speechVoice).toHaveValue('aura-2-andromeda-en');
  const agentLanguage = page.getByLabel('Agent language');
  const listenModel = page.getByLabel('Speech recognition model');
  const thinkModel = page.getByLabel('Reasoning model');
  await expect(agentLanguage).toBeEnabled();
  await agentLanguage.selectOption('es');
  await expect(speechVoice).toHaveValue('aura-2-celeste-es');
  await expect(listenModel).toHaveValue('flux-general-multi');
  await expect(thinkModel).toContainText('Gemini 2.5 Flash');
  await agentLanguage.selectOption('en');
  await expect(speechVoice).toHaveValue('aura-2-andromeda-en');
  await expect(listenModel).toHaveValue('flux-general-multi');
  await voiceOverride.uncheck();
  await expect(page.getByText(/tool failure policy can keep the agent running or end the active call/i)).toBeVisible();
  await runtimeConfig.fill('{');
  await page.getByRole('button', { name: 'Save Draft' }).click();
  await expect(page.getByText('Agent runtime configuration must be valid JSON.')).toBeVisible();
  await runtimeConfig.fill('');
  const mockPreview = page.locator('details.va-disclosure').filter({ hasText: 'Simulation preview' });
  await mockPreview.evaluate((element) => { (element as HTMLDetailsElement).open = true; });
  await page.getByLabel('Mock template variable values').fill('{"customer_name":"Ada"}');
  await page.getByRole('button', { name: 'Run Simulation' }).click();
  await expect(mockPreview).toContainText('Hello Ada, this is the fixture flow.');
  await expect(mockPreview).toContainText('Required variables: customer_name.');
  const versionDisclosure = page.locator('details.va-disclosure').filter({ hasText: 'Agent definition versions' });
  await versionDisclosure.evaluate((element) => { (element as HTMLDetailsElement).open = true; });
  await page.getByRole('button', { name: 'Load version history' }).click();
  const history = page.getByRole('list', { name: 'Agent definition version history' });
  await expect(history).toContainText('Version 2');
  await expect(history).toContainText('Version 1');
  await page.getByRole('button', { name: 'Compare versions' }).click();
  const comparison = page.getByRole('region', { name: 'Version comparison results' });
  await expect(comparison).toContainText('prompt');
  await expect(comparison).toContainText('You are a helpful assistant for {customer_name}.');
  await expect(comparison).toContainText('You are a helpful support assistant for {customer_name}.');
  await page.getByLabel('Compare to version').selectOption('2');
  await expect(page.getByRole('button', { name: 'Compare versions' })).toBeDisabled();
  await page.getByLabel('Compare to version').selectOption('1');
  await page.getByLabel('Version to restore').selectOption('1');
  await page.getByRole('button', { name: 'Restore as draft' }).click();
  expect(restoreConfirmation).toContain('Restore agent definition version 1 as a new draft');
  await expect(page.getByRole('heading', { name: 'Draft version restored' })).toBeVisible();
  await expect(history).toContainText('Version 3');
});

test('shows business-scoped CALL-E operations history and gated detail review from local fixtures', async ({ page }) => {
  let reviewConfirmation = '';
  page.on('dialog', async (dialog) => {
    reviewConfirmation = dialog.message();
    await dialog.accept();
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?fixtureCallEReady=1#/calllog');
  await expect(page.locator('#va-view-stage-root').getByRole('heading', { name: 'Call Log Explorer' })).toBeVisible();
  await page.getByRole('button', { name: 'Load CALL-E calls' }).click();
  await expect(page.getByRole('list', { name: 'CALL-E call history' })).toContainText('call_e_123e4567-e89b-12d3-a456-426614174000');
  await expect(page.getByText('Results ready')).toBeVisible();
  await page.getByRole('button', { name: 'Refresh status and timeline' }).click();
  await expect(page.getByRole('list', { name: 'CALL-E status timeline' })).toContainText('call.completed');
  await page.getByRole('button', { name: 'Review transcript and result' }).click();
  expect(reviewConfirmation).toContain('private CALL-E transcript and result content');
  await expect(page.getByRole('region', { name: 'CALL-E private call review' })).toContainText('Synthetic fixture transcript.');

  await page.getByLabel('Filter by execution status').selectOption('failed');
  await page.getByRole('button', { name: 'Load CALL-E calls' }).click();
  await expect(page.getByRole('list', { name: 'CALL-E call history' })).toContainText('call_e_123e4567-e89b-12d3-a456-426614174001');
  await expect(page.getByRole('list', { name: 'CALL-E call history' })).not.toContainText('call_e_123e4567-e89b-12d3-a456-426614174000');

  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 800 });
    const dimensions = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      document: document.documentElement.scrollWidth,
    }));
    expect(dimensions.document, `Horizontal overflow at ${width}px`).toBeLessThanOrEqual(dimensions.viewport + 1);
  }
});
