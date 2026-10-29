// Pure decision logic shared by the background worker and the unit tests.
// No chrome.* or network calls here.

export const DEFAULT_SETTINGS = {
  enabled: true,
  mode: "ai", // "ai" (TypeSafe Jev) | "keywords"
  apiKey: "",
  model: "jev-latest",
  likes: [
    "AI in operations",
    "AI agents and automation",
    "process improvement",
    "operations leadership",
    "engineering leadership",
    "engineering and technical services firms",
    "fractional COO / CTO",
    "job openings for operations or engineering leaders",
    "lessons learned from real projects",
  ].join("\n"),
  dislikes: [
    "ads and sponsored posts",
    "sales pitch",
    "free trial",
    "discount",
    "limited time offer",
    "DM me",
    "link in comments",
    "book a demo",
    "sign up for my webinar",
    "buy my course",
    "politics",
    "crypto",
  ].join("\n"),
  hideAds: true, // hide "Promoted" posts and posts that read like ads
  threshold: 0.5, // show a post when Jev's "yes" probability is at least this
  hideStyle: "collapse", // "collapse" | "remove"
  // Hide posts with fewer likes, comments or reposts than this. 0 = no limit.
  minLikes: 0,
  minComments: 0,
  minShares: 0,
};

export const ENGAGEMENT = [
  ["minLikes", "likes"],
  ["minComments", "comments"],
  ["minShares", "reposts"],
];

export const MAX_POST_CHARS = 1500;
// Jev must be this sure before a post is hidden as an ad; lower values caught
// job openings and announcements on the real feed.
export const AD_CUTOFF = 0.85;
export const TYPESAFE_URL = "https://api.typesafe.ai/v1/systemone";

export function normalizeSettings(raw) {
  const s = { ...DEFAULT_SETTINGS, ...(raw || {}) };
  // An empty list means "not set yet": use the starter list.
  if (!String(s.likes).trim()) s.likes = DEFAULT_SETTINGS.likes;
  if (!String(s.dislikes).trim()) s.dislikes = DEFAULT_SETTINGS.dislikes;
  return s;
}

// Each site keeps its own lists and switches; X's are stored with an "x_" prefix.
// LinkedIn keeps the plain names so settings saved by older versions still apply.
export const SITES = ["linkedin", "x"];
export const SITE_KEYS = ["likes", "dislikes", "enabled", "hideAds", "minLikes", "minComments", "minShares"];
export const siteKey = (site, key) => (site === "x" ? `x_${key}` : key);

export function siteSettings(raw, site = "linkedin") {
  const r = { ...(raw || {}) };
  if (site !== "linkedin") {
    for (const k of SITE_KEYS) {
      delete r[k];
      if (r[siteKey(site, k)] !== undefined) r[k] = r[siteKey(site, k)];
    }
  }
  return normalizeSettings(r);
}

// Splits a free-text list ("AI, operations\nhiring") into lowercase terms.
export function splitTerms(text) {
  return String(text || "")
    .split(/[\n,;]+/)
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
}

export function clipText(text) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  return clean.length > MAX_POST_CHARS ? clean.slice(0, MAX_POST_CHARS) + "…" : clean;
}

// Free, offline mode: a post is hidden only when it contains a hidden term.
export function classifyByKeywords(settings, posts) {
  const likes = splitTerms(settings.likes);
  const dislikes = splitTerms(settings.dislikes);
  return posts.map((p) => {
    const ad = promotedResult(settings, p);
    if (ad) return ad;
    const hay = `${p.author || ""} ${p.text || ""}`.toLowerCase();
    const bad = dislikes.find((t) => hay.includes(t));
    if (bad) return { id: p.id, show: false, reason: `matches hide word "${bad}"` };
    const good = likes.find((t) => hay.includes(t));
    if (good) return { id: p.id, show: true, reason: `matches like word "${good}"` };
    return { id: p.id, show: true, reason: "no hide word found" };
  });
}

// One TypeSafe System One request per post: the post is the state, and one
// "noul" question asks whether the owner would want to see it.
export function buildJevRequest(settings, post) {
  const likes = splitTerms(settings.likes).join(", ") || "nothing listed";
  const dislikes = splitTerms(settings.dislikes).join(", ") || "nothing listed";
  return {
    model: settings.model || DEFAULT_SETTINGS.model,
    state: `Author: ${clipText(post.author)}\nPost: ${clipText(post.text)}`,
    questions: {
      ...(settings.adsOnly ? {} : { show: {
        type: "noul",
        instructions: "The reader would want to see this LinkedIn post in their feed",
        criteria: {
          true: `The post is about something the reader likes (${likes}), or is an ordinary post that is not mainly about anything they want hidden`,
          false: `The post is mainly about something the reader wants hidden: ${dislikes}`,
        },
      } }),
      ...(settings.hideAds
        ? {
            is_ad: {
              type: "noul",
              instructions: "This LinkedIn post is a paid advertisement or a hard sales pitch aimed at the reader",
              criteria: {
                true: "Its main purpose is to make the reader buy something, start a trial, claim a discount or book a sales call",
                false: "It is a job opening, a product, research or open-source announcement, news, an event, an opinion, a personal story or learning, even if it mentions a company or a link",
              },
            },
          }
        : {}),
    },
  };
}

// LinkedIn marks paid posts "Promoted" and X marks them "Ad"; these are hidden without asking the AI.
// "1,234" / "1.2K" / "3M" -> number; anything else -> null (unknown).
export function parseCount(text) {
  const m = String(text ?? "").trim().replace(/,/g, "").match(/^(\d+(?:\.\d+)?)\s*([KkMm])?/);
  if (!m) return null;
  const mult = { k: 1e3, m: 1e6 }[(m[2] || "").toLowerCase()] || 1;
  return Math.round(Number(m[1]) * mult);
}

// Hides a post below the minimum likes/comments/reposts. Unknown counts never hide.
export function engagementResult(settings, post) {
  if (settings.adsOnly || (settings.hideAds && post.promoted)) return null;
  const counts = post.counts || {};
  for (const [key, name] of ENGAGEMENT) {
    const min = Number(settings[key]) || 0;
    const n = counts[name];
    if (min > 0 && typeof n === "number" && n < min) {
      return { id: post.id, show: false, reason: `Low engagement (${n} ${name}, you want ${min}+)` };
    }
  }
  return null;
}

export function promotedResult(settings, post) {
  return settings.hideAds && post.promoted ? { id: post.id, show: false, reason: "Ad (Promoted)" } : null;
}

// Turns a TypeSafe answer into a show/hide decision. A missing or odd answer
// shows the post (fail open), so a bad response never hides the whole feed.
export function decideFromJev(response, post, threshold = DEFAULT_SETTINGS.threshold, hideAds = false) {
  const ad = response?.answers?.is_ad?.noul;
  if (hideAds && typeof ad === "number" && ad >= AD_CUTOFF) return { id: post.id, show: false, reason: `Looks like an ad (${Math.round(ad * 100)}%)` };
  if (!response?.answers?.show && typeof ad === "number") return { id: post.id, show: true, reason: "not an ad" };
  const p = response?.answers?.show?.noul;
  if (typeof p !== "number" || Number.isNaN(p)) return { id: post.id, show: true, reason: "AI gave no answer" };
  const pct = Math.round(p * 100);
  return p >= threshold
    ? { id: post.id, show: true, reason: `AI: ${pct}% match` }
    : { id: post.id, show: false, reason: `AI: only ${pct}% match` };
}

export function showAll(posts, reason) {
  return posts.map((p) => ({ id: p.id, show: true, reason }));
}
