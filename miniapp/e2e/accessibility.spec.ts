import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test('admin dashboard meets WCAG 2.1 A/AA checks @a11y', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'VOICEDNUT' })).toBeVisible();

  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const summary = results.violations.map(({ id, impact, nodes }) => `${id} (${impact}, ${nodes.length} elements)`).join('; ');
  expect(results.violations.length, summary || 'No accessibility violations found').toBe(0);
});
