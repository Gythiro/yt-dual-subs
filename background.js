// background.js — translation service worker
// Routes cross-origin translation requests here so host_permissions apply
// and content scripts never hit page-CORS restrictions.
//
// All requests go through a rate-limit queue: a minimum spacing between calls
// plus exponential backoff on 429/403/503, so the free endpoint is never
// hammered. Two lanes — the sentence being watched (urgent) jumps ahead of
// prefetch (normal). No internal retries: a failed request is simply
// re-issued by content.js when its cue is next active.

const CACHE = new Map();          // key: `${tl}|${text}` -> translated string
const CACHE_MAX = 2000;           // simple LRU-ish cap

const MIN_INTERVAL_MS = 1200;     // stay under ~1 req/s
const BACKOFF_BASE_MS = 2000;
const BACKOFF_MAX_MS = 60000;
const BACKOFF_SHED_MS = 8000;     // deep backoff: refuse prefetch outright

let gateUntil = 0;                // no request may be SENT before this time
let backoffMs = 0;                // current backoff step (0 = healthy)
const qUrgent = [];
const qNormal = [];
let pumping = false;

// chrome.storage.session needs Chromium >= 102 (manifest sets that minimum,
// but Chromium forks may lag) — degrade to in-memory state without it.
const sessionStore = (chrome.storage && chrome.storage.session) || null;

// Rehydrate the rate-limit gate after a service-worker restart, so a backoff
// in progress survives MV3's aggressive worker teardown.
const hydrated = sessionStore
  ? sessionStore.get({ ytdsGtxGate: null }).then((got) => {
      const g = got && got.ytdsGtxGate;
      if (g) {
        gateUntil = Number(g.gateUntil) || 0;
        backoffMs = Number(g.backoffMs) || 0;
      }
    }).catch(() => {})
  : Promise.resolve();

// Persist only on state TRANSITIONS (enter/deepen/clear backoff) — a handful
// of writes per limiting episode. Doubles as the popup's read-only status
// channel (popup shows its "rate-limited" line off this key).
function persistGate() {
  if (!sessionStore) return;
  try {
    sessionStore.set({ ytdsGtxGate: { gateUntil, backoffMs, ts: Date.now() } });
  } catch (_e) { /* ignore */ }
}

function cacheGet(key) {
  if (!CACHE.has(key)) return undefined;
  const v = CACHE.get(key);
  CACHE.delete(key);              // refresh recency
  CACHE.set(key, v);
  return v;
}

function cacheSet(key, val) {
  CACHE.set(key, val);
  if (CACHE.size > CACHE_MAX) {
    // drop oldest
    const firstKey = CACHE.keys().next().value;
    CACHE.delete(firstKey);
  }
}

// The endpoint occasionally returns a PARTIAL translation — the leading
// sentences translated, the tail echoed back in the source language. Verified
// transient (the same input translates fully on retry). For CJK targets the
// echo is easy to spot: a large share of latin letters survives in the output.
function looksPartial(out, text, targetLang) {
  if (!/^(zh|ja|ko)/.test(targetLang)) return false;
  const letters = (s) => (s.match(/[A-Za-z]/g) || []).length;
  const inL = letters(text);
  return inL >= 20 && letters(out) >= inL * 0.35;
}

// Unofficial, key-free Google Translate endpoint (same one most free tools use).
// Returns a nested array; translated chunks live at data[0][i][0].
// Rate-limit style statuses mark the error so the pump can grow the backoff; a
// thrown fetch (endpoint unreachable — blocked network, offline) is marked
// netfail so content.js can fall back to YouTube's own translation.
async function gtxFetch(text, targetLang, attempt) {
  const url =
    "https://translate.googleapis.com/translate_a/single" +
    "?client=gtx&sl=auto" +
    "&tl=" + encodeURIComponent(targetLang) +
    "&dt=t&q=" + encodeURIComponent(text);

  let res;
  try {
    res = await fetch(url, { method: "GET" });
  } catch (_e) {
    const err = new Error("translate fetch failed");
    err.netfail = true;
    throw err;
  }
  if (res.status === 429 || res.status === 403 || res.status === 503) {
    const err = new Error("translate http " + res.status);
    err.rateLimited = true;
    throw err;
  }
  if (!res.ok) throw new Error("translate http " + res.status);
  const data = await res.json();

  let out = "";
  if (Array.isArray(data) && Array.isArray(data[0])) {
    for (const seg of data[0]) {
      if (seg && typeof seg[0] === "string") out += seg[0];
    }
  }
  out = out.trim();               // an empty 200 is a legal result, NOT a limit
  if (out && !attempt && looksPartial(out, text, targetLang)) {
    // one paced retry; if it is still partial, serve it (honest degrade)
    await new Promise((r) => setTimeout(r, 400));
    return gtxFetch(text, targetLang, 1);
  }
  if (out) cacheSet(`${targetLang}|${text}`, out);
  return out;
}

function enqueue(job) {
  // Deep backoff: shed prefetch instead of queueing it for a minute — content
  // simply re-requests when the sentence becomes active. The watched sentence
  // (urgent) always queues and goes out the moment the gate opens.
  if (!job.urgent && backoffMs >= BACKOFF_SHED_MS && Date.now() < gateUntil) {
    const err = new Error("gtx backoff");
    err.shed = true;
    job.reject(err);
    return;
  }
  (job.urgent ? qUrgent : qNormal).push(job);
  pump();
}

async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    await hydrated;
    while (qUrgent.length || qNormal.length) {
      const wait = gateUntil - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      const job = qUrgent.shift() || qNormal.shift();
      if (!job) break;
      gateUntil = Date.now() + MIN_INTERVAL_MS;
      try {
        const out = await gtxFetch(job.text, job.targetLang);
        if (backoffMs) { backoffMs = 0; persistGate(); }   // recovered
        job.resolve(out);
      } catch (err) {
        if (err && err.rateLimited) {
          backoffMs = backoffMs ? Math.min(backoffMs * 2, BACKOFF_MAX_MS) : BACKOFF_BASE_MS;
          // 0–25% jitter so parallel tabs don't retry in lockstep
          gateUntil = Date.now() + Math.round(backoffMs * (1 + Math.random() * 0.25));
          persistGate();
        }
        job.reject(err);
      }
    }
  } finally {
    pumping = false;
  }
}

function translate(text, targetLang, urgent) {
  const key = `${targetLang}|${text}`;
  const cached = cacheGet(key);
  if (cached !== undefined) return Promise.resolve(cached);  // hits skip the gate
  return new Promise((resolve, reject) =>
    enqueue({ text, targetLang, urgent: !!urgent, resolve, reject }));
}

// ---- install / update notifications --------------------------------------
// install  -> open the site once as a welcome/getting-started page.
// update   -> feature bump (major/minor changed): open the release-notes page
//             once per version (user-disableable via the popup toggle);
//             patch bump: just a "NEW" badge on the icon (popup clears it).
// Dev reloads report previousVersion === current version and stay silent.
const SITE_URL = "https://gythiro.github.io/yt-dual-subs/";

function uiLang() {
  try {
    const ui = (chrome.i18n && chrome.i18n.getUILanguage()) || "";
    if (ui.toLowerCase().indexOf("zh") === 0) return "zh";
  } catch (_e) { /* ignore */ }
  return "en";
}

function isFeatureBump(prev, cur) {
  const p = String(prev || "").split(".");
  const c = String(cur || "").split(".");
  return (+c[0] || 0) !== (+p[0] || 0) || (+c[1] || 0) !== (+p[1] || 0);
}

function showUpdateBadge() {
  try {
    chrome.action.setBadgeText({ text: "NEW" });
    chrome.action.setBadgeBackgroundColor({ color: "#FF4D8D" });
  } catch (_e) { /* ignore */ }
}

chrome.runtime.onInstalled.addListener((details) => {
  const cur = chrome.runtime.getManifest().version;
  if (details.reason === "install") {
    try { chrome.tabs.create({ url: SITE_URL + "?src=install&lang=" + uiLang() }); } catch (_e) {}
    return;
  }
  if (details.reason !== "update") return;
  const prev = details.previousVersion || "";
  if (!prev || prev === cur) return;
  chrome.storage.local.get({ updShownFor: "" }, (got) => {
    if (got.updShownFor === cur) return;           // already announced this version
    chrome.storage.local.set({ updShownFor: cur, updWhatsNew: cur });
    if (!isFeatureBump(prev, cur)) { showUpdateBadge(); return; }
    chrome.storage.sync.get({ updateNotes: true }, (s) => {
      if (s && s.updateNotes) {
        try {
          chrome.tabs.create({
            url: SITE_URL + "updated.html?ver=" + cur + "&lang=" + uiLang() + "&src=ext"
          });
          return;
        } catch (_e) { /* fall through to the badge */ }
      }
      showUpdateBadge();
    });
  });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "translate") {
    translate(msg.text, msg.targetLang, msg.urgent)
      .then((translated) => sendResponse({ ok: true, translated }))
      .catch((err) => sendResponse({
        ok: false,
        error: String(err),
        netfail: !!(err && err.netfail),
        shed: !!(err && err.shed)
      }));
    return true; // keep the message channel open for the async response
  }
});
