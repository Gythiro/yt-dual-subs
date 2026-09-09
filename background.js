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
  byoBaseUrl: "",        // custom provider only
  // Read-aloud starts on the browser's own voices: they need no key, so the
  // feature can be tried by pressing one switch instead of opening an account
  // somewhere first. A stored choice always wins over this.
  ttsProvider: "local-speech",
  ttsVoice: "",          // read-aloud voice ("" = the provider's default)
  ttsRegion: ""          // Azure only: the region its key is bound to ("eastus")
};

const cfgReady = new Promise((resolve) => {
  chrome.storage.sync.get(
    { engine: "auto", backend: "tlang", byoProvider: "", byoModel: "", byoBaseUrl: "",
      ttsProvider: "local-speech", ttsVoice: "", ttsRegion: "" },
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
      cfg.ttsProvider = String(got.ttsProvider || "");
      cfg.ttsVoice = String(got.ttsVoice || "");
      cfg.ttsRegion = String(got.ttsRegion || "");
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
  // Read-aloud settings ride the same listener but must NOT flush the
  // translation lane — a voice change has nothing to do with queued subtitles.
  for (const k of ["ttsProvider", "ttsVoice", "ttsRegion"]) {
    if (!(k in changes)) continue;
    const v = changes[k].newValue;
    cfg[k] = typeof v === "string" ? v : cfg[k];
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
  // Which provider this is FOR. Normally the one the extension translates with,
  // but the settings page can ask about a provider the user is only looking at
  // — reading its model list is a question about that provider, not a decision
  // to start using it. An id that is not in the registry is ignored rather than
  // trusted: this arrives in a message.
  const asked = opts && opts.provider ? PROVIDERS.get(opts.provider) : null;
  const p = asked || PROVIDERS.get(cfg.byoProvider);
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

  const model = (asked
    ? ((cfg.byoModelBy || {})[p.id] || p.defaultModel || "")
    : (cfg.byoModel || p.defaultModel || "")).trim();
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
    // Only one thing can be "the thing happening now" on this lane, so a new
    // urgent job supersedes any urgent job still waiting. True for read-aloud
    // (one line is on screen); false for translation, where several visible
    // cues are legitimately urgent at once.
    singleUrgent: !!opts.singleUrgent,
    // Keep one slot open for the line on screen. The pump sends one request at
    // a time and awaits it inline, so without this a line fetched AHEAD that is
    // already in flight holds the lane: measured at 927ms of extra wait behind
    // a 900ms look-ahead, and the ceiling is the 15s synthesis timeout, by
    // which point the line has been off screen for a dozen seconds. The
    // look-ahead exists to make read-aloud prompt; it must not be what makes it
    // late. Read-aloud only: on the translate lanes several visible cues are
    // legitimately urgent at once and batching is the point.
    urgentSlot: !!opts.urgentSlot,
    persistKey: opts.persistKey || "",
    gateUntil: 0,
    backoffMs: 0,
    // Which backoff episode a request belongs to. With two pumps the lane can
    // have two requests in flight when a provider starts refusing, and both
    // replies are the SAME refusal: without this each one doubles the backoff
    // the other just doubled, and read-aloud stays off twice as long as the
    // provider asked for. A reply whose era is behind the lane's has already
    // been accounted for. Not a timestamp: the gate is re-armed to
    // now + minIntervalMs before every send, so a fast 429 would look like it
    // arrived inside a window that had not started yet.
    era: 0,
    qUrgent: [],
    qNormal: [],
    // One flag per pump. A lane with urgentSlot runs two: they share the rate
    // gate and the backoff, so the pair is still limited to the lane's pace —
    // what they do not share is the wait for each other's request.
    pumping: false,
    pumpingUrgent: false,
    pumpingNormal: false
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

// tts: one utterance per request — a speech API has no batch, and coalescing a
// line that is about to be spoken is the one delay that cannot be recovered
// from. minIntervalMs is a burst brake rather than a quota pace: what the
// providers actually meter is characters, which the lane cannot see.
//
// This lane is what makes a rate limit mean something on the read-aloud side.
// ttsSynthesize has always tagged a 429 as rateLimited; nothing consumed the
// tag, because synthesis was the one outbound path that never went through
// pump(). So the response to being told "too fast" was to ask again for the
// next line, immediately, and report the silence as a skip.
const ttsLane = makeLane({
  id: "tts",
  minIntervalMs: 120,
  backoffBaseMs: 2000,
  backoffMaxMs: 60000,
  backoffShedMs: 8000,             // deep backoff: refuse the prefetched line
  coalesceMs: 0,
  maxBatch: 1,
  maxBatchChars: Infinity,
  persistKey: "ytdsTtsGate",
  singleUrgent: true,
  urgentSlot: true,
  // Every TTS job carries its own sender: the resolved provider, key and voice
  // are per-request state that the lane's shared (texts, targetLang) signature
  // cannot express. pump() prefers job.send when it is there, so this exists
  // only to fail loudly if a job ever arrives without one.
  send: () => { throw new Error("a tts job must carry its own sender"); }
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
  ? sessionStore.get({ ytdsGtxGate: null, ytdsByoGate: null, ytdsTtsGate: null }).then((got) => {
      for (const lane of [gtxLane, byoLane, ttsLane]) {
        const g = got && got[lane.persistKey];
        if (!g) continue;
        lane.gateUntil = Number(g.gateUntil) || 0;
        lane.backoffMs = Number(g.backoffMs) || 0;
      }
    }).catch(() => {})
  : Promise.resolve();

// Surface the last BYO failure for the popup (session-scoped, read-only there).
// On transitions only, the way persistGate has always done it. This is called
// after every batch, success included, and the byo lane spaces batches 250ms
// apart — so a healthy run was writing session storage four times a second and
// waking both the popup and the settings page through onChanged each time, to
// tell them the same thing they already knew.
let lastByoStatus = null;
function noteByoStatus(code) {
  if (!sessionStore) return;
  // The provider is part of the state: the same code against a different
  // provider is different news.
  const now = code ? code + "|" + cfg.byoProvider : "";
  if (now === lastByoStatus) return;
  lastByoStatus = now;
  try {
    sessionStore.set({
      ytdsByoStatus: code ? { code, provider: cfg.byoProvider, ts: Date.now() } : null
    });
  } catch (_e) { /* ignore */ }
}

// `only` scopes the flush to one pump's queue. A lane with two pumps has two
// independent failures: one coming apart says nothing about the other, which is
// still running and will drain its own queue. Rejecting its jobs too would turn
// one pump's crash into lines the other pump was about to speak.
function flushLane(lane, why, only) {
  const jobs = only === "urgent" ? lane.qUrgent.splice(0)
    : only === "normal" ? lane.qNormal.splice(0)
    : lane.qUrgent.splice(0).concat(lane.qNormal.splice(0));
  for (const job of jobs) job.reject(tag(new Error(why || "flushed"), { stale: true }));
}

// Everything still queued for a video the viewer has left is waste: content.js
// throws the answers away anyway (cueEpoch), and on a run of shorts those
// requests are exactly what pushes the free endpoint into rate limiting — which
// the NEXT short then waits out behind a backoff, showing "…" the whole time.
// Export chunks are not playback: they carry noShed, have no "next time the cue
// is active" to be re-asked on, and stay.
function dropPlaybackJobs(lane, why) {
  for (const q of [lane.qUrgent, lane.qNormal]) {
    for (let i = q.length - 1; i >= 0; i--) {
      if (q[i].noShed) continue;
      const [job] = q.splice(i, 1);
      job.reject(tag(new Error(why || "left the video"), { stale: true, code: "stale" }));
    }
  }
}

function enqueue(lane, job) {
  // A job with no text poisons takeBatch (`head.text.length`) rather than
  // failing here — and takeBatch runs OUTSIDE the try that catches a failed
  // request, so the job it had already shifted out was left unsettled forever.
  // The three callers all pass text today; this makes the fourth one's mistake
  // an error the caller sees.
  if (typeof job.text !== "string") {
    job.reject(tag(new Error(lane.id + " job has no text"), { code: "badRequest" }));
    return;
  }
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
  if (job.urgent && lane.singleUrgent) {
    // The line on screen has changed, so the one that was waiting has no cue
    // left to speak for. Without this a backoff turns every passed cue into a
    // paid request nobody hears: pump sits out the gate while the queue grows
    // one urgent job per cue — twenty of them across a 60s backoff — and when
    // the gate opens they all go out, all succeed, all get billed, and every
    // reply is dropped by content's staleness check. Before the lane existed
    // these were 429s the provider refused.
    for (const stale of lane.qUrgent.splice(0)) {
      stale.reject(tag(new Error(lane.id + " superseded"), { stale: true, code: "stale" }));
    }
  }
  (job.urgent ? lane.qUrgent : lane.qNormal).push(job);
  // Each kind wakes its own pump on a lane that keeps a slot for the watched
  // line; everywhere else one pump drains both queues, urgent first.
  pump(lane, lane.urgentSlot ? (job.urgent ? "urgent" : "normal") : "");
}

// Take the next batch: the head job decides the target language (one request
// carries one target), then same-target jobs join it up to the size caps.
// Non-matching jobs stay queued and form the next batch — the head is always
// consumed, so the pump cannot spin.
function takeBatch(lane, only) {
  const queues = only === "urgent" ? [lane.qUrgent]
    : only === "normal" ? [lane.qNormal]
    : [lane.qUrgent, lane.qNormal];
  let head = null;
  for (const q of queues) { if ((head = q.shift())) break; }
  if (!head) return [];
  const batch = [head];
  // A solo job carries its own sender (aligned mode) — one sentence per
  // request, so nothing may ride along with it.
  if (lane.maxBatch <= 1 || head.solo) return batch;
  let chars = head.text.length;
  for (const q of queues) {
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

// `only` is "" on a lane with one pump, and "urgent"/"normal" on a lane that
// keeps a slot for the watched line — see makeLane.
async function pump(lane, only) {
  const flag = only === "urgent" ? "pumpingUrgent"
    : only === "normal" ? "pumpingNormal" : "pumping";
  if (lane[flag]) return;
  lane[flag] = true;
  const pending = () => (only === "urgent" ? lane.qUrgent.length
    : only === "normal" ? lane.qNormal.length
    : lane.qUrgent.length + lane.qNormal.length);
  try {
    await hydrated;
    await cfgReady;
    while (pending()) {
      // A loop, not an if: the other pump may have been asleep on this same
      // deadline, woken first, and armed a new one on its way out.
      for (let wait = lane.gateUntil - Date.now(); wait > 0;
           wait = lane.gateUntil - Date.now()) {
        await sleep(wait);
      }
      // Batching lane, nothing urgent pending: wait briefly for neighbours so
      // prefetch travels in one paid request instead of eight.
      if (lane.coalesceMs && !lane.qUrgent.length && lane.qNormal.length < lane.maxBatch) {
        await sleep(lane.coalesceMs);
      }
      const batch = takeBatch(lane, only);
      if (!batch.length) break;
      lane.gateUntil = Date.now() + lane.minIntervalMs;
      // Which backoff episode this send belongs to: read before the request and
      // compared after it, so a second reply carrying the SAME refusal does not
      // double a backoff the first one already doubled. Reading a field cannot
      // throw, so it sits out here where the catch below can still see it —
      // and everything between taking the batch and entering the try is now
      // two assignments, neither of which can throw past the handler that
      // settles these jobs.
      const era = lane.era;
      try {
        // The namespace as it stands at the moment this batch goes out. A job's
        // cache key was built when the request was made, and the provider and
        // model are read again inside send(), behind two storage round trips —
        // long enough for the settings page to change them. Whatever comes back
        // was produced by the configuration in force somewhere across that gap,
        // and if the gap moved, no namespace can honestly claim it: the answer
        // is still returned to the caller, it simply is not filed. Serving one
        // model's output under another model's name is precisely what having a
        // namespace is for.
        const nsBefore = cacheNs();
        const outs = batch[0].send
          ? await batch[0].send()
          : await lane.send(batch.map((j) => j.text), batch[0].targetLang);
        // Recovered — but only if this reply is news. A request that left
        // before a refusal was recorded says nothing about the state the
        // refusal put the lane in, and with two pumps the look-ahead's 200
        // routinely lands after the watched line's 429. Clearing on it meant
        // the next refusal started from the base instead of doubling, so while
        // anything at all was still succeeding the backoff could never reach
        // backoffShedMs — and shedding look-ahead is the one thing that stops
        // a provider that has said stop from being asked six more times.
        if (lane.backoffMs && era === lane.era) {
          lane.backoffMs = 0;
          persistGate(lane);
        }
        if (lane.id === "byo") noteByoStatus("");
        const nsHeld = cacheNs() === nsBefore;
        batch.forEach((job, i) => {
          const out = (outs && outs[i] !== undefined) ? outs[i] : "";
          // Solo jobs resolve with an object and cache on the content side.
          if (nsHeld && job.cacheKey && typeof out === "string" && out) {
            cacheSet(job.cacheKey, out);
          }
          job.resolve(out);
        });
      } catch (err) {
        // Settle first. Everything below is bookkeeping, and a throw in any of
        // it would leave these jobs held by a promise nobody settles — from
        // the content script's side, the worker simply stops answering.
        for (const job of batch) job.reject(err);
        if (err && err.rateLimited && era === lane.era) {
          lane.era++;
          lane.backoffMs = lane.backoffMs
            ? Math.min(lane.backoffMs * 2, lane.backoffMaxMs)
            : lane.backoffBaseMs;
          // 0–25% jitter so parallel tabs don't retry in lockstep
          lane.gateUntil = Date.now() + Math.round(lane.backoffMs * (1 + Math.random() * 0.25));
          persistGate(lane);
        }
        if (lane.id === "byo") noteByoStatus((err && err.code) || "failed");
      }
    }
  } catch (err) {
    // The loop itself came apart — not the request inside it. Everything that
    // was already shifted out of the queue is now held by a promise nobody
    // will ever settle, and the caller's sendResponse is never called: from
    // content.js's side the worker simply stopped answering. Rejecting is the
    // only outcome that is better than silence.
    flushLane(lane, "pump failed: " + ((err && err.message) || err), only);
  } finally {
    lane[flag] = false;
  }
}

// Awaiting cfgReady is load-bearing: a request arriving while the freshly woken
// worker still has default settings would otherwise be routed to the gtx lane
// and answered by Google while the user is on their own engine.
//
// Awaiting `hydrated` is load-bearing for the same reason, one layer down, and
// it used to happen too late. The backoff a rate limit left behind is written
// to session storage and read back when the worker wakes; the read is a real
// round trip. `enqueue` decides whether to shed a prefetch by looking at that
// backoff, and it ran first — so for the whole of that gap the lane looked
// calm, nothing was shed, and prefetches piled into a queue that could not move
// for another forty seconds. The gate then opened onto a burst, which is the
// behaviour the shedding exists to prevent. A worker is killed after thirty
// seconds idle and a deep backoff outlasts that, so this is the ordinary case
// rather than a corner of one.
async function translate(text, targetLang, urgent) {
  await cfgReady;
  await hydrated;
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
// mangled into a NUL by parts of our JSON tooling, and models
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

// The 200 characters of a provider's error body ride back to the page inside
// the Error message, which is how the popup can say something better than
// "failed". Some providers echo the request back in a 400 — headers included —
// and the read-aloud side already has an assertion saying an error text never
// carries a key. The translation side had the same exposure and no such rule.
// Shapes only: nothing here decides whether a string IS a key, it decides that
// a string shaped like one does not get repeated.
function redactSecrets(text) {
  return String(text || "")
    .replace(/\b(sk|xi|AIza)[-_A-Za-z0-9]{12,}/g, "$1-REDACTED")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 REDACTED")
    .replace(/\b(api[-_]?key|authorization|x-goog-api-key|xi-api-key|ocp-apim-subscription-key)\b\s*[:=]\s*"?[A-Za-z0-9._~+/=-]{8,}"?/gi,
      "$1: REDACTED");
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
  try { detail = redactSecrets((await res.text()).slice(0, 200)); }
  catch (_e) { /* ignore */ }
  throw tag(new Error(who + " http " + s + " " + detail), {
    badRequest: true, code: s === 400 || s === 404 ? "badRequest" : "http"
  });
}

// ---------------------------------------------------------------------------
// connection test (popup "test" button)
// ---------------------------------------------------------------------------
// read-aloud (TTS). Synthesis is requested here so the key never leaves the
// worker and host_permissions apply; playback happens in the content script (a
// worker has no audio output).
//
// This block used to say there was deliberately no lane, because the only
// caller was the options page's "save and test". Both halves stopped being
// true: ttsLane is defined with the other two, and content.js asks for a line
// on every cue plus a window of lines ahead of it. ttsTest still bypasses the
// lane — it is a user-initiated probe, not part of the playback stream.
function keyForTts(providerId) {
  return new Promise((resolve) => {
    chrome.storage.local.get({ ttsKeys: {} }, (got) => {
      const keys = (got && got.ttsKeys) || {};
      resolve(String(keys[providerId] || ""));
    });
  });
}

// Same honest-error discipline as resolveByo: every unfinished-setup state has
// its own code, and the message text never contains the key.

// The upper bound on one synthesis request. Deliberately generous: the point
// is to stop a hung socket from owning the "Testing…" button (and, later, the
// lane) until the worker is killed — not to give up on a slow provider.
const TTS_TIMEOUT_MS = 15000;   // synthesis AND the three voice-list fetches:
                                // "Fetch more voices" spins forever otherwise

// Which name to put in a Google request for the language being spoken now.
function googleVoiceName(t, lang) {
  const carried = /^([a-z]{2,3}-[A-Z]{2})-/.exec(t.voice);
  if (carried && carried[1] === lang) return t.voice;   // fetched FOR this language
  const short = carried
    ? (t.provider.defaultVoice || (t.provider.voices || [])[0] || "")
    : t.voice;
  return lang + "-Chirp3-HD-" + short;
}
// Kept next to the request that depends on it, so the menus and the request
// cannot drift. What actually keeps them together is narrower than it used to
// say here: the pickers list the family UNFILTERED, and the family is exempt
// from the language question (ttsVoiceAppliesTo), so for those entries the two
// agree by construction. A FETCHED name is the case both sides do check, and
// they check it with the same predicate.

// lang: the target language the line will be READ in. Optional — the two
// callers that have it pass it, and without it the language check below is
// skipped rather than guessed at.
//
// askedProvider: for the settings page's two buttons ONLY. cfg is refreshed by
// a storage.onChanged listener, which is a different async path from the write
// the page just made — so "save, then test" could reach here before cfg had
// caught up, and Preview could reach here having never written at all (the
// provider dropdown does not save on change; the language one does). Both ways
// the worker resolved a DIFFERENT provider from the one on screen, and the
// honest answer it gave for the browser's own engine — "nothing to synthesize"
// — was rendered by the page as "connection failed", for a request that never
// touched the network. Measured on a real machine 2026-08-24.
// The override only picks WHICH provider; the key, host permission and voice
// checks below are unchanged, so naming a provider you have not configured
// gets the real "no key" answer instead of a spurious success.
async function resolveTts(lang, askedProvider) {
  const p = PROVIDERS.tts.get(askedProvider || cfg.ttsProvider);
  if (!p) throw tag(new Error("no tts provider selected"), { noKey: true, code: "noProvider" });
  // The browser's own voices need no key and no host: there is no endpoint of
  // OURS to authorize. That is not the same as "nothing leaves the machine" —
  // which is what this used to say, and it is not true of all of them. Chrome
  // also offers its own online voices (localService === false; on a Mac those
  // are the three named "Google …"), and for those the browser sends the line
  // to its own maker. Nothing we can gate: the utterance goes through the Web
  // Speech API, not through us. What we can do is not claim otherwise.
  let key = "";
  if (!p.keyless) {
    key = await keyForTts(p.id);
    if (!key) throw tag(new Error("no tts api key"), { noKey: true, code: "noKey" });
    await ensureHostPermission(p.origin);
  }
  // A voice belongs to ONE provider: "alloy" spliced into Google's naming
  // scheme yields zh-CN-Chirp3-HD-alloy, which is a 400 and reads to the user
  // as "read-aloud is broken". A stored voice that is not in this provider's
  // list is stale — a provider switched somewhere that did not rewrite it, or
  // a voice we stopped listing — so the provider's own default wins. The
  // pickers show that same default, which keeps the UI honest about what is
  // actually being spoken.
  const stored = (cfg.ttsVoice || "").trim();
  // "Belongs to this provider" is the built-in family PLUS anything the user
  // fetched for a language on the settings page — otherwise the voice they
  // just picked there would be bounced back to the default by the engine, and
  // the menu would be describing something that never plays. Fetched ids are
  // still shaped like this provider's, which is what the pattern checks.
  // The local engine's voices are whatever this machine has, so the worker
  // cannot vet them — the page that enumerated them is the only authority.
  // "Belongs to this provider" AND "works for the language being read". Both
  // pickers already ask the second question — tts.voiceAppliesTo — and the
  // engine did not, so a voice fetched for Japanese and kept after the target
  // moved to Chinese was spliced straight into the request while both menus
  // showed the family default. The menu said Ava and the speaker said Nanami,
  // reading Chinese. Google was covered by googleVoiceName rebuilding the
  // name; nothing covered Azure. (ElevenLabs is not in this story either way:
  // its ids carry no locale, so the predicate has nothing to read.) And the
  // family a provider SHIPS is exempt — see ttsVoiceAppliesTo for why the
  // first cut of this took Azure's twelve multilingual voices out with it.
  const known = PROVIDERS.tts.voiceOwned(p, stored) &&
    (!lang || PROVIDERS.tts.voiceAppliesTo(p, stored, lang));
  const voice = known ? stored : (p.defaultVoice || (p.voices || [])[0] || "");
  let region = "";
  if (p.needsRegion) {
    // The region is spliced into the request HOST — gate it to a hostname
    // label so a stray value cannot rewrite where the key gets sent.
    region = String(cfg.ttsRegion || "").trim().toLowerCase();
    if (!/^[a-z0-9]{1,42}$/.test(region)) {
      throw tag(new Error("no azure region"), { noKey: true, code: "noRegion" });
    }
  }
  return { provider: p, key, voice, model: p.defaultModel, region };
}



// Qwen-TTS speaks ten languages, not fifty; anything else is refused the same
// honest way Chirp 3 refuses what it has no voice for.
const QWEN_TTS_LANGS = new Set([
  "zh-CN", "zh-TW", "en", "fr", "de", "ru", "it", "es", "pt", "ja", "ko"
]);

// DashScope streams speech back as base64 PCM segments — 24 kHz, 16-bit,
// mono — with the finished file only offered as a URL on a storage host we
// deliberately do not ask permission for. Wrapping the samples in a WAV header
// here keeps everything on the one origin the user already granted.
function wavFromPcm(pcm, sampleRate) {
  const rate = sampleRate || 24000;
  const out = new Uint8Array(44 + pcm.length);
  const dv = new DataView(out.buffer);
  const ascii = (off, str) => {
    for (let i = 0; i < str.length; i++) out[off + i] = str.charCodeAt(i);
  };
  ascii(0, "RIFF");
  dv.setUint32(4, 36 + pcm.length, true);
  ascii(8, "WAVEfmt ");
  dv.setUint32(16, 16, true);          // PCM header size
  dv.setUint16(20, 1, true);           // format = PCM
  dv.setUint16(22, 1, true);           // mono
  dv.setUint32(24, rate, true);
  dv.setUint32(28, rate * 2, true);    // byte rate (mono, 16-bit)
  dv.setUint16(32, 2, true);           // block align
  dv.setUint16(34, 16, true);          // bits per sample
  ascii(36, "data");
  dv.setUint32(40, pcm.length, true);
  out.set(pcm, 44);
  return out;
}

// What the bytes coming out of ttsSynthesize actually are. Everything is mp3
// except Qwen, which arrives as PCM and leaves here wrapped as a WAV.
function ttsMime(provider) {
  return provider && provider.kind === "qwen-tts" ? "audio/wav" : "audio/mpeg";
}

function bytesFromB64(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// DashScope answers HTTP 200 and then puts the failure IN the stream: an event
// that is valid JSON and carries code + message instead of audio. Parsing it
// succeeds, so the read used to end with "no audio at all" — badShape, which
// carries no rateLimited flag, so the lane never backed off and the look-ahead
// went on firing into a provider that had already said stop. Mapped here onto
// the same vocabulary the HTTP statuses use, so one backend fault gets one
// answer whichever way it arrives.
function qwenBizError(payload) {
  const code = payload && typeof payload.code === "string" ? payload.code : "";
  if (!code) return null;
  let msg = "";
  try { msg = redactSecrets(String(payload.message || "").slice(0, 200)); }
  catch (_e) { /* the code alone is enough to classify */ }
  const err = new Error("qwen " + code + (msg ? " " + msg : ""));
  // The allowance being used up before the rate limit: Throttling.RateQuota is
  // requests-per-second and clears by itself, Throttling.AllocationQuota is the
  // free grant being gone and does not.
  if (/Arrearage|AllocationQuota|InsufficientQuota|QuotaExhausted/i.test(code)) {
    return tag(err, { rateLimited: true, code: "quota" });
  }
  if (/^Throttling|RateLimit|TooManyRequests/i.test(code)) {
    return tag(err, { rateLimited: true, code: "limited" });
  }
  if (/ApiKey|Unauthorized|AccessDenied|Forbidden/i.test(code)) {
    return tag(err, { authFailed: true, code: "auth" });
  }
  return tag(err, { code: "refused" });
}

// Has this provider said "you have run out", rather than "slow down" or "who
// are you"? Both of the two that do it hide it behind a status that means
// something else, and the wording those statuses earn points the reader at a
// fix that does not exist. Bounded and best-effort: the body is only ever used
// to choose between two sentences, so failing to read it costs the better one
// and nothing more.
async function ttsOutOfCredit(res) {
  let body = "";
  try { body = String(await res.text()).slice(0, 400); } catch (_e) { return false; }
  return /insufficient_quota|quota_exceeded|exceeded your current quota|out of credits?/i
    .test(body);
}

// One more try for a connection that failed outright, the way the translate
// side has treated a dropped connection since withNetRetry was written — a
// blink of the network used to cost a whole line. Deliberately narrower than
// that one: a timeout has already spent fifteen seconds and the line it was
// for is long past, and anything the provider actually ANSWERED — a refusal, a
// throttle, an exhausted allowance — is not made truer by asking again, while
// every ask costs the user money.
async function withTtsRetry(run) {
  try {
    return await run();
  } catch (err) {
    if (!err || !err.netfail || err.timedOut) throw err;
    await sleep(600);
    return run();
  }
}

// The status rule for every read-aloud request — synthesis and voice list
// alike. It is deliberately not the shared throwForStatus: that one is the
// translate side's and calls every 5xx a rate limit. Having two rules behind
// two buttons of the same card meant one backend fault got two explanations,
// depending on whether the user pressed test or fetch voices.
async function ttsThrowForStatus(res) {
  if (res.status === 401 || res.status === 403) {
    // An exhausted allowance dressed as a rejected key: some ElevenLabs
    // accounts answer 401 for it. "Check that the key was copied in full"
    // sends the reader to look for a fault in a key that is fine.
    const spent = await ttsOutOfCredit(res);
    throw tag(new Error("tts auth " + res.status),
      spent ? { rateLimited: true, code: "quota" } : { code: "auth" });
  }
  if (res.status === 429 || res.status >= 500) {
    // Both mean "back off", but they do not mean the same thing to the reader.
    // 429, and Azure's documented 503, get the rate-limit wording; a plain 500
    // or 502 falls through to errorKey's default, "Connection failed. Try
    // again in a moment.", which is the truth. What none of them may be is
    // badRequest: that text sends the user off to check a model name and a
    // base URL that are perfectly fine.
    const throttled = res.status === 429 || res.status === 503;
    // …and the other way round: OpenAI returns 429 when the credit is gone.
    // The rate-limit wording promises it will pass, and this will not.
    const spent = res.status === 429 && await ttsOutOfCredit(res);
    throw tag(new Error("tts http " + res.status), {
      rateLimited: true,
      code: spent ? "quota" : (throttled ? "limited" : "server")
    });
  }
  // Anything else the provider refused — 400, 404, 415, 422. NOT badRequest:
  // that sentence names a model name and a base URL, the translate card's two
  // fields, and the read-aloud card has neither. A retired ElevenLabs voice id
  // (404, and the id is in the path) sent the reader off to check two controls
  // they cannot see, past the one control that is actually wrong.
  if (!res.ok) throw tag(new Error("tts http " + res.status), { code: "refused" });
}

// The most of a line that qwen3-tts-flash will accept, cut where a listener
// would not notice the seam. Not a general splitter: one line, one request —
// speaking half a sentence and then half of the next one is worse than
// speaking one whole clause.
const QWEN_TTS_MAX_CHARS = 600;
function qwenFit(text) {
  const s = String(text || "");
  if (s.length <= QWEN_TTS_MAX_CHARS) return s;
  const head = s.slice(0, QWEN_TTS_MAX_CHARS);
  const at = (marks) => {
    let best = -1;
    for (const m of marks) best = Math.max(best, head.lastIndexOf(m));
    return best;
  };
  const cut = at(["。", "！", "？", ".", "!", "?", "\n"]);
  const soft = cut > 40 ? cut : at(["，", "；", "：", ",", ";", ":", " "]);
  return (soft > 40 ? head.slice(0, soft + 1) : head).trim();
}

// Read a DashScope SSE body and hand back everything its data: lines carried.
async function qwenPcmFromSse(res) {
  const reader = res.body && res.body.getReader ? res.body.getReader() : null;
  if (!reader) throw tag(new Error("no stream"), { code: "badShape" });
  const dec = new TextDecoder();
  const parts = [];
  let total = 0;
  let buf = "";
  // Whatever happens below, let go of the body. A reader abandoned mid-stream
  // holds the connection until the worker is collected, and this one is thrown
  // out of by a business error in the middle of a stream.
  const release = () => {
    try { reader.cancel(); } catch (_e) { /* already done with it */ }
  };
  const takeLine = (line) => {
    if (line.slice(0, 5) !== "data:") return;
    let payload;
    try { payload = JSON.parse(line.slice(5).trim()); } catch (_e) { return; }
    const d = payload && payload.output && payload.output.audio &&
      payload.output.audio.data;
    if (!d) {
      const err = qwenBizError(payload);
      if (err) throw err;
      return;
    }
    const chunk = bytesFromB64(d);
    parts.push(chunk);
    total += chunk.length;
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        takeLine(buf.slice(0, nl).trim());
        buf = buf.slice(nl + 1);
      }
    }
    // The last event need not end in a newline, and a multi-byte character can
    // be sitting half-decoded in the decoder. Both used to be dropped, which
    // takes the end off the spoken line.
    buf += dec.decode();
    if (buf.trim()) takeLine(buf.trim());
  } finally {
    release();
  }
  if (!total) throw tag(new Error("qwen returned no audio"), { code: "badShape" });
  const pcm = new Uint8Array(total);
  let at = 0;
  for (const part of parts) { pcm.set(part, at); at += part.length; }
  return pcm;
}

const escapeXml = (s) => String(s).replace(/[<>&'"]/g, (c) => (
  { "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]
));

// One utterance -> base64 audio (the shape both callers keep), one branch per
// provider kind. Google answers base64 JSON natively; the binary kinds are
// encoded here so the cache and the message envelope stay one format.
async function ttsSynthesize(text, t, targetLang) {
  const kind = t.provider.kind;
  let req;
  if (kind === "azure-speech") {
    req = {
      url: "https://" + t.region + ".tts.speech.microsoft.com/cognitiveservices/v1",
      init: {
        method: "POST",
        headers: {
          "Ocp-Apim-Subscription-Key": t.key,
          "Content-Type": "application/ssml+xml",
          "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3"
        },
        // xml:lang names the DOCUMENT language; the Multilingual voice family
        // detects and follows the language of the text itself.
        body: "<speak version='1.0' xml:lang='en-US'><voice name='" + t.voice + "'>" +
          escapeXml(text) + "</voice></speak>"
      }
    };
  } else if (kind === "google-tts") {
    const lang = PROVIDERS.tts.localeFor.google[targetLang || ""];
    if (!lang) {
      throw tag(new Error("chirp has no " + (targetLang || "?")),
        { unsupportedTarget: true, code: "unsupportedTarget" });
    }
    req = {
      url: t.provider.baseUrl + "/v1/text:synthesize",
      init: {
        method: "POST",
        headers: { "X-Goog-Api-Key": t.key, "Content-Type": "application/json" },
        body: JSON.stringify({
          input: { text: text },
          // A fetched name already carries its locale and family; only the
          // short family names get assembled. But a fetched name is PINNED to
          // the language it was fetched for, and the reader can change target
          // language afterwards — that sent languageCode ja-JP carrying a
          // cmn-CN name, which is a 400 and a line that never speaks. The short
          // family name is the one that follows the reader, so it answers.
          voice: {
            languageCode: lang,
            name: googleVoiceName(t, lang)
          },
          audioConfig: { audioEncoding: "MP3" }
        })
      }
    };
  } else if (kind === "elevenlabs") {
    req = {
      url: t.provider.baseUrl + "/v1/text-to-speech/" + encodeURIComponent(t.voice) +
        "?output_format=mp3_44100_128",
      init: {
        method: "POST",
        headers: { "xi-api-key": t.key, "Content-Type": "application/json" },
        body: JSON.stringify({ text: text, model_id: t.model || "eleven_multilingual_v2" })
      }
    };
  } else if (kind === "qwen-tts") {
    if (!QWEN_TTS_LANGS.has(targetLang || "")) {
      throw tag(new Error("qwen-tts has no " + (targetLang || "?")),
        { unsupportedTarget: true, code: "unsupportedTarget" });
    }
    // qwen3-tts-flash refuses more than 600 characters with a 400, and a 400
    // is a refusal we would tell the reader to fix by changing voice — which
    // would not help, because the fault is the length. A line can only get
    // here that long if a translation more than doubled a source already
    // capped at MAX_GROUP_CHARS, so this is a last resort and not a budget:
    // cut at the last sentence end, then the last clause break, and only fall
    // back to a hard cut if the line has no punctuation at all.
    text = qwenFit(text);
    req = {
      url: t.provider.baseUrl +
        "/api/v1/services/aigc/multimodal-generation/generation",
      init: {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + t.key,
          "Content-Type": "application/json",
          // Streaming is not for speed here: the non-streaming reply hands
          // back only a URL on a storage host, and asking for that host is a
          // permission the feature does not need.
          "X-DashScope-SSE": "enable"
        },
        body: JSON.stringify({
          model: t.model || "qwen3-tts-flash",
          input: { text: text, voice: t.voice }
        })
      }
    };
  } else {
    req = {
      url: t.provider.baseUrl + "/audio/speech",
      init: {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + t.key,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: t.model,
          voice: t.voice,
          input: text,
          response_format: "mp3"
        })
      }
    };
  }
  let res;
  try {
    // Synthesis is the only fetch in this worker with no upper bound on it.
    // A connection that opens and then goes quiet keeps "Testing…" on the
    // settings page until the service worker is killed thirty seconds later,
    // and the user is looking at a button that will never answer. An abort
    // lands in the catch below as netfail — "cannot reach that endpoint",
    // which is what happened. 15s is generous for one sentence.
    res = await fetch(req.url, Object.assign({}, req.init, {
      signal: AbortSignal.timeout(TTS_TIMEOUT_MS)
    }));
  } catch (e) {
    // Which kind of "no answer" this was. A dropped connection is worth one
    // more try; the fifteen-second timeout above is not — see withTtsRetry.
    const timedOut = !!e && (e.name === "TimeoutError" || e.name === "AbortError");
    throw tag(new Error("tts fetch failed"),
      { netfail: true, timedOut: timedOut, code: "netfail" });
  }
  await ttsThrowForStatus(res);
  if (kind === "google-tts") {
    let data;
    try { data = await res.json(); } catch (_e) { data = null; }
    const b64 = data && typeof data.audioContent === "string" ? data.audioContent : "";
    if (!b64) throw tag(new Error("tts empty audio"), { code: "noAudio" });
    return b64;
  }
  if (kind === "qwen-tts") {
    return b64FromBuf(wavFromPcm(await qwenPcmFromSse(res), 24000).buffer);
  }
  const buf = await res.arrayBuffer();
  if (!buf || buf.byteLength === 0) {
    throw tag(new Error("tts empty audio"), { code: "noAudio" });
  }
  return b64FromBuf(buf);
}

// The language a settings-page message names, if it is one we offer: shape
// checked so nothing unprintable can ride in it, then membership checked
// against the one list of target languages. Anything else answers "", and the
// caller reads storage as before.
function ttsAskedLang(raw) {
  const s = String(raw || "");
  if (!/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(s)) return "";
  return self.YTDS_LANGS && self.YTDS_LANGS.get && self.YTDS_LANGS.get(s) ? s : "";
}

// User-initiated probe from the options page — the read-aloud twin of byoTest.
// The probe speaks in the CURRENT target language: for Google that is the
// language the voice name is built from, so testing anything else would pass
// on a voice that then fails on the first real subtitle.
async function ttsTest(voiceOverride, asked) {
  // The language first, and then resolve WITH it. This was the one path that
  // resolved without it, which made it the one path that would cheerfully
  // sample a voice the video is not going to get: the settings page said
  // "connected — sampled with Xiaoyi", played Xiaoyi, and YouTube then read
  // the line in the family default. A button whose whole job is to tell you
  // whether this will work has to be asked the same question the playback is.
  //
  // The page may name the language too. The language dropdown DOES write on
  // change, so reading storage is usually right — but "usually" is the same
  // race the provider had, one storage round-trip wide, and a button pressed
  // the instant after a change is exactly when it is open. Shape-checked
  // rather than trusted: a value that is not a language tag is ignored, not
  // spliced into a request.
  const a = asked || {};
  // Shape first, then membership. The shape alone let "en-US" through — well
  // formed, not one of our fifty — and the Google path then threw
  // unsupportedTarget for a language the extension does not offer, while
  // playback, reading the stored code, worked fine. An unknown code falls
  // back to storage exactly like a malformed one.
  const named = ttsAskedLang(a.targetLang);
  const targetLang = named || await new Promise((resolve) => {
    chrome.storage.sync.get({ targetLang: "zh-CN" }, (got) => {
      resolve((got && got.targetLang) || "zh-CN");
    });
  });
  const t = await resolveTts(targetLang, a.provider);
  if (t.provider.kind === "local-speech") {
    // Nothing to probe: no key, no endpoint. The settings page speaks the
    // sample itself, which IS the test.
    return { bytes: 0, ms: 0, voice: voiceOverride || t.voice, local: true,
      lang: targetLang };
  }
  // Previewing a voice you have not saved yet is the whole point of a preview:
  // the caller may name one, and it is honoured only if it belongs to the
  // provider actually resolved — the same predicate resolveTts applies to what
  // is in storage, not a second opinion. The second opinion this replaces was
  // the built-in table alone, which refuses every FETCHED voice: exactly the
  // ones a preview exists for. You pressed Preview on the name you had just
  // pulled down, heard the family default, and chose from that.
  if (voiceOverride && PROVIDERS.tts.voiceOwned(t.provider, voiceOverride)) {
    t.voice = voiceOverride;
  }
  // A sentence in the language being READ, not "Hi." — the point is to hear
  // this voice speak your language, and an English probe passes on a voice
  // that then mangles the first real subtitle.
  const line = (self.YTDS_LANGS && self.YTDS_LANGS.sample(targetLang)) || "Hi.";
  const started = Date.now();
  const b64 = await withTtsRetry(() => ttsSynthesize(line, t, targetLang));
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  const bytes = Math.floor(b64.length * 3 / 4) - pad;
  // The audio rides back so the settings page can play what it just paid for.
  return { bytes, ms: Date.now() - started, voice: t.voice, b64,
    mime: ttsMime(t.provider) };
}

// Speech for one subtitle line, as base64 the content script can turn into a
// Blob — sendMessage is JSON, an ArrayBuffer would not survive the trip. Small
// LRU so a replayed or re-entered cue does not bill the user twice; keyed by
// provider+voice+text because a voice change must not serve the old voice.
const TTS_CACHE = new Map();
const TTS_CACHE_MAX = 30;

function b64FromBuf(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const STEP = 0x8000;            // String.fromCharCode arg-count limit safety
  for (let i = 0; i < bytes.length; i += STEP) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + STEP));
  }
  return btoa(bin);
}

async function ttsSpeak(text, targetLang, urgent) {
  const line = String(text || "").trim();
  if (!line) throw tag(new Error("tts empty input"), { code: "badRequest" });
  const t = await resolveTts(targetLang);
  // Local speech never becomes bytes: a service worker has no
  // speechSynthesis, and there would be nothing to cache anyway. The reply
  // says "say this yourself" and the page that has a speaker does it.
  if (t.provider.kind === "local-speech") {
    return { local: true, voice: t.voice, lang: targetLang || "", cached: false };
  }
  // The language is part of the identity: the same line synthesized under a
  // different target is different audio (Google even bakes it into the voice).
  const key = t.provider.id + "|" + t.voice + "|" + (targetLang || "") + "|" + line;
  const hit = TTS_CACHE.get(key);
  if (hit) {
    TTS_CACHE.delete(key);        // refresh recency
    TTS_CACHE.set(key, hit);
    return { b64: hit, mime: ttsMime(t.provider), cached: true };
  }
  // Only now — a cache hit must not wait on a round trip, and it cannot be
  // shed either. Past this point the request is going to the network, so the
  // backoff that a rate limit left behind has to be in memory before enqueue
  // decides whether to shed: that read is a real cross-process round trip and
  // running it after the decision is precisely the bug d5e7063 fixed on the
  // translation side.
  await hydrated;
  const b64 = await new Promise((resolve, reject) => enqueue(ttsLane, {
    text: line,
    targetLang: targetLang || "",
    urgent: !!urgent,
    // No cacheKey: TTS has its own store below. Handing one to the lane would
    // file audio under a translation namespace.
    send: () => withTtsRetry(() => ttsSynthesize(line, t, targetLang))
      .then((out) => [out]),
    resolve, reject
  }));
  TTS_CACHE.set(key, b64);
  if (TTS_CACHE.size > TTS_CACHE_MAX) {
    const oldest = TTS_CACHE.keys().next().value;
    TTS_CACHE.delete(oldest);
  }
  return { b64, mime: ttsMime(t.provider), cached: false };
}

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
async function byoModels(providerId) {
  const t = await resolveByo({ needModel: false, provider: providerId });
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

// The read-aloud twin of byoModels: the voices this provider has FOR THE
// LANGUAGE BEING READ. Deliberately a button on the settings page rather than
// something the popup does on open — a menu that needs the network is a menu
// that is empty on a train, and the built-in family list is the answer when
// this fails. Google filters server-side; Azure returns everything it has and
// is narrowed here, which is why the result is cached rather than re-fetched.
async function ttsVoices(asked) {
  // Same two races the test button had, and it got neither fix at the time:
  // the provider dropdown does not write on change, and cfg refreshes on a
  // different async path than the page's write — so "fetch voices" could ask
  // whatever storage still held instead of the provider on screen.
  const a = asked || {};
  const t = await resolveTts(undefined, a.provider);
  const p = t.provider;
  if (!p.listVoices) return { voices: [], listable: false };
  const targetLang = ttsAskedLang(a.targetLang) || await new Promise((resolve) => {
    chrome.storage.sync.get({ targetLang: "zh-CN" }, (got) => {
      resolve((got && got.targetLang) || "zh-CN");
    });
  });
  let res;
  if (p.kind === "google-tts") {
    const lang = PROVIDERS.tts.localeFor.google[targetLang || ""];
    if (!lang) {
      throw tag(new Error("chirp has no " + targetLang),
        { unsupportedTarget: true, code: "unsupportedTarget" });
    }
    try {
      res = await fetch(p.baseUrl + "/v1/voices?languageCode=" + encodeURIComponent(lang),
        { headers: { "X-Goog-Api-Key": t.key }, signal: AbortSignal.timeout(TTS_TIMEOUT_MS) });
    } catch (_e) {
      throw tag(new Error("voices fetch failed"), { netfail: true, code: "netfail" });
    }
    await ttsThrowForStatus(res);
    const data = await res.json().catch(() => null);
    const names = ((data && data.voices) || [])
      .map((v) => v && v.name).filter(Boolean);
    return { voices: names, listable: true };
  }
  if (p.kind === "elevenlabs") {
    // 100 is the largest page the endpoint serves, and a library of cloned
    // voices goes past it. Without following the token the menu stopped at the
    // first hundred and everything after it looked deleted. Bounded at five
    // pages: a request per page against a 15s timeout each, and five hundred
    // entries is already more than a dropdown can be read at.
    // A Set, not an array: a page that repeats — see the token check below —
    // must not put the same voice in the menu twice, and neither must an
    // overlap between two pages of a library someone is editing while we walk
    // it. Insertion order is kept, so the list is still the endpoint's order.
    const seen = new Set();
    const names = {};
    let token = "";
    for (let page = 0; page < 5; page++) {
      try {
        res = await fetch(p.baseUrl + "/v2/voices?page_size=100" +
          (token ? "&next_page_token=" + encodeURIComponent(token) : ""),
          { headers: { "xi-api-key": t.key }, signal: AbortSignal.timeout(TTS_TIMEOUT_MS) });
      } catch (_e) {
        throw tag(new Error("voices fetch failed"), { netfail: true, code: "netfail" });
      }
      await ttsThrowForStatus(res);
      const data = await res.json().catch(() => null);
      for (const v of (data && data.voices) || []) {
        if (!v || !v.voice_id) continue;
        seen.add(v.voice_id);
        // The id is opaque; the service just told us what it is called. Losing
        // that turns the picker into a column of tokens.
        if (v.name) names[v.voice_id] = String(v.name);
      }
      const next = (data && data.has_more && data.next_page_token) || "";
      // A server that does not recognise the parameter answers page one again,
      // and hands back the same token with it. Following that asks five times
      // for one page and lists every voice five times — worse than the
      // truncation this loop replaced. The token has to move for us to.
      if (!next || next === token) break;
      token = next;
    }
    return { voices: [...seen], names: names, listable: true };
  }
  // azure-speech
  try {
    res = await fetch("https://" + t.region + ".tts.speech.microsoft.com" +
      "/cognitiveservices/voices/list",
      { headers: { "Ocp-Apim-Subscription-Key": t.key },
        signal: AbortSignal.timeout(TTS_TIMEOUT_MS) });
  } catch (_e) {
    throw tag(new Error("voices fetch failed"), { netfail: true, code: "netfail" });
  }
  await ttsThrowForStatus(res);
  const data = await res.json().catch(() => null);
  const want = PROVIDERS.tts.localeFor.azure[targetLang || ""] || "";
  const names = ((data && Array.isArray(data)) ? data : [])
    // Only neural voices, and only the language being read: the raw list is
    // several hundred long and most of it cannot say a word of it.
    .filter((v) => v && v.ShortName && /Neural/i.test(v.VoiceType || v.ShortName))
    .filter((v) => !want || String(v.Locale || "").toLowerCase() === want.toLowerCase())
    .map((v) => v.ShortName);
  return { voices: names, listable: true };
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

// Map a browser language code onto one of the shipped target languages, or ""
// when it isn't offered. zh needs script handling; a few codes have legacy or
// sibling spellings; everything else matches on the base tag.
function mapAcceptToTarget(code) {
  const c = String(code || "").replace(/_/g, "-").toLowerCase();
  if (!c) return "";
  if (c.indexOf("zh") === 0) {
    return /hant|-tw|-hk|-mo/.test(c) ? "zh-TW" : "zh-CN";
  }
  const base = c.split("-")[0];
  const alias = { nb: "no", nn: "no", tl: "fil", he: "iw", in: "id" };
  const cand = alias[base] || base;
  return LANGS.get(cand) ? cand : "";
}

// First install only: guess the translation target from the browser's own
// preferred-content languages. The UI language is the wrong signal on its own —
// much of the measured user base reads Chinese on an English-UI browser, and
// their accept-languages list usually still carries zh. The guess is written
// once, only when sync holds no targetLang (a reinstall under the same account
// keeps whatever the user had), and the start page shows it with a one-click
// change. Existing users are never touched: the static default stays zh-CN.
function deriveTargetLang() {
  try {
    chrome.storage.sync.get("targetLang", (got) => {
      if (got && typeof got.targetLang === "string" && got.targetLang) return;
      const uiLangCode = () => {
        try { return (chrome.i18n && chrome.i18n.getUILanguage && chrome.i18n.getUILanguage()) || ""; }
        catch (_e) { return ""; }
      };
      const finish = (codes) => {
        let pick = "";
        for (const c of codes) { pick = mapAcceptToTarget(c); if (pick) break; }
        try { chrome.storage.sync.set({ targetLang: pick || "en" }); } catch (_e) { /* ignore */ }
      };
      try {
        chrome.i18n.getAcceptLanguages((accepts) => {
          finish([].concat(accepts || [], [uiLangCode()]));
        });
      } catch (_e) { finish([uiLangCode()]); }
    });
  } catch (_e) { /* ignore */ }
}

chrome.runtime.onInstalled.addListener((details) => {
  const cur = chrome.runtime.getManifest().version;
  if (details.reason === "install") {
    deriveTargetLang();
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
  if (msg && msg.type === "openOptions") {
    // The in-player menu's settings row. A content script cannot call
    // openOptionsPage itself; this is the whole errand.
    try { chrome.runtime.openOptionsPage(); } catch (_e) { /* ignore */ }
    sendResponse({ ok: true });
    return false;
  }
  if (msg && msg.type === "videoLeft") {
    dropPlaybackJobs(gtxLane, "left the video");
    dropPlaybackJobs(byoLane, "left the video");
    // Read-aloud is playback too, and on a run of shorts a queue of lines for
    // a video nobody is watching is exactly the traffic that earns the next
    // rate limit — which the NEXT short then waits out in silence.
    dropPlaybackJobs(ttsLane, "left the video");
    sendResponse({ ok: true });
    return false;
  }
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
  if (msg && msg.type === "ttsVoices") {
    cfgReady
      .then(() => ttsVoices({ provider: msg.provider, targetLang: msg.targetLang }))
      .then((r) => sendResponse({ ok: true, voices: r.voices, listable: r.listable }))
      .catch((err) => sendResponse({
        ok: false,
        code: (err && err.code) || "failed",
        error: String(err)
      }));
    return true;
  }
  if (msg && msg.type === "byoModels") {
    cfgReady
      .then(() => byoModels(msg.provider))
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
  if (msg && msg.type === "ttsTest") {
    cfgReady
      .then(() => ttsTest(msg.voice, { provider: msg.provider, targetLang: msg.targetLang }))
      .then((r) => sendResponse({ ok: true, bytes: r.bytes, ms: r.ms, voice: r.voice,
        b64: r.b64, mime: r.mime, local: r.local, lang: r.lang }))
      .catch((err) => sendResponse({
        ok: false,
        code: (err && err.code) || "failed",
        error: String(err)
      }));
    return true;
  }
  if (msg && msg.type === "ttsSpeak") {
    cfgReady
      .then(() => ttsSpeak(msg.text, msg.targetLang, msg.urgent))
      .then((r) => sendResponse({ ok: true, b64: r.b64, mime: r.mime, cached: r.cached,
        local: r.local, voice: r.voice, lang: r.lang }))
      .catch((err) => sendResponse({
        ok: false,
        // A shed is not a failure of this request, it is the lane still
        // waiting out a rate limit — which is what "limited" already says,
        // and what the extension is in fact doing. Reporting it as the
        // generic failure would blame the provider for the pacing we chose.
        code: (err && err.shed) ? "limited" : ((err && err.code) || "failed"),
        shed: !!(err && err.shed),
        error: String(err)
      }));
    return true;
  }
});
