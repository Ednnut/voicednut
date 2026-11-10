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
  await expect(page.getByRole('heading', { name: 'Cartesia operations' })).toBeVisible();
  await expect(page.getByText('Managed Agents', { exact: true })).toBeVisible();
  await expect(page.getByText('Disabled by server', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Review transcript and summary' })).toBeVisible();
});

test('loads Cartesia call transcript only after an explicit private-data review confirmation', async ({ page }) => {
  let acceptReview = false;
  page.on('dialog', async (dialog) => {
    expect(dialog.message()).toContain('private Cartesia transcript and summary');
    if (acceptReview) await dialog.accept();
    else await dialog.dismiss();
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/provider');
  const reviewButton = page.getByRole('button', { name: 'Review transcript and summary' });
  await reviewButton.click();
  await expect(page.getByRole('region', { name: 'Cartesia private call review' })).toHaveCount(0);
  acceptReview = true;
  await reviewButton.click();
  await expect(page.getByRole('region', { name: 'Cartesia private call review' })).toBeVisible();
  await expect(page.getByText('Fixture summary: the caller requested a follow-up.')).toBeVisible();
  await expect(page.getByText('Please call me tomorrow.')).toBeVisible();
  await page.getByRole('button', { name: 'Refresh Cartesia status' }).click();
  const audit = page.getByRole('list', { name: 'Cartesia private call review audit events' });
  await expect(audit).toBeVisible();
  await expect(audit).toContainText('call_fixture_001');
  await expect(audit).toContainText('Operator 12345');
  await expect(audit).not.toContainText('Please call me tomorrow.');
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
  }));
  expect(dimensions.document, 'Cartesia private review should not overflow at mobile width').toBeLessThanOrEqual(dimensions.viewport + 1);
});

test('loads business-scoped Cartesia history for a selected business', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/provider');
  await page.getByLabel('Business ID for scoped Cartesia call history').fill('fixture-business');
  await page.getByRole('button', { name: 'Load business call history' }).click();
  await expect(page.getByText('Business-scoped history for fixture-business.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Review transcript and summary' })).toBeVisible();
  let approved = false;
  page.once('dialog', async (dialog) => {
    approved = true;
    await dialog.accept();
  });
  await page.getByRole('button', { name: 'Review transcript and summary' }).click();
  await expect(page.getByRole('region', { name: 'Cartesia private call review' })).toBeVisible();
  expect(approved).toBe(true);
});

test('previews and confirms a Cartesia inbound agent assignment with fixture-only requests', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/provider');
  await page.getByLabel('Cartesia phone number for assignment').selectOption('pn_fixture_01');
  await page.getByLabel('Target Cartesia agent ID').fill('agent_fixture_next');
  await page.getByRole('button', { name: 'Preview assignment' }).click();
  const preview = page.getByRole('region', { name: 'Cartesia phone assignment preview' });
  await expect(preview).toBeVisible();
  await expect(preview).toContainText('agent_fixture_01 → agent_fixture_next');
  page.once('dialog', async (dialog) => {
    expect(dialog.message()).toContain('Change inbound routing');
    expect(dialog.message()).toContain('agent_fixture_01');
    expect(dialog.message()).toContain('agent_fixture_next');
    await dialog.accept();
  });
  await preview.getByRole('button', { name: 'Confirm inbound assignment' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Cartesia confirmed the phone assignment.' })).toBeVisible();
  await page.getByRole('button', { name: 'Refresh Cartesia status' }).click();
  await expect(page.getByRole('list', { name: 'Cartesia phone number inventory' }).getByRole('listitem')).toContainText('Updated fixture agent');
  const audit = page.getByRole('list', { name: 'Cartesia admin action audit events' });
  await expect(audit).toBeVisible();
  await expect(audit).toContainText('succeeded');
  await expect(audit).toContainText('agent_fixture_next');
  await expect(audit).toContainText('Operator 12345');
  await expect(audit).not.toContainText('+15555550123');
  const phoneAudit = page.getByRole('region', { name: 'Cartesia phone-number operation audit' });
  await expect(phoneAudit).toBeVisible();
  await expect(phoneAudit).toContainText('shared admin token cannot identify an individual operator');
  await expect(phoneAudit).toContainText('No Cartesia phone-number operation events have been recorded.');
  const providerAudit = page.getByRole('region', { name: 'Cartesia provider operation audit' });
  await expect(providerAudit).toBeVisible();
  await expect(providerAudit).toContainText('No Cartesia provider operation events have been recorded.');
  const callAudit = page.getByRole('region', { name: 'Cartesia call operation audit' });
  await expect(callAudit).toBeVisible();
  await expect(callAudit).toContainText('No Cartesia call operation events have been recorded.');
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
  }));
  expect(dimensions.document, 'Cartesia assignment controls should not overflow at mobile width').toBeLessThanOrEqual(dimensions.viewport + 1);
});

test('configures Cartesia as an explicit draft agent runtime with a validated hosted agent ID', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/content');
  await expect(page.locator('#va-view-stage-root').getByRole('heading', { name: 'AI Agent Studio' })).toBeVisible();
  await page.getByRole('button', { name: 'Refresh Scripts' }).click();
  const agentRow = page.locator('li').filter({ hasText: 'Welcome Script' });
  await agentRow.getByRole('button', { name: 'Select' }).click();
  await page.getByLabel('Voice agent runtime').selectOption('cartesia_line');
  await expect(page.getByLabel('Cartesia hosted agent ID')).toBeVisible();
  await expect(page.getByText(/runs only for a live script when both server gates are enabled/i)).toBeVisible();
  await page.getByLabel('Cartesia hosted agent ID').fill('agent_bad');
  await page.getByRole('button', { name: 'Save Draft' }).click();
  await expect(page.getByText('Enter a valid Cartesia hosted agent ID before saving.')).toBeVisible();
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
  }));
  expect(dimensions.document, 'Cartesia runtime editor should not overflow at mobile width').toBeLessThanOrEqual(dimensions.viewport + 1);
});

test('builds and approves a business-scoped post-call workflow in local fixtures', async ({ page }) => {
  let confirmation = '';
  page.on('dialog', async (dialog) => {
    confirmation = dialog.message();
    await dialog.accept();
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/content');
  await expect(page.getByRole('heading', { name: 'Post-call workflow builder' })).toBeVisible();
  await page.getByLabel('Business ID').fill('qa-business');
  await page.getByRole('button', { name: 'Load business workflows' }).click();
  await expect(page.getByText('No versions yet. Create a draft to begin.')).toBeVisible();

  await page.getByLabel('Workflow ID').fill('qa_follow_up');
  await page.getByLabel('Name', { exact: true }).fill('QA follow-up');
  await page.getByLabel('Trigger event').fill('post_call_completed');
  await page.getByLabel('Step 1 type').selectOption('action');
  await page.getByLabel('Step 1 action').selectOption('send_email');
  await page.getByLabel('Email text').fill('Thank you for your time.');
  await page.getByRole('button', { name: 'Save draft version' }).click();
  await expect(page.getByText(/Draft version 1 saved/)).toBeVisible();
  await expect(page.getByLabel('Workflow version')).toContainText('draft');
  await page.getByRole('button', { name: 'Approve selected draft' }).click();
  expect(confirmation).toContain('Matching post_call_completed events can then run its email, CRM, or ticket actions.');
  await expect(page.getByText('Workflow version approved. Matching events may now start it.')).toBeVisible();
  await expect(page.getByText('approved · v1')).toBeVisible();
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
  }));
  expect(dimensions.document, 'Workflow editor should not overflow at mobile width').toBeLessThanOrEqual(dimensions.viewport + 1);
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

test('platform admin can save workflow drafts and review sanitized run metadata from fixtures', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?fixtureRole=operator#/workflows');
  await expect(page.getByRole('heading', { name: 'Post-call workflows' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Workflow Builder' })).toHaveCount(0);

  await page.goto('/?fixtureRole=admin#/workflows');
  await expect(page.locator('#va-view-stage-root').getByRole('heading', { name: 'Post-call workflows' })).toBeVisible();
  await expect(page.getByText('Fixture post-call review')).toBeVisible();
  await expect(page.getByRole('list', { name: 'Recent workflow runs' })).toContainText('workflow_run_fixture_001');

  await page.getByLabel('Workflow ID').fill('browser_fixture_workflow');
  await page.getByLabel('Workflow name').fill('Browser fixture workflow');
  await page.getByLabel('Trigger').selectOption('call_e_result_ready');
  await expect(page.getByLabel('Business ID')).toBeVisible();
  await page.getByLabel('Business ID').fill('fixture_business');
  await expect(page.getByLabel('New step type').locator('option[value="action"]')).toBeDisabled();
  await expect(page.getByText('Raw values are never stored.')).toBeVisible();
  await page.getByRole('button', { name: 'Add classification' }).click();
  await page.getByLabel('Template ID').fill('42');
  await page.getByLabel('Template version').fill('3');
  await page.getByLabel('Classification ID').fill('lead_status');
  await page.getByLabel('Result field').fill('qualification');
  await page.getByLabel('Enum option index').fill('1');
  await page.getByLabel('Outcome label').selectOption('positive');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Draft saved:' })).toBeVisible();
  await page.getByLabel('Trigger').selectOption('post_call_completed');
  await expect(page.getByRole('group', { name: 'CALL-E result classifications' })).toHaveCount(0);
  await page.getByLabel('New step type').selectOption('wait');
  await page.getByRole('button', { name: 'Add step' }).click();
  await expect(page.getByRole('list', { name: 'Workflow steps' })).toContainText('wait');
  await page.getByLabel('Wait seconds').fill('15');
  const saveButton = page.getByRole('button', { name: 'Save draft' });
  await saveButton.focus();
  await expect(saveButton).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status').filter({ hasText: 'Draft saved:' })).toBeVisible();
  await expect(page.getByText('Browser fixture workflow')).toBeVisible();

  await page.getByRole('button', { name: 'Inspect run workflow_run_fixture_001' }).click();
  await expect(page.getByRole('heading', { name: 'Step audit' })).toBeVisible();
  await expect(page.getByRole('list').filter({ hasText: 'send_followup' })).toContainText('provider_timeout');
  await expect(page.getByText(/FIXTURE_PRIVATE_(TRIGGER_PAYLOAD|ACTION_RESULT)_MUST_NOT_RENDER/)).toHaveCount(0);

  for (const viewport of [
    { width: 390, height: 844 },
    { width: 768, height: 1024 },
    { width: 1280, height: 800 },
  ]) {
    await page.setViewportSize(viewport);
    const dimensions = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      document: document.documentElement.scrollWidth,
    }));
    expect(dimensions.document, `Horizontal overflow at ${viewport.width}px`).toBeLessThanOrEqual(dimensions.viewport + 1);
  }
});

test('saves and reviews a masked CALL-E campaign report without dispatching calls', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?fixtureCallEReady=1#/content');
  await page.getByRole('button', { name: 'Refresh Scripts' }).click();
  const liveFixture = page.locator('li').filter({ hasText: 'CALL-E QA Fixture' });
  await liveFixture.getByRole('button', { name: 'Select' }).click();

  const rehearsal = page.getByRole('region', { name: 'CALL-E campaign rehearsal' });
  await expect(rehearsal.getByText('Preview checks template compatibility only')).toBeVisible();
  await expect(rehearsal).toContainText('does not verify consent, reserve calls, or place calls');
  const destinations = rehearsal.getByLabel('Destinations (E.164; one per line)');
  await destinations.fill('+14155550123\n+442079460123');
  const runButton = rehearsal.getByRole('button', { name: 'Run compatibility previews' });
  await expect(runButton).toBeDisabled();
  await rehearsal.getByLabel('I confirm that I am authorized to contact every destination entered above.').check();
  await expect(runButton).toBeEnabled();
  await runButton.click();

  const results = rehearsal.getByRole('region', { name: 'Simulated CALL-E readiness results' });
  await expect(results.getByRole('listitem')).toHaveCount(2);
  await expect(results).toContainText('2 compatible · 0 blocked');
  await expect(results).toContainText('••••0123');
  await expect(results).not.toContainText('+14155550123');
  await expect(results).not.toContainText('+442079460123');
  await expect(results).toContainText('(not saved)');
  await results.getByRole('button', { name: 'Save durable review draft' }).click();
  await expect(rehearsal.getByRole('heading', { name: 'Saved review report' })).toBeVisible();
  await expect(rehearsal).toContainText('Durable review draft saved. The server stored masked destinations only; this is not a dispatch queue.');
  await expect(rehearsal).toContainText('Status: draft · 2 compatible · 0 blocked');
  await results.getByRole('button', { name: 'Refresh review queue' }).click();
  const reviewQueue = rehearsal.getByRole('region', { name: 'CALL-E campaign review queue' });
  await expect(reviewQueue).toContainText('draft');
  await reviewQueue.getByRole('button', { name: 'View masked review rows' }).click();
  const reviewRows = rehearsal.getByRole('region', { name: 'CALL-E campaign review recipients' });
  await expect(reviewRows.getByRole('listitem')).toHaveCount(2);
  await expect(reviewRows).not.toContainText('+14155550123');
  await expect(reviewRows).not.toContainText('+442079460123');
  await reviewQueue.getByRole('button', { name: 'Approve review report' }).click();
  await expect(reviewQueue).toContainText('approved');
  await expect(rehearsal).toContainText('This records a review decision only and does not dispatch calls.');
  await expect(rehearsal.getByRole('button', { name: /dispatch/i })).toHaveCount(0);

  const mobileDimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
  }));
  expect(mobileDimensions.document).toBeLessThanOrEqual(mobileDimensions.viewport + 1);

  await page.setViewportSize({ width: 1280, height: 800 });
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
  }));
  expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport + 1);
});
