const $ = (id) => document.getElementById(id);
// LinkedIn switches use plain names; X's carry an "x_" prefix (see classify.js).
const SWITCHES = ["enabled", "hideAds", "x_enabled", "x_hideAds"];

async function render() {
  const saved = await chrome.storage.local.get(SWITCHES);
  const { stats = { shown: 0, hidden: 0, lastError: "" } } = await chrome.storage.session.get("stats");
  for (const k of SWITCHES) $(k).checked = saved[k] ?? true;
  $("shown").textContent = stats.shown;
  $("hidden").textContent = stats.hidden;
  $("ai").textContent = stats.ai || 0;
  $("rules").textContent = stats.rules || 0;
  // Ads, popularity and hide-word fallbacks are rules; topics need the AI and a key.
  const { mode = "ai", apiKey = "" } = await chrome.storage.local.get(["mode", "apiKey"]);
  $("mode").textContent =
    mode === "keywords" ? "Mode: Keywords only. The AI is not used." : apiKey ? "Mode: AI (key saved)." : "Mode: AI, but no API key saved. Rules are used instead.";
  $("error").textContent = stats.lastError || "";
}

for (const k of SWITCHES) $(k).addEventListener("change", (e) => chrome.storage.local.set({ [k]: e.target.checked }));
$("settings").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});
chrome.storage.onChanged.addListener(render);
render();
