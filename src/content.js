// Runs on LinkedIn and X, but only acts on each site's home feed.
(() => {
  // One adapter per site. Both sites change their markup often, so the
  // selectors are kept here, in one place.
  const SITES = {
    linkedin: {
      onFeed: () => location.pathname === "/feed" || location.pathname.startsWith("/feed/"),
      posts: [
        'div[data-urn^="urn:li:activity"]',
        'div[data-id^="urn:li:activity"]',
        'div[data-urn^="urn:li:aggregate"]',
        "div.feed-shared-update-v2",
        // 2026 feed: each post is a list item keyed "update-card…".
        '[role="listitem"][componentkey^="update-card"]',
      ].join(","),
      text: '[data-testid="expandable-text-box"], .update-components-text, .feed-shared-update-v2__description, .feed-shared-text',
      author: ".update-components-actor__title, .update-components-actor__name, .feed-shared-actor__name",
      adLabel: /^(promoted|sponsored)( by .+)?$/i,
      id: (el) => el.getAttribute("data-urn") || el.getAttribute("data-id") || el.getAttribute("componentkey"),
      // LinkedIn writes counts as "1,234", "12 comments", "5 reposts".
      counts: (el) => {
        const out = {};
        const r = el.querySelector(".social-details-social-counts__reactions-count");
        if (r) out.likes = parseCount(r.innerText);
        for (const n of el.querySelectorAll("button, span, a")) {
          const t = (n.getAttribute("aria-label") || n.innerText || "").trim();
          const m = t.match(/^([\d.,]+[KM]?)\s+(reactions?|likes?|comments?|reposts?)\b/i);
          if (!m) continue;
          const name = { reaction: "likes", like: "likes", comment: "comments", repost: "reposts" }[m[2].toLowerCase().replace(/s$/, "")];
          out[name] ??= parseCount(m[1]);
        }
        return out;
      },
    },
    x: {
      onFeed: () => location.pathname === "/home" || location.pathname.startsWith("/explore"),
      posts: 'article[data-testid="tweet"]',
      text: '[data-testid="tweetText"]',
      author: '[data-testid="User-Name"]',
      adLabel: /^(ad|promoted)$/i,
      // X reuses article elements while scrolling, so the id comes from the post link.
      id: (el) => el.querySelector('a[href*="/status/"] time')?.closest("a")?.getAttribute("href") || null,
      // X buttons carry labels like "1234 Likes. Like"; no number means zero.
      counts: (el) => {
        const read = (ids) => {
          const b = el.querySelector(ids.map((i) => `[data-testid="${i}"]`).join(","));
          if (!b) return undefined;
          return parseCount(b.getAttribute("aria-label")) ?? 0;
        };
        return { likes: read(["like", "unlike"]), comments: read(["reply"]), reposts: read(["retweet", "unretweet"]) };
      },
    },
  };
  function parseCount(text) {
    const m = String(text ?? "").trim().replace(/,/g, "").match(/^(\d+(?:\.\d+)?)\s*([KkMm])?/);
    if (!m) return null;
    return Math.round(Number(m[1]) * ({ k: 1e3, m: 1e6 }[(m[2] || "").toLowerCase()] || 1));
  }
  const SITE = location.hostname === "x.com" ? "x" : "linkedin";
  const S = SITES[SITE];
  const POST_SELECTOR = S.posts;
  const TEXT_SELECTOR = S.text;
  const AUTHOR_SELECTOR = S.author;
  const AD_LABEL = S.adLabel;
  const BATCH_SIZE = 8;
  const DEBOUNCE_MS = 600;

  let queue = [];
  let timer = null;
  let autoId = 0;

  const onFeed = S.onFeed;

  function postId(el) {
    const id = S.id(el);
    if (id) return id;
    if (!el.dataset.lffId) el.dataset.lffId = `lff-${++autoId}`;
    return el.dataset.lffId;
  }

  function findNewPosts() {
    const found = [];
    for (const el of document.querySelectorAll(POST_SELECTOR)) {
      // A reused element now showing a different post: judge it again.
      if (el.dataset.lffState && el.dataset.lffFor && el.dataset.lffFor !== postId(el)) clear(el);
      if (el.dataset.lffState) continue;
      // Skip a post nested inside another post (reshares): judge the outer one.
      if (el.parentElement?.closest(POST_SELECTOR)) continue;
      const text = (el.querySelector(TEXT_SELECTOR) || el).innerText || "";
      if (!text.trim()) continue; // still loading; try again on the next change
      found.push(el);
    }
    return found;
  }

  // LinkedIn shows "Promoted" and X shows "Ad" on paid posts.
  function isPromoted(el) {
    // Only short label elements count, so "Promoted to VP" in a post never matches.
    for (const n of el.querySelectorAll("p, span")) {
      if (n.childElementCount > 1) continue;
      if (AD_LABEL.test((n.innerText || n.textContent || "").trim())) return true;
    }
    return false;
  }

  function markPending(el) {
    el.dataset.lffState = "pending";
    el.dataset.lffFor = postId(el);
    el.classList.add("lff-pending");
  }

  function apply(el, result, hideStyle) {
    el.classList.remove("lff-pending");
    el.querySelector(":scope > .lff-bar")?.remove();
    if (!result || result.show) {
      el.dataset.lffState = "shown";
      el.classList.remove("lff-collapsed", "lff-removed");
      if (result?.reason) {
        el.title = `Feed filter: ${result.reason}`;
        const tag = document.createElement("div");
        tag.className = "lff-bar lff-ok";
        tag.textContent = `✅ Checked by feed filter: ${result.reason}`;
        el.prepend(tag);
      }
      return;
    }
    el.dataset.lffState = "hidden";
    el.dataset.lffStyle = hideStyle === "remove" ? "remove" : "collapse";
    if (hideStyle === "remove") {
      el.classList.add("lff-removed");
      return;
    }
    el.classList.add("lff-collapsed");
    const bar = document.createElement("div");
    bar.className = "lff-bar";
    const label = document.createElement("span");
    const preview = (el.querySelector(TEXT_SELECTOR)?.innerText || "").replace(/\s+/g, " ").slice(0, 70);
    label.textContent = `🙈 Collapsed: ${result.reason || "not a match"}${preview ? ` — "${preview}…"` : ""}`;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "Show";
    btn.addEventListener("click", () => {
      el.classList.remove("lff-collapsed");
      el.dataset.lffState = "revealed";
      bar.remove();
    });
    bar.append(label, btn);
    el.prepend(bar);
  }

  async function flush() {
    timer = null;
    const batch = queue.splice(0, BATCH_SIZE);
    if (queue.length) schedule();
    if (!batch.length) return;
    const byId = new Map(batch.map((el) => [postId(el), el]));
    const posts = batch.map((el) => ({
      id: postId(el),
      author: el.querySelector(AUTHOR_SELECTOR)?.innerText || "",
      text: (el.querySelector(TEXT_SELECTOR) || el).innerText || "",
      promoted: isPromoted(el),
      counts: S.counts(el),
    }));
    let answer;
    try {
      answer = await chrome.runtime.sendMessage({ type: "classify", site: SITE, posts });
    } catch {
      answer = null; // extension reloaded or worker gone: show everything
    }
    // This copy belongs to a reloaded extension; the new copy takes over.
    if (!chrome.runtime?.id) observer.disconnect();
    const results = new Map((answer?.results || []).filter(Boolean).map((r) => [r.id, r]));
    for (const [id, el] of byId) apply(el, results.get(id), answer?.hideStyle);
  }

  function schedule() {
    if (!timer) timer = setTimeout(flush, DEBOUNCE_MS);
  }

  function scan() {
    if (!onFeed()) return;
    const posts = findNewPosts();
    if (!posts.length) return;
    posts.forEach(markPending);
    queue.push(...posts);
    schedule();
  }

  // Settings changed in the popup or options page: re-judge everything on screen.
  function clear(el) {
    el.querySelector(":scope > .lff-bar")?.remove();
    el.classList.remove("lff-pending", "lff-collapsed", "lff-removed");
    delete el.dataset.lffState;
    delete el.dataset.lffFor;
    delete el.dataset.lffStyle;
  }

  function rescan() {
    for (const el of document.querySelectorAll("[data-lff-state]")) clear(el);
    queue = [];
    scan();
  }

  // X only: hide the sidebar modules and in-feed suggestions the owner switched off.
  // Each module is found by its heading, since X's class names change often.
  const PANELS = [
    ["x_hidePremium", /premium/i],
    ["x_hideFollow", /^(who to follow|you might like|discover more)$/i],
    ["x_hideLive", /^live on x$/i],
    ["x_hideTrends", /./], // everything else: What's happening, news, sports
  ];
  let panelPrefs = {};
  function panelKey(heading) {
    return PANELS.find(([, re]) => re.test(heading.trim()))?.[0];
  }
  function tidyX() {
    if (SITE !== "x") return;
    const side = document.querySelector('[data-testid="sidebarColumn"]');
    for (const h of side?.querySelectorAll("h2") || []) {
      // Climb to the largest box that holds this heading and no other.
      let box = h;
      while (box.parentElement && box.parentElement !== side && box.parentElement.querySelectorAll("h2").length === 1) box = box.parentElement;
      const hide = !!panelPrefs[panelKey(h.innerText || h.textContent || "")];
      if (hide) box.dataset.lffPanel = "hidden";
      else if (box.dataset.lffPanel) delete box.dataset.lffPanel;
    }
    // Paid trends ("Promoted by …") in the sidebar and on Explore go with the ads.
    for (const t of document.querySelectorAll('[data-testid="trend"]')) {
      const box = t.closest('[data-testid="cellInnerDiv"]') || t;
      if (panelPrefs.x_hideAds !== false && [...t.querySelectorAll("span")].some((n) => /^promoted by /i.test(n.textContent.trim()))) box.dataset.lffPanel = "hidden";
      else if (box.dataset.lffPanel && !box.querySelector('[data-testid="UserCell"]')) delete box.dataset.lffPanel;
    }
    // In-feed "Who to follow": its heading, the account rows and "Show more".
    // Only on the feeds: on a Following or Followers page the account rows are the content.
    if (!S.onFeed()) return;
    for (const cell of document.querySelectorAll('[data-testid="primaryColumn"] [data-testid="cellInnerDiv"]')) {
      const h = cell.querySelector("h2")?.innerText || "";
      const follow = (h && panelKey(h) === "x_hideFollow") || (!cell.querySelector("article") && cell.querySelector('[data-testid="UserCell"], a[href^="/i/connect_people"]'));
      if (follow && panelPrefs.x_hideFollow) cell.dataset.lffPanel = "hidden";
      else if (cell.dataset.lffPanel) delete cell.dataset.lffPanel;
    }
  }
  async function loadPanelPrefs() {
    if (SITE !== "x") return;
    panelPrefs = await chrome.storage.local.get([...PANELS.map(([k]) => k), "x_hideAds"]);
    tidyX();
  }

  chrome.storage.onChanged.addListener((_c, area) => {
    if (area !== "local") return;
    loadPanelPrefs();
    rescan();
  });

  // LinkedIn is a single-page app: new posts and page changes arrive without a reload.
  const observer = new MutationObserver(() => {
    scan();
    tidyX();
  });
  observer.observe(document.body, { childList: true, subtree: true });
  // rescan, not scan: clears marks left by an older copy after an extension reload.
  rescan();
  loadPanelPrefs();
})();
