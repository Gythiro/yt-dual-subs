// background.js — translation service worker
// Routes cross-origin translation requests here so host_permissions apply
// and content scripts never hit page-CORS restrictions.
//
// Three adapters behind one message contract (content.js is engine-agnostic):
//   gtx   — key-free Google endpoint, one text per request (the 3.4 behaviour,
//           unchanged: 1.2s spacing, exponential backoff, prefetch shedding)
//   llm   — any OpenAI-compatible /chat/completions, user's own key, several
//           sentences per request via the numbered-line protocol
//   deepl — DeepL v2 REST, natively batched, free/pro endpoint from the key
//
// Each adapter owns a LANE: its own pacing gate, backoff state and queues, so a
// rate-limited Google never delays the user's paid endpoint (or vice versa).
// Two priority tiers inside a lane — the sentence being watched (urgent) jumps
// ahead of prefetch. No internal retries for transport errors: a failed request
// is simply re-issued by content.js when its cue is next active.

importScripts("providers.js", "languages.js");
const PROVIDERS = self.YTDS_PROVIDERS;
const LANGS = self.YTDS_LANGS;

const CACHE = new Map();          // key: `${ns}|${tl}|${text}` -> translated string
const CACHE_MAX = 2000;           // simple LRU-ish cap

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// chrome.storage.session needs Chromium >= 102 (manifest sets that minimum,
// but Chromium forks may lag) — degrade to in-memory state without it.
const sessionStore = (chrome.storage && chrome.storage.session) || null;

// ---------------------------------------------------------------------------
// settings mirror
// ---------------------------------------------------------------------------
// The worker needs to know which engine is selected. Keys mirror the popup /
// content DEFAULTS contract; the API key itself lives in storage.local and is
// read per request so it is never held in a long-lived variable.
const cfg = {
  engine: "auto",        // "auto" | "tlang" | "gtx" | "byo"
  byoProvider: "",       // providers.js id
  byoModel: "",
  byoBaseUrl: ""         // custom provider only
};

const cfgReady = new Promise((resolve) => {
  chrome.storage.sync.get(
    { engine: "auto", backend: "tlang", byoProvider: "", byoModel: "", byoBaseUrl: "" },
    (got) => {
      got = got || {};
      // Same read-side migration as content.js: a stored "gtx" backend was a
      // deliberate pre-3.4 choice, everything unknown lands on auto. Never
      // written back — old versions on the same sync profile read "auto" as gtx.
      const e = got.engine;
      cfg.engine = (e === "auto" || e === "tlang" || e === "gtx" || e === "byo")
        ? e
        : (got.backend === "gtx" ? "gtx" : "auto");
      cfg.byoProvider = String(got.byoProvider || "");
      cfg.byoModel = String(got.byoModel || "");
      cfg.byoBaseUrl = String(got.byoBaseUrl || "");
      resolve();
    }
  );
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;
  let byoChanged = false;
  for (const k of ["engine", "byoProvider", "byoModel", "byoBaseUrl"]) {
    if (!(k in changes)) continue;
    const v = changes[k].newValue;
    cfg[k] = typeof v === "string" ? v : cfg[k];
    if (k !== "engine") byoChanged = true;
  }
  // Provider/model/endpoint changed mid-flight: queued jobs were built for the
  // old target and their answers would be attributed to the new one. Drop them;
  // content.js re-requests on its own recue path.
  if (byoChanged || "engine" in changes) flushLane(byoLane, "config changed");
  // "This model cannot keep the export labels" is a fact about one model.
  if (byoChanged) groupedMisses = 0;
});

function keyFor(providerId) {
  return new Promise((resolve) => {
    chrome.storage.local.get({ byoKeys: {} }, (got) => {
      const keys = (got && got.byoKeys) || {};
      resolve(String(keys[providerId] || ""));
    });
  });
}

// Resolve the active BYO target: provider record + endpoint + model + key.
// Throws tagged errors for every "user has not finished setting this up" state
// so the popup can show one honest line instead of a generic failure.
// opts.needModel = false when the caller only needs the endpoint and key (the
// options page listing models has no model picked yet, by definition).
async function resolveByo(opts) {
  const p = PROVIDERS.get(cfg.byoProvider);
  if (!p) throw tag(new Error("no provider selected"), { noKey: true, code: "noProvider" });

  let baseUrl = p.baseUrl;
  let origin = p.origin;
  if (p.custom) {
    const parsed = PROVIDERS.parseCustomBase(cfg.byoBaseUrl);
    if (!parsed) throw tag(new Error("bad custom base url"), { noKey: true, code: "badBaseUrl" });
    baseUrl = parsed.baseUrl;
    origin = parsed.origin;
  }

  const key = await keyFor(p.id);
  if (!key) throw tag(new Error("no api key"), { noKey: true, code: "noKey" });

  const endpoint = PROVIDERS.endpointFor(p, { baseUrl, key });
  if (p.kind === "deepl") origin = new URL(endpoint).origin;   // free vs pro

  await ensureHostPermission(origin);

  const model = (cfg.byoModel || p.defaultModel || "").trim();
  if ((!opts || opts.needModel !== false) && p.kind === "llm" && !model) {
    throw tag(new Error("no model"), { noKey: true, code: "noModel" });
  }
  return { provider: p, endpoint, origin, model, key };
}

// Host permission is granted from the popup (a user gesture is required, which
// a worker does not have) — here we only verify and report.
async function ensureHostPermission(origin) {
  if (!chrome.permissions || !origin) return;
  let has = false;
  try {
    has = await chrome.permissions.contains({ origins: [origin + "/*"] });
  } catch (_e) {
    return;                       // cannot tell: let the request itself decide
  }
  if (!has) throw tag(new Error("host permission missing"), { noPerm: true, code: "noPerm", origin });
}

function tag(err, props) {
  return Object.assign(err, props || {});
}

// ---------------------------------------------------------------------------
// cache
// ---------------------------------------------------------------------------
// The namespace pins a cached string to the engine (and model) that produced
// it: switching provider must not serve yesterday's Google output as if the
// user's LLM had answered.
function cacheNs() {
  if (cfg.engine !== "byo") return "gtx";
  return "byo:" + (cfg.byoProvider || "-") + ":" + (cfg.byoModel || "-");
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
    const firstKey = CACHE.keys().next().value;   // drop oldest
    CACHE.delete(firstKey);
  }
}

// ---------------------------------------------------------------------------
// lanes
// ---------------------------------------------------------------------------
function makeLane(opts) {
  return {
    id: opts.id,
    minIntervalMs: opts.minIntervalMs,
    backoffBaseMs: opts.backoffBaseMs,
    backoffMaxMs: opts.backoffMaxMs,
    backoffShedMs: opts.backoffShedMs,
    coalesceMs: opts.coalesceMs,       // 0 = send immediately (no batching)
    maxBatch: opts.maxBatch,
    maxBatchChars: opts.maxBatchChars,
    send: opts.send,                   // (texts, targetLang) -> string[]
    persistKey: opts.persistKey || "",
    gateUntil: 0,
    backoffMs: 0,
    qUrgent: [],
    qNormal: [],
    pumping: false
  };
}

// gtx: one text per request, 1.2s spacing — the tuned 3.4 numbers, unchanged.
const gtxLane = makeLane({
  id: "gtx",
  minIntervalMs: 1200,
  backoffBaseMs: 2000,
  backoffMaxMs: 60000,
  backoffShedMs: 8000,             // deep backoff: refuse prefetch outright
  coalesceMs: 0,
  maxBatch: 1,
  maxBatchChars: Infinity,
  persistKey: "ytdsGtxGate",
  send: (texts, targetLang) => gtxFetch(texts[0], targetLang).then((out) => [out])
});

// byo: the user pays per call, so batch. A short coalescing window lets the
// prefetcher's neighbouring sentences ride along in one request; the watched
// sentence never waits for the window.
const byoLane = makeLane({
  id: "byo",
  minIntervalMs: 250,
  backoffBaseMs: 3000,
  backoffMaxMs: 60000,
  backoffShedMs: 10000,
  coalesceMs: 300,
  maxBatch: 8,
  maxBatchChars: 1800,
  persistKey: "ytdsByoGate",
  send: byoSend
});

function laneFor() {
  return cfg.engine === "byo" ? byoLane : gtxLane;
}

// Persist only on state TRANSITIONS (enter/deepen/clear backoff) — a handful of
// writes per limiting episode. Doubles as the popup's read-only status channel
// (the "rate-limited" line reads ytdsGtxGate).
function persistGate(lane) {
  if (!sessionStore || !lane.persistKey) return;
  try {
    sessionStore.set({
      [lane.persistKey]: { gateUntil: lane.gateUntil, backoffMs: lane.backoffMs, ts: Date.now() }
    });
  } catch (_e) { /* ignore */ }
}

// Rehydrate the rate-limit gates after a service-worker restart, so a backoff
// in progress survives MV3's aggressive worker teardown.
const hydrated = sessionStore
  ? sessionStore.get({ ytdsGtxGate: null, ytdsByoGate: null }).then((got) => {
      for (const lane of [gtxLane, byoLane]) {
        const g = got && got[lane.persistKey];
        if (!g) continue;
        lane.gateUntil = Number(g.gateUntil) || 0;
        lane.backoffMs = Number(g.backoffMs) || 0;
      }
    }).catch(() => {})
  : Promise.resolve();

// Surface the last BYO failure for the popup (session-scoped, read-only there).
function noteByoStatus(code) {
  if (!sessionStore) return;
  try {
    sessionStore.set({
      ytdsByoStatus: code ? { code, provider: cfg.byoProvider, ts: Date.now() } : null
    });
  } catch (_e) { /* ignore */ }
}

function flushLane(lane, why) {
  const jobs = lane.qUrgent.splice(0).concat(lane.qNormal.splice(0));
  for (const job of jobs) job.reject(tag(new Error(why || "flushed"), { stale: true }));
}

function enqueue(lane, job) {
  // Deep backoff: shed prefetch instead of queueing it for a minute — content
  // simply re-requests when the sentence becomes active. The watched sentence
  // (urgent) always queues and goes out the moment the gate opens.
  // job.noShed opts out: an export chunk has no "next time the cue is active"
  // to be re-asked on, so it waits for the gate instead of being dropped.
  if (!job.urgent && !job.noShed &&
      lane.backoffMs >= lane.backoffShedMs && Date.now() < lane.gateUntil) {
    job.reject(tag(new Error(lane.id + " backoff"), { shed: true }));
    return;
  }
  (job.urgent ? lane.qUrgent : lane.qNormal).push(job);
  pump(lane);
}

// Take the next batch: the head job decides the target language (one request
// carries one target), then same-target jobs join it up to the size caps.
// Non-matching jobs stay queued and form the next batch — the head is always
// consumed, so the pump cannot spin.
function takeBatch(lane) {
  const head = lane.qUrgent.shift() || lane.qNormal.shift();
  if (!head) return [];
  const batch = [head];
  // A solo job carries its own sender (aligned mode) — one sentence per
  // request, so nothing may ride along with it.
  if (lane.maxBatch <= 1 || head.solo) return batch;
  let chars = head.text.length;
  for (const q of [lane.qUrgent, lane.qNormal]) {
    for (let i = 0; i < q.length && batch.length < lane.maxBatch; ) {
      const job = q[i];
      if (job.targetLang !== head.targetLang || chars + job.text.length > lane.maxBatchChars) {
        i++;
        continue;
      }
      chars += job.text.length;
      batch.push(job);
      q.splice(i, 1);
    }
  }
  return batch;
}

async function pump(lane) {
  if (lane.pumping) return;
  lane.pumping = true;
  try {
    await hydrated;
    await cfgReady;
    while (lane.qUrgent.length || lane.qNormal.length) {
      const wait = lane.gateUntil - Date.now();
      if (wait > 0) await sleep(wait);
      // Batching lane, nothing urgent pending: wait briefly for neighbours so
      // prefetch travels in one paid request instead of eight.
      if (lane.coalesceMs && !lane.qUrgent.length && lane.qNormal.length < lane.maxBatch) {
        await sleep(lane.coalesceMs);
      }
      const batch = takeBatch(lane);
      if (!batch.length) break;
      lane.gateUntil = Date.now() + lane.minIntervalMs;
      try {
        const outs = batch[0].send
          ? await batch[0].send()
          : await lane.send(batch.map((j) => j.text), batch[0].targetLang);
        if (lane.backoffMs) { lane.backoffMs = 0; persistGate(lane); }   // recovered
        if (lane.id === "byo") noteByoStatus("");
        batch.forEach((job, i) => {
          const out = (outs && outs[i] !== undefined) ? outs[i] : "";
          // Solo jobs resolve with an object and cache on the content side.
          if (job.cacheKey && typeof out === "string" && out) cacheSet(job.cacheKey, out);
          job.resolve(out);
        });
      } catch (err) {
        if (err && err.rateLimited) {
          lane.backoffMs = lane.backoffMs
            ? Math.min(lane.backoffMs * 2, lane.backoffMaxMs)
            : lane.backoffBaseMs;
          // 0–25% jitter so parallel tabs don't retry in lockstep
          lane.gateUntil = Date.now() + Math.round(lane.backoffMs * (1 + Math.random() * 0.25));
          persistGate(lane);
        }
        if (lane.id === "byo") noteByoStatus((err && err.code) || "failed");
        for (const job of batch) job.reject(err);
      }
    }
  } finally {
    lane.pumping = false;
  }
}

// Awaiting cfgReady is load-bearing: a request arriving while the freshly woken
// worker still has default settings would otherwise be routed to the gtx lane
// and answered by Google while the user is on their own engine.
async function translate(text, targetLang, urgent) {
  await cfgReady;
  const lane = laneFor();
  const cacheKey = `${cacheNs()}|${targetLang}|${text}`;
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) return Promise.resolve(cached);  // hits skip the gate
  return new Promise((resolve, reject) =>
    enqueue(lane, { text, targetLang, cacheKey, urgent: !!urgent, resolve, reject }));
}

// ---------------------------------------------------------------------------
// adapter: gtx (key-free Google endpoint)
// ---------------------------------------------------------------------------
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
    throw tag(new Error("translate fetch failed"), { netfail: true, code: "netfail" });
  }
  if (res.status === 429 || res.status === 403 || res.status === 503) {
    throw tag(new Error("translate http " + res.status), { rateLimited: true, code: "limited" });
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
    await sleep(400);
    return gtxFetch(text, targetLang, 1);
  }
  return out;
}

// ---------------------------------------------------------------------------
// adapter: byo (llm / deepl)
// ---------------------------------------------------------------------------
// Measured on the China-region endpoints (R3-S3): roughly one connection in
// several is dropped at handshake. gtx can shrug that off — content.js re-asks
// when the cue is active, and auto falls back to YouTube's own translation —
// but a BYO request has no fallback and takes a whole sentence (or eight) down
// with it, so one paced retry is worth the call.
async function withNetRetry(run) {
  try {
    return await run();
  } catch (err) {
    if (!err || !err.netfail) throw err;
    await sleep(600);
    return run();
  }
}

async function byoSend(texts, targetLang) {
  const t = await resolveByo();
  return withNetRetry(() => (t.provider.kind === "deepl"
    ? deeplTranslate(texts, targetLang, t)
    : llmTranslate(texts, targetLang, t)));
}

// ---------------------------------------------------------------------------
// aligned mode: one sentence in, one line per on-screen fragment out
// ---------------------------------------------------------------------------
// A sentence group is N cues of ONE spoken sentence, glued back together for
// translation quality (ASR cues are fragments with no punctuation, so
// translating them one by one produces nonsense). The cost is that the
// translation line then sits still for the whole group while the original line
// advances cue by cue — the two lines visibly run at different speeds.
//
// Aligned mode gets both: translate the sentence as a whole, then split the
// result back into N lines so each cue has its own. Only the BYO engines can do
// it — an LLM because we write the prompt, DeepL because its API takes a
// `context` string. The key-free gtx endpoint has neither and keeps the group
// behaviour.
function alignedMessages(texts, targetLang) {
  const lang = LANG_NAMES[targetLang] || targetLang;
  const n = texts.length;
  const system =
    "You translate video subtitles. The " + n + " numbered lines below are " +
    "consecutive fragments of ONE spoken sentence, split up for on-screen timing.\n" +
    "Translate the sentence as a whole into " + lang + ", then split your " +
    "translation back into exactly " + n + " lines, so line k covers the same " +
    "part of the sentence as fragment k.\n" +
    "Rules:\n" +
    "- Output exactly " + n + " line(s), nothing else, each as N|translation\n" +
    "- Every line must be non-empty. Never merge, split, reorder or drop lines.\n" +
    "- No notes, no markdown. Keep names and numbers as-is. Spoken register.";
  return [
    { role: "system", content: system },
    { role: "user", content: packNumbered(texts) }
  ];
}

// Returns the per-fragment lines, or null when the model ignored the shape.
// Deliberately does NOT split-and-retry: halving the sentence would destroy the
// alignment this mode exists for. The caller falls back to one whole line.
async function llmAligned(texts, targetLang, target) {
  return llmOnce(texts, targetLang, target, { aligned: true });
}

async function byoAlignedSend(texts, targetLang) {
  const t = await resolveByo();
  return withNetRetry(async () => {
    if (t.provider.kind === "deepl") {
      // One request: the fragments as the payload, the whole sentence as
      // context, so each line is translated knowing the rest.
      const values = await deeplTranslate(texts, targetLang, t, texts.join(" "));
      return { aligned: true, values };
    }
    const values = await llmAligned(texts, targetLang, t);
    if (values) return { aligned: true, values };
    const whole = await llmTranslate([texts.join(" ")], targetLang, t);
    return { aligned: false, translated: whole[0] || "" };
  });
}

// Queued on the byo lane as a solo job so it still respects pacing and backoff.
// Not cached here: the caller owns per-cue caching (the same fragment can mean
// different things in a different sentence).
function translateAligned(texts, targetLang, urgent) {
  return cfgReady.then(() => {
    if (cfg.engine !== "byo") return { aligned: false, translated: "" };
    return new Promise((resolve, reject) => enqueue(byoLane, {
      text: texts.join(" "),
      targetLang,
      urgent: !!urgent,
      solo: true,
      cacheKey: "",
      send: () => byoAlignedSend(texts, targetLang).then((r) => [r]),
      resolve,
      reject
    }));
  });
}

// One list, in languages.js, so adding a language cannot leave the prompt
// saying "translate into zh-CN" or DeepL guessing at a neighbouring target.
const LANG_NAMES = LANGS.englishNames();

// Numbered-line protocol. "|" is the separator on purpose: a tab would be
// mangled into a NUL by parts of our JSON tooling (see HANDOFF), and models
// reproduce a pipe far more reliably than exotic delimiters.
function packNumbered(texts) {
  return texts.map((s, i) => (i + 1) + "|" + String(s).replace(/\s*\n\s*/g, " ")).join("\n");
}

// Returns an array of n translations, or null when the shape is off (missing,
// duplicated, extra or empty lines) — the caller then splits and retries.
function unpackNumbered(raw, n) {
  let body = String(raw || "").trim();
  // Models like to wrap answers in a fenced block; unwrap before parsing.
  const fenced = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(body);
  if (fenced) body = fenced[1];
  const found = new Map();
  for (const line of body.split(/\r?\n/)) {
    const m = /^\s*[>*\-\s]*(\d+)\s*\|(.*)$/.exec(line);
    if (!m) continue;
    const id = Number(m[1]);
    if (!(id >= 1 && id <= n) || found.has(id)) continue;
    found.set(id, m[2].trim());
  }
  if (found.size !== n) return null;
  const out = [];
  for (let i = 1; i <= n; i++) {
    const v = found.get(i);
    if (!v) return null;
    out.push(v);
  }
  return out;
}

// Two-level numbering, "G.K|text": G = sentence, K = fragment inside it. It is
// the numbered protocol plus the sentence boundaries — one request can then
// carry many sentences and still come back split per on-screen cue, which is
// exactly what an SRT file needs (aligned mode does the same thing for a single
// sentence at a time, where latency rules out batching).
function packGrouped(groups) {
  const lines = [];
  groups.forEach((g, gi) => {
    g.forEach((s, k) => {
      lines.push((gi + 1) + "." + (k + 1) + "|" + String(s).replace(/\s*\n\s*/g, " "));
    });
  });
  return lines.join("\n");
}

// Returns the same shape as `groups` (one translation per fragment), or null
// when any label is missing, duplicated, empty or out of range.
function unpackGrouped(raw, groups) {
  let body = String(raw || "").trim();
  const fenced = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(body);
  if (fenced) body = fenced[1];
  const found = new Map();                        // "g.k" -> translation
  for (const line of body.split(/\r?\n/)) {
    const m = /^\s*[>*\-\s]*(\d+)\s*\.\s*(\d+)\s*\|(.*)$/.exec(line);
    if (!m) continue;
    const gi = Number(m[1]), k = Number(m[2]);
    const g = groups[gi - 1];
    if (!g || !(k >= 1 && k <= g.length)) continue;
    const id = gi + "." + k;
    if (found.has(id)) return null;               // duplicate label: shape is off
    found.set(id, m[3].trim());
  }
  const out = [];
  for (let gi = 0; gi < groups.length; gi++) {
    const row = [];
    for (let k = 0; k < groups[gi].length; k++) {
      const v = found.get((gi + 1) + "." + (k + 1));
      if (!v) return null;
      row.push(v);
    }
    out.push(row);
  }
  return out;
}

function llmMessages(texts, targetLang) {
  const lang = LANG_NAMES[targetLang] || targetLang;
  const system =
    "You translate video subtitles. Translate each numbered input line into " + lang + ".\n" +
    "Rules:\n" +
    "- Output exactly " + texts.length + " line(s), one per input line, nothing else.\n" +
    '- Keep the numbering and the "|" separator: N|translation\n' +
    "- Never merge, split, reorder or drop lines. Never add notes or markdown.\n" +
    "- Keep names, numbers and code as-is. Natural spoken register, no honorific padding.";
  return [
    { role: "system", content: system },
    { role: "user", content: packNumbered(texts) }
  ];
}

// opts.bareOk   accept a single unnumbered line (single-text calls only)
// opts.aligned  use the fragment-splitting prompt instead of the plain one
// opts.messages override the prompt entirely (export's grouped protocol)
// opts.unpack   override the reply parser to match those messages
async function llmOnce(texts, targetLang, target, opts) {
  const bareOk = !!(opts && opts.bareOk);
  // extraBody carries provider-specific switches (see providers.js) — notably
  // DashScope's enable_thinking:false, worth ~4x on latency.
  const body = Object.assign({
    model: target.model,
    messages: (opts && opts.messages) ? opts.messages
      : (opts && opts.aligned) ? alignedMessages(texts, targetLang)
      : llmMessages(texts, targetLang),
    temperature: 0.2,
    stream: false
  }, target.provider.extraBody || {});
  const headers = Object.assign(
    {
      "Content-Type": "application/json",
      Authorization: "Bearer " + target.key
    },
    target.provider.extraHeaders || {}
  );

  let res;
  try {
    res = await fetch(target.endpoint + "/chat/completions", {
      method: "POST",
      headers,
      body: JSON.stringify(body)
    });
  } catch (_e) {
    throw tag(new Error("llm fetch failed"), { netfail: true, code: "netfail" });
  }
  await throwForStatus(res, "llm");

  let data;
  try {
    data = await res.json();
  } catch (_e) {
    throw tag(new Error("llm bad json"), { badShape: true, code: "badShape" });
  }
  const choice = data && data.choices && data.choices[0];
  const msg = (choice && choice.message) || null;
  const content = (msg && msg.content) || "";
  // A reasoning model can spend the whole answer on its chain of thought and
  // hand back an empty content field. Splitting the batch cannot fix that —
  // it is a model choice — so say which problem it is and stop.
  if (!content.trim() && msg && msg.reasoning_content) {
    throw tag(new Error("llm answered with reasoning only"), {
      badShape: true, code: "reasoning"
    });
  }
  const parsed = (opts && opts.unpack)
    ? opts.unpack(content)
    : unpackNumbered(content, texts.length);
  if (parsed) return parsed;
  // Single line, unnumbered answer: the most common harmless deviation.
  if (bareOk && texts.length === 1) {
    const bare = String(content).replace(/^```[^\n]*\n?|\n?```$/g, "").trim();
    if (bare) return [bare.split(/\r?\n/)[0].replace(/^\s*\d+\s*\|/, "").trim()];
  }
  return null;
}

// Shape failure is not a transport failure: halve the batch and retry, down to
// a single line, before giving up. A 200ms gap keeps the split from bursting
// past the lane's pacing.
async function llmTranslate(texts, targetLang, target) {
  if (!texts.length) return [];
  const out = await llmOnce(texts, targetLang, target, { bareOk: texts.length === 1 });
  if (out) return out;
  if (texts.length === 1) {
    throw tag(new Error("llm line shape"), { badShape: true, code: "badShape" });
  }
  const mid = Math.ceil(texts.length / 2);
  const a = await llmTranslate(texts.slice(0, mid), targetLang, target);
  await sleep(200);
  const b = await llmTranslate(texts.slice(mid), targetLang, target);
  return a.concat(b);
}

// ---------------------------------------------------------------------------
// export: the whole track, several sentences per request
// ---------------------------------------------------------------------------
// Playback translates one sentence at a time because latency is what matters
// there. A download has no such clock, so the unit becomes a CHUNK of
// consecutive sentences — a 20-minute talk costs a handful of requests instead
// of one per sentence. What it must NOT do is go the whole way and send the
// track in a single call: output caps (4k–8k tokens on most services) and the
// line-count discipline both break down long before that, and one dropped line
// invalidates the entire file.
function exportMessages(groups, targetLang) {
  const lang = LANG_NAMES[targetLang] || targetLang;
  const n = groups.reduce((sum, g) => sum + g.length, 0);
  const system =
    "You translate video subtitles into " + lang + ".\n" +
    'Each input line is "G.K|text": G is the sentence number, K is the fragment ' +
    "index inside that sentence. Fragments sharing a G are one spoken sentence, " +
    "split up for on-screen timing.\n" +
    "Translate sentence by sentence: read the whole sentence, then split your " +
    "translation back across its fragments so fragment K covers the same part.\n" +
    "Rules:\n" +
    "- Output exactly " + n + " line(s), one per input line, same order, each as G.K|translation\n" +
    "- Repeat every G.K label exactly. Never merge, split, reorder or drop lines.\n" +
    "- Every line must be non-empty. No notes, no markdown.\n" +
    "- Keep names, numbers and code as-is. Natural spoken register.";
  return [
    { role: "system", content: system },
    { role: "user", content: packGrouped(groups) }
  ];
}

async function llmOnceGrouped(groups, targetLang, target) {
  const flat = [];
  for (const g of groups) for (const s of g) flat.push(s);
  return llmOnce(flat, targetLang, target, {
    messages: exportMessages(groups, targetLang),
    unpack: (content) => unpackGrouped(content, groups)
  });
}

// Asking for the translation of a sentence to be split back into exactly K
// pieces is the one instruction weaker models drop lines on, and the risk
// compounds with the number of sentences in the request — playback only ever
// asks for one at a time. Measured (tests/export-live.js): qwen-flash drops a
// line on 5 of 5 grouped requests of 24 lines, and translates the same 24 lines
// flat without a slip.
//
// So flat numbering is the rung below: one line in, one line out, nothing to
// redistribute. It costs a little quality at fragment boundaries and one extra
// request, which is nothing next to halving the chunk repeatedly.
//
// After two chunks in a row that the model would not label, stop asking: this
// provider evidently cannot do it, and every later chunk would pay the same
// wasted request. Reset when the provider or model changes (below) — the next
// one may be fine.
let groupedMisses = 0;
const GROUPED_GIVE_UP = 2;

function reshapeLike(values, groups) {
  const out = [];
  let i = 0;
  for (const g of groups) out.push(values.slice(i, (i += g.length)));
  return out;
}

async function llmExport(groups, targetLang, target) {
  if (!groups.length) return [];
  if (groupedMisses < GROUPED_GIVE_UP) {
    const out = await llmOnceGrouped(groups, targetLang, target);
    if (out) { groupedMisses = 0; return out; }
    groupedMisses++;
  }
  const flat = [];
  for (const g of groups) for (const s of g) flat.push(s);
  const plain = await llmOnce(flat, targetLang, target, { bareOk: flat.length === 1 });
  if (plain) return reshapeLike(plain, groups);

  // Neither shape held. Halve — but only ever at a SENTENCE boundary (aligned
  // mode refuses to split at all because halving a sentence destroys the
  // alignment it exists for; between sentences it costs nothing but a request).
  // A lone sentence that still fails is given up on: its fragments come back
  // empty and the caller keeps YouTube's line for those cues. One bad sentence
  // must not cost the whole download.
  if (groups.length === 1) return [groups[0].map(() => "")];
  const mid = Math.ceil(groups.length / 2);
  const a = await llmExport(groups.slice(0, mid), targetLang, target);
  await sleep(200);
  const b = await llmExport(groups.slice(mid), targetLang, target);
  return a.concat(b);
}

// DeepL has no prompt to give sentence structure to, but it does take a
// `context` string: send the fragments as the payload and the whole chunk as
// context, so every fragment is translated knowing the sentence around it.
// Its API caps a request at 50 text items, so a larger chunk splits.
const DEEPL_MAX_TEXTS = 50;

async function deeplExport(groups, targetLang, target) {
  if (!groups.length) return [];
  const flat = [];
  for (const g of groups) for (const s of g) flat.push(s);
  if (flat.length > DEEPL_MAX_TEXTS && groups.length > 1) {
    const mid = Math.ceil(groups.length / 2);
    const a = await deeplExport(groups.slice(0, mid), targetLang, target);
    await sleep(200);
    const b = await deeplExport(groups.slice(mid), targetLang, target);
    return a.concat(b);
  }
  return reshapeLike(await deeplTranslate(flat, targetLang, target, flat.join(" ")), groups);
}

async function byoExportSend(groups, targetLang) {
  const t = await resolveByo();
  return withNetRetry(() => (t.provider.kind === "deepl"
    ? deeplExport(groups, targetLang, t)
    : llmExport(groups, targetLang, t)));
}

// One chunk = one solo job on the byo lane, so a download obeys the same pacing
// and backoff as playback. noShed because there is no second chance: an export
// chunk that is dropped is a hole in the file, not a cue that will be re-asked
// for a second later. Not urgent either — a video playing in the tab keeps
// priority over a download the user is watching a progress line for.
function translateExport(groups, targetLang) {
  return cfgReady.then(() => {
    if (cfg.engine !== "byo") {
      throw tag(new Error("export needs an own-key engine"), { code: "noProvider" });
    }
    return new Promise((resolve, reject) => enqueue(byoLane, {
      text: groups.map((g) => g.join(" ")).join(" "),
      targetLang,
      urgent: false,
      solo: true,
      noShed: true,
      cacheKey: "",
      send: () => byoExportSend(groups, targetLang).then((r) => [r]),
      resolve,
      reject
    }));
  });
}

// DeepL target codes, from the same shared table. Regional variants are
// required for EN and PT; ZH-HANS / ZH-HANT are the two Chinese targets.
// A language with no entry has no DeepL target, and saying so beats silently
// translating into a neighbouring one. Every code here was checked against the
// live /v2/languages list (110 targets, 2026-07-27).
const DEEPL_TARGETS = LANGS.deeplTargets();

// context (optional) is sent along but not translated — DeepL uses it to
// disambiguate short fragments. That is what makes aligned mode possible here.
async function deeplTranslate(texts, targetLang, target, context) {
  const tl = DEEPL_TARGETS[targetLang];
  if (!tl) {
    throw tag(new Error("deepl target unsupported"), {
      unsupportedTarget: true, code: "unsupportedTarget"
    });
  }
  const payload = { text: texts, target_lang: tl };
  if (context) payload.context = context;
  let res;
  try {
    res = await fetch(target.endpoint + "/translate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "DeepL-Auth-Key " + target.key
      },
      body: JSON.stringify(payload)
    });
  } catch (_e) {
    throw tag(new Error("deepl fetch failed"), { netfail: true, code: "netfail" });
  }
  await throwForStatus(res, "deepl");

  let data;
  try {
    data = await res.json();
  } catch (_e) {
    throw tag(new Error("deepl bad json"), { badShape: true, code: "badShape" });
  }
  const list = data && data.translations;
  if (!Array.isArray(list) || list.length !== texts.length) {
    throw tag(new Error("deepl bad shape"), { badShape: true, code: "badShape" });
  }
  return list.map((x) => String((x && x.text) || "").trim());
}

// One place to turn HTTP status into our error vocabulary. 401/403 is a key
// problem the user must fix (never retried); 429/5xx is the lane's backoff.
async function throwForStatus(res, who) {
  if (res.ok) return;
  const s = res.status;
  if (s === 401 || s === 403) {
    throw tag(new Error(who + " auth " + s), { authFailed: true, code: "auth" });
  }
  if (s === 429 || s === 456 || s >= 500) {
    // DeepL 456 = quota exhausted for the billing period; treat as limited so
    // the lane stops hammering, and let the popup explain it.
    throw tag(new Error(who + " limited " + s), {
      rateLimited: true, code: s === 456 ? "quota" : "limited"
    });
  }
  let detail = "";
  try { detail = (await res.text()).slice(0, 200); } catch (_e) { /* ignore */ }
  throw tag(new Error(who + " http " + s + " " + detail), {
    badRequest: true, code: s === 400 || s === 404 ? "badRequest" : "http"
  });
}

// ---------------------------------------------------------------------------
// connection test (popup "test" button)
// ---------------------------------------------------------------------------
// Runs one real request against the saved configuration and reports a code the
// popup turns into a sentence. Bypasses the lane: it is a user-initiated probe,
// not part of the playback stream.
async function byoTest(targetLang) {
  const t = await resolveByo();
  if (t.provider.kind === "deepl") {
    const langs = await deeplTargets(t);
    const want = DEEPL_TARGETS[targetLang];
    if (langs && want && !langs.includes(want.split("-")[0])) {
      throw tag(new Error("deepl target unsupported"), {
        unsupportedTarget: true, code: "unsupportedTarget"
      });
    }
    const out = await deeplTranslate(["Hello."], targetLang, t);
    return { sample: out[0] };
  }
  const out = await llmTranslate(["Hello."], targetLang, t);
  return { sample: out[0] };
}

// Model list from the user's own key, for the options page dropdown. Asking the
// endpoint beats shipping a curated list that quietly rots (gemini-2.0-flash was
// already out of quota on free keys before we ever tested it).
async function byoModels() {
  const t = await resolveByo({ needModel: false });
  if (t.provider.kind === "deepl") return { models: [] };
  const headers = Object.assign(
    { Authorization: "Bearer " + t.key },
    t.provider.extraHeaders || {}
  );
  let res;
  try {
    res = await fetch(t.endpoint + "/models", { headers });
  } catch (_e) {
    throw tag(new Error("models fetch failed"), { netfail: true, code: "netfail" });
  }
  await throwForStatus(res, "llm");
  let data;
  try {
    data = await res.json();
  } catch (_e) {
    throw tag(new Error("models bad json"), { badShape: true, code: "badShape" });
  }
  const ids = ((data && data.data) || []).map((m) => m && m.id);
  return { models: PROVIDERS.usableModels(ids) };
}

// Live target list, so a stale hard-coded table can never be the reason a user
// is told their language is unsupported.
async function deeplTargets(t) {
  try {
    const res = await fetch(t.endpoint + "/languages?type=target", {
      headers: { Authorization: "DeepL-Auth-Key " + t.key }
    });
    if (!res.ok) return null;
    const list = await res.json();
    if (!Array.isArray(list)) return null;
    return list.map((x) => String((x && x.language) || "").split("-")[0]);
  } catch (_e) {
    return null;
  }
}

// ---- install / update notifications --------------------------------------
// install  -> open the extension's own getting-started page once.
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
    // Let the drag grip show itself on the first few videos. Install only:
    // an upgrade must not pester people who already know how to drag.
    try { chrome.storage.local.set({ handleHintsLeft: 3 }); } catch (_e) {}
    // The extension's own page, not the site: it works offline, it is already
    // in the user's language, and step 2 (the subtitle box can be dragged) is
    // the one thing new users demonstrably miss.
    try {
      chrome.tabs.create({ url: chrome.runtime.getURL("options.html") + "#start" });
    } catch (_e) { /* ignore */ }
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
        code: (err && err.code) || "",
        netfail: !!(err && err.netfail),
        shed: !!(err && err.shed),
        stale: !!(err && err.stale),
        authFailed: !!(err && err.authFailed),
        noPerm: !!(err && err.noPerm),
        noKey: !!(err && err.noKey)
      }));
    return true; // keep the message channel open for the async response
  }
  if (msg && msg.type === "translateAligned") {
    translateAligned(msg.texts, msg.targetLang, msg.urgent)
      .then((r) => sendResponse(Object.assign({ ok: true }, r)))
      .catch((err) => sendResponse({
        ok: false,
        error: String(err),
        code: (err && err.code) || "",
        netfail: !!(err && err.netfail),
        shed: !!(err && err.shed),
        stale: !!(err && err.stale)
      }));
    return true;
  }
  if (msg && msg.type === "exportTranslate") {
    translateExport(msg.groups || [], msg.targetLang)
      .then((values) => sendResponse({ ok: true, values }))
      .catch((err) => sendResponse({
        ok: false,
        error: String(err),
        code: (err && err.code) || "",
        netfail: !!(err && err.netfail),
        stale: !!(err && err.stale),
        authFailed: !!(err && err.authFailed),
        noPerm: !!(err && err.noPerm),
        noKey: !!(err && err.noKey)
      }));
    return true;
  }
  if (msg && msg.type === "byoModels") {
    cfgReady
      .then(byoModels)
      .then((r) => sendResponse({ ok: true, models: r.models }))
      .catch((err) => sendResponse({
        ok: false,
        code: (err && err.code) || "failed",
        error: String(err)
      }));
    return true;
  }
  if (msg && msg.type === "byoTest") {
    cfgReady
      .then(() => byoTest(msg.targetLang || "zh-CN"))
      .then((r) => sendResponse({ ok: true, sample: r.sample }))
      .catch((err) => sendResponse({
        ok: false,
        code: (err && err.code) || "failed",
        error: String(err)
      }));
    return true;
  }
});
