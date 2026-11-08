import { type Browser, expect, type Page, test } from "@playwright/test";

async function join(browser: Browser, name: string): Promise<Page> {
  const page = await (
    await browser.newContext({ viewport: { width: 900, height: 560 } })
  ).newPage();
  await page.goto("/");
  await page.locator("#lobby .room").first().waitFor();
  await page.fill("#pilot", name);
  await page.click('#lobby .room[data-id="night"]');
  await page.click("#join");
  await page.waitForFunction(() => {
    const g = window.__game;
    return g !== undefined && "shipId" in g && g.latest !== null;
  });
  return page;
}

test("two browsers: same room, roster, movement seen by the other, chat", async ({ browser }) => {
  const a = await join(browser, "Alpha");
  const b = await join(browser, "Bravo");

  // roster in both windows
  await expect(a.locator("#roster li")).toHaveCount(2);
  await expect(b.locator("#roster li")).toHaveCount(2);

  // A flies; B must observe A's ship moving within 500 ms
  const aShip = await a.evaluate(() => {
    const g = window.__game;
    if (!g || !("shipId" in g)) throw new Error("no network game");
    return g.shipId;
  });
  const seenByB = () =>
    b.evaluate((id) => {
      const g = window.__game;
      const e = g && "latest" in g ? g.latest?.entities.get(id) : undefined;
      return e ? { x: e.x, y: e.y } : null;
    }, aShip);
  const before = await seenByB();
  expect(before).not.toBeNull();
  await a.bringToFront();
  await a.keyboard.down("KeyW");
  const t0 = Date.now();
  await expect
    .poll(
      async () => {
        const now = await seenByB();
        return now && before ? Math.hypot(now.x - before.x, now.y - before.y) : 0;
      },
      { timeout: 500, intervals: [25] },
    )
    .toBeGreaterThan(1);
  await a.keyboard.up("KeyW");
  console.log(`B saw A move after ${Date.now() - t0} ms`);

  // chat reaches the other window
  await a.keyboard.press("Enter");
  await a.keyboard.type("e2e привіт");
  await a.keyboard.press("Enter");
  await expect(b.locator("#chatlog")).toContainText("Alpha: e2e привіт");
});
