import { DEFAULT_SETTINGS, SITES, siteKey, siteSettings } from "./classify.js";

const $ = (id) => document.getElementById(id);
const SHARED = ["mode", "apiKey", "model", "threshold", "hideStyle"];
const LISTS = ["likes", "dislikes"];
const SWITCHES = ["enabled", "hideAds"];
// X page clean-up switches (X only, off by default).
const PANELS = ["x_hidePremium", "x_hideTrends", "x_hideFollow", "x_hideLive"];
const NUMBERS = ["minLikes", "minComments", "minShares"];

async function load() {
  const raw = await chrome.storage.local.get(null);
  const base = siteSettings(raw, "linkedin");
  for (const f of SHARED) $(f).value = base[f];
  for (const site of SITES) {
    const s = siteSettings(raw, site);
    for (const f of LISTS) $(siteKey(site, f)).value = s[f];
    for (const f of SWITCHES) $(siteKey(site, f)).checked = s[f];
    for (const f of NUMBERS) $(siteKey(site, f)).value = s[f];
  }
  for (const f of PANELS) $(f).checked = !!raw[f];
}

async function save() {
  const s = {};
  for (const f of SHARED) s[f] = $(f).value.trim();
  for (const site of SITES) {
    for (const f of LISTS) s[siteKey(site, f)] = $(siteKey(site, f)).value.trim();
    for (const f of SWITCHES) s[siteKey(site, f)] = $(siteKey(site, f)).checked;
    for (const f of NUMBERS) s[siteKey(site, f)] = Math.max(0, Math.floor(Number($(siteKey(site, f)).value) || 0));
  }
  for (const f of PANELS) s[f] = $(f).checked;
  const t = Number(s.threshold);
  s.threshold = Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : DEFAULT_SETTINGS.threshold;
  s.model ||= DEFAULT_SETTINGS.model;
  await chrome.storage.local.set(s);
  $("status").textContent = "Saved. Your feeds update now.";
}

for (const tab of document.querySelectorAll("[role=tab]")) {
  tab.addEventListener("click", () => {
    for (const t of document.querySelectorAll("[role=tab]")) t.setAttribute("aria-selected", t === tab);
    for (const p of document.querySelectorAll(".panel")) p.classList.toggle("active", p.dataset.tab === tab.dataset.for);
  });
}
document.querySelector(".panel").classList.add("active");
$("save").addEventListener("click", save);
load();
