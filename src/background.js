import { siteSettings, TYPESAFE_URL, buildJevRequest, classifyByKeywords, decideFromJev, engagementResult, promotedResult, showAll } from "./classify.js";

// Decisions already made this browser session, keyed by post id.
const cache = new Map();

async function getSettings(site) {
  const raw = await chrome.storage.local.get(null);
  return siteSettings(raw, site);
}

async function bumpStats(results, error) {
  const { stats = { shown: 0, hidden: 0, lastError: "" } } = await chrome.storage.session.get("stats");
  for (const r of results) {
    r.show ? stats.shown++ : stats.hidden++;
    r.byAi ? (stats.ai = (stats.ai || 0) + 1) : (stats.rules = (stats.rules || 0) + 1);
  }
  stats.lastError = error || "";
  await chrome.storage.session.set({ stats });
}

class ApiError extends Error {
  constructor(status) {
    super(`HTTP ${status}`);
    this.status = status;
  }
}

async function askJev(settings, post) {
  const res = await fetch(TYPESAFE_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${settings.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(buildJevRequest(settings, post)),
  });
  if (!res.ok) throw new ApiError(res.status);
  const data = await res.json();
  // Ads-only mode: ignore any topic answer, even if one comes back.
  if (settings.adsOnly && data?.answers) delete data.answers.show;
  return { ...decideFromJev(data, post, Number(settings.threshold), settings.hideAds), byAi: true };
}

function describeError(err) {
  if (err instanceof ApiError) {
    if (err.status === 401 || err.status === 403) return "API key is wrong";
    if (err.status === 429) return "Too many requests; try later";
    return `AI error ${err.status}`;
  }
  return "Could not reach the AI";
}

// The AI could not answer: still apply the hide words, so popular posts on a
// hidden topic are not let through. Not cached, so the AI is asked again later.
function keywordFallback(settings, post, why) {
  const r = classifyByKeywords(settings, [post])[0];
  return { ...r, reason: `${why}; ${r.reason}`, failed: true };
}

// Asks Jev about every post in parallel. Posts whose call failed are shown.
async function classifyWithJev(settings, posts) {
  const settled = await Promise.allSettled(posts.map((p) => askJev(settings, p)));
  let error = "";
  const results = settled.map((s, i) => {
    if (s.status === "fulfilled") return s.value;
    error ||= describeError(s.reason);
    return keywordFallback(settings, posts[i], error);
  });
  return { results, error };
}

export async function classify(posts, site = "linkedin") {
  const settings = await getSettings(site);
  if (!settings.enabled && !settings.hideAds) return { results: showAll(posts, "filter off"), hideStyle: settings.hideStyle };
  // Filter off but "Hide ads" on: judge ads only, never topics.
  settings.adsOnly = !settings.enabled;

  const fresh = posts.filter((p) => !cache.has(p.id));
  const decided = new Map();
  let error = "";
  if (fresh.length) {
    // Likes/comments/reposts limits are checked locally, before topics or the AI.
    const low = fresh.map((p) => engagementResult(settings, p));
    const rest = fresh.filter((_, i) => !low[i]);
    let results;
    if (settings.adsOnly && (settings.mode === "keywords" || !settings.apiKey)) {
      results = rest.map((p) => promotedResult(settings, p) || { id: p.id, show: true, reason: "filter off; not an ad" });
    } else if (settings.mode === "keywords") {
      results = classifyByKeywords(settings, rest);
    } else {
      // Promoted posts are decided locally; only the rest go to the AI.
      const ads = rest.map((p) => promotedResult(settings, p));
      const ask = rest.filter((_, i) => !ads[i]);
      let jev = { results: [], error: "" };
      if (ask.length && !settings.apiKey) {
        const msg = "No API key; open the extension settings";
        jev = { results: ask.map((p) => keywordFallback(settings, p, msg)), error: msg };
      } else if (ask.length) {
        jev = await classifyWithJev(settings, ask);
      }
      error = jev.error;
      results = [...ads.filter(Boolean), ...jev.results];
    }
    results = [...low.filter(Boolean), ...results];
    // Failed posts are not cached, so they are retried on the next load.
    for (const r of results) {
      decided.set(r.id, r);
      if (!r.failed) cache.set(r.id, r);
    }
    await bumpStats(results, error);
  }
  const out = { results: posts.map((p) => cache.get(p.id) || decided.get(p.id)), hideStyle: settings.hideStyle };
  if (error) out.error = error;
  return out;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "classify" && Array.isArray(msg.posts)) {
    classify(msg.posts, msg.site).then(sendResponse, () =>
      sendResponse({ results: showAll(msg.posts, "filter error"), error: "filter error" })
    );
    return true; // keep the channel open for the async answer
  }
  if (msg?.type === "reset") {
    cache.clear();
    chrome.storage.session.set({ stats: { shown: 0, hidden: 0, lastError: "" } }).then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});

// Settings changed: forget old decisions so the feed is re-judged.
chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === "local") cache.clear();
});

// After install or reload, open LinkedIn and X tabs still run the old content script.
// Inject the new one so the feed is re-judged without refreshing the page.
chrome.runtime.onInstalled.addListener(async () => {
  const tabs = await chrome.tabs.query({ url: ["https://www.linkedin.com/*", "https://x.com/*"] });
  for (const tab of tabs) {
    chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["content.css"] }).catch(() => {});
    chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] }).catch(() => {});
  }
});
