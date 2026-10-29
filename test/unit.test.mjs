import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_POST_CHARS,
  buildJevRequest,
  classifyByKeywords,
  clipText,
  decideFromJev,
  engagementResult,
  parseCount,
  siteSettings,
  normalizeSettings,
  promotedResult,
  splitTerms,
} from "../src/classify.js";

const post = { id: "urn:li:activity:1", author: "Ops Person", text: "AI for operations reporting" };

test("splitTerms handles commas, semicolons and new lines", () => {
  assert.deepEqual(splitTerms(" AI, Ops ;\nHiring\n\n"), ["ai", "ops", "hiring"]);
  assert.deepEqual(splitTerms(""), []);
});

test("clipText squashes spaces and caps length", () => {
  assert.equal(clipText("  a \n\n b  "), "a b");
  assert.equal(clipText("x".repeat(MAX_POST_CHARS + 50)).length, MAX_POST_CHARS + 1);
});

test("normalizeSettings fills defaults", () => {
  const s = normalizeSettings({ likes: "ai" });
  assert.equal(s.model, "jev-latest");
  assert.equal(s.threshold, 0.5);
  assert.equal(s.likes, "ai");
  assert.match(normalizeSettings({ likes: " " }).likes, /AI in operations/);
  assert.match(normalizeSettings({}).dislikes, /sales pitch/);
});

test("keyword mode: hide word wins, everything else shows", () => {
  const s = { likes: "ai", dislikes: "politics" };
  const r = classifyByKeywords(s, [
    { id: "a", text: "AI and politics" },
    { id: "b", text: "New AI tool" },
    { id: "c", text: "Lunch photo" },
  ]);
  assert.deepEqual(r.map((x) => x.show), [false, true, true]);
});

test("keyword mode with no likes shows everything not disliked", () => {
  const r = classifyByKeywords({ likes: "", dislikes: "crypto" }, [{ id: "a", text: "Lunch" }, { id: "b", text: "Crypto!" }]);
  assert.deepEqual(r.map((x) => x.show), [true, false]);
});

test("buildJevRequest matches the TypeSafe System One shape", () => {
  const req = buildJevRequest(normalizeSettings({ likes: "AI\nops", dislikes: "politics" }), post);
  assert.equal(req.model, "jev-latest");
  assert.match(req.state, /Ops Person/);
  assert.match(req.state, /AI for operations/);
  assert.equal(req.questions.show.type, "noul");
  assert.match(req.questions.show.criteria.true, /ai, ops/);
  assert.match(req.questions.show.criteria.false, /politics/);
});

test("decideFromJev uses the threshold", () => {
  const yes = { answers: { show: { type: "noul", noul: 0.8 } } };
  const no = { answers: { show: { type: "noul", noul: 0.2 } } };
  assert.equal(decideFromJev(yes, post).show, true);
  assert.equal(decideFromJev(no, post).show, false);
  assert.equal(decideFromJev(yes, post, 0.9).show, false);
  assert.equal(decideFromJev(no, post).id, post.id);
});

test("decideFromJev fails open on a bad answer", () => {
  for (const bad of [null, {}, { answers: {} }, { answers: { show: { noul: "x" } } }]) {
    assert.equal(decideFromJev(bad, post).show, true);
  }
});

test("hideAds adds an is_ad question and hides ad-like posts", () => {
  const req = buildJevRequest(normalizeSettings({}), post);
  assert.equal(req.questions.is_ad.type, "noul");
  assert.equal(buildJevRequest(normalizeSettings({ hideAds: false }), post).questions.is_ad, undefined);
  const adLike = { answers: { show: { noul: 0.9 }, is_ad: { noul: 0.9 } } };
  const maybeAd = { answers: { show: { noul: 0.9 }, is_ad: { noul: 0.8 } } };
  assert.equal(decideFromJev(maybeAd, post, 0.5, true).show, true);
  assert.equal(decideFromJev(adLike, post, 0.5, true).show, false);
  assert.equal(decideFromJev(adLike, post, 0.5, false).show, true);
});

test("Promoted posts are hidden locally, in keyword mode too", () => {
  const ad = { ...post, promoted: true };
  assert.equal(promotedResult(normalizeSettings({}), ad).show, false);
  assert.equal(promotedResult(normalizeSettings({ hideAds: false }), ad), null);
  assert.equal(promotedResult(normalizeSettings({}), post), null);
  assert.equal(classifyByKeywords(normalizeSettings({ likes: "AI" }), [ad])[0].show, false);
});

test("siteSettings keeps LinkedIn and X apart", () => {
  const raw = { likes: "li", x_likes: "xx", hideAds: false, x_minLikes: 5, mode: "keywords" };
  assert.equal(siteSettings(raw, "linkedin").likes, "li");
  assert.equal(siteSettings(raw, "linkedin").minLikes, 0);
  const x = siteSettings(raw, "x");
  assert.equal(x.likes, "xx");
  assert.equal(x.hideAds, true); // LinkedIn's switch does not leak into X
  assert.equal(x.minLikes, 5);
  assert.equal(x.mode, "keywords"); // shared
});

test("parseCount reads 1,234 / 1.2K / 3M and labels", () => {
  assert.equal(parseCount("1,234"), 1234);
  assert.equal(parseCount("1.2K"), 1200);
  assert.equal(parseCount("3M"), 3000000);
  assert.equal(parseCount("40 Likes. Like"), 40);
  assert.equal(parseCount("Like"), null);
});

test("engagementResult hides below the minimum, never on unknown counts", () => {
  const s = normalizeSettings({ minLikes: 10, minComments: 2 });
  assert.equal(engagementResult(s, { id: "a", counts: { likes: 3 } }).show, false);
  assert.equal(engagementResult(s, { id: "b", counts: { likes: 30, comments: 1 } }).show, false);
  assert.equal(engagementResult(s, { id: "c", counts: { likes: 30, comments: 5 } }), null);
  assert.equal(engagementResult(s, { id: "d", counts: {} }), null);
  assert.equal(engagementResult({ ...s, adsOnly: true }, { id: "e", counts: { likes: 0 } }), null);
  assert.equal(engagementResult(normalizeSettings({}), { id: "f", counts: { likes: 0 } }), null);
});
