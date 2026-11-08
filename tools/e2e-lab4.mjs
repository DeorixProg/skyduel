// Lab 4 demo: two browser windows join one room and chat. Server must run on :8080.
import fs from "node:fs";
import { chromium } from "playwright-core";

const OUT = "docs/lab04";
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.launch({ channel: "chrome", headless: false });

async function player(name) {
  const ctx = await browser.newContext({ viewport: { width: 960, height: 600 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log(name, "PAGEERROR", e.message));
  await page.goto("http://localhost:8080/");
  await page.waitForSelector("#lobby .room");
  await page.fill("#pilot", name);
  await page.click('#lobby .room[data-id="somme"]');
  await page.click("#join");
  await page.waitForSelector("#roster li");
  return page;
}

const a = await player("Maksym");
const b = await player("Sofiia");
await sleep(500);
await a.keyboard.press("Enter");
await a.keyboard.type("Привіт! Летимо над Соммою?");
await a.keyboard.press("Enter");
await sleep(300);
await b.keyboard.press("Enter");
await b.keyboard.type("Так, я праворуч від хмари ✈");
await b.keyboard.press("Enter");
await sleep(800);
const rosterA = await a.locator("#roster li").allTextContents();
const chatB = await b.locator("#chatlog p").allTextContents();
console.log(JSON.stringify({ rosterA, chatB }, null, 1));
await a.screenshot({ path: `${OUT}/window-a.png` });
await b.screenshot({ path: `${OUT}/window-b.png` });
await browser.close();
