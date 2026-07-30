import { test, expect } from '@playwright/test';

/**
 * Watchable smoke: host an In-Between night against three bots and actually
 * play. Exercises the create flow, the one-tap wager presets, the ace call,
 * and the middle-card reveal banner. Engine correctness lives in the Vitest
 * suite — this is the "does a real night at the table work" check.
 */
test('in-between night vs bots: create, wager with presets, see the reveal', async ({ page }) => {
  await page.goto('/');
  await page.getByPlaceholder('Your name').fill('E2E Hero');
  await page.getByRole('button', { name: /Host a game/ }).click();
  await page.getByLabel('Computer players').fill('3');

  // Leave only In-Between on the call sheet (single variant = no choosing
  // phase, so the test can't stall on a dealer pick).
  for (const label of [
    "Texas Hold'em",
    'Five-Card Draw',
    'Seven-Card Stud',
    'Three-Card Guts',
    'Baseball (No-Peek)',
  ]) {
    await page.getByLabel(label).uncheck();
  }
  await expect(page.getByLabel('In-Between')).toBeChecked();

  await page.getByRole('button', { name: 'Create table' }).click();
  await page.waitForURL(/\/game\//);
  await page.getByRole('button', { name: /Start game/ }).click();
  await expect(page.getByText('IN-BETWEEN')).toBeVisible({ timeout: 15_000 });

  // Play turns as they come for up to two minutes: call any ace high, bet
  // the pot, and confirm the outcome is announced to the table each time.
  // The table re-renders on every SSE frame and turns expire server-side, so
  // every action is best-effort with a short timeout — a missed click just
  // means the loop reads the fresh state and tries again.
  let wagers = 0;
  const deadline = Date.now() + 120_000;
  while (wagers < 3 && Date.now() < deadline) {
    // Recover if a slow turn marked the hero away.
    const imBack = page.getByRole('button', { name: "I'm back" });
    if (await imBack.isVisible().catch(() => false)) {
      await imBack.click({ timeout: 2_000 }).catch(() => {});
      continue;
    }
    // isVisible returns immediately; isEnabled would WAIT for an absent
    // element — only ask it about a button that is already on screen.
    const ace = page.getByRole('button', { name: 'High', exact: true });
    if (
      (await ace.isVisible().catch(() => false)) &&
      (await ace.isEnabled({ timeout: 500 }).catch(() => false))
    ) {
      await ace.click({ timeout: 3_000 }).catch(() => {});
      continue;
    }
    // "Pot $N" — anchored so ¼/½ Pot don't match.
    const potBet = page.getByRole('button', { name: /^Pot/ });
    if (
      (await potBet.isVisible().catch(() => false)) &&
      (await potBet.isEnabled({ timeout: 500 }).catch(() => false))
    ) {
      await potBet.click({ timeout: 3_000 }).catch(() => {});
      try {
        await page
          .getByText(/wins \$|loses \$|pays double/)
          .first()
          .waitFor({ state: 'visible', timeout: 5_000 });
        wagers++;
      } catch {
        // The click raced a turn change — nothing was wagered; try again.
      }
      continue;
    }
    await page.waitForTimeout(400);
  }
  expect(wagers, 'hero should have completed at least one announced wager').toBeGreaterThanOrEqual(1);
});
