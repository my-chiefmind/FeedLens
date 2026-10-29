// Loads the built extension into a real Chromium and checks it on fake pages.
// No real LinkedIn or TypeSafe traffic: both are answered by Playwright routes.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const DIST = path.resolve("dist");
const FEED = readFileSync("test/fixtures/feed.html", "utf8");
const XFEED = readFileSync("test/fixtures/x-feed.html", "utf8");
const POST_TEXT = (urn) => `[data-urn="${urn}"]`;

let context, worker, userDir;
const apiCalls = [];

test.before(async () => {
  userDir = mkdtempSync(path.join(tmpdir(), "lff-"));
  context = await chromium.launchPersistentContext(userDir, {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
  });
  const html = { status: 200, contentType: "text/html", body: FEED };
  await context.route("https://www.linkedin.com/**", (route) => route.fulfill(html));
  await context.route("https://x.com/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: XFEED }));
  await context.route("https://example.com/**", (route) => route.fulfill(html));
  // Fake Jev: says yes to posts about AI, no to everything else.
  await context.route("https://api.typesafe.ai/**", async (route) => {
    const req = route.request();
    const body = req.postDataJSON();
    apiCalls.push({ auth: req.headers()["authorization"], body });
    const noul = /\bAI\b/.test(body.state) ? 0.9 : 0.1;
    const answers = { show: { type: "noul", noul } };
    if (body.questions.is_ad) answers.is_ad = { type: "noul", noul: /buy|sale|free trial/i.test(body.state) ? 0.95 : 0.05 };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ model: "jev-test", answers }) });
  });
  worker = context.serviceWorkers()[0] || (await context.waitForEvent("serviceworker"));
});

test.after(async () => {
  await context?.close();
  rmSync(userDir, { recursive: true, force: true });
});

async function setSettings(s) {
  await worker.evaluate(async (s) => {
    await chrome.storage.local.clear();
    await chrome.storage.local.set(s);
    await chrome.storage.session.clear();
  }, s);
}

async function states(page) {
  return page.$$eval("[data-urn]", (els) => els.map((e) => e.dataset.lffState || "untouched"));
}

async function waitSettled(page, count = 6) {
  await page.waitForFunction(
    (n) => [...document.querySelectorAll("[data-urn]")].filter((e) => ["shown", "hidden"].includes(e.dataset.lffState)).length >= n,
    count,
    { timeout: 10000 }
  );
}

test("AI mode: shows the AI post, folds the other two on the feed", async () => {
  await setSettings({ mode: "ai", apiKey: "test-key", likes: "AI", dislikes: "politics" });
  apiCalls.length = 0;
  const page = await context.newPage();
  await page.goto("https://www.linkedin.com/feed/");
  await waitSettled(page);
  // 1004 is "Promoted" (hidden without asking the AI), 1005 reads like an ad,
  // 1006 says "Promoted to VP" but is not an ad.
  assert.deepEqual(await states(page), ["shown", "hidden", "hidden", "hidden", "hidden", "shown"]);
  assert.equal(apiCalls.length, 5);
  const stats = await worker.evaluate(async () => (await chrome.storage.session.get("stats")).stats);
  assert.equal(stats.ai, 5);
  assert.equal(stats.rules, 1); // the Promoted post
  assert.ok(apiCalls[0].body.questions.is_ad);
  assert.match(await page.locator(`${POST_TEXT("urn:li:activity:1004")} .lff-bar`).innerText(), /Ad \(Promoted\)/);
  assert.match(await page.locator(`${POST_TEXT("urn:li:activity:1005")} .lff-bar`).innerText(), /Looks like an ad/);
  assert.equal(apiCalls[0].auth, "Bearer test-key");
  assert.equal(apiCalls[0].body.questions.show.type, "noul");
  // Collapsed posts get a bar; the text itself is hidden.
  assert.equal(await page.locator(`${POST_TEXT("urn:li:activity:1002")} .lff-bar`).count(), 1);
  assert.equal(await page.locator(`${POST_TEXT("urn:li:activity:1002")} .update-components-text`).isVisible(), false);
  assert.equal(await page.locator(`${POST_TEXT("urn:li:activity:1001")} .update-components-text`).isVisible(), true);
  // "Show" brings it back.
  await page.locator(`${POST_TEXT("urn:li:activity:1002")} .lff-bar button`).click();
  assert.equal(await page.locator(`${POST_TEXT("urn:li:activity:1002")} .update-components-text`).isVisible(), true);
  await page.close();
});

test("a post that loads later (scrolling) is also judged", async () => {
  await setSettings({ mode: "keywords", likes: "AI", dislikes: "politics" });
  const page = await context.newPage();
  await page.goto("https://www.linkedin.com/feed/");
  await waitSettled(page);
  await page.evaluate(() => {
    const d = document.createElement("div");
    d.setAttribute("data-urn", "urn:li:activity:2001");
    d.innerHTML = '<div class="update-components-text">My politics rant</div>';
    document.querySelector("main").append(d);
  });
  await waitSettled(page, 7);
  assert.deepEqual(await states(page), ["shown", "hidden", "shown", "hidden", "shown", "shown", "hidden"]);
  await page.close();
});

test("remove style hides posts completely", async () => {
  await setSettings({ mode: "keywords", likes: "AI", hideStyle: "remove" });
  const page = await context.newPage();
  await page.goto("https://www.linkedin.com/feed/");
  await waitSettled(page);
  assert.equal(await page.locator(POST_TEXT("urn:li:activity:1002")).isVisible(), false);
  assert.equal(await page.locator(".lff-bar:not(.lff-ok)").count(), 0);
  await page.close();
});

test("API failure or missing key hides nothing but hide-word posts", async () => {
  await setSettings({ mode: "ai", apiKey: "", likes: "AI", dislikes: "nothing" });
  const page = await context.newPage();
  await page.goto("https://www.linkedin.com/feed/");
  await waitSettled(page);
  // Promoted ads are still hidden: that check needs no AI.
  assert.deepEqual(await states(page), ["shown", "shown", "shown", "hidden", "shown", "shown"]);
  const err = await worker.evaluate(async () => (await chrome.storage.session.get("stats")).stats.lastError);
  assert.match(err, /No API key/);
  await page.close();
});

test("does nothing on other LinkedIn pages (/jobs)", async () => {
  await setSettings({ mode: "keywords", likes: "AI" });
  const page = await context.newPage();
  await page.goto("https://www.linkedin.com/jobs/");
  await page.waitForTimeout(1500);
  assert.deepEqual(await states(page), Array(6).fill("untouched"));
  await page.close();
});

test("does nothing on non-LinkedIn sites (same page served on example.com)", async () => {
  await setSettings({ mode: "keywords", likes: "AI" });
  const page = await context.newPage();
  await page.goto("https://example.com/feed/");
  await page.waitForTimeout(1500);
  assert.deepEqual(await states(page), Array(6).fill("untouched"));
  await page.close();
});

test("hide-ads switched off keeps Promoted posts", async () => {
  await setSettings({ mode: "keywords", likes: "AI", dislikes: "politics", hideAds: false });
  const page = await context.newPage();
  await page.goto("https://www.linkedin.com/feed/");
  await waitSettled(page);
  assert.deepEqual(await states(page), ["shown", "hidden", "shown", "shown", "shown", "shown"]);
  await page.close();
});

test("filter off and hide-ads off shows everything", async () => {
  await setSettings({ enabled: false, hideAds: false, mode: "keywords", likes: "AI" });
  const page = await context.newPage();
  await page.goto("https://www.linkedin.com/feed/");
  await waitSettled(page);
  assert.deepEqual(await states(page), Array(6).fill("shown"));
  await page.close();
});

test("2026 LinkedIn markup: list-item cards are judged, Promoted ones collapse", async () => {
  await setSettings({ mode: "keywords", likes: "AI", dislikes: "politics" });
  const page = await context.newPage();
  await page.goto("https://www.linkedin.com/feed/");
  await waitSettled(page);
  await page.evaluate(() => {
    const list = document.createElement("div");
    list.setAttribute("role", "list");
    list.setAttribute("componentkey", "container-update-list_mainFeed");
    list.innerHTML = `
      <div role="listitem" componentkey="update-card-focusAAA"><p>Big Software Co</p><p><span>Promoted</span></p>
        <p data-testid="expandable-text-box">AI tools for teams</p></div>
      <div role="listitem" componentkey="update-card-focusBBB"><p>Colleague</p>
        <p data-testid="expandable-text-box">What I learned using AI in operations</p></div>`;
    document.body.append(list);
  });
  const st = (key) => page.locator(`[componentkey="${key}"]`).getAttribute("data-lff-state");
  await page.waitForFunction(() => document.querySelectorAll('[componentkey^="update-card"][data-lff-state="shown"], [componentkey^="update-card"][data-lff-state="hidden"]').length === 2);
  assert.equal(await st("update-card-focusAAA"), "hidden");
  assert.equal(await st("update-card-focusBBB"), "shown");
  assert.match(await page.locator('[componentkey="update-card-focusAAA"] .lff-bar').innerText(), /Collapsed: Ad \(Promoted\) — "AI tools for teams/);
  assert.match(await page.locator('[componentkey="update-card-focusBBB"] .lff-ok').innerText(), /Checked by feed filter/);
  await page.close();
});

test("saving new settings re-judges the open feed without a reload", async () => {
  await setSettings({ mode: "keywords", likes: "AI", dislikes: "politics" });
  const page = await context.newPage();
  await page.goto("https://www.linkedin.com/feed/");
  await waitSettled(page);
  assert.equal((await states(page))[2], "shown");
  await worker.evaluate(() => chrome.storage.local.set({ dislikes: "politics, lunch" }));
  await page.waitForFunction(() => document.querySelector('[data-urn="urn:li:activity:1003"]').dataset.lffState === "hidden", null, { timeout: 10000 });
  await page.close();
});

test("filter off but hide-ads on still hides ads, nothing else", async () => {
  await setSettings({ enabled: false, mode: "ai", apiKey: "test-key", likes: "AI", dislikes: "politics" });
  apiCalls.length = 0;
  const page = await context.newPage();
  await page.goto("https://www.linkedin.com/feed/");
  await waitSettled(page);
  // 1004 is Promoted; 1005 reads like an ad; the politics and lunch posts stay.
  assert.deepEqual(await states(page), ["shown", "shown", "shown", "hidden", "hidden", "shown"]);
  assert.equal(apiCalls[0].body.questions.show, undefined);
  await page.close();
});

test("popup has both switches and they save", async () => {
  await setSettings({});
  const id = new URL(worker.url()).host;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/popup.html`);
  assert.equal(await page.isChecked("#enabled"), true);
  assert.equal(await page.isChecked("#hideAds"), true);
  await page.uncheck("#hideAds");
  await page.waitForFunction(async () => (await chrome.storage.local.get("hideAds")).hideAds === false);
  await page.close();
});

const xStates = (page) => page.$$eval('article[data-testid="tweet"]', (els) => els.map((e) => e.dataset.lffState || "untouched"));
async function xSettled(page, n = 4) {
  await page.waitForFunction((n) => document.querySelectorAll('article[data-lff-state="shown"], article[data-lff-state="hidden"]').length >= n, n, { timeout: 10000 });
}

test("X: uses its own topic list, hides the Ad, ignores LinkedIn's lists", async () => {
  // LinkedIn hides "AI"; X hides politics. X must follow its own list.
  await setSettings({ mode: "keywords", dislikes: "AI", x_dislikes: "politics" });
  const page = await context.newPage();
  await page.goto("https://x.com/home");
  await xSettled(page);
  assert.deepEqual(await xStates(page), ["shown", "hidden", "hidden", "shown"]);
  assert.match(await page.locator("article >> nth=2").locator(".lff-bar").innerText(), /Ad/);
  await page.close();
});

test("X: minimum likes hides small posts; LinkedIn is not affected", async () => {
  await setSettings({ mode: "keywords", likes: "AI", dislikes: "politics", x_dislikes: "nothing", x_minLikes: 10 });
  const page = await context.newPage();
  await page.goto("https://x.com/home");
  await xSettled(page);
  assert.deepEqual(await xStates(page), ["shown", "shown", "hidden", "hidden"]);
  assert.match(await page.locator("article >> nth=3").locator(".lff-bar").innerText(), /Low engagement \(2 likes/);
  const li = await context.newPage();
  await li.goto("https://www.linkedin.com/feed/");
  await waitSettled(li);
  assert.deepEqual(await states(li), ["shown", "hidden", "shown", "hidden", "shown", "shown"]);
  await page.close();
  await li.close();
});

test("X: filter switched off for X only", async () => {
  await setSettings({ mode: "keywords", x_enabled: false, x_hideAds: false, x_dislikes: "politics" });
  const page = await context.newPage();
  await page.goto("https://x.com/home");
  await xSettled(page);
  assert.deepEqual(await xStates(page), Array(4).fill("shown"));
  await page.close();
});

test("settings page saves LinkedIn and X separately", async () => {
  await setSettings({});
  const id = new URL(worker.url()).host;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/options.html`);
  await page.click('[data-for="x"]');
  await page.fill("#x_dislikes", "sports");
  await page.fill("#x_minLikes", "50");
  await page.click("#save");
  await page.waitForFunction(async () => (await chrome.storage.local.get("x_minLikes")).x_minLikes === 50);
  const saved = await worker.evaluate(() => chrome.storage.local.get(null));
  assert.equal(saved.x_dislikes, "sports");
  assert.equal(saved.minLikes, 0);
  assert.notEqual(saved.dislikes, "sports");
  await page.close();
});

test("popularity is an extra rule: a popular post on a hidden topic stays hidden", async () => {
  // Pundit's politics post has 40 likes, above the minimum of 10.
  for (const mode of ["keywords", "ai"]) {
    await setSettings({ mode, apiKey: "test-key", x_likes: "AI", x_dislikes: "politics", x_minLikes: 10 });
    const page = await context.newPage();
    await page.goto("https://x.com/home");
    await xSettled(page);
    assert.deepEqual(await xStates(page), ["shown", "hidden", "hidden", "hidden"], mode);
    await page.close();
  }
  // Same with no API key: the hide words still apply.
  await setSettings({ mode: "ai", apiKey: "", x_dislikes: "politics", x_minLikes: 10 });
  const page = await context.newPage();
  await page.goto("https://x.com/home");
  await xSettled(page);
  assert.equal((await xStates(page))[1], "hidden");
  await page.close();
});

test("X: the bar sits on top of a row-layout post and survives class rewrites", async () => {
  await setSettings({ mode: "keywords", x_dislikes: "politics" });
  const page = await context.newPage();
  await page.goto("https://x.com/home");
  // X draws each post as a row (avatar | content).
  await page.addStyleTag({ content: 'article[data-testid="tweet"] { display:flex; flex-direction:row; width:600px; }' });
  await xSettled(page);
  const post = page.locator("article >> nth=1");
  // React rewrites className on re-render; the post must stay folded.
  await post.evaluate((el) => (el.className = ""));
  const bar = await post.locator(".lff-bar").boundingBox();
  const box = await post.boundingBox();
  assert.ok(bar.width > box.width * 0.9, `bar is ${bar.width}px of ${box.width}px`);
  assert.equal(await post.locator('[data-testid="tweetText"]').isVisible(), false);
  await page.close();
});

test("X: page clean-up switches hide only the chosen sidebar modules", async () => {
  await setSettings({ mode: "keywords", x_hidePremium: true, x_hideFollow: true });
  const page = await context.newPage();
  await page.goto("https://x.com/home");
  await xSettled(page);
  const visible = async (sel) => page.locator(sel).first().isVisible();
  assert.equal(await visible("#p-premium"), false);
  assert.equal(await visible("#p-follow"), false);
  assert.equal(await visible('[data-testid="UserCell"]'), false);
  assert.equal(await visible('a[href="/i/connect_people"]'), false);
  assert.equal(await visible("#p-live"), true);
  assert.equal(await visible("#p-news"), true);
  assert.equal(await visible('input[placeholder="Search"]'), true);
  // Turning trends on hides news and sports; turning follow off brings it back.
  await worker.evaluate(() => chrome.storage.local.set({ x_hideTrends: true, x_hideFollow: false }));
  await page.waitForFunction(() => getComputedStyle(document.querySelector("#p-nfl")).display === "none");
  assert.equal(await visible("#p-news"), false);
  assert.equal(await visible("#p-follow"), true);
  assert.equal(await visible("#p-live"), true);
  await page.close();
});

test("X: clean-up switches are off by default and save from the settings page", async () => {
  await setSettings({ mode: "keywords" });
  const page = await context.newPage();
  await page.goto("https://x.com/home");
  await xSettled(page);
  assert.equal(await page.locator("#p-premium").isVisible(), true);
  const id = new URL(worker.url()).host;
  const opt = await context.newPage();
  await opt.goto(`chrome-extension://${id}/options.html`);
  await opt.click('[data-for="x"]');
  await opt.click("#x_hideLive", { force: true });
  await opt.click("#save");
  await opt.waitForFunction(async () => (await chrome.storage.local.get("x_hideLive")).x_hideLive === true);
  await page.waitForFunction(() => getComputedStyle(document.querySelector("#p-live")).display === "none");
  await opt.close();
  await page.close();
});

test("X Explore: posts are judged and promoted trends hide with the ads", async () => {
  await setSettings({ mode: "keywords", x_dislikes: "politics", x_hideFollow: true });
  const page = await context.newPage();
  await page.goto("https://x.com/explore");
  await xSettled(page);
  assert.deepEqual(await xStates(page), ["shown", "hidden", "hidden", "shown"]);
  assert.equal(await page.locator("#t-paid").isVisible(), false);
  assert.equal(await page.locator("#t-free").isVisible(), true);
  await page.close();
});

test("X: account lists on a Following page are never hidden", async () => {
  await setSettings({ mode: "keywords", x_hideFollow: true });
  const page = await context.newPage();
  await page.goto("https://x.com/someone/following");
  await page.waitForTimeout(800);
  assert.equal(await page.locator('[data-testid="UserCell"]').isVisible(), true);
  await page.close();
});

test("X: promoted trends stay when hide-ads is off", async () => {
  await setSettings({ mode: "keywords", x_hideAds: false });
  const page = await context.newPage();
  await page.goto("https://x.com/explore");
  await xSettled(page);
  assert.equal(await page.locator("#t-paid").isVisible(), true);
  await page.close();
});
