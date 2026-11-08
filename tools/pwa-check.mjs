// Lab 8: is the production build installable? Chrome's own check (no errors = installable).
import { spawn } from "node:child_process";
import fs from "node:fs";
import { chromium } from "playwright-core";

const PORT = 8096;
const server = spawn(process.execPath, ["server/src/index.ts"], {
  env: { ...process.env, PORT: String(PORT), LOG_LEVEL: "warn" },
  stdio: "ignore",
});
for (let i = 0; i < 100; i++) {
  if (
    await fetch(`http://localhost:${PORT}/health`)
      .then((r) => r.ok)
      .catch(() => false)
  )
    break;
  await new Promise((r) => setTimeout(r, 100));
}
// a persistent (non-incognito) profile: Chrome never offers installation in incognito
const profile = fs.mkdtempSync(`${process.env.TEMP ?? "/tmp"}/skyduel-pwa-`);
const browser = await chromium.launchPersistentContext(profile, {
  channel: "chrome",
  args: ["--mute-audio"],
});
const page = browser.pages()[0] ?? (await browser.newPage());
await page.goto(`http://localhost:${PORT}/`);
await page.evaluate(() => navigator.serviceWorker.ready.then(() => true)); // wait until active
await page.reload(); // the second load is controlled by the service worker
await page.waitForTimeout(1000);
const cdp = await browser.newCDPSession(page);
const { installabilityErrors } = await cdp.send("Page.getInstallabilityErrors");
const manifest = await cdp.send("Page.getAppManifest");
const sw = await page.evaluate(() =>
  navigator.serviceWorker.controller
    ? `controlling: ${navigator.serviceWorker.controller.scriptURL}`
    : "not controlling",
);
const reg = await page.evaluate(async () => {
  const r = await navigator.serviceWorker.getRegistration();
  return r
    ? {
        scope: r.scope,
        active: r.active?.state ?? null,
        waiting: r.waiting?.state ?? null,
        installing: r.installing?.state ?? null,
      }
    : null;
});
const result = {
  registration: reg,
  installabilityErrors,
  manifestErrors: manifest.errors,
  manifestUrl: manifest.url,
  serviceWorker: sw,
};
fs.mkdirSync("docs/lab08", { recursive: true });
fs.writeFileSync("docs/lab08/pwa.json", JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
await browser.close();
server.kill();
