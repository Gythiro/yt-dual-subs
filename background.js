// background.js — translation service worker
// Routes cross-origin translation requests here so host_permissions apply
// and content scripts never hit page-CORS restrictions.

const CACHE = new Map();          // key: `${tl}\u0000${text}` -> translated string
const CACHE_MAX = 2000;           // simple LRU-ish cap

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

// Unofficial, key-free Google Translate endpoint (same one most free tools use).
// Returns a nested array; translated chunks live at data[0][i][0].
async function translate(text, targetLang) {
  const key = `${targetLang}\u0000${text}`;
  const cached = cacheGet(key);
  if (cached !== undefined) return cached;

  const url =
    "https://translate.googleapis.com/translate_a/single" +
    "?client=gtx&sl=auto" +
    "&tl=" + encodeURIComponent(targetLang) +
    "&dt=t&q=" + encodeURIComponent(text);

  const res = await fetch(url, { method: "GET" });
  if (!res.ok) throw new Error("translate http " + res.status);
  const data = await res.json();

  let out = "";
  if (Array.isArray(data) && Array.isArray(data[0])) {
    for (const seg of data[0]) {
      if (seg && typeof seg[0] === "string") out += seg[0];
    }
  }
  out = out.trim();
  if (out) cacheSet(key, out);
  return out;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "translate") {
    translate(msg.text, msg.targetLang)
      .then((translated) => sendResponse({ ok: true, translated }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true; // keep the message channel open for the async response
  }
});
