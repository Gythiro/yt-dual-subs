// content.js — isolated world.
// Renders YouTube bilingual subtitles as a single non-overlapping layer.
//
// Two paths:
//   (A) CUE MODE  — inject.js (MAIN world) captures the player's pot-bearing
//       timedtext URL, fetches json3 cues (+ optional tlang translation aligned
//       cue-for-cue), and posts them here. We drive an overlay off currentTime,
//       switching PER-SENTENCE (no per-word jitter).
//   (B) FALLBACK  — if no cues arrive (nocues), fall back to v1 rendered-scrape:
//       poll .ytp-caption-segment every 200ms, debounce gtx translate.
(() => {
  "use strict";

  // ---- guard against double injection (mirror inject.js) -------------------
  // In normal MV3 operation this runs once per document, but an extension
  // reload (or a future move to programmatic injection) could re-run it; the
  // guard prevents accumulating listeners / cue loops / duplicate overlays.
  if (window.__ytdsContentLoaded) return;
  window.__ytdsContentLoaded = true;

  // ---- i18n ----------------------------------------------------------------
  // Safe wrapper around chrome.i18n.getMessage: returns the localized string,
  // or the supplied fallback if i18n is unavailable / the key is missing, so
  // nothing breaks if a message is absent.
  // The interface-language override. chrome.i18n answers in the browser's
  // language; a reader who chose German on an English Chrome had German
  // menus in the popup and English ones in the player (twenty-three
  // strings: the corner menu, the whole summary panel, the handle and
  // toggle titles, the dub toast). The chosen table comes from the worker —
  // a content script cannot fetch its own extension's files — and until it
  // arrives, or on "auto", lookups fall through to chrome.i18n as before.
  let uiTable = null;
  function uiSubst(entry, subs) {
    let msg = String(entry.message || "");
    const ph = entry.placeholders || {};
    for (const name of Object.keys(ph)) {
      const idx = parseInt(String(ph[name].content || "").slice(1), 10);
      const val = subs && subs[idx - 1] != null ? String(subs[idx - 1]) : "";
      msg = msg.replace(new RegExp("\\$" + name + "\\$", "gi"), val);
    }
    return msg;
  }
  function loadUiTable() {
    try {
      chrome.runtime.sendMessage({ type: "uiTable" }, (table) => {
        void chrome.runtime.lastError;
        uiTable = (table && typeof table === "object") ? table : null;
      });
    } catch (_e) { /* orphaned or not yet ready: keep chrome.i18n */ }
  }
  const t = (k, fb) => {
    if (uiTable && uiTable[k] && uiTable[k].message) return uiSubst(uiTable[k]);
    return (chrome.i18n && chrome.i18n.getMessage(k)) || fb;
  };

  // ---- shared settings model -----------------------------------------------
  // Agrees with popup.js DEFAULTS on every key both hold; the two are not the
  // same list (see the note there). ttsComplete lives here and not there.
  const DEFAULTS = {
    enabled: true,
    targetLang: "zh-CN",
    uiLocale: "auto",          // interface language (popup/options); the four
                               // strings this file shows follow the browser
                               // locale — accepted, see the design spec
    ttsEnabled: false,         // read the translation line aloud (needs a
                               // configured read-aloud provider; off by default)
    ttsVolume: 100,            // spoken line's own loudness, 0-100 (Audio.volume)
    ttsDuckPct: 25,            // original audio while a line speaks, as % of the
                               // user's own volume (inject.js ducks to this)
    // Steady cruise — backdoor keys: no UI, no locale strings; tuned by ear
    // from the console until the defaults settle. In a dense stretch speech
    // is floored at ttsCruiseRate and EVERY line ships a fit of
    // ttsCruiseVideo × the user's own rate, instead of per-line firefighting.
    ttsCruise: true,
    ttsCruiseRate: 1.25,
    ttsCruiseVideo: 0.85,
    // Read every line to its end, letting the picture sink as deep as the
    // line needs (floored at 25% of the user's own rate) instead of holding
    // the 0.76 floor and cutting the tail. Off by default: it trades speed
    // for completeness, and that is the listener's call (D114).
    ttsComplete: false,
    engine: "auto",              // "auto" | "tlang" | "gtx" | "byo" (source of
                                 // truth since 3.4; "byo" = own key, since 3.6)
    backend: "tlang",            // legacy pre-3.4 key ("tlang" | "gtx"); kept as a
                                 // mirror so not-yet-updated devices on the same
                                 // sync profile still read a value they understand
    // BYO-key engine (3.6). The key itself lives in storage.local, never sync.
    byoProvider: "",             // providers.js id
    byoModel: "",                // empty = the provider's default model
    byoBaseUrl: "",              // custom provider only (https, validated)
    updateNotes: true,           // used by background.js only; listed so the
                                 // popup.js DEFAULTS contract stays in sync
    order: "orig-top",           // which line on top: "orig-top" | "trans-top"
    rowGap: 4,                   // px between the two lines
    position: "bottom",          // preset anchor: "top" | "center" | "bottom"
    posMode: "preset",           // "preset" | "custom" (custom set by dragging)
    // Let the pointer reach the two subtitle lines so their text can be
    // selected and copied (asked for by a reader collecting vocabulary,
    // 2026-08-24). OFF by default and that is deliberate: the overlay sits in
    // the click-to-pause hotspot at the bottom of the picture, and click-
    // through is a contract every viewer relies on. Most people never copy a
    // line; the ones who do turn this on once.
    selectText: false,
    posXpct: 50,                 // % of player width  (overlay center x) when custom
    posYpct: 90,                 // % of player height (overlay center y) when custom
    // original line
    showOriginal: true,
    origFont: "system",
    origSize: 22,
    origColor: "#ffffff",
    origBg: "#080808",
    origBgOpacity: 0.6,
    origStroke: "#000000",
    origStrokeOpacity: 0,        // 0 => no outline
    // translation line
    showTranslation: true,
    transFont: "system",
    transSize: 24,
    transColor: "#ffe98a",
    transBg: "#080808",
    transBgOpacity: 0.6,
    transStroke: "#000000",
    transStrokeOpacity: 0
  };

  // The stored font value -> font-family, through the one builder in fonts.js
  // (loaded before this file by the manifest). A "f:<id>" value is a font from
  // the reader's computer; the fifteen keys that shipped through 3.6 still map
  // to the stacks they always had. The builder quotes and escapes the name —
  // it is the only outside string this script ever writes into CSS.
  function fontStack(key) {
    const F = self.YTDS_FONTS;
    if (!F) return 'system-ui, -apple-system, "Segoe UI", sans-serif';
    let css = F.css(key);
    // An imported face is registered on this page under a name minted per
    // page (importAlias): the stored id is unique to this reader and would
    // otherwise sit in the page's inline style for any script to read.
    const id = F.isFont(key) ? F.idOf(key) : "";
    if (id && importAlias.has(id)) css = css.replace(F.quote(id), F.quote(importAlias.get(id)));
    return css;
  }
  const importAlias = new Map();

  // A font the reader imported is not on this computer as far as YouTube's
  // page knows: it exists only as a copy in the extension's storage, which
  // this script cannot open. Ask the worker for the bytes once and register
  // the face on this document; the lines that name it re-resolve on their
  // own. Until it arrives (or if it never does) the family falls through to
  // the system stack that "System default" uses.
  const importFontsAsked = new Set();
  function ensureImportFont(value) {
    const F = self.YTDS_FONTS;
    if (!F || !F.isFont(value)) return;
    const id = F.idOf(value);
    if (!F.isImport(id) || importFontsAsked.has(id)) return;
    importFontsAsked.add(id);
    extCall(() => chrome.runtime.sendMessage({ type: "fontBytes", id }, (r) => {
      if (chrome.runtime.lastError || !r || !r.ok || !r.b64) { importFontsAsked.delete(id); return; }
      try {
        // Handed to the browser as a data: URL: it decodes the base64 off
        // this thread, instead of a JS loop over up to 33 MB of text on the
        // player page's main thread. The family name is minted for this
        // page; the lines are restyled once it is in.
        const alias = "YTDS-F-" + Math.random().toString(36).slice(2, 10);
        const face = new FontFace(alias, "url(data:application/octet-stream;base64," + r.b64 + ")");
        face.load().then(() => {
          document.fonts.add(face);
          importAlias.set(id, alias);
          if (overlay) styleOverlay();
        }).catch(() => importFontsAsked.delete(id));
      } catch (_e) { importFontsAsked.delete(id); }
    }));
  }

  // ---- color helpers (tolerant of #rgb / #rrggbb) --------------------------
  function hexToRgb(hex) {
    let h = String(hex || "").trim().replace(/^#/, "");
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (h.length !== 6 || /[^0-9a-fA-F]/.test(h)) return { r: 0, g: 0, b: 0 };
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16)
    };
  }
  function rgba(hex, alpha) {
    const { r, g, b } = hexToRgb(hex);
    let a = Number(alpha);
    if (!isFinite(a)) a = 1;
    a = Math.max(0, Math.min(1, a));
    return `rgba(${r},${g},${b},${a})`;
  }
  // Build a multi-direction text-shadow "ring" to fake an outline. Falls back
  // to the soft drop-shadow when opacity is 0 (matches content.css default).
  function outlineShadow(strokeHex, strokeOpacity) {
    const a = Number(strokeOpacity);
    if (!isFinite(a) || a <= 0) return "0 1px 2px rgba(0,0,0,0.9)";
    const c = rgba(strokeHex, a);
    const o = 1.2; // px
    return [
      `-${o}px -${o}px 0 ${c}`,
      `0 -${o}px 0 ${c}`,
      `${o}px -${o}px 0 ${c}`,
      `${o}px 0 0 ${c}`,
      `${o}px ${o}px 0 ${c}`,
      `0 ${o}px 0 ${c}`,
      `-${o}px ${o}px 0 ${c}`,
      `-${o}px 0 0 ${c}`
    ].join(", ");
  }
  function clampPct(v) {
    let n = Number(v);
    if (!isFinite(n)) n = 50;
    return Math.max(2, Math.min(98, n));
  }
  // Same, but with limits measured from the box being placed, so the whole box
  // (plus the grip above it) stays inside the player. Falls back to clampPct's
  // fixed margin when the box has not been measured yet.
  function clampRange(v, lo, hi) {
    let n = Number(v);
    if (!isFinite(n)) n = 50;
    if (!(hi > lo)) return clampPct(n);
    return Math.max(lo, Math.min(hi, n));
  }
  // Vertical space the grip occupies above the subtitle box (top offset + its
  // own height); keep in step with .ytds-handle in content.css.
  const HANDLE_ROOM_PX = 60;

  let settings = { ...DEFAULTS };

  // overlay
  let overlay = null;
  let origEl = null;
  let transEl = null;
  let handleEl = null;

  // drag bookkeeping (listeners live on the handle, so they die with overlay)
  let dragging = false;
  let dragMoved = false;       // true once the pointer actually moved past threshold
  let dragGrabDx = 0;          // pointer-to-overlay-center offset captured on grab
  let dragGrabDy = 0;
  let dragStartX = 0;          // pointerdown coords (for movement-threshold check)
  let dragStartY = 0;
  let dragSaveTimer = null;
  const DRAG_THRESHOLD = 3;    // px the pointer must move before it counts as a drag

  // cue mode
  let cueList = null;        // [{start,dur,end,text,trans?}]
  let tcueList = null;       // aligned translation cues OR null (timestamp fallback)
  let cueAligned = null;     // boolean | null
  let cueVideoId = "";       // videoId the cues belong to
  let cueTimer = null;       // currentTime-driven loop
  let activeCueIdx = -1;     // index of currently shown cue
  let cueEpoch = 0;          // bumped each (re)start/teardown; invalidates in-flight gtx
  const transCache = new Map(); // key `${videoId} ${idx}` (per-cue) or `${videoId} g${gIdx}` (group)
  const transInflight = new Set(); // in-flight gtx dedupe: cue idx (number) or "g"+gIdx (string)
  const PREFETCH_AHEAD = 12;    // warm this many upcoming cues' gtx translations
  const ZERO_DUR_FLOOR_MS = 1000; // min visible window for a trailing zero-dur cue

  // sentence groups — gtx "smart sentences" mode. ASR cues are time slices, not
  // sentences; translating them one by one is broken BY INPUT (word sense and
  // word order need the whole sentence). So when there is no tlang data at all
  // we rebuild sentences from the cues and translate those instead. Built only
  // in onCues when data.aligned == null; every consumer keys off cueToGroup.
  let sentGroups = null;        // [{startIdx,endIdx,text,start,end}] | null
  let cueToGroup = null;        // cue idx -> group idx | null (null = per-cue mode)
  // Sentence spans for READING ALOUD ONLY, built when YouTube supplies the
  // translation (tlang) and the track is the scrolling ASR kind. There the
  // captions arrive as running fragments and YouTube translates each fragment
  // on its own, so a cue's translation can be a single word — "from an"
  // becomes "从", and the voice reads one character, alone, as a sentence.
  // Grouping them for the VOICE fixes that without touching what is drawn:
  // the captions still pair fragment with fragment, as they must, because
  // that is what lines up with the original on screen.
  //
  // Deliberately NOT sentGroups: those also drive prefetch, export and the
  // gtx request path, all of which must keep working per-cue under tlang.
  let speechSpans = null;       // [{startIdx,endIdx}] | null
  let cueToSpan = null;         // cue idx -> span idx | null
  let activeGroupIdx = -1;      // group of the active cue (-1 when none/per-cue)
  let cueTrackKind = "";        // "asr" | "manual" | "" — from inject's captured URL
  let cueSameLang = false;      // track already speaks the target language —
                                // nothing to translate, render single-line
  let cueTrackId = "";          // normKey of the track the caches were filled
                                // for — a switch invalidates them
  let gtxNetFails = 0;          // consecutive network-dead gtx failures (group mode)
  let gtxFellBack = false;      // this video: auto engine fell back to tlang
  let tlangGated = false;       // worker says YouTube's translation endpoint is
                                // rate-limited: new videos go straight to gtx,
                                // no tlang request is even attempted
  let cueTlangStatus = 0;       // why THIS track has no whole-track translation
                                // (0 = it does / never asked, 429 = rate limit)
  let pendingTimer = null;      // delayed "…" placeholder for the active group
  const PAUSE_BREAK_MS = 600;   // word-level silence that ends a sentence
  const MAX_GROUP_WORDS = 32;   // sentence cap (space-separated word count)
  const MAX_GROUP_CHARS = 280;  // second cap: CJK sources (no spaces) + URL safety
  const PREFETCH_GROUPS = 4;    // ~28s lookahead at the measured ~7s/group
  const GTX_FALLBACK_FAILS = 3; // network failures before auto falls back to tlang
  const PENDING_ELLIPSIS_MS = 400; // show "…" if the active group is still in flight
  const SENT_END_RE = /[.!?…。！？]["'""''」』》】)）\]]?\s*$/;

  // fallback (rendered-scrape) mode
  let pollTimer = null;
  let debounceTimer = null;
  let lastSource = "";
  let lastTransSource = "";
  let lastReqToken = 0;
  const DEBOUNCE_MS = 450;

  // bookkeeping
  let currentVideoId = videoIdFromLocation();
  let nocuesFallback = false;   // true once we've committed to scrape mode
  let blankRecoveries = 0;      // paced re-asks when the overlay stays empty
  let blankNextAt = 0;          // earliest next recovery (the pacing half)
  let rearmedForVideo = false;  // CC already force-toggled once for this video
  const MAX_BLANK_RECOVERIES = 3;
  let configNonce = 0;          // monotonic; echoed by inject.js to reject stale replies

  // export (SRT download) bookkeeping
  let exportSeq = 0;                  // correlation id for export-request round-trips
  const exportWaiters = new Map();   // exportId -> { resolve, timer }

  // v3.4 engine migration — READ-side only, never written back. "engine" is the
  // source of truth; pre-3.4 versions stored only "backend". A stored gtx was a
  // deliberate choice (the old default was tlang) so it survives; everything
  // else lands on "auto". Not writing back keeps not-yet-updated devices on the
  // same sync profile working — old code would read "auto" as gtx.
  function normalizeEngine(got) {
    const e = got && got.engine;
    if (e === "auto" || e === "tlang" || e === "gtx" || e === "byo") return e;
    return got && got.backend === "gtx" ? "gtx" : "auto";
  }

  // ---- orphaned content script ---------------------------------------------
  // Chrome leaves the PREVIOUS content script running in every open tab when
  // the extension is reloaded or updated — a store update does this to every
  // user with YouTube open, not just to us in development. Its timers keep
  // firing, and the first chrome.* call throws "Extension context invalidated":
  // one uncaught error per tick in the page console and in chrome://extensions,
  // an overlay that has quietly stopped translating, and a drag whose position
  // is never saved. Notice it, take the overlay away — this page belongs to the
  // new script now — and go quiet. The tab's next load gets a live one.
  let orphaned = false;
  let navPollTimer = null;
  // Declared here, with the other things goOrphan has to switch off, so it can
  // never be reached before its own `let` has run.
  let blankWatchTimer = null;

  function extensionAlive() {
    try { return !!(chrome.runtime && chrome.runtime.id); } catch (_e) { return false; }
  }

  function goOrphan() {
    if (orphaned) return;
    orphaned = true;
    try { teardownAll(); } catch (_e) { /* ignore */ }
    // Leave no dead control in the player either: this button would still
    // toggle, and would put a subtitle box back that can never translate again.
    try { if (toggleBtn) { toggleBtn.remove(); toggleBtn = null; } } catch (_e) { /* ignore */ }
    moreEl = null;
    try { hideMenuBubble(); } catch (_e) { /* ignore */ }
    try { closeMenu(); } catch (_e) { /* ignore */ }
    try { sumClose(); } catch (_e) { /* ignore */ }
    try { document.removeEventListener("mousedown", onDocMouseDownForMenu, true); } catch (_e) { /* ignore */ }
    try { document.removeEventListener("keydown", onKeyDownForMenu, true); } catch (_e) { /* ignore */ }
    try { document.removeEventListener("selectionchange", flushHeldLines); } catch (_e) { /* ignore */ }
    try { window.removeEventListener("mouseup", onAnyMouseUp, true); } catch (_e) { /* ignore */ }
    try { window.removeEventListener("click", onStrayClick, true); } catch (_e) { /* ignore */ }
    // The one listener this teardown used to leave behind. A dead tab went on
    // answering settings changes: flip anything in the popup afterwards and it
    // put its overlay back and started talking to a worker that is not there.
    try { chrome.storage.onChanged.removeListener(onStorageChanged); } catch (_e) { /* ignore */ }
    try { if (localVoicesTake && window.speechSynthesis) window.speechSynthesis.removeEventListener("voiceschanged", localVoicesTake); } catch (_e) { /* ignore */ }
    // The paused flag lives on speechSynthesis, survives us, and cancel() does
    // not clear it (see ttsFollowPause). An instance that is torn down while
    // holding a pause — an extension reload, which is every ↻ during
    // development — leaves the engine paused for the whole browser, and every
    // later utterance anywhere, including the settings page's Preview, is
    // queued into it and says nothing. Hand it back before dying.
    try {
      if (window.speechSynthesis) { window.speechSynthesis.cancel(); window.speechSynthesis.resume(); }
    } catch (_e) { /* no engine here: nothing to hand back */ }
    // inject.js keeps producing cues for a config it still holds; tell it the
    // listener is gone (plain postMessage: chrome.* is dead by now).
    try { window.postMessage({ source: "ytds-content", type: "bye" }, "*"); } catch (_e) { /* ignore */ }
    // A connected observer is not idle: it runs its callback on every mutation
    // YouTube makes to the bar, and holds this whole dead scope alive doing it.
    // Timers were being cleared here; this was not.
    if (controlsObserver) {
      try { controlsObserver.disconnect(); } catch (_e) { /* ignore */ }
      controlsObserver = null;
      controlsObserved = null;
    }
    if (navPollTimer) { clearInterval(navPollTimer); navPollTimer = null; }
    if (blankWatchTimer) { clearTimeout(blankWatchTimer); blankWatchTimer = null; }
  }

  // The single door for every chrome.* call in this file. After invalidation
  // they throw synchronously, and no caller should have to know that.
  function extCall(fn) {
    if (orphaned) return false;
    if (!extensionAlive()) { goOrphan(); return false; }
    try { fn(); return true; } catch (_e) { goOrphan(); return false; }
  }

  // ---- settings ------------------------------------------------------------
  function loadSettings() {
    return new Promise((resolve) => {
      // get(null): fetch only what is actually stored, so normalizeEngine can
      // tell "engine never set" apart from an explicit value.
      chrome.storage.sync.get(null, (got) => {
        got = got || {};
        settings = { ...DEFAULTS, ...got };
        // The interface-language table is asked of the worker only when an
        // override is set. On "auto" — every fresh install — nothing is
        // asked: a plain video must be able to play without one worker call
        // (the no-traffic scenarios pin that), and chrome.i18n already
        // answers in the right language then.
        if (got.uiLocale && got.uiLocale !== "auto") loadUiTable();
        settings.engine = normalizeEngine(got);
        // migrate legacy global bgOpacity -> per-line bg opacities if present
        // and the per-line keys were never set.
        if (typeof got.bgOpacity === "number") {
          if (typeof got.origBgOpacity !== "number") settings.origBgOpacity = got.bgOpacity;
          if (typeof got.transBgOpacity !== "number") settings.transBgOpacity = got.bgOpacity;
        }
        resolve();
      });
    });
  }

  // ONLY these keys require re-requesting cues from inject.js; every other key
  // is a pure style/position change that applies live via styleOverlay(). This
  // positive set is the single source of truth for the re-cue decision.
  // The BYO keys belong here too: a different provider/model/endpoint is a
  // different translator, so cached lines from the previous one must go.
  const RECUE_KEYS = new Set([
    "engine", "backend", "targetLang", "byoProvider", "byoModel", "byoBaseUrl"
  ]);

  // Held so teardown can take it back. An orphaned script kept answering
  // storage changes: flip any setting in the popup afterwards and the dead
  // tab put its overlay back and started talking to a worker that is not
  // there — the one listener goOrphan did not remove.
  const onStorageChanged = (changes, area) => {
    if (orphaned) return;
    if (area === "sync" && changes.uiLocale) {
      const v = changes.uiLocale.newValue;
      if (v && v !== "auto") loadUiTable(); else uiTable = null;
    }
    if (area !== "sync") return;
    let needRecue = false;
    for (const k of Object.keys(changes)) {
      if (k in settings) {
        const oldV = settings[k];
        // A removed key (the popup's reset removes a few) arrives with no
        // newValue at all; mirroring that as undefined is not "back to default".
        settings[k] = ("newValue" in changes[k]) ? changes[k].newValue : DEFAULTS[k];
        if (k === "engine") settings.engine = normalizeEngine(settings);
        if (RECUE_KEYS.has(k) && oldV !== settings[k]) {
          needRecue = true;
        }
      }
    }
    applyStateToDom();
    if (overlay) styleOverlay();   // position/fonts/colors/bg/stroke/sizes apply live
    if ("enabled" in changes) syncCaptions();   // master switch flipped from popup
    // …and switching ON re-arms the still-blank watch, which stops re-arming
    // itself while the extension is off (armBlankWatch checks before looping).
    if ("enabled" in changes && settings.enabled) armBlankWatch();
    // The in-player menu shows these same keys. Flipped from the popup or
    // another tab while it is open, its ticks went stale and the next press
    // acted on what the screen showed — the opposite of what was wanted. And
    // with the whole extension switched off elsewhere, a live menu was left
    // floating over a player whose overlay had just been torn down.
    paintMenuRows();
    if ("enabled" in changes && !settings.enabled) closeMenu();
    // Read-aloud off, or a different voice/provider: what is queued or sounding
    // belongs to the old setting — stop it rather than letting it finish wrong.
    // targetLang belongs here too, and did not use to: it goes down the recue
    // path, which clears the translation cache and bumps the CUE epoch but not
    // the read-aloud one. So a line already in flight came back and was spoken
    // — in the language the viewer had just moved off — over an overlay that
    // was blank, waiting for the new one. The window survived that on its own
    // (a held line is only used when its text still matches), but the line on
    // screen had no such check.
    // targetLang is compared by VALUE, not by presence: it is the one key in
    // this list that is also in RECUE_KEYS, where a no-op write is already
    // known to happen, and cutting off the line being spoken for a write that
    // changed nothing is a worse answer than doing nothing.
    const langMoved = "targetLang" in changes &&
      changes.targetLang && changes.targetLang.oldValue !== changes.targetLang.newValue;
    if (("ttsEnabled" in changes && !settings.ttsEnabled) ||
        "ttsProvider" in changes || "ttsVoice" in changes || langMoved) {
      ttsStop();
    }
    // The complaint belonged to the old configuration — keeping it would make a
    // fresh provider look broken before it has been asked for a single line.
    // Region is in this list and not in the one above: it changes nothing that
    // is queued, but it is exactly what turns a failing Azure into a working one.
    // The switch is here because it sits directly above the message: flipping
    // it off and on is what a reader does when they see one, and the same
    // complaint coming back before the re-enabled engine has been asked for a
    // single line reads as "still broken". The language is here because
    // unsupportedTarget asks the reader to change it — a complaint that outlives
    // being obeyed is telling them to do the thing they just did.
    if ("ttsProvider" in changes || "ttsVoice" in changes || "ttsRegion" in changes ||
        langMoved || ("ttsEnabled" in changes && settings.ttsEnabled)) {
      ttsErr = "";
      ttsFailRun = 0;
    }
    // A different voice has a different start-up cost; the measured average
    // belongs to the voice it was measured on.
    if ("ttsProvider" in changes || "ttsVoice" in changes) ttsLocalNetEma = 0;
    // Loudness is a live control: the options slider should be audible on the
    // line that is speaking, not on the next one. Duck depth stays per-line —
    // it is sent with each duck message, and restore compares what was SET.
    if ("ttsVolume" in changes && ttsAudio) {
      try { ttsAudio.volume = Math.max(0, Math.min(1, settings.ttsVolume / 100)); }
      catch (_e) { /* ignore */ }
    }
    // Duck depth is live too, while a line is actually ducking. The two sliders
    // now sit next to each other in the popup: one of them answering on the
    // next line and the other at once reads as the slower one being broken.
    // Off-air it needs no message — the next duck carries the new depth.
    // localUtter as well as ttsAudio: the browser's own voice is the provider
    // everybody starts on, and it has no audio element — so on the default
    // engine this slider did nothing at all while a line was being read, which
    // is the only time it does anything.
    if ("ttsDuckPct" in changes &&
        ((ttsAudio && !ttsAudio.paused && !ttsAudio.ended) || localUtter)) {
      ttsDuck(true, ttsFit);
    }
    // Same-language/dedupe paints depend on WHICH line is visible (the single
    // line migrates to whichever is shown) — re-render the active cue, and
    // re-process the scraped caption, under the new setting instead of leaving
    // the box empty until the next caption change.
    if ("showOriginal" in changes) {
      if (cueTimer) activeCueIdx = -1;
      if (pollTimer) { lastSource = ""; lastTransSource = ""; }
    }
    // engine / targetLang changed: re-request cues from inject.js
    if (needRecue && settings.enabled) {
      transCache.clear();
      transInflight.clear();
      gtxNetFails = 0;
      gtxFellBack = false;          // fresh engine/lang choice: give gtx a new chance
      clearPendingTimer();
      // The current cue loop is now running against stale translation data
      // (old tlang alignment / old gtx cache). Drop the translation source and
      // bump the epoch so the loop degrades cleanly (no wrong-but-plausible
      // lines) and stale in-flight gtx callbacks are ignored until fresh cues
      // arrive from inject.js. Sentence groups stay: they are a pure function
      // of the unchanged cueList (onCues rebuilds/clears them with fresh data).
      tcueList = null;
      cueAligned = null;
      cueSameLang = false;          // the new target may need translating again
      cueEpoch++;
      activeGroupIdx = -1;
      if (cueTimer) {
        activeCueIdx = -1;          // force re-render of translation on next tick
        setTranslation("", "");
      }
      sendConfig();
    }
  };
  try { chrome.storage.onChanged.addListener(onStorageChanged); } catch (_e) { /* ignore */ }

  // ---- generic helpers -----------------------------------------------------
  function videoIdFromLocation() {
    try {
      const u = new URL(location.href);
      // Shorts URLs carry the id in the path, not in ?v=. So does /embed/, and
      // this side has to agree with inject.js about that or the two disagree
      // about what is playing: everything gated on an id here goes quiet on an
      // embed page, including BOTH blank-overlay recoveries — the 20s watchdog
      // and the visibilitychange one — which return early when there is no id.
      // /embed/videoseries and /embed/live_stream are excluded for the same
      // reason as there: eleven legal id characters that are not an id.
      // /live/<id> is the third shape that carries the id in the path. It has
      // been in isVideoPage since it was written, so the button mounted and
      // nothing else did: no id meant produceCues returned at its second line
      // forever, every recovery that is gated on an id went quiet, and export
      // and summary had no complete track to work from. The two files have to
      // agree about this or they disagree about what is playing.
      const m = u.pathname.match(
        /^\/(?:shorts|embed|live)\/(?!videoseries\b|live_stream\b)([A-Za-z0-9_-]{6,})/);
      if (m) return m[1];
      return u.searchParams.get("v") || "";
    } catch (_e) {
      return "";
    }
  }

  function isShorts() {
    try { return /^\/shorts\//.test(location.pathname); } catch (_e) { return false; }
  }

  // A shorts page keeps a hidden #movie_player around (preloaded watch player,
  // complete with its own CC button), so query order must follow the page type
  // or the overlay/CC clicks land on the invisible player.
  // Only on a page that IS a video: the home page's hover preview and the
  // channel page's trailer are .html5-video-player too, and mounting there
  // put the button in a preview and had ensureCaptionsOn press its CC (D156).
  function isVideoPage() {
    try { return /^\/(watch|shorts\/|embed\/|live\/)/.test(location.pathname); }
    catch (_e) { return false; }
  }
  function getPlayer() {
    // The player's id is the identity: #movie_player on watch / embed / live,
    // #shorts-player on Shorts. The bare-class fallback is only for a page
    // that has lost the id mid-navigation — and on the home, search and
    // channel pages the only .html5-video-player is the hover preview, which
    // used to get our toggle button and overlay. So the fallback is allowed
    // on video URLs only; the id lookup needs no such gate.
    if (isShorts()) {
      return document.getElementById("shorts-player") ||
             (isVideoPage() ? document.querySelector(".html5-video-player") : null);
    }
    return document.querySelector("#movie_player") ||
           (isVideoPage() ? document.querySelector(".html5-video-player") : null);
  }

  // YouTube plays its advertisements through the SAME media element, so while
  // one runs, currentTime is the AD's clock — a number that lands squarely on
  // this video's opening cues. Measured: two lines drawn over the ad and
  // read-aloud speaking them. The player says so on itself while it happens,
  // which is the only signal there is: the element, the URL and the video id
  // are all unchanged.
  function isAdShowing() {
    const p = getPlayer();
    if (!p || !p.classList) return false;
    return p.classList.contains("ad-showing") ||
           p.classList.contains("ad-interrupting");
  }

  function getVideo() {
    const p = getPlayer();
    return (p && p.querySelector("video")) ||
           document.querySelector("video.html5-main-video") ||
           document.querySelector("video");
  }

  // Read the currently displayed native caption text (fallback path).
  // Read ONLY .ytp-caption-segment (the combined node would duplicate text),
  // scoped to the ACTIVE player so a hidden preloaded player can't leak text.
  function readNativeCaption() {
    const player = getPlayer();
    if (!player) return "";
    const segs = player.querySelectorAll(".ytp-caption-segment");
    if (!segs.length) return "";
    let parts = [];
    segs.forEach((s) => {
      const t = s.textContent.trim();
      if (t) parts.push(t);
    });
    return parts.join(" ").replace(/\s+/g, " ").trim();
  }

  // ---- overlay -------------------------------------------------------------
  function ensureOverlay() {
    const player = getPlayer();
    if (!player) return null;
    if (overlay && overlay.isConnected) return overlay;

    overlay = document.createElement("div");
    overlay.id = "ytds-overlay";
    transEl = document.createElement("div");
    transEl.className = "ytds-line ytds-trans";
    transEl.dir = "auto";           // Arabic, Hebrew: punctuation on the right side
    origEl = document.createElement("div");
    origEl.className = "ytds-line ytds-orig";
    origEl.dir = "auto";

    overlay.appendChild(transEl);
    overlay.appendChild(origEl);
    for (const el of [transEl, origEl]) {
      el.addEventListener("mousedown", onLineMouseDown);
      el.addEventListener("contextmenu", onLineContextMenu);
    }
    buildHandle();                  // drag grip (its listeners die with overlay)
    overlay.classList.toggle("ytds-shorts", isShorts());
    player.appendChild(overlay);
    observePlayerControls(player);  // lift the overlay off the control bar
    styleOverlay();
    return overlay;
  }

  // A small round grip in the overlay's top-left corner. It is the only
  // pointer-events:auto child; all drag listeners are attached to it (plus
  // pointer capture), so removing the overlay removes every listener with no
  // document-level leaks across SPA navigation.
  function buildHandle() {
    handleEl = document.createElement("div");
    handleEl.className = "ytds-handle";
    handleEl.title = t("handleTitle", "拖动移动字幕 · 双击复位");
    handleEl.setAttribute("aria-label", t("handleAria", "拖动移动字幕，双击复位"));
    // Six-dot grip rather than a move cross: the dots are the universal
    // "you can drag this" symbol (tables, task boards, list rows all use it),
    // while arrows read as "this is a move tool". Laid out 3x2 to match the
    // horizontal bar — a 2x3 column in a wide bar looks like a mistake.
    handleEl.innerHTML =
      '<svg viewBox="0 0 17 12" fill="currentColor">' +
      '<circle cx="3.5" cy="3.5" r="1.5"/><circle cx="8.5" cy="3.5" r="1.5"/>' +
      '<circle cx="13.5" cy="3.5" r="1.5"/><circle cx="3.5" cy="8.5" r="1.5"/>' +
      '<circle cx="8.5" cy="8.5" r="1.5"/><circle cx="13.5" cy="8.5" r="1.5"/></svg>';

    handleEl.addEventListener("pointerdown", onHandlePointerDown);
    handleEl.addEventListener("pointermove", onHandlePointerMove);
    handleEl.addEventListener("pointerup", onHandlePointerUp);
    handleEl.addEventListener("pointercancel", onHandlePointerUp);
    handleEl.addEventListener("dblclick", onHandleDblClick);

    overlay.appendChild(handleEl);
  }

  // ---- first-run discovery -------------------------------------------------
  // The grip is invisible until the pointer is near the player, which is exactly
  // why people never find it (a store review said "there are only three
  // positions"). New installs get it shown, and gently pulsed, on their first
  // few videos. The counter is written by background.js on install ONLY —
  // upgrades must not pester people who already know how to drag.
  let hintedThisVideo = false;

  function flashHandle(ms) {
    if (!overlay || !handleEl) return false;
    overlay.classList.add("ytds-hint");
    setTimeout(() => {
      if (overlay) overlay.classList.remove("ytds-hint");
    }, ms || 2400);
    return true;
  }

  function maybeHintHandle() {
    if (hintedThisVideo || !overlay || !handleEl) return;
    hintedThisVideo = true;                    // one shot per video either way
    extCall(() => chrome.storage.local.get({ handleHintsLeft: 0 }, (got) => {
      const left = Number(got && got.handleHintsLeft) || 0;
      if (left <= 0) return;
      extCall(() => chrome.storage.local.set({ handleHintsLeft: left - 1 }));
      flashHandle(3600);
    }));
  }

  // The corner menu gets the same bargain: a 9px arrow is the door to
  // read-aloud, copy, summary and settings, and nobody finds it unprompted
  // (the owner's call, 2026-09-01: teach it in onboarding AND pulse it).
  // Unlike the grip, UPDATES seed this one too — the menu is new, so
  // long-time users have never seen the arrow either (background.js seeds
  // once). Opened once = discovered = retired for good.
  let menuHintedThisVideo = false;
  let menuHintKilled = false;
  let menuBubbleEl = null;
  let menuBubbleTimer = null;

  // The words half of the hint: a one-time callout above the button saying
  // what the arrow IS. The pulse alone was judged too small on the real
  // machine (the arrow is 9px; owner, 2026-09-01) — the bubble carries the
  // meaning and is itself the door: clicking it opens the menu.
  function hideMenuBubble() {
    if (menuBubbleTimer) { clearTimeout(menuBubbleTimer); menuBubbleTimer = null; }
    if (menuBubbleEl) { menuBubbleEl.remove(); menuBubbleEl = null; }
  }

  function showMenuBubble() {
    hideMenuBubble();
    const player = getPlayer();
    if (!player || !toggleBtn || !toggleBtn.isConnected) return;
    const b = document.createElement("div");
    b.className = "ytds-menu-bubble";
    b.textContent = ct("menuHintBubble",
      "朗读、视频总结、选中复制——都在这个小箭头菜单里");
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      openMenu();                              // openMenu retires the hint
    });
    player.appendChild(b);
    // Above the button, tail near the arrow. Measured, not guessed: the
    // control bar's height varies with player size and theater mode.
    const pr = player.getBoundingClientRect();
    const br = toggleBtn.getBoundingClientRect();
    if (br.width && br.height && pr.width) {
      b.style.right = Math.max(8, Math.round(pr.right - br.right - 2)) + "px";
      b.style.bottom = Math.round(pr.bottom - br.top + 10) + "px";
    } else {
      // Mid-SPA-navigation the button can measure 0x0 (caught on the real
      // machine: the bubble computed itself into the middle of the frame).
      // A fixed bottom-right anchor is where the button will be anyway.
      b.style.right = "12px";
      b.style.bottom = "64px";
    }
    menuBubbleEl = b;
    menuBubbleTimer = setTimeout(hideMenuBubble, 6500);
  }

  function maybeHintMenu() {
    if (menuHintedThisVideo || menuHintKilled) return;
    if (!toggleBtn || !toggleBtn.isConnected || !moreEl) return;
    menuHintedThisVideo = true;                // one shot per video either way
    extCall(() => chrome.storage.local.get({ menuHintsLeft: 0 }, (got) => {
      const left = Number(got && got.menuHintsLeft) || 0;
      if (left <= 0 || menuHintKilled) return;
      extCall(() => chrome.storage.local.set({ menuHintsLeft: left - 1 }));
      if (!toggleBtn || !toggleBtn.isConnected) return;
      toggleBtn.classList.add("ytds-menu-hint");
      showMenuBubble();
      setTimeout(() => {
        if (toggleBtn) toggleBtn.classList.remove("ytds-menu-hint");
      }, 6500);
    }));
  }

  function onHandlePointerDown(e) {
    const player = getPlayer();
    if (!player) return;
    dragging = true;
    dragMoved = false;              // no real movement yet — a bare click won't persist
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    // Record the offset between the pointer and the overlay's CURRENT center so
    // the grabbed point stays under the cursor (no first-move teleport). The
    // handle sits at the overlay's top-left corner, ~half the box away from
    // center, so without this the box would jump when the drag begins.
    if (overlay) {
      const orect = overlay.getBoundingClientRect();
      dragGrabDx = e.clientX - (orect.left + orect.width / 2);
      dragGrabDy = e.clientY - (orect.top + orect.height / 2);
    } else {
      dragGrabDx = 0;
      dragGrabDy = 0;
    }
    handleEl.classList.add("ytds-dragging");
    // Lift the whole box while it is being moved: without it the user is
    // dragging text with no visible edges and cannot tell what they grabbed.
    overlay.classList.add("ytds-drag");
    overlay.classList.remove("ytds-hint");     // a real drag ends the hint
    // Drop the lift and kill transitions for the gesture: the box must track
    // the cursor exactly, not float `controlsLift` px above it.
    controlsLift = 0;
    overlay.classList.add("ytds-notrans");
    try { handleEl.setPointerCapture(e.pointerId); } catch (_e) { /* ignore */ }
    e.preventDefault();
    e.stopPropagation();
  }

  function onHandlePointerMove(e) {
    if (!dragging) return;
    const player = getPlayer();
    if (!player) return;
    // Ignore sub-threshold jitter so a plain click never flips to custom mode.
    if (!dragMoved) {
      if (Math.abs(e.clientX - dragStartX) < DRAG_THRESHOLD &&
          Math.abs(e.clientY - dragStartY) < DRAG_THRESHOLD) {
        return;
      }
      dragMoved = true;
    }
    const rect = player.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    // Subtract the grab offset so the overlay center tracks the point the user
    // actually grabbed rather than snapping the center onto the cursor.
    const cx = e.clientX - dragGrabDx;
    const cy = e.clientY - dragGrabDy;
    // The stored position is the box CENTRE, so clamping it to 0..100 still lets
    // half the box hang outside the player — dragging to the bottom cut the
    // lower subtitle line in half (reported on both windowed and fullscreen).
    // Clamp by half the box, and leave room above it for the grip, which lives
    // outside the box and would otherwise be pushed off-screen at the top.
    const orect = overlay.getBoundingClientRect();
    const halfW = orect.width ? (orect.width / 2 / rect.width) * 100 : 0;
    const halfH = orect.height ? (orect.height / 2 / rect.height) * 100 : 0;
    const gripPct = (HANDLE_ROOM_PX / rect.height) * 100;
    const xpct = clampRange(((cx - rect.left) / rect.width) * 100, halfW, 100 - halfW);
    const ypct = clampRange(((cy - rect.top) / rect.height) * 100,
                            halfH + gripPct, 100 - halfH);
    settings.posMode = "custom";
    settings.posXpct = xpct;
    settings.posYpct = ypct;
    applyPosition();                // smooth live feedback; no storage write
    e.preventDefault();
  }

  function onHandlePointerUp(e) {
    if (!dragging) return;
    dragging = false;
    handleEl.classList.remove("ytds-dragging");
    if (overlay) {
      overlay.classList.remove("ytds-notrans");
      overlay.classList.remove("ytds-drag");
    }
    computeLift();                 // ease back off the control bar if needed
    try { handleEl.releasePointerCapture(e.pointerId); } catch (_e) { /* ignore */ }
    // Only persist when a REAL drag happened. A bare click (no movement) must
    // not flip posMode to custom or move the box, and must not race the
    // dblclick reset (which clears this timer anyway).
    if (!dragMoved) return;
    // persist ONCE (coalesced) at the end of the gesture
    if (dragSaveTimer) clearTimeout(dragSaveTimer);
    dragSaveTimer = setTimeout(() => {
      dragSaveTimer = null;
      extCall(() => chrome.storage.sync.set({
        posMode: "custom",
        posXpct: settings.posXpct,
        posYpct: settings.posYpct
      }));
    }, 60);
  }

  function onHandleDblClick(e) {
    e.preventDefault();
    e.stopPropagation();
    // Cancel any pending drag-save timer; otherwise the still-pending write from
    // the preceding pointerup(s) fires ~60ms later and clobbers this reset back
    // to a custom position. Also drop any in-progress drag state.
    if (dragSaveTimer) { clearTimeout(dragSaveTimer); dragSaveTimer = null; }
    dragging = false;
    dragMoved = false;
    settings.posMode = "preset";
    applyPosition();
    extCall(() => chrome.storage.sync.set({ posMode: "preset" }));
  }

  // ---- control-bar avoidance ----------------------------------------------
  // Native YouTube captions shift up while the control bar is shown so the
  // progress bar never sits on top of the text; mirror that. controlsLift is
  // the px the overlay is raised by; it is folded into applyPosition so preset
  // AND dragged custom positions both step aside. Recomputed when the player's
  // class flips (ytp-autohide) and when the rendered text changes height.
  let controlsLift = 0;
  let liftObserver = null;
  let liftRaf = 0;

  // Coalesce triggers (class mutations fire in bursts while the cursor rides
  // the progress bar) into one computation per frame.
  let liftWasAutohide = null;   // last seen state; null = not yet observed
  function scheduleLift() {
    if (liftRaf) return;
    liftRaf = requestAnimationFrame(() => {
      liftRaf = 0;
      computeLift();
      // The controls the menu is anchored to just slid away: a menu floating
      // alone over the picture is debris — it goes with them. On the EDGE
      // into autohide only, never on mere presence of the class: unrelated
      // class churn while the bar is already hidden must not eat the menu
      // (the rig's player is even BORN with ytp-autohide).
      const pl = getPlayer();
      const hid = !!(pl && pl.classList.contains("ytp-autohide"));
      if (menuEl && hid && liftWasAutohide === false) closeMenu();
      liftWasAutohide = hid;
    });
  }

  function observePlayerControls(player) {
    if (liftObserver) liftObserver.disconnect();
    liftWasAutohide = null;            // a new player gets a fresh edge
    liftObserver = new MutationObserver(scheduleLift);
    liftObserver.observe(player, { attributes: true, attributeFilter: ["class"] });
    computeLift();
  }

  // A dragged position is stored as the box CENTRE, so it stays valid only for
  // the box size it was chosen with. A later, longer subtitle wraps to two lines
  // and the box grows both ways from that centre — which is how the bottom line
  // ended up cut off again after the drag-time clamp (intermittent, because it
  // depends on how long the next sentence happens to be). So re-clamp on every
  // relayout: text change, resize, fullscreen. In memory only — persisting on
  // every caption change would be write spam, and the stored value gets clamped
  // again on the next paint anyway.
  function clampCustomIntoView() {
    if (settings.posMode !== "custom" || !overlay || dragging) return;
    const player = getPlayer();
    if (!player) return;
    const rect = player.getBoundingClientRect();
    const orect = overlay.getBoundingClientRect();
    if (!rect.width || !rect.height || !orect.height) return;
    const halfW = (orect.width / 2 / rect.width) * 100;
    const halfH = (orect.height / 2 / rect.height) * 100;
    const gripPct = (HANDLE_ROOM_PX / rect.height) * 100;
    const x = clampRange(settings.posXpct, halfW, 100 - halfW);
    const y = clampRange(settings.posYpct, halfH + gripPct, 100 - halfH);
    if (Math.abs(x - settings.posXpct) < 0.3 && Math.abs(y - settings.posYpct) < 0.3) {
      return;                                   // already inside: no reflow
    }
    settings.posXpct = x;
    settings.posYpct = y;
    // Instantly, not over the 0.18s `top` transition that content.css uses for
    // the control-bar lift: this is a hard constraint, and animating it left the
    // box measurably outside the player for the whole transition (28px for
    // ~180ms in the geometry rig — long enough to screenshot, which is how it
    // was reported). The lift keeps its easing; only the correction skips it.
    overlay.classList.add("ytds-notrans");
    applyPosition();
    // Force the style to take effect before the transition comes back.
    void overlay.offsetHeight;
    requestAnimationFrame(() => {
      if (overlay && !dragging) overlay.classList.remove("ytds-notrans");
    });
  }

  function computeLift() {
    if (!overlay || dragging) return;      // mid-drag: stay 1:1 with the cursor
    clampCustomIntoView();                 // box may have grown since the drag
    let lift = 0;
    try {
      const player = getPlayer();
      if (player && !player.classList.contains("ytp-autohide")) {
        const bar = player.querySelector(".ytp-chrome-bottom");
        if (bar && bar.offsetParent !== null) {
          const p = player.getBoundingClientRect();
          const o = overlay.getBoundingClientRect();
          const b = bar.getBoundingClientRect();
          // Only the bottom preset and dragged custom positions avoid the bar
          // (top/center presets never reach it, and applyPosition would have
          // nowhere to fold a lift into for them anyway).
          const eligible = settings.posMode === "custom" || settings.position === "bottom";
          if (eligible && p.height && o.height && b.height) {
            // Derive the UNLIFTED bottom edge from layout math, never from the
            // overlay's live rect: top/bottom are transitioned, so a rect read
            // mid-animation fed the previous lift back into the measurement
            // and the value oscillated while the cursor rode the progress bar
            // (class mutations retriggered this at animation midpoints).
            // Heights are not animated, so o.height is safe to use.
            const baseBottom = settings.posMode === "custom"
              ? p.top + (clampPct(settings.posYpct) / 100) * p.height + o.height / 2
              : p.bottom - (isShorts() ? 0.18 : 0.08) * p.height;
            const intrude = baseBottom - (b.top - 6);
            if (intrude > 0) lift = Math.min(Math.round(intrude), 160);
          }
        }
      }
    } catch (_e) { /* ignore */ }
    // Hysteresis: the bar's own hover states wiggle its rect by a few px —
    // absorb that instead of re-animating the overlay for every pixel.
    if (lift && controlsLift && Math.abs(lift - controlsLift) <= 4) return;
    if (lift !== controlsLift) {
      controlsLift = lift;
      applyPosition();
    }
  }

  // Player size changes without a class mutation (window resize, theater
  // toggle mid-hover) — re-check on resize too.
  window.addEventListener("resize", scheduleLift);

  // Apply ONLY positioning (shared by styleOverlay + live drag feedback).
  function applyPosition() {
    if (!overlay) return;
    if (settings.posMode === "custom") {
      overlay.classList.remove("ytds-pos-bottom", "ytds-pos-center", "ytds-pos-top");
      const x = clampPct(settings.posXpct);
      const y = clampPct(settings.posYpct);
      overlay.style.left = x + "%";
      overlay.style.top = controlsLift
        ? "calc(" + y + "% - " + controlsLift + "px)"
        : y + "%";
      overlay.style.bottom = "auto";
      overlay.style.transform = "translate(-50%, -50%)";
    } else {
      // preset: hand control back to the CSS classes (+ lift when needed)
      overlay.style.left = "";
      overlay.style.top = "";
      overlay.style.bottom =
        (settings.position === "bottom" && controlsLift)
          ? "calc(" + (isShorts() ? 18 : 8) + "% + " + controlsLift + "px)"
          : "";
      overlay.style.transform = "";
      overlay.classList.remove("ytds-pos-bottom", "ytds-pos-center", "ytds-pos-top");
      overlay.classList.add("ytds-pos-" + settings.position);
    }
  }

  // Which language each line is in, so the browser picks that language's
  // glyphs. Han characters are drawn differently in Chinese, Japanese and
  // Taiwanese typography — 直 角 骨 社 are not the same shape — and a browser
  // told nothing falls back to whatever its own default is. Measured with
  // Chrome's own CSS.getPlatformFontsForNode, 2026-09-03, on a stock macOS:
  //   no lang        -> PingFang SC / Songti SC   (Simplified Chinese forms)
  //   lang="ja"      -> Hiragino Kaku Gothic ProN (Japanese forms)
  //   lang="zh-Hant" -> PingFang TC               (Traditional forms)
  // So every Japanese line this extension has ever drawn was drawn in
  // Simplified Chinese shapes, whatever font the reader had picked.
  //
  // The track's own language comes out of the id we already hold: normKey
  // keeps the lang parameter, dropping only fmt/tlang/pot. No new message,
  // no new permission.
  function langTag(raw) {
    // inject's trackLangOf hands back whatever the URL said, uncleaned, and
    // YouTube does emit legacy and odd values. A malformed tag and "und"
    // both behave EXACTLY like setting nothing (measured across 17 shapes),
    // so an unchecked value would silently buy nothing — the worst way for
    // this to fail, because the overlay looks fine and is still wrong.
    const v = String(raw || "").trim();
    if (!v || v.toLowerCase() === "und") return "";
    try { new Intl.Locale(v); } catch (_e) { return ""; }
    return v;
  }

  function trackLang() {
    try {
      return langTag(new URL(cueTrackId, location.href).searchParams.get("lang"));
    } catch (_e) { return ""; }
  }

  // The settings pane's font list asks "can this font draw the language of
  // the videos you watch?" — so the original languages of recent videos are
  // remembered, on this machine only, newest first, five at most. One write
  // per new language, none for the same language again.
  let langSeenLast = "";
  function noteLangSeen(lang) {
    if (lang === langSeenLast) return;
    langSeenLast = lang;
    extCall(() => chrome.storage.local.get({ fontLangsSeen: [] }, (got) => {
      if (chrome.runtime.lastError) return;
      const cur = Array.isArray(got && got.fontLangsSeen) ? got.fontLangsSeen : [];
      if (cur[0] === lang) return;
      const next = [lang].concat(cur.filter((c) => c !== lang)).slice(0, 5);
      try { chrome.storage.local.set({ fontLangsSeen: next }); } catch (_e) { /* ignore */ }
    }));
  }

  function paintLineLangs() {
    if (!origEl || !transEl) return;
    // Only write when it changes: this runs on every settings change and on
    // every track switch, and an attribute write invalidates style.
    const o = trackLang();
    if (origEl.getAttribute("lang") !== o) {
      if (o) origEl.setAttribute("lang", o); else origEl.removeAttribute("lang");
    }
    // Remembered under the probe's key ("zh-Hans" is zh-CN there), so the
    // settings page finds it in its language table.
    if (o) {
      const key = self.YTDS_FONTS ? self.YTDS_FONTS.probeLang(o) : o;
      if (key) noteLangSeen(key);
    }
    // The translation line is in the language the reader chose. When the track
    // is already in that language the overlay shows one line carrying the
    // original text — and that line is still in the target language, which is
    // what makes it the same-language case, so there is nothing special here.
    const t = langTag(settings.targetLang);
    if (transEl.getAttribute("lang") !== t) {
      if (t) transEl.setAttribute("lang", t); else transEl.removeAttribute("lang");
    }
  }

  function styleOverlay() {
    if (!overlay) return;
    applySelectText();

    // spacing + order
    overlay.style.gap = (Number(settings.rowGap) || 0) + "px";
    if (settings.order === "trans-top") {
      overlay.style.flexDirection = "column";         // trans first (on top)
    } else {
      overlay.style.flexDirection = "column-reverse"; // orig first (on top)
    }

    // original line
    ensureImportFont(settings.origFont);
    ensureImportFont(settings.transFont);
    origEl.style.fontFamily = fontStack(settings.origFont);
    origEl.style.fontSize = settings.origSize + "px";
    origEl.style.color = settings.origColor;
    origEl.style.background = rgba(settings.origBg, settings.origBgOpacity);
    origEl.style.textShadow = outlineShadow(settings.origStroke, settings.origStrokeOpacity);

    // translation line
    transEl.style.fontFamily = fontStack(settings.transFont);
    transEl.style.fontSize = settings.transSize + "px";
    transEl.style.color = settings.transColor;
    transEl.style.background = rgba(settings.transBg, settings.transBgOpacity);
    transEl.style.textShadow = outlineShadow(settings.transStroke, settings.transStrokeOpacity);

    paintLineLangs();

    // per-line visibility
    origEl.style.display = settings.showOriginal ? "" : "none";
    transEl.style.display = settings.showTranslation ? "" : "none";

    applyPosition();
    updateEmptyState();
  }

  function removeOverlay() {
    if (dragSaveTimer) { clearTimeout(dragSaveTimer); dragSaveTimer = null; }
    dragging = false;
    if (liftObserver) { liftObserver.disconnect(); liftObserver = null; }
    if (liftRaf) { cancelAnimationFrame(liftRaf); liftRaf = 0; }
    controlsLift = 0;
    if (overlay) { overlay.remove(); overlay = null; } // removes handle + its listeners
    origEl = null;
    transEl = null;
    handleEl = null;
  }

  // Hide the container only when there is no VISIBLE content. A line counts as
  // empty if its layer is turned off (showOriginal/showTranslation) OR it has
  // no text — so a disabled-but-non-empty layer does not keep the box open.
  function updateEmptyState() {
    if (!overlay) return;
    const oEmpty = !settings.showOriginal || !origEl.textContent;
    const tEmpty = !settings.showTranslation || !transEl.textContent;
    const empty = oEmpty && tEmpty;
    overlay.classList.toggle("ytds-empty", empty);
    // The moment there is something on screen is the moment the grip is worth
    // pointing at — before that there is no box to drag.
    if (!empty) { maybeHintHandle(); maybeHintMenu(); }
    // Synchronously, in the same task as the text change: leaving this to the
    // rAF in scheduleLift() let a taller line paint one frame outside the
    // player before being pulled back (measured 76px of overflow for a frame
    // at a large font size).
    clampCustomIntoView();
    scheduleLift();                // text height changed — re-check the bar gap
  }

  // Writing textContent replaces the node's children, which destroys any
  // Selection inside it — even when the string is identical. Three things
  // write these lines while a reader could be dragging across them: the "…"
  // placeholder 400ms in, the translation landing afterwards, and a late
  // per-cue reply. Selecting a line while the video played therefore lost the
  // selection twice before the words even settled. Hold the write instead;
  // the pending text is flushed when the selection collapses. Nothing about
  // the clock is touched — cueTick, the look-ahead and read-aloud all carry
  // on, only these two nodes stand still.
  let pendingOrig = null, pendingTrans = null;
  function selectionInside(el) {
    if (!settings.selectText || !el) return false;
    let s = null;
    try { s = window.getSelection(); } catch (_e) { return false; }
    if (!s || s.isCollapsed || !s.anchorNode) return false;
    return el.contains(s.anchorNode) || el.contains(s.focusNode);
  }

  function setOriginal(text) {
    if (!ensureOverlay()) return;
    const next = text || "";
    if (selectionInside(origEl)) { pendingOrig = next; return; }
    pendingOrig = null;
    origEl.textContent = next;
    updateEmptyState();
  }

  function setTranslation(text, forSource) {
    if (!ensureOverlay()) return;
    const next = text || "";
    if (arguments.length > 1) lastTransSource = forSource || "";
    if (selectionInside(transEl)) { pendingTrans = next; return; }
    pendingTrans = null;
    transEl.textContent = next;
    updateEmptyState();
  }

  // An advert, a track switch or a torn-down overlay must not be held back by
  // a selection: the hold exists for late TRANSLATIONS, and holding the BLANK
  // kept the previous sentence painted over an ad for as long as the viewer's
  // selection lived — the exact bug the ad branch was written to prevent.
  function forceBlankLines() {
    pendingOrig = null;
    pendingTrans = null;
    if (!overlay) return;
    origEl.textContent = "";
    transEl.textContent = "";
    lastTransSource = "";
    updateEmptyState();
  }

  // The selection let go: catch the lines up with whatever they missed.
  function flushHeldLines() {
    if (!overlay) return;
    if (pendingOrig !== null && !selectionInside(origEl)) {
      origEl.textContent = pendingOrig; pendingOrig = null;
    }
    if (pendingTrans !== null && !selectionInside(transEl)) {
      transEl.textContent = pendingTrans; pendingTrans = null;
    }
    updateEmptyState();
  }
  document.addEventListener("selectionchange", flushHeldLines);

  // ---- selecting subtitle text --------------------------------------------
  // The overlay is a CHILD of #movie_player, not a layer under it, so the
  // moment a line accepts the pointer its events bubble straight up to the
  // player and YouTube pauses the video on the click. mousedown is stopped
  // (never prevented — preventing it is what starts a selection) and so is
  // contextmenu, or right-click-copy would open YouTube's menu instead of the
  // browser's.
  //
  // The stray click is the other half: press on a line, drag off it, release
  // over the picture, and the click event fires on their nearest common
  // ancestor — the player. One click, eaten in the capture phase, only when a
  // press on a line started it.
  // Two flags, two lifetimes. selectGesture lives from a press on a line to
  // ITS OWN mouseup — and several real gestures end without any click at all
  // (ctrl-click opening a context menu, a press dragged out of the window),
  // which left the old single flag armed until it ate the viewer's next
  // honest click on the player. The mouseup decides whether the ONE click
  // that may follow it is a stray (released off the line) and arms
  // strayClickArmed for exactly that click.
  let selectGesture = false;
  let strayClickArmed = false;
  function onLineMouseDown(e) {
    if (!settings.selectText || e.button !== 0) return;
    selectGesture = true;
    strayClickArmed = false;
    e.stopPropagation();
  }
  function onLineContextMenu(e) {
    if (!settings.selectText) return;
    e.stopPropagation();
  }
  function onAnyMouseUp(e) {
    if (!selectGesture) return;
    selectGesture = false;
    strayClickArmed = !(overlay && overlay.contains(e.target));
  }
  function onStrayClick(e) {
    if (!strayClickArmed) return;
    strayClickArmed = false;
    e.stopPropagation();
    e.preventDefault();
  }
  window.addEventListener("mouseup", onAnyMouseUp, true);
  window.addEventListener("click", onStrayClick, true);

  function applySelectText() {
    if (!overlay) return;
    overlay.classList.toggle("ytds-select", !!settings.selectText);
    if (!settings.selectText) { selectGesture = false; flushHeldLines(); }
  }

  // ---- video summary --------------------------------------------------------
  // BYO-only, click-to-request, chunked map→reduce. The panel is a content
  // surface like the overlay and the menu: textContent rendering only, closed
  // on navigation / orphaning / the master switch, absolute inside the player
  // so fullscreen keeps it.
  const SUM_CHUNK_CHARS = 9000;
  const SUM_OVERLAP_CHARS = 900;
  function sumStamp(sec) {
    const t = Math.max(0, Math.round(sec));
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), r = t % 60;
    const rr = String(r).padStart(2, "0");
    return h ? h + ":" + String(m).padStart(2, "0") + ":" + rr : m + ":" + rr;
  }
  function sumParseStamp(str) {
    const m = String(str || "").trim().match(/^(\d+):(\d{2})(?::(\d{2}))?$/);
    if (!m) return -1;
    return m[3] != null
      ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3])
      : (+m[1]) * 60 + (+m[2]);
  }
  // The ORIGINAL track feeds the model (translate+summarize in one pass — the
  // reply is asked for in targetLang); stamps ride in the text so chapters
  // can only anchor to marks that exist.
  function sumRows() {
    const rows = [];
    if (!cueList) return rows;
    for (const c of cueList) {
      const x = String(c.text || "").trim();
      if (x) rows.push("[" + sumStamp((c.start || 0) / 1000) + "] " + x);
    }
    return rows;
  }
  function sumChunksFromRows(lines) {
    const chunks = [];
    let cur = [], size = 0;
    for (const l of lines) {
      if (size + l.length > SUM_CHUNK_CHARS && cur.length) {
        chunks.push(cur.join("\n"));
        // ~10% tail rides into the next chunk so a point cut at the seam is
        // whole in at least one of them.
        const keep = []; let kept = 0;
        for (let i = cur.length - 1; i >= 0 && kept < SUM_OVERLAP_CHARS; i--) {
          keep.unshift(cur[i]); kept += cur[i].length;
        }
        cur = keep; size = kept;
      }
      cur.push(l); size += l.length;
    }
    if (cur.length) chunks.push(cur.join("\n"));
    return chunks;
  }

  let sumEl = null;
  let sumEpoch = 0;               // bumped on close: in-flight replies are stale
  // The last finished summary, and what it was a summary OF. Closing the panel
  // and opening it again used to re-run the whole thing — a second full charge
  // against the reader's own quota for a result they had just read. The key is
  // the track, the provider and the target language: change any of the three
  // and it is a different summary, so the price is quoted again.
  let sumCache = null;
  function sumForget() { sumCache = null; }
  function sumClose() {
    sumEpoch++;
    if (sumEl) { try { sumEl.remove(); } catch (_e) { /* ignore */ } sumEl = null; }
  }
  function sumNode(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function sumBody() {
    const player = getPlayer();
    if (!player) return null;
    if (!sumEl || !sumEl.isConnected) {
      sumEl = sumNode("div", "ytds-sum");
      sumEl.addEventListener("mousedown", (e) => e.stopPropagation());
      // The panel opens INSIDE the player, so focus stayed on the player and
      // its buttons were a long tab away. It takes focus itself — the panel,
      // not a button in it: the export dialog can put focus on its confirm key
      // because it owns the page, but here the space bar belongs to YouTube,
      // and a focused "Summarize" would turn Pause into Spend.
      sumEl.tabIndex = -1;
      sumEl.setAttribute("role", "region");
      sumEl.setAttribute("aria-label", ct("sumPanelTitle", "视频总结"));
      const head = sumNode("div", "ytds-sum-head");
      head.appendChild(sumNode("span", "ytds-sum-title", ct("sumPanelTitle", "视频总结")));
      const close = sumNode("button", "ytds-sum-close", "\u00d7");
      close.type = "button";
      close.setAttribute("aria-label", ct("sumClose", "关闭"));
      close.addEventListener("click", sumClose);
      head.appendChild(close);
      sumEl.appendChild(head);
      sumEl.appendChild(sumNode("div", "ytds-sum-body"));
      player.appendChild(sumEl);
      try { sumEl.focus({ preventScroll: true }); } catch (_e) { /* ignore */ }
    }
    const body = sumEl.querySelector(".ytds-sum-body");
    body.textContent = "";
    return body;
  }
  function sumButton(label, cls, onClick) {
    const b = sumNode("button", "ytds-sum-btn" + (cls ? " " + cls : ""), label);
    b.type = "button";
    b.addEventListener("click", onClick);
    return b;
  }
  function sumSeek(sec) {
    const v = getVideo();
    if (!v || sec < 0) return;
    try { v.currentTime = sec; } catch (_e) { /* a rig video has no setter */ }
  }
  // TLDR: line, "@ stamp title" chapters, "- point" bullets — the contract
  // sumOnceMessages/sumReduceMessages pin on the worker side. Parsed
  // tolerantly: a line that fits nothing joins the open chapter as a point.
  function sumRender(text, failedParts) {
    const body = sumBody();
    if (!body) return;
    let chapters = null;
    for (const raw of String(text || "").split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      const tl = line.match(/^TLDR[::]\s*(.*)$/i);
      if (tl) { body.appendChild(sumNode("p", "ytds-sum-tldr", tl[1])); continue; }
      // The stamps ride the input as [m:ss], and a model that copies them
      // verbatim writes "@ [0:44] title" — measured on qwen2.5:7b live. The
      // brackets are welcome either way; only the stamp inside them matters.
      const ch = line.match(/^@\s*\[?(\d+:\d{2}(?::\d{2})?)\]?\s*(.*)$/);
      if (ch) {
        chapters = chapters || body.appendChild(sumNode("div", "ytds-sum-chapters"));
        // One grid per chapter: the stamp sits in the first column and both
        // the title and every point that follows sit in the second. The
        // points used to be siblings of the stamp indented by a fixed 46px,
        // which is the width of "0:05" and nothing else — an hour-long video
        // stamps 1:02:33 and the text under it stopped lining up with the
        // heading it belonged to.
        const sec = sumNode("section", "ytds-sum-sec");
        const stamp = sumParseStamp(ch[1]);
        sec.appendChild(sumButton(ch[1], "ytds-sum-stamp", () => sumSeek(stamp)));
        sec.appendChild(sumNode("h3", "ytds-sum-ch-title", ch[2]));
        chapters.appendChild(sec);
        continue;
      }
      const pt = line.match(/^[-•]\s*(.*)$/);
      const dest = chapters && chapters.lastChild ? chapters.lastChild : null;
      const li = sumNode("div", "ytds-sum-pt", pt ? pt[1] : line);
      if (dest) dest.appendChild(li); else body.appendChild(li);
    }
    if (failedParts > 0) {
      body.appendChild(sumNode("p", "ytds-sum-warn",
        tsub("sumFailedPart", [String(failedParts)], "有 $1$ 段没能总结，以上是其余部分。")));
    }
  }
  // The refusals worth naming here. Each already has a sentence in every
  // language on the translate side, each is self-contained (none names a field
  // or a button this panel does not have), and each is something the reader
  // can act on. "Try again later" stays for the one code it is actually true
  // of — rate limiting — and for anything unrecognised: said over a rejected
  // key or an empty account it sent the reader back to press the same button
  // on the same broken setup.
  function sumErrLine(code) {
    if (code === "auth") {
      return ct("byoErrAuth", "Key 被拒绝（401）：检查是不是完整复制、是不是还有效。");
    }
    if (code === "quota") {
      return ct("byoErrQuota", "这个账号本期的余额或额度已经用完——去服务商后台充值或等下个周期。");
    }
    if (code === "forbidden") {
      return ct("byoErrForbidden", "服务商拒绝了这次调用（403）。通常不是 Key 写错了，而是这个账号不被允许这样调用——余额不足、实名认证还没做、这个模型没开通，或者所在地区受限。去服务商后台看看账号状态。");
    }
    if (code === "netfail") {
      return ct("byoErrNetfail", "连不上这个接口(网络或区域限制)。");
    }
    return "";
  }
  function sumFail(resp) {
    const code = (resp && resp.code) || "failed";
    if (code === "noProvider" || code === "needLlm" || code === "noKey" ||
        code === "noModel" || code === "badBaseUrl") { sumNeedKeyState(); return; }
    const body = sumBody();
    if (!body) return;
    const named = sumErrLine(code);
    body.appendChild(sumNode("p", "ytds-sum-warn",
      named || ct("sumFail", "总结失败，稍后再试。")));
  }
  function sumNeedKeyState() {
    const body = sumBody();
    if (!body) return;
    body.appendChild(sumNode("p", null,
      ct("sumNeedKey", "总结需要你自己的翻译服务（填过 Key 的任何一家，或本机跑的模型）。免费引擎只翻译，不总结。")));
    body.appendChild(sumButton(ct("sumConfigure", "去配置翻译服务"), "ytds-sum-primary",
      () => extCall(() => chrome.runtime.sendMessage({ type: "openOptions" }))));
  }
  function sumProgress(done, total, myEpoch) {
    const body = sumBody();
    if (!body) return;
    body.appendChild(sumNode("p", "ytds-sum-busy",
      tsub("sumWorking", [String(done), String(total)], "总结中… 第 $1$/$2$ 段")));
    body.appendChild(sumButton(ct("exportConfirmBack", "取消"), null,
      () => { if (myEpoch === sumEpoch) sumClose(); }));
  }
  function sumKeep(name, text, failed) {
    sumCache = { track: cueTrackId, name: name, lang: settings.targetLang,
      text: text, failed: failed };
  }
  function sumRun(chunks, name) {
    const myEpoch = sumEpoch;
    const total = chunks.length;
    if (total === 1) {
      sumProgress(0, 1, myEpoch);
      extCall(() => chrome.runtime.sendMessage(
        { type: "sumOnce", text: chunks[0], targetLang: settings.targetLang }, (resp) => {
          if (myEpoch !== sumEpoch) return;
          if (chrome.runtime.lastError || !resp || !resp.ok) { sumFail(resp); return; }
          sumKeep(name, resp.summary, 0);
          sumRender(resp.summary, 0);
        }));
      return;
    }
    const notes = [];
    let failed = 0;
    const step = (i) => {
      // Redundant with the reply-side epoch check below and kept on purpose
      // (the D83/D85 double-guard shape): each survives alone, the pair died
      // together under combined mutation. This half is what stops a DIRECT
      // step() call after a close, if a refactor ever adds one.
      if (myEpoch !== sumEpoch) return;             // closed / cancelled
      if (i >= total) {
        const good = notes.filter((x) => x != null);
        if (!good.length) { sumFail(null); return; }
        extCall(() => chrome.runtime.sendMessage(
          { type: "sumReduce", notes: good, targetLang: settings.targetLang }, (resp) => {
            if (myEpoch !== sumEpoch) return;
            if (chrome.runtime.lastError || !resp || !resp.ok) { sumFail(resp); return; }
            sumKeep(name, resp.summary, failed);
            sumRender(resp.summary, failed);
          }));
        return;
      }
      sumProgress(i, total, myEpoch);
      extCall(() => chrome.runtime.sendMessage(
        { type: "sumMap", text: chunks[i], targetLang: settings.targetLang }, (resp) => {
          if (myEpoch !== sumEpoch) return;
          if (chrome.runtime.lastError || !resp || !resp.ok) { failed++; notes[i] = null; }
          else notes[i] = resp.notes;
          step(i + 1);
        }));
    };
    step(0);
  }
  function openSummary() {
    const rows = sumRows();
    if (!rows.length) {
      const body = sumBody();
      // Two different empties. With the overlay switched off there are no rows
      // because we tore them down, not because the video has none — saying
      // "this video has no caption track" over a video whose captions the
      // reader can see burned into the picture is the product being wrong
      // about something the reader can check.
      if (body) {
        body.appendChild(sumNode("p", null, settings.enabled
          ? ct("sumEmpty", "这支视频没有可用的字幕轨。")
          : ct("sumNeedSubs", "先把字幕打开再总结——总结是照着字幕轨做的。")));
      }
      return;
    }
    const chunks = sumChunksFromRows(rows);
    const myEpoch = sumEpoch;
    const body = sumBody();
    if (!body) return;
    body.appendChild(sumNode("p", "ytds-sum-busy", "…"));
    extCall(() => chrome.runtime.sendMessage({ type: "sumInfo" }, (info) => {
      if (myEpoch !== sumEpoch) return;
      if (chrome.runtime.lastError || !info || !info.ok) { sumFail(null); return; }
      if (!info.configured || info.kind !== "llm") { sumNeedKeyState(); return; }
      // Already summarized, and nothing about it has changed: give the reader
      // back what they paid for instead of charging them for it twice. The
      // way to spend again is a button that says so and goes through the
      // same quote as the first time.
      const keep = sumCache;
      if (keep && keep.track === cueTrackId && keep.name === info.name &&
          keep.lang === settings.targetLang) {
        sumRender(keep.text, keep.failed);
        const b1 = sumEl && sumEl.querySelector(".ytds-sum-body");
        if (b1) {
          b1.appendChild(sumButton(ct("sumAgain", "重新总结"), "ytds-sum-again", () => {
            if (myEpoch !== sumEpoch) return;
            sumForget();
            openSummary();
          }));
        }
        return;
      }
      // The whole track leaves the browser and burns the user's own quota —
      // said out loud BEFORE the first request, the export precedent.
      const b2 = sumBody();
      if (!b2) return;
      // Display through the provider's shortKey (the raw short put 「百炼」
      // into nineteen locales here); identity checks above stay on the raw
      // name — a cache must not change identity with the UI language.
      const provName = (info.nameKey && ct(info.nameKey, info.name)) || info.name;
      b2.appendChild(sumNode("p", null,
        tsub("sumConfirm", [provName, String(chunks.length)],
          "会把整条字幕发给 $1$，分 $2$ 段，花的是你自己的额度。")));
      b2.appendChild(sumButton(ct("sumStart", "开始总结"), "ytds-sum-primary",
        () => { if (myEpoch === sumEpoch) sumRun(chunks, info.name); }));
      b2.appendChild(sumButton(ct("exportConfirmBack", "取消"), null,
        () => { if (myEpoch === sumEpoch) sumClose(); }));
    }));
  }

  // ---- the in-player menu (behind the toggle button's arrow) ---------------
  // Entry plan B, picked 2026-08-24: the button keeps its one job — a click
  // still toggles the subtitles — and a small arrow in its corner pulls out a
  // menu with the high-frequency switches, so turning read-aloud or
  // select-and-copy on or off no longer needs the popup. Every row writes the
  // SAME sync key the popup writes and lets storage.onChanged do the real
  // work, so the two UIs cannot drift apart.
  let menuEl = null;
  let moreEl = null;

  function ct(key, fb) {
    if (uiTable && uiTable[key] && uiTable[key].message) return uiSubst(uiTable[key]);
    try { return chrome.i18n.getMessage(key) || fb; } catch (_e) { return fb; }
  }
  // ct with $1$-style substitutions; the fallback substitutes too, or the rig
  // (whose getMessage answers nothing) would show literal "$1$" to a reader.
  function tsub(key, subs, fb) {
    try {
      if (uiTable && uiTable[key] && uiTable[key].message) return uiSubst(uiTable[key], subs);
      const v = chrome.i18n.getMessage(key, subs);
      if (v) return v;
    } catch (_e) { /* fall through to the inline fallback */ }
    let out = String(fb || "");
    (subs || []).forEach((x, i) => { out = out.replace("$" + (i + 1) + "$", x); });
    return out;
  }

  // One stroke family for the menu (1.8px, round caps, currentColor) — the
  // in-player equivalent of provider-icons' single visual system. Static
  // markup only; the label is set with textContent, never markup. The
  // selection glyph is two subtitle lines with the top one boxed: an I-beam
  // reads as "edit", and this toggle edits nothing.
  const MENU_SVG_ATTRS = 'xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"';
  const MENU_ICONS = {
    enabled: '<svg class="ytds-mi-icon" ' + MENU_SVG_ATTRS + '><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M6.5 12.2h6.5M6.5 15.4h9.5"/></svg>',
    ttsEnabled: '<svg class="ytds-mi-icon" ' + MENU_SVG_ATTRS + '><path d="M4.5 10v4h3l4.5 3.8V6.2L7.5 10h-3z"/><path d="M15.2 9.6a3.6 3.6 0 0 1 0 4.8M17.6 7.6a6.6 6.6 0 0 1 0 8.8"/></svg>',
    selectText: '<svg class="ytds-mi-icon" ' + MENU_SVG_ATTRS + '><rect x="3.2" y="6.6" width="13.6" height="4.8" rx="1.4"/><path d="M6 9h8M6 16.4h12"/></svg>',
    summary: '<svg class="ytds-mi-icon" ' + MENU_SVG_ATTRS + '><rect x="5" y="4" width="14" height="16" rx="2"/><path d="M8.5 9h7M8.5 12.5h7M8.5 16h4.5"/></svg>',
    openOptions: '<svg class="ytds-mi-icon" ' + MENU_SVG_ATTRS + '><circle cx="12" cy="12" r="3.1"/><path d="M12 4.6v2.2M12 17.2v2.2M4.6 12h2.2M17.2 12h2.2M6.9 6.9l1.5 1.5M15.6 15.6l1.5 1.5M17.1 6.9l-1.5 1.5M8.4 15.6l-1.5 1.5"/></svg>'
  };
  // The right-hand slot: an empty box that fills with a check — the shape
  // says "this is a switch" even while it is off, which the bare hover-only
  // checkmark never managed. The settings row carries the leave arrow.
  const MENU_STATE_SVG = '<svg class="ytds-mi-state" ' + MENU_SVG_ATTRS + '><rect x="4.2" y="4.2" width="15.6" height="15.6" rx="3.4"/><path class="ytds-check" d="M8 12.3l2.7 2.7 5.4-6"/></svg>';
  const MENU_GO_SVG = '<svg class="ytds-mi-state ytds-mi-go" ' + MENU_SVG_ATTRS + '><path d="M7.5 16.5l9-9M9.5 7.5h7v7"/></svg>';

  const MENU_ROWS = [
    { key: "enabled", label: () => ct("menuSubtitles", "字幕") },
    { key: "ttsEnabled", label: () => ct("optNavReadaloud", "朗读") },
    // Its own SHORT key, not the popup checkbox's sentence: a menu row is a
    // name, and the sentence wrapped to two lines and read as an action.
    { key: "selectText", label: () => ct("menuSelectText", "选中复制") },
    { key: "summary", label: () => ct("menuSummary", "总结"), action: true,
      run: () => openSummary() },
    { key: "openOptions", label: () => ct("openOptions", "设置"), action: true,
      run: () => extCall(() => chrome.runtime.sendMessage({ type: "openOptions" })) }
  ];

  function closeMenu() {
    if (menuEl) { try { menuEl.remove(); } catch (_e) { /* ignore */ } menuEl = null; }
  }

  function paintMenuRows() {
    if (!menuEl) return;
    for (const el of menuEl.querySelectorAll(".ytds-mi[data-key]")) {
      const k = el.getAttribute("data-key");
      if (k === "openOptions" || k === "summary") continue;   // action rows, not switches
      el.setAttribute("aria-pressed", settings[k] ? "true" : "false");
    }
  }

  function openMenu() {
    if (orphaned) return;
    closeMenu();
    const player = getPlayer();
    if (!player || !toggleBtn || !toggleBtn.isConnected) return;
    // Opened once = the arrow is discovered: retire the first-run pulse for
    // good (one write, ever — the guard keeps every later open silent).
    if (!menuHintKilled) {
      menuHintKilled = true;
      toggleBtn.classList.remove("ytds-menu-hint");
      hideMenuBubble();
      extCall(() => chrome.storage.local.set({ menuHintsLeft: 0 }));
    }
    menuEl = document.createElement("div");
    menuEl.className = "ytds-menu";
    // Presses inside the menu are the menu's business — they must neither
    // close it (the document listener below) nor pause the player.
    menuEl.addEventListener("mousedown", (e) => e.stopPropagation());
    for (const row of MENU_ROWS) {
      // The switches and the actions live apart: ONE visible seam before the
      // first action row is what tells a row that flips from a row that does.
      if (row.action && !menuEl.querySelector(".ytds-msep")) {
        const sep = document.createElement("div");
        sep.className = "ytds-msep";
        menuEl.appendChild(sep);
      }
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ytds-mi";
      b.setAttribute("data-key", row.key);
      b.innerHTML = (MENU_ICONS[row.key] || "") +
        '<span class="ytds-mi-label"></span>' +
        (row.action ? MENU_GO_SVG : MENU_STATE_SVG);
      b.querySelector(".ytds-mi-label").textContent = row.label();
      if (!row.action) b.setAttribute("aria-pressed", settings[row.key] ? "true" : "false");
      b.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (orphaned) { closeMenu(); return; }
        if (row.action) {
          // A content script has no openOptionsPage; the worker opens the
          // settings page, and the summary panel opens itself — each action
          // row carries its own run().
          if (row.run) row.run();
          closeMenu();
          return;
        }
        const next = !settings[row.key];
        settings[row.key] = next;              // optimistic, like onToggleClick
        paintMenuRows();
        if (row.key === "enabled") { updateToggleState(); applyStateToDom(); syncCaptions(); }
        if (row.key === "selectText") applySelectText();
        // Read-aloud is the one key whose storage round-trip is audible: the
        // press said off, a reply already in flight said a whole line, and
        // onChanged only stopped things a beat later. Do locally what the
        // listener would do — stop now, and on the way back on offer the line
        // on screen to the engine instead of waiting for the next boundary.
        if (row.key === "ttsEnabled") {
          // ttsStop here survives mutation for the same reason the reply-path
          // check does — each currently covers for the other — and is kept for
          // the same reason: it is the half that silences audio ALREADY
          // speaking, which no reply-side check can reach.
          if (!next) ttsStop();
          else if (activeCueIdx >= 0 && cueList && cueList[activeCueIdx]) {
            const vv2 = getVideo();
            const cue2 = cueList[activeCueIdx];
            ttsOnCue(activeCueIdx, cue2,
              vv2 ? Math.max(0, vv2.currentTime * 1000 - ttsLineStartMs(activeCueIdx)) : 0);
          }
        }
        extCall(() => chrome.storage.sync.set({ [row.key]: next }));
      });
      menuEl.appendChild(b);
    }
    // Right-aligned over the button, above the control bar. The menu is a
    // child of the player, so the offsets are player-relative.
    const pr = player.getBoundingClientRect();
    const br = toggleBtn.getBoundingClientRect();
    menuEl.style.right = Math.max(8, Math.round(pr.right - br.right)) + "px";
    menuEl.style.bottom = Math.max(48, Math.round(pr.bottom - br.top) + 4) + "px";
    player.appendChild(menuEl);
    // Never taller than the player: a mini-player is ~225px high, and richer
    // rows would run the first ones off its top — lower the anchor instead
    // (the redesign review's height audit; measured, not assumed).
    // Small embeds first cap the menu's own height (it scrolls past that),
    // then the anchor comes down if the capped menu still overflows the top.
    menuEl.style.maxHeight = Math.max(96, pr.height - 8) + "px";
    const mh = menuEl.getBoundingClientRect().height;
    const b0 = parseFloat(menuEl.style.bottom) || 0;
    const over = b0 + mh - (pr.height - 4);
    if (over > 0) menuEl.style.bottom = Math.max(4, b0 - over) + "px";
    // …and the same care sideways, which it never had. The menu hangs to the
    // LEFT of a right-aligned anchor, and the anchor is draggable: park the
    // button near the left edge and the menu opened off the side of the
    // player, most of it outside the picture. The height audit above was
    // written after a review caught the vertical version of this; nothing had
    // ever measured the horizontal one, because no test could open this menu
    // in a player at all until menu-locales.js.
    const mw = menuEl.getBoundingClientRect().width;
    const r0 = parseFloat(menuEl.style.right) || 0;
    const spill = mw + r0 - (pr.width - 4);
    if (spill > 0) menuEl.style.right = Math.max(4, r0 - spill) + "px";
  }

  function onDocMouseDownForMenu(e) {
    if (!menuEl) return;
    if (menuEl.contains(e.target)) return;
    if (moreEl && moreEl.contains(e.target)) return;   // the arrow itself toggles
    closeMenu();
  }
  document.addEventListener("mousedown", onDocMouseDownForMenu, true);
  // Escape closes it too. The menu is a popup over the picture and everything
  // else that behaves like one in this extension — the popup's two inline
  // panels, the engine tip — already answers Escape; this one only closed by
  // clicking elsewhere, which on a video means clicking the video.
  // NOT the summary panel: closing that by accident throws away something the
  // reader may have paid for, and leaving it out is a decision, not an
  // oversight.
  function onKeyDownForMenu(e) {
    if (orphaned || !menuEl) return;
    if (e.key !== "Escape" && e.key !== "Esc") return;
    // The arrow gets the focus back, so the keyboard is where it was.
    closeMenu();
    try { if (moreEl) moreEl.focus(); } catch (_e2) { /* ignore */ }
    e.stopPropagation();
  }
  document.addEventListener("keydown", onKeyDownForMenu, true);

  // ---- in-player quick toggle (YouTube control bar) ------------------------
  // A small button in the player's right-controls that flips the whole
  // extension on/off without opening the popup — handy when a video has
  // burned-in subtitles and the overlay would just overlap them.
  let toggleBtn = null;
  let controlsObserver = null;
  let controlsObserved = null;   // the element it is bound to

  function ensureToggleButton(retries) {
    // A retry can still be pending from before the reload — the controls were
    // not ready yet — and it must not put a dead button into a player the live
    // script has already taken over.
    if (orphaned) return;
    const player = getPlayer();
    const rc = player && player.querySelector(".ytp-right-controls");
    if (!rc) {                              // controls not ready yet — retry briefly
      if (retries > 0) setTimeout(() => ensureToggleButton(retries - 1), 500);
      return;
    }
    if (toggleBtn && toggleBtn.isConnected) { updateToggleState(); return; }
    toggleBtn = document.createElement("button");
    toggleBtn.className = "ytp-button ytds-toggle";
    toggleBtn.type = "button";
    toggleBtn.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true">' +
      '<rect x="2.6" y="5.5" width="18.8" height="13" rx="2.6" fill="none" ' +
      'stroke="currentColor" stroke-width="1.8"></rect>' +
      '<rect x="5.6" y="9.2" width="7" height="1.8" rx="0.9" fill="currentColor"></rect>' +
      '<rect x="5.6" y="13" width="11" height="1.8" rx="0.9" fill="currentColor"></rect>' +
      "</svg>";
    toggleBtn.addEventListener("click", onToggleClick, true);
    moreEl = document.createElement("span");
    moreEl.className = "ytds-toggle-more";
    moreEl.textContent = "▾";
    // No listener of its own: onToggleClick runs in the CAPTURE phase on the
    // button, so it sees the arrow's clicks first and routes them to the menu.
    toggleBtn.appendChild(moreEl);
    rc.insertBefore(toggleBtn, rc.firstChild);   // leftmost of the right group
    updateToggleState();
    observeControls(rc);
  }

  function onToggleClick(e) {
    e.preventDefault();
    e.stopPropagation();
    if (moreEl && (e.target === moreEl || moreEl.contains(e.target))) {
      if (menuEl) closeMenu(); else openMenu();
      return;
    }
    settings.enabled = !settings.enabled;   // optimistic
    updateToggleState();                     // instant button feedback
    applyStateToDom();                       // add/remove overlay immediately
    syncCaptions();                          // turn YouTube CC on/off to match
    extCall(() => chrome.storage.sync.set({ enabled: settings.enabled }));
  }

  function updateToggleState() {
    if (!toggleBtn) return;
    const on = !!settings.enabled;
    toggleBtn.classList.toggle("ytds-on", on);
    toggleBtn.setAttribute("aria-pressed", on ? "true" : "false");
    const label =
      (on ? t("toggleTurnOff", "关闭双语字幕") : t("toggleTurnOn", "开启双语字幕")) +
      " (Dual Subtitles for YouTube)";
    toggleBtn.setAttribute("aria-label", label);
    toggleBtn.title = label;
  }

  // Re-inject the button if YouTube ever rebuilds/clears its right-controls.
  // Bound to whichever control bar exists NOW: YouTube rebuilds this element,
  // and moving between a watch page and a short swaps the player outright. The
  // guard used to be "already observing, nothing to do", which left the
  // observer watching an element no longer on the page — so on the second
  // player the watchdog that puts our button back was quietly not running.
  // Same shape liftObserver already uses.
  function observeControls(rc) {
    if (controlsObserver && controlsObserved === rc) return;
    if (controlsObserver) controlsObserver.disconnect();
    controlsObserved = rc;
    controlsObserver = new MutationObserver(() => {
      if (!toggleBtn || !toggleBtn.isConnected) {
        toggleBtn = null;
        closeMenu();               // its anchor just went; coordinates are stale
        ensureToggleButton(0);
      }
    });
    controlsObserver.observe(rc, { childList: true });
  }

  // ---- auto-enable YouTube's caption track ---------------------------------
  // The overlay needs the player to actually FETCH a timedtext track (that is
  // how inject.js gets the pot-bearing URL). So when the extension is on we turn
  // YouTube's CC on for the user by clicking the native button; turning the
  // extension off restores it — but only if WE were the ones who turned it on.
  let weEnabledCC = false;

  function ensureCaptionsOn(retries) {
    if (!settings.enabled) return;
    // Scope to the ACTIVE player: a shorts page keeps a hidden #movie_player
    // whose CC button must not be clicked (it toggles the wrong player). The
    // chromeless shorts player has no CC button at all — retries simply lapse
    // and inject.js nudges the captions module instead.
    const player = getPlayer();
    const cc = player && player.querySelector(".ytp-subtitles-button");
    if (!cc || cc.getAttribute("aria-pressed") === null) {
      if (retries > 0) setTimeout(() => ensureCaptionsOn(retries - 1), 600);
      return;                                   // button / state not ready yet
    }
    if (cc.getAttribute("aria-disabled") === "true") {
      // Disabled is often TRANSIENT: on a cold page load YouTube keeps the CC
      // button disabled until the video's track list arrives, several seconds
      // after the button exists. Treating that as "no captions on this video"
      // made auto-enable give up on cold loads (SPA navs were fast enough to
      // never hit it). Keep retrying within the window; a video with genuinely
      // no track just lets the retries lapse — clicking never happens either way.
      if (retries > 0) setTimeout(() => ensureCaptionsOn(retries - 1), 600);
      return;
    }
    if (cc.getAttribute("aria-pressed") !== "true") {
      cc.click();
      weEnabledCC = true;
    }
  }

  function restoreCaptionsIfWeEnabled() {
    if (!weEnabledCC) return;
    weEnabledCC = false;
    const player = getPlayer();
    const cc = player && player.querySelector(".ytp-subtitles-button");
    if (cc && cc.getAttribute("aria-pressed") === "true") cc.click();
  }

  function syncCaptions() {
    // 20 × 600ms ≈ 12s window: covers slow cold loads where the CC button
    // stays aria-disabled for several seconds while the track list loads.
    if (settings.enabled) ensureCaptionsOn(20);
    else restoreCaptionsIfWeEnabled();
  }

  // =========================================================================
  // CUE MODE
  // =========================================================================

  // binary search: greatest index whose start <= t. -1 if none.
  function findCueIdx(t) {
    if (!cueList || !cueList.length) return -1;
    let lo = 0, hi = cueList.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cueList[mid].start <= t) { ans = mid; lo = mid + 1; }
      else { hi = mid - 1; }
    }
    return ans;
  }

  // Find the cue active at time t, tolerant of overlapping/zero-dur cues.
  // findCueIdx gives the greatest-start candidate; if t is past that cue's
  // effective end we walk back to catch an earlier, longer cue still covering t
  // before declaring a gap. Returns the cue index or -1.
  function activeCueIdxAt(t) {
    let idx = findCueIdx(t);
    if (idx < 0) return -1;
    // Walk back over earlier cues whose (sorted) start <= t in case a longer
    // earlier cue still covers t. Bounded scan keeps this cheap.
    for (let i = idx; i >= 0; i--) {
      const c = cueList[i];
      if (t < c.end) return i;       // c covers t (end is the effective end)
      // If even the latest-starting candidate (i === idx) has ended, an
      // earlier cue might still be open (overlap); keep walking a small window.
      if (idx - i > 8) break;        // safety bound; cues rarely overlap deeply
    }
    return -1;                        // genuine gap
  }

  function startCueLoop() {
    stopCueLoop();
    activeCueIdx = -1;
    activeGroupIdx = -1;
    clearPendingTimer();
    cueEpoch++;                       // invalidate any in-flight gtx callbacks
    ensureOverlay();
    // Clear any leftover text (e.g. last scraped fallback line, or a previous
    // cue) so a start during a gap does not leave a stale line on screen.
    setOriginal("");
    setTranslation("", "");
    cueTimer = setInterval(cueTick, 120);
    cueTick();                        // render the active cue NOW (no blank frame)
  }

  function stopCueLoop() {
    if (cueTimer) { clearInterval(cueTimer); cueTimer = null; }
    activeCueIdx = -1;
  }

  // ---- read-aloud playback --------------------------------------------------
  // Speaks the translation line the overlay is showing, one sentence at a time.
  // The rules are the honest ones from the design round, in code order below:
  // a line whose translation is not ready WHEN ITS CUE STARTS is skipped, never
  // caught up on (a late voice is a wrong voice); leaving the video drops
  // everything; the player's own audio is ducked through inject.js while a
  // line is speaking, and politely restored. The worker does the synthesis and
  // the byte cache — this side only decides WHEN, and holds one Audio at a time.
  // How long a decoded line may take to report how long it is. These are blob
  // URLs already in memory, so this is not a slow decode allowance — it is the
  // point past which the decode is not going to happen and the bytes have to
  // go back.
  const TTS_META_MS = 4000;
  // How long a locally spoken line may run before we stop believing that
  // `end` is coming. Generous on purpose: releasing the duck late is a
  // second of quiet video, releasing it early talks over the speaker.
  const TTS_LOCAL_MIN_MS = 2500;
  const TTS_LOCAL_MAX_MS = 30000;
  // How long to wait for the voice to BEGIN, which is a different question
  // from how long a line takes to say. The ceiling above covers a long spoken
  // line; using it here too meant a line that never made a sound at all held
  // the video quiet for half a minute. Ten seconds is generous for the slowest
  // of these — Chrome's own network-backed voices fetch their audio — and a
  // local voice that has not started by then is not going to.
  const TTS_LOCAL_START_MS = 10000;
  // Milliseconds a character is worth. An estimate, not a measurement: it has
  // to cover the slowest of the languages this reads, which are the CJK ones
  // at roughly four to five characters a second, so it is far too generous for
  // a Latin line. That is the right direction to be wrong in — the ceiling
  // catches the long ones, and holding the video quiet a moment too long is a
  // smaller fault than talking over the voice.
  const TTS_LOCAL_PER_CHAR_MS = 240;
  // …but that ceiling is the wrong RULER for sizing. 240ms/char is a
  // Chinese/Japanese pace; a Latin, Cyrillic, Greek or Arabic line is read
  // about three times as fast, and sizing it against 240 called nearly every
  // English line "does not fit" — the picture sat at 0.85× of the viewer's
  // speed for the whole video (D156). The ruler is seeded per script and then
  // learned from this machine's own finished lines (start→end, whole
  // utterances only), biased long: a cut tail costs more than a late release.
  const TTS_LOCAL_PER_CHAR_MS_LATIN = 80;
  const ttsLocalCharEma = { cjk: 0, other: 0 };
  const ttsScriptClass = (text) =>
    /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\u0e00-\u0e7f]/.test(String(text || "")) ? "cjk" : "other";
  function ttsLocalCharMs(text) {
    const cls = ttsScriptClass(text);
    const seed = cls === "cjk" ? TTS_LOCAL_PER_CHAR_MS : TTS_LOCAL_PER_CHAR_MS_LATIN;
    const ema = ttsLocalCharEma[cls];
    return ema ? Math.max(seed * 0.5, Math.min(seed * 2, ema * 1.15)) : seed;
  }
  function ttsLocalCharLearn(text, realMs, rate) {
    const len = String(text || "").length;
    if (len < 6 || !(realMs > 0)) return;          // too short to say anything about the voice
    const cls = ttsScriptClass(text);
    const seed = cls === "cjk" ? TTS_LOCAL_PER_CHAR_MS : TTS_LOCAL_PER_CHAR_MS_LATIN;
    const per = realMs * (rate > 0 ? rate : 1) / len;
    // A real voice lands within a band around the seed (CJK 120–600 ms a
    // character, Latin 40–200). A sample outside it — an `end` that fired
    // early, a line cut off, a synthetic voice in a test rig — teaches
    // nothing, and the first honest sample only nudges the seed: one line is
    // not a measurement of the voice.
    if (per < seed * 0.5 || per > seed * 2.5) return;
    const cur = ttsLocalCharEma[cls] || seed;
    ttsLocalCharEma[cls] = cur * 0.7 + per * 0.3;
  }
  // How long a finishing line may hold the next one back. The audio path has
  // had this from the start (400ms, measured remaining); here the remaining
  // is an ESTIMATE, so the window is slightly wider to absorb its error.
  const TTS_LOCAL_GRACE_MS = 500;
  // The speak()→start hole of Chrome's NETWORKED built-in voices (D34): a
  // conservative default until a real measurement exists, then a moving
  // average, capped — past the cap it is the never-begins watchdog's problem.
  const TTS_LOCAL_NET_PENALTY_MS = 1200;
  const TTS_LOCAL_NET_PENALTY_MAX = 3000;
  let ttsLocalNetEma = 0;       // reset when the voice or provider changes
  let localTimer = 0;
  // Lines decoded but not yet on air, by cue index. Their bytes live in a
  // closure inside ttsPlay, so this is the only handle anything else has on
  // them — ttsStop uses it to empty the room, and each new line uses it to
  // free the ones it has just made pointless.
  const ttsPendingRelease = new Map();
  let ttsEpoch = 0;             // bumped on stop: any in-flight reply is stale
  let ttsAudio = null;
  // Whether the video was paused the last time we looked. The voice follows
  // the video: pausing means stop, not "finish the sentence over a frozen
  // frame" — and while it finished, the video's own sound stayed held down
  // underneath it. Polled rather than listened for, because the element is
  // replaced on every navigation and a listener would have to be re-attached
  // each time; the cue loop already has the element in its hand every 120ms.
  let ttsPausedWith = false;
  let ttsBlobUrl = "";
  let ttsSpokenIdx = -1;        // last cue index we started speaking
  // Skips charged against the sentence currently on screen, so a claim that
  // lands late can take them back. "Skipped" is a verdict, and at cue start
  // it is only provisional: the words may still arrive with time to spare.
  // Billing at the start and speaking anyway left the popup calling a line it
  // had just read "skipped" (measured in the rig).
  let ttsSkipGroup = -1;        // which group the provisional skips belong to
  let ttsSkipCharged = 0;       // how many were charged against it
  // Synthesis runs ahead of playback: idx -> { text, audio, url, bytes }.
  // One line ahead — which is what this was — is only enough while every line
  // is long. On a run of short cues the answer for line N+1 lands after its
  // cue has already gone by, and the run goes quiet; that is the shape the
  // real-device report described, and the reason B2 exists. Several lines
  // ahead absorbs it.
  //
  // The three numbers below are what stop it being unbounded, and they are
  // caps rather than targets: the window is as deep as the caps allow.
  // How far ahead to look, in SECONDS OF VIDEO — not in cues. A cue is the
  // wrong unit for a buffer: a sentence spans about three of them, so "six
  // cues" was two sentences in group mode, about fourteen seconds, while the
  // translation beside it was already warmed twenty-eight seconds out
  // (PREFETCH_GROUPS) and in whole-track mode the entire track is in hand. The
  // thing that decides whether a line is ever waited for is how many seconds
  // of speech are ready, so that is what this counts.
  //
  // It is a REACH, not a budget: the caps below still decide how much is
  // actually held and how much is in flight, and a deep backoff still sheds
  // the lot. What this changes is that the reach no longer shrinks to nothing
  // exactly where the sentences are longest.
  const TTS_AHEAD_MS = 45000;
  const TTS_AHEAD_CUES = 60;             // ceiling, so a track of 0.2s cues ends
  const TTS_AHEAD_MAX = 10;              // decoded lines held at once
  const TTS_AHEAD_BYTES = 4 * 1024 * 1024;
  const TTS_AHEAD_INFLIGHT = 3;          // synthesis requests in the air at once
  let ttsAhead = new Map();
  // idx -> { token, text } for the request in flight for it. A Set could not
  // tell two requests for the same index apart, and there can be two: an index
  // pruned when the window moved, then asked for again when it moved back.
  // The first reply's `delete` then freed the SECOND one's slot.
  // The text is here so the fill can see what is already ON THE WAY: a sentence
  // group hands the same words to several cues, and a request still in the air
  // used to be invisible to that check — the cue after it was bought a second
  // copy of the sentence being fetched.
  let ttsAheadAsking = new Map();
  let ttsAskSeq = 0;
  let ttsAheadBytes = 0;
  // The browser's own voices answer "say this yourself" and never send
  // bytes, so nothing can be held ahead for them. Learned from the first
  // reply rather than read from settings: the reply is the only place that
  // knows, and it is what the window would have stored.
  let ttsAheadOff = false;
  // The text of the line last put on air. A sentence group hands the SAME
  // translation to every cue in it, so speaking per cue reads one sentence
  // two or three times over.
  let ttsSpokenText = "";
  let ttsSpoken = 0;            // lines spoken on THIS video (popup status)
  // Why the last line stayed silent, as a provider error code. Silence used to
  // be reported only as a rising skip count, on the assumption that anyone who
  // changed provider had just seen the options page test it — no longer true
  // now that the popup switches provider by picking a voice. A stored key is
  // not a working one: the key is saved before the test runs, so "saved" also
  // covers "saved, then the test said no region".
  let ttsErr = "";
  // How many lines in a row have failed since the last one that spoke. A
  // provider that works and then stops — an account running out of quota
  // halfway through — used to be invisible: the status line only spoke up
  // when NOTHING had ever worked, so one good line at the start bought the
  // rest of the video silence.
  //
  // One is the threshold, decided 2026-08-23. It was two for a day, on the
  // reasoning that one bad line is a hiccup the counts already cover. Two
  // things settled it the other way: the counts are now shown ALONGSIDE the
  // reason rather than replaced by it, so saying why costs nothing; and this
  // card is not on screen continuously — a fault that clears before anyone
  // opens the popup is never seen, and one that IS seen is true. Staying
  // quiet through the first failure reads as dropping a line and not
  // admitting it.
  let ttsFailRun = 0;
  const TTS_FAIL_RUN_LOUD = 1;
  // This line's fit (the absolute video rate at which it would just fit), kept
  // only while it is on air so a live duck-depth change can carry it along.
  let ttsFit;
  // The USER'S playback rate — sampled only while no fit of ours is applied.
  // Sizing a line against the live playbackRate reads back our own slowdown:
  // with the video already held at 0.8 the next line computes "fits without
  // help", ships a duck with no fit, and inject — for whom no-fit means "this
  // line needs nothing" — snaps the video back to full speed under it. Every
  // dense passage then alternates slow/normal and cuts tails (measured on
  // V6IItDAEtjs). Lines must be sized against the rate the user chose.
  // The viewer's own rate, and it comes from ONE place: inject, which is the
  // only side that knows whose hand moved the dial (采样器根修-方案 §三). It
  // used to be sampled off the element whenever no fit of ours was applied,
  // and that signal was wrong three ways: cruise keeps a fit on every line so
  // the sampler never opened; before the first line there was no sample at all
  // and the fallback read our own slowdown; and clearing a fit and inject
  // letting go of the rate are two different moments, so the ticks in between
  // wrote our rate down as the viewer's choice.
  let ttsUserBase = 0;          // 0 = not told yet
  // The absolute rate we last asked for (0 = we are asking for nothing). Set
  // optimistically the moment a duck goes out, then corrected by inject's
  // report — the element's own ratechange can beat the postMessage back.
  let ttsAsked = 0;
  // The duck currently on the wire pressed the original all the way to 0
  // (completeness deep-sink) — such a duck is restored, never held.
  let ttsDuckZero = false;
  // What inject says it is holding right now (0 = it has let go). This is the
  // half the element cannot tell us: clearing a fit and the player actually
  // giving the rate back are two different moments, and the ticks in between
  // read exactly like a viewer who chose 0.85.
  let ttsHeld = 0;
  // Judging playhead jumps needs both clocks from the SAME tick: background
  // tabs clamp the poll to ~1s and 2× playback doubles the honest video
  // delta, so only |videoΔ − wallΔ×rate| means anything, never videoΔ alone.
  let ttsTickWall = 0;          // Date.now() at the last cueTick sample
  let ttsTickVid = -1;          // video ms at that sample; -1 = don't judge yet
  let ttsJumpCuts = 0;          // calibration count only — shown nowhere
  let ttsOverran = 0;           // lines the NEXT line's takeover cut short — recorded, not acted on
  // ---- bounded drift (the debt) --------------------------------------------
  // A dense passage asks for more speech than its cues can hold: measured on
  // V6IItDAEtjs, lines needed 2.4x to fit, while speech caps at 1.4x and the
  // video may only be slowed to 76% of the viewer's rate — 1.84x between them.
  // Past that the old answer was to cut the tail off, every time.
  //
  // The answer here is the one the offline dubbers use, made bounded: let a
  // line START LATE and pay the lateness back out of the gaps that follow.
  // The debt is how far behind the speech is running, in WALL-CLOCK ms — the
  // lag an ear hears. Video ms are worth more than wall ms whenever the video
  // is slowed (at 0.85x, 1200 video ms is 1.4s of waiting), so everything is
  // converted at the rate in force before it is compared with the cap.
  //
  // The cap is what stops "never cut" from becoming "always behind": 1200ms
  // covers one or two overrunning lines and is paid back within a couple of
  // roomy ones. Under it a line is never cut; at it, it is.
  const TTS_DEBT_MAX_MS = 1200;
  // A tlang SPAN may wait longer for the previous tail. Paired 1x runs
  // (2026-09-01, three segments): tlang cut 3/4/3 tails per 75s where gtx cut
  // none, and the cut rows were late=0 with 1612-2411ms of tail left — healthy
  // lines whose only fault was a neighbour that ran long, capped at 1200.
  // 2500 covers every one of those measured tails; the ledger (ttsDebtMs)
  // stays clamped at TTS_DEBT_MAX_MS, so sizing, the urgent tier and cruise
  // all keep their shipped numbers — the lateness a longer wait leaves behind
  // shows up in the NEXT line's measured lateNow and shrinks its wait, which
  // is the only backoff this needs (three-way review 2026-09-01: the flat-EXTRA
  // variant was rejected twice over for defeating exactly that decay).
  const TTS_SPAN_WAIT_MAX_MS = 2500;
  // Under this the debt is settled: no repayment pressure on the speech rate.
  const TTS_DEBT_CLEAR_MS = 150;
  // Cruise may not UNLOCK while this much is owed. Repayment shortens every
  // window, which deflates the need figure that cruise votes on — without this
  // the tightest passage would read as roomy, cruise would let the video back
  // to full speed, and the debt would run away.
  const TTS_DEBT_HOLD_MS = 200;
  // The last gear before a cut: past 60% of the cap, a line that still cannot
  // fit may speak at 1.55x. Not a new ceiling — 1.4x stays the comfortable
  // one, and this is a state, not a setting.
  const TTS_RATE_MAX = 1.4;
  const TTS_RATE_URGENT = 1.55;
  // What the two existing tiers can absorb between them before anything has
  // to be borrowed. Slowing the video is itself borrowed time — but borrowed
  // from the picture, which moves with the speech, so nothing falls behind and
  // nothing is owed. inject will not go below 76% of the viewer's rate
  // (inject.js), so 1.4x speech inside a 0.76x picture fits 1.84x of speech
  // into one cue with no debt at all. Only past THAT does drift start.
  const TTS_VIDEO_FLOOR = 0.76;
  // "Read everything" mode's hard floor: the picture may sink to a quarter of
  // the user's own rate for a line that needs it, never further (D114).
  const TTS_COMPLETE_FLOOR = 0.25;
  const TTS_FIT_CEILING = TTS_RATE_MAX / TTS_VIDEO_FLOOR;
  // The comfortable ceiling was tuned for 1x viewing and stayed ABSOLUTE while
  // the need it faces scales with the viewer's rate (ownNeed = dur*vRate/own):
  // at 2x the viewer already accepts 2x original audio, yet speech held at 1.4
  // cut the tail of ~84% of dense lines (measured 2026-08-31). So the ceiling
  // follows the rate — never below the tuned 1.4, never past 2.0 (time-stretch
  // beyond that turns choppy even with pitch preserved, and 2.0 already
  // matches the tempo the viewer chose). At <=1.4x every number is identical
  // to before (four-way review 2026-09-01, 4/4; the owner's own ask).
  function ttsRateMaxFor(vRate) {
    return Math.min(2, Math.max(TTS_RATE_MAX, vRate || 1));
  }
  // The urgent gear keeps its exact distance above the ceiling (1.55/1.4, so a
  // 1x viewer still gets precisely today's 1.55), capped in step with it.
  function ttsRateUrgentFor(cap) {
    return Math.min(2.2, cap * (TTS_RATE_URGENT / TTS_RATE_MAX));
  }
  let ttsDebtMs = 0;
  // Every line goes on air a little after its cue: the cue loop samples every
  // 120ms and the bytes still have to decode. That offset is constant, it does
  // not accumulate, and nobody hears it — but counted as debt it would put the
  // speech in permanent repayment, hurrying every line of every video to pay
  // back a lag that was never there. Only lateness past this is drift.
  const TTS_DEBT_FLOOR_MS = 300;
  // How late THIS line is against the cue it belongs to, in wall ms. Measured
  // at takeover rather than accumulated: a seek, a pause or a dropped line
  // would each need their own correction to an accumulator, and the video's
  // own clock already answers the question without any of them.
  function ttsLatenessMs(idx) {
    const v = getVideo();
    if (!v || idx == null) return 0;
    const startMs = ttsLineStartMs(idx);
    const rate = v.playbackRate || 1;
    const late = (v.currentTime * 1000 - startMs) / rate;
    return Math.max(0, late - TTS_DEBT_FLOOR_MS);
  }
  // ---- takeover trace ------------------------------------------------------
  // A ring of the last few sizing and handover decisions, readable over
  // engineStatus, so a "the line lost its last word" report from a live video
  // can be matched to what the sizing believed at that moment. Numbers and cue
  // indexes only — no line text rides along, so the diagnostic bundle carries
  // no category of data it did not already carry.
  const TTS_TRACE_MAX = 48;
  const ttsTrace = [];
  // Why the skipped lines were skipped, counted per reason for THIS video. The
  // ring above forgets, and "skipped 2" without a reason is the shape of
  // question that cost two rounds of guessing to answer — the popup can say
  // "the translation had not arrived" instead of leaving a bare number that
  // reads like a fault. Counted here rather than at each of the six skip
  // sites, so a seventh cannot be added without its reason coming along.
  let ttsSkipWhy = Object.create(null);
  function ttsTraceAdd(ev) {
    ev.t = Date.now();
    if (ev.k === "skip" && ev.why) {
      ttsSkipWhy[ev.why] = (ttsSkipWhy[ev.why] || 0) + 1;
    }
    ttsTrace.push(ev);
    if (ttsTrace.length > TTS_TRACE_MAX) ttsTrace.shift();
  }
  // ---- steady cruise -------------------------------------------------------
  // Per-line sizing in a dense stretch was the audible wobble: speech jumping
  // 1.0↔1.4 line to line, the video snapping back at every seam. After two
  // consecutive tight sizings the pair LOCKS — speech at least ttsCruiseRate,
  // video at ttsCruiseVideo of the USER'S rate — and holds until three roomy
  // sizings in a row. The hysteresis is the point. While cruising EVERY line
  // ships a fit: a fitless duck snaps the video back (inject shareRate), and
  // a set module ttsFit also parks the user-rate sampler for the stretch —
  // without that, cueTick would read our own 0.85 back as the user's choice.
  let ttsCruiseTight = 0, ttsCruiseLoose = 0, ttsCruising = false;
  // Votes on the STRUCTURAL need — what the line would have needed inside its
  // own cue, with no borrowing. The need that repayment produces is smaller by
  // construction, and voting on that would unlock cruise exactly where the
  // passage is tightest.
  function ttsCruiseNote(needRate) {
    if (!settings.ttsCruise) { ttsCruising = false; return; }
    const was = ttsCruising;
    if (needRate >= 1.05) {
      ttsCruiseLoose = 0;
      if (++ttsCruiseTight >= 2) ttsCruising = true;
    } else if (needRate <= 0.8) {
      ttsCruiseTight = 0;
      // Owing means the roomy line in hand is being spent on the last one's
      // overrun. Letting the video back up here is what turns borrowing into
      // a runaway: the repayment it was about to make is cancelled.
      if (++ttsCruiseLoose >= 3 && ttsDebtMs <= TTS_DEBT_HOLD_MS)
        ttsCruising = false;
    }
    if (ttsCruising !== was) ttsTraceAdd({ k: "cru", on: ttsCruising });
    // in between: keep the state and both counters — flapping here would just
    // move the square wave one level up
  }
  // `cap` is the ceiling IN FORCE for this line (comfortable or urgent).
  // Before it existed this clamp hard-coded 1.4 — which made the urgent gear
  // dead code: the debt clamp below the cap assignment pulled every 1.55 back
  // to 1.4 while the fallback fit had been computed FOR 1.55, so the most
  // urgent lines got a video that slowed less AND speech that never sped up.
  // Present since the gear was built; found by the 2026-09-01 four-way QA.
  function ttsCruiseSpeech(rate, cap) {
    const top = cap || TTS_RATE_MAX;
    const r = Math.max(1, Math.min(top, Number(settings.ttsCruiseRate) || 1.25));
    return Math.min(top, Math.max(rate || 1, r));
  }
  function ttsCruiseFit(fit, vRate) {
    const f = Math.max(0.5, Math.min(1, Number(settings.ttsCruiseVideo) || 0.85));
    const cAbs = vRate * f;
    return fit != null ? Math.min(fit, cAbs) : cAbs;
  }
  let ttsSkipped = 0;           // lines skipped on this video — a line whose
                                // translation wasn't ready, or whose synthesis
                                // failed; nav resets both

  // Is line j inside the window anchored at `from`? Both bounds, one place:
  // the fill uses it to decide what to ask for, the reply uses it to refuse an
  // answer the window has moved past, and the prune uses it to let go. Three
  // copies of this rule drifting apart is how a line gets fetched, refused on
  // arrival, and fetched again.
  function ttsWithinAhead(j, from) {
    if (!cueList || j <= from || j >= cueList.length) return false;
    if (j > from + TTS_AHEAD_CUES) return false;
    const a = cueList[from] && cueList[from].start;
    const b = cueList[j] && cueList[j].start;
    if (a == null || b == null) return true;   // no timing: the count decides
    return b - a <= TTS_AHEAD_MS;
  }

  function ttsAheadDrop(idx) {
    const held = ttsAhead.get(idx);
    if (!held) return;
    ttsAhead.delete(idx);
    ttsAheadBytes -= held.bytes;
    try { URL.revokeObjectURL(held.url); } catch (_e) { /* ignore */ }
  }

  function ttsAheadClear() {
    for (const idx of Array.from(ttsAhead.keys())) ttsAheadDrop(idx);
    ttsAheadAsking.clear();
    ttsAheadBytes = 0;
  }

  // Hand a held line to the caller, which becomes responsible for its url.
  // The text has to match: the translation this cue will SHOW may have been
  // replaced since it was fetched, and speaking the older one is worse than
  // paying for the newer one.
  function ttsAheadTake(idx, text) {
    const held = ttsAhead.get(idx);
    if (!held || held.text !== text) return null;
    ttsAhead.delete(idx);
    ttsAheadBytes -= held.bytes;
    return held;
  }

  function ttsAheadEvict() {
    while (ttsAhead.size > TTS_AHEAD_MAX || ttsAheadBytes > TTS_AHEAD_BYTES) {
      // Drop the furthest away first: it has the most time to be asked for
      // again, and is the likeliest never to be reached at all.
      let far = -1;
      for (const k of ttsAhead.keys()) if (k > far) far = k;
      if (far < 0) return;
      ttsAheadDrop(far);
    }
  }

  function ttsStop(navigated) {
    ttsEpoch++;
    ttsSpokenIdx = -1;
    ttsPausedWith = false;         // resampled on the next tick; never carried across videos
    if (ttsHoldTimer) { clearTimeout(ttsHoldTimer); ttsHoldTimer = 0; }
    if (ttsAudio) { try { ttsAudio.pause(); } catch (_e) { /* ignore */ } ttsAudio = null; }
    if (ttsBlobUrl) { try { URL.revokeObjectURL(ttsBlobUrl); } catch (_e) { /* ignore */ } ttsBlobUrl = ""; }
    if (localTimer) { clearTimeout(localTimer); localTimer = 0; }
    if (localDeferTimer) { clearTimeout(localDeferTimer); localDeferTimer = 0; }
    localStartedAt = 0;
    if (localUtter) {
      localUtter = null;
      try { window.speechSynthesis && window.speechSynthesis.cancel(); } catch (_e) { /* ignore */ }
    }
    ttsFit = undefined;             // it described the line that just stopped
    ttsAsked = 0;                   // …and so did the rate it asked for
    ttsAheadClear();
    ttsAheadOff = false;             // the provider may be a different one now
    ttsSpokenText = "";
    ttsTickVid = -1;                 // a fresh start is not a jump
    ttsCruiseTight = 0; ttsCruiseLoose = 0; ttsCruising = false;
    ttsDebtMs = 0;                   // nothing is owed for a line nobody heard
    for (const rel of Array.from(ttsPendingRelease.values())) rel();
    try { window.postMessage({ source: "ytds-content", type: "ttsDuck", on: false, nav: !!navigated }, "*"); }
    catch (_e) { /* ignore */ }
  }

  // Stop the line the viewer seeked away from — and ONLY that line. Not
  // ttsStop: the look-ahead window survives (a short jump forward lands
  // inside it) and the epoch stays (in-flight replies are already refused by
  // the containment test). Not a bare pause either: ttsFollowPause would
  // resume it on the next tick as if nothing had happened.
  function ttsCutResidual(tMs) {
    if (ttsAudio) { try { ttsAudio.pause(); } catch (_e) { /* ignore */ } ttsAudio = null; }
    if (ttsBlobUrl) { try { URL.revokeObjectURL(ttsBlobUrl); } catch (_e) { /* ignore */ } ttsBlobUrl = ""; }
    if (localTimer) { clearTimeout(localTimer); localTimer = 0; }
    if (localDeferTimer) { clearTimeout(localDeferTimer); localDeferTimer = 0; }
    localStartedAt = 0;
    if (localUtter) {
      localUtter = null;
      try { window.speechSynthesis && window.speechSynthesis.cancel(); } catch (_e) { /* ignore */ }
    }
    // The debt describes how far behind the line the viewer jumped away from
    // was running. There is no such line any more, and carrying its lateness
    // into the landing point would hurry the first line after a seek for a
    // lag nobody ever heard.
    ttsDebtMs = 0;
    ttsFit = undefined;
    ttsAsked = 0;
    ttsSpokenIdx = -1;               // a seek back must be allowed to re-read it
    ttsSpokenText = "";
    // The landing spot may be about to re-duck: releasing here and re-ducking
    // one tick later is the square wave the duck-hold removed. Hold when a cue
    // is live at the landing time; the safety lets go if nobody claims it.
    if (settings.ttsEnabled && !orphaned && cueList && activeCueIdxAt(tMs) >= 0) {
      clearTimeout(ttsHoldTimer);
      ttsHoldTimer = setTimeout(() => { ttsHoldTimer = 0; ttsDuck(false); }, 700);
    } else {
      ttsDuck(false);
    }
  }

  // Duck rides ONE message with everything inject.js needs: the duck depth
  // (a setting, sent along because inject has no chrome.*) and, when a line
  // cannot fit even at 1.4× speech, `fit` — the absolute video rate at which
  // it just would. Volume and rate then restore at the same three points:
  // line end, next line's takeover, ttsStop.
  function ttsFollowPause(paused) {
    if (paused === ttsPausedWith) return;
    ttsPausedWith = paused;
    try {
      if (paused) {
        if (ttsAudio && !ttsAudio.paused && !ttsAudio.ended) ttsAudio.pause();
        // The local path cannot be resumed mid-word reliably, but it can be
        // held: Chrome's pause/resume on speechSynthesis is exactly this case.
        // Its watchdog has to stop counting too, or a long pause fires it and
        // the video gets its sound back with a voice still queued to speak.
        if (localUtter) {
          if (localTimer) { clearTimeout(localTimer); localTimer = 0; }
          try { window.speechSynthesis && window.speechSynthesis.pause(); }
          catch (_e) { /* ignore */ }
        }
      } else {
        if (ttsAudio && ttsAudio.paused && !ttsAudio.ended) {
          const p = ttsAudio.play();
          if (p && p.catch) p.catch(() => { /* the next cue takes over */ });
        }
        // Unconditionally, and this is the whole point: the paused flag lives
        // on speechSynthesis itself, not on the utterance, and cancel() does
        // not clear it. Pause while a line is speaking, then let that line go
        // away — a video change, a provider change, read-aloud switched off —
        // and there is nothing left holding a reference to resume through. The
        // engine stays paused, every later line is queued into it and says
        // nothing, and pressing play does not help. Pause once and read-aloud
        // is over for the rest of the video.
        try { window.speechSynthesis && window.speechSynthesis.resume(); }
        catch (_e) { /* no engine here: nothing to resume */ }
        if (localUtter) {
          // Re-armed at the ceiling rather than the estimate: how much of the
          // line is left to say is not knowable here, and releasing the duck
          // late is the error this path is written to prefer.
          clearTimeout(localTimer);
          localTimer = setTimeout(() => {
            if (!localUtter) return;
            localUtter = null;
            ttsDuck(false);
          }, TTS_LOCAL_MAX_MS);
        }
      }
    } catch (_e) { /* a paused voice is not worth an exception */ }
  }

  // A line's end is not the passage's end. Releasing the duck between two
  // lines that nearly touch made dense passages a 25%↔100% square wave — and
  // the release, carrying no fit, snapped the video back to full speed for
  // the seam. When the next line starts within this window, keep the duck
  // (and the fit it carries); the next takeover re-ducks with its own
  // numbers. The safety timer is for the seam that never gets its next line
  // (translation missing, line skipped): held quiet with nobody speaking is
  // the "original audio stuck low" bug, so an unclaimed hold lets go.
  const TTS_DUCK_HOLD_MS = 1400;
  let ttsHoldTimer = 0;
  function ttsDuckOffOrHold(idx) {
    // A zero-duck never crosses a line boundary as zero: a gap at 0 is
    // silence, and a failed next line would park it there. But restoring all
    // the way UP and re-muting 300ms later was worse — the round trip's
    // give-back ramp raced the next duck and poisoned the saved volume (the
    // 80→20→15→5→0 walk-down, fixed in inject too), and the full-volume blip
    // between deep lines was its own noise. So the mute is DEMOTED to the
    // stored duck level first; the ordinary hold/off logic below then treats
    // it like any speaking-level duck.
    if (ttsDuckZero) ttsDuck(true);
    if (settings.ttsEnabled && !orphaned && idx != null && cueList) {
      const v = getVideo();
      const nx = ttsWindowEnd(idx);
      if (v && !v.paused && !isAdShowing() && nx && nx.start != null) {
        const gap = nx.start - v.currentTime * 1000;
        if (gap > -500 && gap < TTS_DUCK_HOLD_MS) {
          clearTimeout(ttsHoldTimer);
          ttsHoldTimer = setTimeout(() => { ttsHoldTimer = 0; ttsDuck(false); },
            Math.max(0, gap) + 600);
          return;
        }
      }
    }
    ttsDuck(false);
  }

  function ttsDuck(on, fit) {
    if (on && ttsHoldTimer) { clearTimeout(ttsHoldTimer); ttsHoldTimer = 0; }
    // Releasing the duck releases the rate with it. Nothing used to clear
    // ttsFit when a line simply ENDED — only a stop or a seek did — so between
    // one line and the next it still held the last line's value, and the
    // sampler below, which only looks while no fit of ours is applied, was
    // shut for the whole gap. On a stretch with no subtitles it stayed shut.
    if (!on) ttsFit = undefined;
    // What we are asking for, written down before the message leaves. inject
    // will confirm it, but its reply can arrive AFTER the element's own
    // ratechange — and a ratechange with no ask on record reads as the viewer
    // reaching for the dial.
    ttsAsked = (on && typeof fit === "number" && fit > 0) ? fit : 0;
    // Deep sink fades the original by the ABSOLUTE rate, with the knob as the
    // ceiling. The first cut of this compared fit to 70% of the viewer's OWN
    // rate — at 2x that muted original playing at 1.0-1.4x absolute, which is
    // perfectly intelligible, and the owner's knob at 100% counted for
    // nothing ("原声直接静音", 2026-09-01). Garble is a property of the
    // absolute playback rate: above 0.7x the original is speech and gets the
    // full knob; below 0.5x it is garble at any volume and goes to zero even
    // over a loud knob; between them it fades linearly. Only completeness
    // mode can sink below 0.7x absolute at normal viewing rates, so the knob
    // keeps its plain meaning everywhere else. inject's 200ms volume ramp
    // turns each step into a fade. (四方合成:sub 的绝对阈值诊断 + 三方的
    // 「旋钮是天花板」共识;端点 0.5/0.7 = garble 区上沿 / 原 1x deep 阈值。)
    let pct = settings.ttsDuckPct;
    if (on && settings.ttsComplete && typeof fit === "number" && fit > 0) {
      const audible = Math.max(0, Math.min(1, (fit - 0.5) / 0.2));
      pct = Math.round(settings.ttsDuckPct * audible);
    }
    ttsDuckZero = !!(on && pct === 0 && typeof fit === "number");
    try { window.postMessage({ source: "ytds-content", type: "ttsDuck", on: !!on,
      pct: pct, fit: fit }, "*"); }
    catch (_e) { /* ignore */ }
  }

  // What the user is reading right now — the only text worth speaking. "…" is
  // the in-flight placeholder, and same-language videos have nothing to speak.
  // null = nothing to speak, ever (not a skip); "" = not ready (a skip).
  // A line that is nothing but a bracketed stage note — （笑声）/(Applause)/
  // [Music] — or a ♪ lyric marker has no voice to give it: null, not a skip.
  const TTS_STAGE_NOTE = /^[（(\[【〔♪♫♬].*[）)\]】〕♪♫♬]$/;
  // The line ANY cue would speak — not just the one on screen, and not read
  // off the screen. It answers the same question renderTranslationForCue
  // answers, in the same order, minus the painting and minus asking for
  // anything that is missing.
  //
  // Reading transEl.textContent was three problems in one line. It could only
  // ever describe the active cue, so the look-ahead had to get its text from
  // cue.trans instead — which exists only on a track YouTube translated cue
  // for cue, so on every other track the look-ahead gave up on its first line
  // and each sentence paid a full round trip while its cue was already up. The
  // two sources also disagree legally (dedupeTrans, sameLangLine), and
  // ttsOnCue compares them to decide whether a prefetched line is the line it
  // wanted — a mismatch quietly threw the audio away and fetched it again. And
  // while a fresh translation is in flight the previous one is still on screen,
  // so the speaker could read out the line before.
  //
  // Contract, unchanged: null = nothing to speak, ever (not a skip);
  // "" = no answer yet (a skip); anything else is the line.
  // Join one sentence's worth of YouTube's per-fragment translations. The
  // fragments were cut mid-sentence, so they rejoin without a seam: "从" +
  // "旁观者的角度来看" is the sentence YouTube would have given for the whole
  // thing. A space goes in only where both sides are wordy scripts — putting
  // one between two CJK characters would be a word break that is not there.
  function tlangSpanText(span) {
    let out = "";
    for (let k = span.startIdx; k <= span.endIdx; k++) {
      const c = cueList && cueList[k];
      if (!c) continue;
      let part;
      if (cueAligned && typeof c.trans === "string" && c.trans) part = c.trans;
      else if (tcueList && cueAligned === false) {
        const m = nearestTcue(c.start);
        part = m ? m.text : "";
      }
      part = dedupeTrans(part || "", c.text);
      if (!part) continue;
      // A fragment repeated verbatim by the scrolling track says nothing new.
      if (out.endsWith(part)) continue;
      if (!out) { out = part; continue; }
      out += (/[A-Za-z0-9)\]]$/.test(out) && /^[A-Za-z0-9(\[]/.test(part))
        ? " " : "";
      out += part;
    }
    return out;
  }

  function cueSpeechText(idx) {
    const cue = cueList && cueList[idx];
    if (!cue) return "";
    if (cueSameLang) return null;
    const origText = cue.text;
    let text;
    // Under tlang on a scrolling track the voice speaks whole sentences, not
    // the fragments the captions are drawn in: the first cue of a sentence
    // says all of it, and the fragments it swallowed say nothing at all —
    // null, which this contract already defines as "never to be spoken", so
    // they are not charged as skips either.
    if (cueToSpan && speechSpans && cueToSpan[idx] != null) {
      const span = speechSpans[cueToSpan[idx]];
      if (span) {
        if (idx !== span.startIdx) return null;
        text = tlangSpanText(span);
      }
    }
    // A stranded mark is the same case as a swallowed fragment: the sentence
    // went out with the cue before, and this one has nothing left to say. It
    // reaches here only on a MANUAL track, where there are no spans to swallow
    // it — a cloud voice was being sent "。" to pronounce, which spends a
    // request to say nothing AND cuts off the sentence still being spoken.
    if (text === undefined && cueAligned && isStrandedMark(cue.trans, origText)) return null;
    if (text === undefined && cueAligned && typeof cue.trans === "string" && cue.trans) {
      text = dedupeTrans(cue.trans, origText);
    } else if (text === undefined && tcueList && cueAligned === false) {
      const m = nearestTcue(cue.start);
      if (m && isStrandedMark(m.text, origText)) return null;
      if (m) text = dedupeTrans(m.text, origText);
    }
    if (text === undefined) {
      const perCue = transCache.get(cueVideoId + " " + idx);
      if (perCue !== undefined) {
        text = dedupeTrans(perCue, origText);
      } else {
        // The sentence group this cue belongs to — cueToGroup, not
        // activeGroupIdx: the group of the cue being asked about, which for a
        // look-ahead is not the group on screen.
        const g = (cueToGroup && cueToGroup[idx] != null) ? cueToGroup[idx] : -1;
        if (g >= 0) {
          const gCached = transCache.get(groupKey(g));
          // "" is the group-echo marker: the sentence already speaks the
          // target language. What goes on the translation line in that case is
          // sameLangLine — empty when the original line is showing, the
          // ORIGINAL TEXT when the user has hidden it, so the video still has
          // subtitles. Speech has to follow the same rule or it contradicts
          // the screen: with the original line hidden, the overlay shows a
          // line and read-aloud said nothing, and did not even count it.
          if (gCached !== undefined) {
            text = gCached === "" ? sameLangLine(origText) : gCached;
          }
        }
      }
    }
    if (text === undefined) return "";            // not translated yet
    const out = String(text).trim();
    if (!out) return null;                        // nothing to say, not a skip
    if (TTS_STAGE_NOTE.test(out) || out.charAt(0) === "♪") return null;
    return out;
  }

  // (The guard that used to be documented here — "is the line this audio was
  // made for still the line on screen" — lived one rewrite and is gone: it
  // compared source sentences, and on per-cue aligned answers that let a
  // stale slice take the speaker from the one actually talking. The story,
  // and the claim-based guard that replaced it, are with ttsClaimStillCurrent
  // below.)

  // A line whose translation was not ready when its cue began is skipped, and
  // that is the right call: spoken two seconds late it would talk over the one
  // after it. What was wrong is that nothing ever came back for it. cueTick
  // does not re-enter a cue it is already on, and the reply that fills the
  // cache paints the screen without telling read-aloud — so on a long sentence
  // the words sat there, unspoken, for their whole seven seconds with room to
  // spare, and the status line said nothing was wrong.
  //
  // Offer the line once, at the moment its words exist, and only while it is
  // still the line on screen with nothing claimed for it. The claim ttsOnCue
  // writes is what stops this from firing twice; ttsFitFor is what decides
  // whether what is left is enough to say it in.
  function ttsCatchUp(gIdx) {
    if (!settings.ttsEnabled || orphaned) return;
    if (activeCueIdx < 0 || !cueList || !cueToGroup) return;
    if (cueToGroup[activeCueIdx] !== gIdx) return;
    // Paused means stop — the pause follower only acts when the state FLIPS,
    // so audio started after the pause would have nobody to stop it: it spoke
    // over a frozen frame (measured in the rig). The line is forfeited, same
    // as if its translation had never come. Adverts likewise: cueTick clears
    // the overlay on its next turn, but this callback can land inside the
    // 120ms before it does.
    const v = getVideo();
    if (!v || v.paused || isAdShowing()) return;
    // Survives mutation, deliberately kept: ttsOnCue's own guards (same index,
    // then same text in the same group) already stop a second CLAIM from
    // becoming a second voice, so removing this line does not turn any
    // assertion red. What it does turn is a claim that is taken and then
    // handed straight back — ttsAheadTake pulls the prefetched line out of the
    // window and the dedupe branch revokes it — for every late reply on a
    // sentence that is already speaking. Cheap to keep, and the thing it
    // guards is one refactor of ttsOnCue away from being a real double-read.
    if (ttsSpokenIdx >= 0 && cueToGroup[ttsSpokenIdx] === gIdx) return;
    const cue = cueList[activeCueIdx];
    if (!cue) return;
    // From the LINE's start, not the slice's: a group-text sentence caught up
    // on its second slice is already a slice deep, and "just arrived" here
    // meant the whole sentence played from the top over its own second half.
    const into = Math.max(0, v.currentTime * 1000 - ttsLineStartMs(activeCueIdx));
    ttsOnCue(activeCueIdx, cue, into);
  }

  // Whether the request claimed under cue `idx` still owns the speaker. The
  // speaker belongs to the CLAIM (ttsSpokenIdx, written before the round
  // trip), never to the source sentence.
  //
  // The original guard was `idx === activeCueIdx`, and it dropped whole
  // sentences: the claim sits on the FIRST slice, the rest of the group
  // dedupes against it, and synthesis outlasts one slice. The first rewrite
  // compared "same source sentence" instead — and introduced the opposite
  // failure on own-key aligned answers, where every slice speaks ITS OWN line
  // and claims in turn: a slow reply for slice one took the speaker over
  // while slice two was already talking — stale words, and on the local
  // engine a cancel() of the line actually being said. The review that
  // caught it was right: the sentence is not who owns the speaker.
  //
  // So, the claim test. Group-text mode: the dedupe keeps ttsSpokenIdx on the
  // first slice all sentence long, so the slow reply still lands — the
  // original fix survives. Per-cue mode: the next slice's claim moves
  // ttsSpokenIdx and the stale reply is refused. The containment test bounds
  // the rest: a reply whose line the playhead has left entirely (a seek, or
  // past the window into the next line's time) is dropped, not spoken over
  // whatever is there now. Everything else still goes through ttsStop and the
  // epoch: new video, advert, read-aloud off, target-language change.
  function ttsClaimStillCurrent(idx) {
    if (idx !== ttsSpokenIdx) return false;      // superseded by a later claim
    if (idx === activeCueIdx) return true;       // plainly on screen
    const v = getVideo();
    if (!v) return false;
    const now = v.currentTime * 1000;
    const nx = ttsWindowEnd(idx);
    return now >= ttsLineStartMs(idx) && (nx == null || nx.start == null || now < nx.start);
  }

  // The claim's containment test at an EXPLICIT time. The jump judge runs
  // before the tick moves activeCueIdx, so ttsClaimStillCurrent's shortcut
  // would answer for where the viewer WAS, not where they landed.
  function ttsSpokenContains(tMs) {
    if (ttsSpokenIdx < 0) return false;
    const nx = ttsWindowEnd(ttsSpokenIdx);
    return tMs >= ttsLineStartMs(ttsSpokenIdx) &&
      (nx == null || nx.start == null || tMs < nx.start);
  }

  // A jump that lands INSIDE the sentence being spoken: keep speaking, but
  // line the cloud audio up with the new spot — what is left to say should
  // take as long as what is left to watch, the same account ttsPlay settles
  // for a seek that lands mid-line. The local engine has no seek; it keeps
  // its old offset, as before.
  function ttsRealign(tMs) {
    const a = ttsAudio;
    if (!a || a.paused || a.ended) return;
    const vv = getVideo();
    const vRateNow = (vv && vv.playbackRate) || 1;
    const nx = ttsWindowEnd(ttsSpokenIdx);
    const cue = cueList && cueList[ttsSpokenIdx];
    const winEnd = nx && nx.start != null ? nx.start
      : (cue && cue.end != null ? cue.end : 0);
    if (!winEnd) return;
    // What is left to WATCH is video time; the audio runs on the wall clock.
    const leftS = Math.max(0, (winEnd - tMs) / 1000) / vRateNow;
    const dur = a.duration || 0;
    if (!isFinite(dur) || dur <= 0.3) return;
    const target = Math.max(0, Math.min(dur - 0.05, dur - leftS * (a.playbackRate || 1)));
    // Only for a real displacement — nudging every wobble is its own stutter.
    if (Math.abs(target - a.currentTime) > 0.35) {
      try { a.currentTime = target; } catch (_e) { /* not seekable: play on */ }
    }
  }

  function ttsOnTimeJump(tMs) {
    if (ttsSpokenIdx < 0) return;
    if (ttsSpokenContains(tMs)) { ttsRealign(tMs); return; }
    ttsJumpCuts++;
    ttsTraceAdd({ k: "cut", by: "jump", vt: Math.round(tMs), pi: ttsSpokenIdx });
    ttsCutResidual(tMs);
  }

  // One sentence-worth of speech, or one slice-worth? Own-key aligned answers
  // fill the per-cue cache and every slice speaks its own line; the
  // group-text engines cache one string for the whole sentence and the other
  // slices dedupe away. Which granularity a cue is on decides where its line
  // STARTS (how far in are we) and where its window ENDS (who takes over).
  // The per-cue cache is the honest witness: it exists exactly when the
  // slices have lines of their own.
  function ttsPerCueInGroup(idx) {
    return transCache.has(cueVideoId + " " + idx);
  }

  function ttsLineStartMs(idx) {
    // A spoken sentence begins where its FIRST fragment does, not where the
    // fragment that happens to be on screen does.
    if (cueToSpan && speechSpans && cueToSpan[idx] != null) {
      const sp = speechSpans[cueToSpan[idx]];
      const c0 = sp && cueList && cueList[sp.startIdx];
      if (c0 && c0.start != null) return c0.start;
    }
    if (cueToGroup && sentGroups && cueToGroup[idx] != null && !ttsPerCueInGroup(idx)) {
      const grp = sentGroups[cueToGroup[idx]];
      if (grp && grp.start != null) return grp.start;
    }
    const c = cueList && cueList[idx];
    return (c && c.start) || 0;
  }

  // Where this LINE's window ends — the cue that will actually take over from
  // it, which in group mode is the first cue of the NEXT SENTENCE, not the
  // next slice of this one. Both callers used cueList[idx + 1] and so measured
  // a sentence against a third of the time it owns: a 1.2s utterance in a 1.5s
  // sentence was told it had 0.4s, pinned to 1.4x and handed inject a fit of
  // 0.47 (clamped to 0.76) — the video slowed, audibly, on every multi-cue
  // sentence, for nothing. Measured in the rig; the number above is the one it
  // printed. The slice boundary was never a deadline: the rest of the group
  // dedupes away and nothing takes over there.
  // …but only where the sentence really IS the line. On per-cue answers the
  // next slice claims and takes over, so the slice is the window. And a last
  // sentence with nothing after it ends at its own end — the old fallback
  // was the claimed CUE's end, one slice again, which brought the squeeze
  // this function removes back on every video's final line.
  function ttsWindowEnd(idx) {
    // …and it owns the room up to the NEXT sentence, not up to the next
    // fragment of itself. Sized against a fragment, a whole spoken sentence
    // reads as needing three times the speed it really does.
    if (cueToSpan && speechSpans && cueToSpan[idx] != null) {
      const sp = speechSpans[cueToSpan[idx]];
      if (sp && sp.endIdx != null) {
        const after = cueList && cueList[sp.endIdx + 1];
        const own = cueList && cueList[sp.endIdx];
        if (after || own) return after || { start: own.end };
      }
    }
    if (cueToGroup && sentGroups && cueToGroup[idx] != null && !ttsPerCueInGroup(idx)) {
      const grp = sentGroups[cueToGroup[idx]];
      if (grp && grp.endIdx != null) {
        return (cueList && cueList[grp.endIdx + 1]) || { start: grp.end };
      }
    }
    return (cueList && cueList[idx + 1]) || null;
  }

  function ttsDecode(b64, mime) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([bytes], { type: mime || "audio/mpeg" }));
    return { url, audio: new Audio(url) };
  }

  // Fit the line into what is LEFT of its cue at the moment it can start —
  // the full cue length would understate the squeeze once any latency has
  // spent part of it. Mild speech speed-up first (past 1.4× turns into
  // chipmunk); when even 1.4× cannot fit, return the absolute video rate at
  // which it just would, and inject.js slows toward it (never below 76% of
  // the user's own rate). Still not enough? The line runs long and the next
  // line's start wins.
  function ttsFitFor(audio, cue, next) {
    const durMs = (audio.duration || 0) * 1000;
    const v = getVideo();
    // The USER'S rate, not the live one — the live one may be our own
    // slowdown, and sizing against it declares the next line "fits unaided",
    // whose no-fit duck then snaps the video back up (see ttsUserBase).
    const vRate = ttsUserBase || ((v && v.playbackRate) || 1);
    // The line's real window runs to the NEXT line's start, not to its own
    // cue end — the gap between cues is free speaking time (the competitor's
    // continuous track eats it too), and an overlapping next cue takes over
    // at ITS start, making the window honestly shorter.
    const endMs = next && next.start != null ? next.start
      : (cue && cue.end != null ? cue.end : 0);
    const ownMs = Math.max(300, v && endMs
      ? endMs - v.currentTime * 1000
      : (cue && cue.dur) || 0);
    // The line's OWN cue is the window, and cruise votes on the need it
    // produces — a vote no borrowing can deflate.
    const ownNeed = (durMs * vRate) / ownMs;
    ttsCruiseNote(ownNeed);                           // structural need
    let leftMs = ownMs, needRate = ownNeed;
    // Borrowing is the LAST tier, not a default. Speech speed handles the
    // gentle squeeze and the video slowdown handles the hard one, and neither
    // of them falls behind — so a line that either tier can still absorb is
    // sized against its own cue and finishes inside it, owing nothing.
    // Reaching for the budget any earlier would relax every line in the video
    // by a second and leave the speech permanently late, which is "always
    // behind", not "catching up". Only a line past what both tiers together
    // can hold reaches beyond its cue end, and only as far as the budget
    // still allows. Video ms against video ms: the budget is wall clock, so
    // it is scaled by the rate in force before joining a window read off the
    // video's own clock.
    let fit, borrowed = 0;
    const rateCap = ttsRateMaxFor(vRate);
    if (ownNeed > rateCap / TTS_VIDEO_FLOOR) {
      // Spend the free tier first. The picture goes to its floor, which buys
      // real speaking time and costs no drift, and only what is STILL missing
      // after that is borrowed. Skipping the slowdown here and borrowing the
      // whole shortfall would owe far more than the line actually needed.
      // With "read everything" on, the floor is the line's own need — the
      // picture sinks exactly as deep as speech at the ceiling requires, and
      // no deeper — hard-floored at a quarter of the user's rate so one
      // pathological line cannot park the video (debt absorbs past that).
      // Measured 2026-08-31: at 2x the fixed floor cuts the tail of nearly
      // every dense line (need median 3.2 vs 1.84 absorbed); this is the one
      // mechanism that buys completeness at any speed, chosen over a deeper
      // fixed floor (2.58 still loses to the median) by both outside reviews.
      fit = settings.ttsComplete
        ? Math.max(vRate * TTS_COMPLETE_FLOOR,
            Math.min((rateCap * ownMs) / durMs, vRate * TTS_VIDEO_FLOOR))
        : vRate * TTS_VIDEO_FLOOR;
      // What the cue is worth in wall time once the picture is at that floor,
      // against what the line needs at the comfortable ceiling.
      const wallHave = ownMs / fit;
      const wallWant = durMs / rateCap;
      borrowed = Math.min(Math.max(0, wallWant - wallHave),
        Math.max(0, TTS_DEBT_MAX_MS - ttsDebtMs));
      leftMs = (wallHave + borrowed) * fit;         // back to video ms
      needRate = durMs / (wallHave + borrowed);
    }
    // Past 60% of the cap a line that still will not fit gets one gear beyond
    // the comfortable ceiling, rather than losing its end.
    const cap = (ttsDebtMs > TTS_DEBT_MAX_MS * 0.6 && needRate > rateCap)
      ? ttsRateUrgentFor(rateCap) : rateCap;
    if (needRate > 1) {
      audio.playbackRate = Math.min(cap, needRate);
      if (needRate > cap && fit == null) fit = (cap * leftMs) / durMs;
    }
    if (ttsCruising) {
      audio.playbackRate = ttsCruiseSpeech(audio.playbackRate, cap);
      fit = ttsCruiseFit(fit, vRate);
    }
    // Repayment is made out of speech, never out of the video: slowing the
    // picture to catch up would make the lag both longer AND more visible.
    // While anything is owed the speech holds at the cruise floor — clamped to
    // the cap IN FORCE, never back down through it (the dead-gear bug).
    if (ttsDebtMs > TTS_DEBT_CLEAR_MS)
      audio.playbackRate = ttsCruiseSpeech(audio.playbackRate, cap);
    ttsTraceAdd({ k: "fit", vt: v ? Math.round(v.currentTime * 1000) : -1,
      dur: Math.round(durMs), left: Math.round(leftMs), own: Math.round(ownMs),
      debt: Math.round(ttsDebtMs), bor: Math.round(borrowed),
      need: Math.round(needRate * 100) / 100,
      rate: Math.round((audio.playbackRate || 1) * 100) / 100,
      fit: fit == null ? -1 : Math.round(fit * 100) / 100,
      cru: ttsCruising });
    return fit;
  }

  // Fetch one line of the window ahead, decoded to a ready Audio, so its cue
  // starts with no round trip. Synthesis latency is what eats the cue window
  // and got lines cut mid-word (measured live; the competitor avoids it by
  // pre-synthesizing the whole track).
  //
  // This header used to describe a single "next line" slot that could only be
  // filled on whole-track cues, because it read the text off cue.trans.
  // Neither is still true: cueSpeechText answers for any cue on any engine,
  // and there are several lines in the air rather than one.
  function ttsAheadAsk(j, text) {
    const nEpoch = ttsEpoch;
    const token = ++ttsAskSeq;
    ttsAheadAsking.set(j, { token: token, text: text });
    extCall(() => chrome.runtime.sendMessage(
      // Not urgent: a line fetched ahead has a next time round — its cue will
      // ask again when it arrives. That is the contract the worker's shedding
      // was written to, and it is what keeps a rate limit from being made
      // worse by the look-ahead.
      { type: "ttsSpeak", text, targetLang: settings.targetLang, urgent: false },
      (resp) => {
        // Freeing the slot comes first and happens on every path. A service
        // worker Chrome killed answers by setting lastError and nothing else;
        // a slot left marked in-flight is never retried and never given back,
        // so two of those and the look-ahead is finished for the rest of the
        // video, in silence.
        const mine = ttsAheadAsking.get(j);
        if (mine && mine.token === token) ttsAheadAsking.delete(j);
        if (chrome.runtime.lastError) return;
        if (resp && resp.ok && resp.local) {
          // Keyless local speech: nothing to hold, and asking again for every
          // cue is two wasted round trips per line for the DEFAULT provider.
          ttsAheadOff = true;
          ttsAheadClear();
          return;
        }
        if (nEpoch !== ttsEpoch || !resp || !resp.ok || !resp.b64) return;
        if (ttsAhead.has(j)) return;       // a newer answer already landed
        // …and refuse an answer for a cue the window has already moved past.
        // Storing it decoded a blob that nothing would use and that only the
        // NEXT fill would free — and if the playhead is between cues at that
        // moment there is no next fill, so it was held until one came.
        if (activeCueIdx >= 0 && !ttsWithinAhead(j, activeCueIdx)) return;
        try {
          const d = ttsDecode(resp.b64, resp.mime);
          // base64 length, not decoded bytes: a third too big, and it is a cap
          // rather than a measurement. Counting the real length would mean
          // decoding twice.
          ttsAhead.set(j, { text, audio: d.audio, url: d.url, bytes: resp.b64.length });
          ttsAheadBytes += resp.b64.length;
          ttsAheadEvict();
          // If the eviction just threw away what we inserted — it drops the
          // furthest-away entry, and the one that arrived last usually IS the
          // furthest — then topping up below would ask for it again, get it
          // again, and evict it again. The byte cap makes that reachable:
          // unlike the count cap it stops as soon as the total fits, which can
          // leave the map strictly below both caps and the fill willing to
          // refill. Six long WAV lines from Qwen is enough.
          if (!ttsAhead.has(j)) return;
          // Top the window up now that a slot is free, rather than waiting for
          // the next cue. Sitting on one long line would otherwise leave the
          // window at whatever depth a single pass could reach.
          //
          // Only on success, and that is not tidiness: a failed index is not
          // in the map, so a fill triggered by a failure would immediately ask
          // for the same index again, and again. Failures wait for the next
          // cue change, which is also the retry pacing.
          if (nEpoch === ttsEpoch && settings.ttsEnabled && activeCueIdx >= 0) {
            ttsFillAhead(activeCueIdx);
          }
        } catch (_e) { /* best-effort */ }
      }));
  }

  // Slide the window to sit just after `idx` and fill whatever it can.
  function ttsFillAhead(idx) {
    for (const k of Array.from(ttsAhead.keys())) {
      if (!ttsWithinAhead(k, idx)) ttsAheadDrop(k);
    }
    for (const k of Array.from(ttsAheadAsking.keys())) {
      // Not cancellable. The reply is refused on arrival (see ttsAheadAsk) —
      // it used to be decoded, given a blob and stored, and only pruned by
      // the NEXT fill. Either way the slot has to stop counting against a
      // window it is no longer inside.
      if (!ttsWithinAhead(k, idx)) ttsAheadAsking.delete(k);
    }
    if (ttsAheadOff) return;
    // What the window is already holding or waiting for. A sentence group gives
    // every one of its cues the same translation, so without this the six slots
    // fill with copies of one sentence and the entry evicted for being furthest
    // away is the genuinely next one.
    const held = new Set();
    for (const v of ttsAhead.values()) held.add(v.text);
    // Including what is on the way. The check below skips an in-flight index
    // BEFORE its words can count as held, so without this the next cue of the
    // same sentence group looks unfetched and is bought again — the same audio
    // paid for twice, and the copy then claimed by a cue that turns out to have
    // nothing to say. Argued, not measured: producing it needs a look-ahead
    // request for a group that is not the one on screen, and the rig's
    // translation stub only translates a group once its cue comes up, so no
    // future group ever has text for the window to fetch. Kept because it can
    // only ever prevent a request, never cause one.
    for (const v of ttsAheadAsking.values()) { if (v && v.text) held.add(v.text); }
    // The line on air counts as held: the cue after it inside the same sentence
    // group carries the very same words, so fetching it would be paying for a
    // copy of what is being said right now.
    if (ttsSpokenText) held.add(ttsSpokenText);
    for (let j = idx + 1; ttsWithinAhead(j, idx); j++) {
      if (ttsAheadAsking.size >= TTS_AHEAD_INFLIGHT) return;
      if (ttsAhead.size >= TTS_AHEAD_MAX || ttsAheadBytes >= TTS_AHEAD_BYTES) return;
      if (ttsAhead.has(j) || ttsAheadAsking.has(j)) continue;
      // "" here is "no translation yet", not "nothing to say": skip it this
      // round and let the next cue's fill pick it up once it has landed.
      const text = cueSpeechText(j);
      if (!text || held.has(text)) continue;
      held.add(text);
      ttsAheadAsk(j, text);
    }
  }

  // Put ONE decoded line on air: wait out the grace window, take over from
  // the sounding line, size the fit at the true start moment, and play. It
  // does NOT arm the look-ahead — ttsOnCue does, and did before today too;
  // this line had been describing a neighbour's job for three releases.
  // Past this much into a line, the line was not entered by playing into it.
  // The competitor uses one second; so do we. Below it, starting from the top
  // is right even though we are late — the opening words of a translation are
  // the ones worth having.
  const TTS_SEEK_IN_MS = 1000;
  function ttsPlay(idx, cue, audio, url, myEpoch, enteredAtMs) {
    // These bytes have exactly one owner. Until the line takes over that owner
    // is this call; afterwards it is ttsBlobUrl, which ttsStop and the next
    // takeover know how to free. Every way out has to pass through release(),
    // and three of them did not: audio that failed to decode counted a skip
    // and walked away, a reply that arrived after a stop returned early, and
    // audio that never fired any event at all was simply never spoken of
    // again. Each one pinned its blob for the life of the tab.
    let owned = url;
    const release = () => {
      // Only if this call still owns the slot. Two ttsPlay calls can exist for
      // the same cue index — seek back to a line that was skipped, and the
      // "behind me" sweep below never ran for it — and a bare delete lets the
      // older one's 4s deadline evict the younger one's entry, after which
      // stopping can no longer reach the younger one's bytes. The same
      // deadline also charges a skip and an error reason against a line that
      // is playing perfectly well.
      if (ttsPendingRelease.get(idx) === release) ttsPendingRelease.delete(idx);
      if (!owned) return;
      try { URL.revokeObjectURL(owned); } catch (_e) { /* ignore */ }
      owned = "";
    };
    // Anything still waiting to start that is BEHIND this line will never
    // start: the cue it belonged to has gone by. Freeing it here is what keeps
    // the waiting room from filling up on a run of short lines, where a line
    // can sit out its whole metadata deadline while three more begin.
    for (const [k, rel] of Array.from(ttsPendingRelease)) if (k < idx) rel();
    // Stopping has to be able to reach this too. Between here and takeover the
    // only reference to these bytes is inside this call, so ttsStop — which
    // knows about ttsBlobUrl and about the window, and nothing else — could
    // not free a line that was still waiting to start. Turning read-aloud off
    // mid-track left one blob behind per line in flight.
    ttsPendingRelease.set(idx, release);
    // What the arm decided, for the cut row: how much tail the previous line
    // still had (wanted) and how much of that the debt budget let us wait out
    // (waited). wanted>waited is the capped cut the D113 instrumentation reads
    // offline — the join with the arm row used to be by-hand (planned-vs-
    // actual, four-way review C1).
    let armWantedMs = 0, armWaitedMs = 0;
    const takeover = () => {
      if (myEpoch !== ttsEpoch || !ttsClaimStillCurrent(idx)) {
        release();                 // superseded while waiting: never played
        return;
      }
      // The same door the built-in path has: a paused video (scrubbing the
      // bar while paused still ticks the cue loop) or an advert is not a
      // moment to start talking, duck, or set a fit (D156).
      const vv0 = getVideo();
      if (!vv0 || vv0.paused || isAdShowing()) {
        ttsTraceAdd({ k: "skip", i: idx, why: vv0 && vv0.paused ? "paused" : "ad" });
        release();
        return;
      }
      // How far behind this line is starting, measured off the video's own
      // clock. Everything that made it late is already in the number: the
      // wait for the last line's tail, a slow decode, a late reply.
      ttsDebtMs = Math.min(TTS_DEBT_MAX_MS, ttsLatenessMs(idx));
      const prev = ttsAudio, prevUrl = ttsBlobUrl;
      if (prev && !prev.paused && !prev.ended) {
        const cutMs = isFinite(prev.duration)
          ? Math.max(0, Math.round((prev.duration - prev.currentTime)
              / (prev.playbackRate || 1) * 1000))
          : -1;
        // Under a syllable's worth left is not a cut — it is the grace timer
        // and the `ended` event finishing in a dead heat, with the takeover
        // first by a frame. Recording that as a cut (and counting it overrun)
        // made the tool report a loss nobody could hear.
        if (cutMs < 0 || cutMs >= 120) {
          ttsOverran++;   // cut by the next line: counted, not acted on
          // No "who was cut" index here: ttsSpokenIdx is already the NEW
          // line's by claim time, and naming the wrong line reads as fact.
          // The cut line is the one the previous fit row belongs to.
          ttsTraceAdd({ k: "cut", by: "take", i: idx, cutMs: cutMs,
            wanted: Math.round(armWantedMs), waited: Math.round(armWaitedMs) });
        } else {
          ttsTraceAdd({ k: "end", i: -1 });   // finished to the sample; the
                                              // takeover just beat the event
        }
      }
      if (prev) { try { prev.pause(); } catch (_e) { /* ignore */ } }
      if (prevUrl) { try { URL.revokeObjectURL(prevUrl); } catch (_e) { /* ignore */ } }
      ttsAudio = audio;
      ttsBlobUrl = url;
      if (ttsPendingRelease.get(idx) === release) ttsPendingRelease.delete(idx);
      owned = "";                  // ttsBlobUrl owns it from here
      audio.volume = Math.max(0, Math.min(1, settings.ttsVolume / 100));
      audio.addEventListener("ended", () => {
        if (myEpoch !== ttsEpoch || ttsAudio !== audio) return;
        ttsTraceAdd({ k: "end", i: idx });
        ttsDuckOffOrHold(idx);       // a near-touching next line keeps the duck
      });
      // Kept so a mid-line duck-depth change can be re-sent WITH it: the fit is
      // what holds this line's video slow-down, and a duck message without it
      // reads as "this line fits" and restores the rate (inject shareRate).
      ttsFit = ttsFitFor(audio, cue, ttsWindowEnd(idx));
      // Dropped into the middle of a line: start the speech from where the
      // line has got to. Read from the top it would be talking about something
      // already watched past, and it would run over everything after it — the
      // fit maths cannot rescue that, because a whole sentence does not
      // compress into the seconds of cue that are left. What is left to say
      // should take exactly as long as what is left to watch.
      if (enteredAtMs > TTS_SEEK_IN_MS) {
        const vv = getVideo();
        const nx = ttsWindowEnd(idx);
        const winEnd = nx && nx.start != null ? nx.start
          : (cue && cue.end != null ? cue.end : 0);
        const leftS = vv && winEnd
          ? Math.max(0, (winEnd - vv.currentTime * 1000) / 1000) / (vv.playbackRate || 1) : 0;
        const dur = audio.duration || 0;
        const skip = dur - leftS * (audio.playbackRate || 1);
        if (isFinite(skip) && skip > 0.2 && dur > 0.3) {
          try { audio.currentTime = Math.min(skip, dur - 0.05); }
          catch (_e) { /* not seekable: it starts from the top, as before */ }
        }
      }
      ttsDuck(true, ttsFit);
      // Counted when it is heard, like the built-in path's `start`: a play()
      // the browser refuses must not read as a line spoken.
      audio.addEventListener("playing", () => {
        if (myEpoch === ttsEpoch) { ttsSpoken++; ttsFailRun = 0; }
      }, { once: true });
      audio.play().catch(() => { if (myEpoch === ttsEpoch) ttsDuck(false); });
    };
    const arm = () => {
      // Let the sounding line finish, and charge the wait to the drift budget.
      // A line cut mid-syllable is the louder wrong, and the budget is what
      // keeps "let it finish" from drifting away for good: the wait is granted
      // in full while the debt it would leave stays under the cap, and once
      // the cap is reached the tail is cut — but at the cap, not at 400ms.
      //
      // Waiting is only half of it. The line that waits is then sized against
      // a window that runs past its own cue end by whatever budget is left
      // (ttsFitFor), so it hurries a little and hands the gap after it back.
      // That is the repayment; without it this would just be a slower start.
      const prev = ttsAudio;
      const prevLeft = prev && !prev.paused && !prev.ended && isFinite(prev.duration)
        ? Math.max(0, (prev.duration - prev.currentTime) / (prev.playbackRate || 1) * 1000)
        : 0;
      const lateNow = ttsLatenessMs(idx);
      // Spans (tlang's merged sentences) get the longer cap — see the constant.
      const spanHere = !!(cueToSpan && speechSpans && cueToSpan[idx] != null);
      let canWait = Math.max(0,
        (spanHere ? TTS_SPAN_WAIT_MAX_MS : TTS_DEBT_MAX_MS) - lateNow);
      // Never wait past this line's OWN window: a takeover that lands after
      // the next line's start is refused by ttsClaimStillCurrent, and the
      // line that politely waited vanishes without a count or a trace row.
      // That hole predates the longer cap; the cap doubles the exposure, so
      // the wait now leaves at least enough room to actually speak.
      const vw = getVideo();
      const nxw = ttsWindowEnd(idx);
      if (vw && nxw && nxw.start != null) {
        const roomWall = (nxw.start - vw.currentTime * 1000)
          / (vw.playbackRate || 1) - 150;
        canWait = Math.min(canWait, Math.max(0, roomWall));
      }
      const wait = Math.min(prevLeft, canWait);
      armWantedMs = prevLeft;
      armWaitedMs = wait;
      ttsTraceAdd({ k: "arm", i: idx, left: Math.round(prevLeft),
        late: Math.round(lateNow), wait: Math.round(wait),
        g: wait >= prevLeft && prevLeft > 0 });
      // Under a frame's worth of budget is not a wait, it is a stutter.
      if (wait > 30) setTimeout(takeover, wait + 30);
      else takeover();
    };
    // Audio that cannot be decoded. Two shapes, both silent until now:
    // metadata never arrives, so `arm` is never called and the line is skipped
    // without a word; or decoding fails after play() already resolved, and the
    // duck stays down — the video's own sound held at the read-aloud level with
    // nothing reading, until the switch is turned off or the video changes. A
    // provider whose bytes we have never heard (the two that have never been
    // called for real) is exactly where this would show up.
    let metaTimer = 0;
    const onDead = () => {
      clearTimeout(metaTimer);
      release();
      if (myEpoch !== ttsEpoch) return;
      if (ttsAudio === audio) ttsDuck(false);
      ttsSkipped++;
      ttsTraceAdd({ k: "skip", i: idx, why: "dead" });
      // Latest wins. The question the status line answers is "what is going
      // wrong now", and a first-wins reason outlives the fault it named.
      ttsErr = "noAudio";
      ttsFailRun++;
    };
    audio.addEventListener("error", onDead, { once: true });
    // A line fetched ahead had its Audio built cues ago, in ttsDecode. If those
    // bytes were undecodable the error event has ALREADY fired and will not
    // fire again, duration is NaN, and loadedmetadata is never coming — so
    // without this the line sits out the whole 4s deadline before it is
    // counted, and nothing refills the window while it waits. On a provider
    // whose bytes Chrome cannot decode that is every line.
    if (audio.error) { onDead(); return; }
    // …and the third shape, which fires nothing at all: metadata that simply
    // never arrives. There was no deadline on it, so that line waited forever
    // — silent, uncounted, and still holding its bytes. These are blob URLs
    // already in memory, so four seconds is not a slow decode, it is a decode
    // that is not going to happen.
    metaTimer = setTimeout(() => {
      if (!owned) return;          // already on air, or already released
      onDead();
    }, TTS_META_MS);
    if (isFinite(audio.duration) && audio.duration > 0) { clearTimeout(metaTimer); arm(); }
    else audio.addEventListener("loadedmetadata", () => {
      clearTimeout(metaTimer);
      if (myEpoch !== ttsEpoch) { release(); return; }
      arm();
    }, { once: true });
  }

  // The browser's own voices, spoken here because a service worker has no
  // speechSynthesis. No Audio element, so three things this path cannot do and
  // does not pretend to: there is no duration until it has finished, so the
  // video is never slowed to fit a line; there is no blob to cache; and the
  // read-aloud volume rides the utterance instead of an element. Ducking still
  // works — that is a message to inject.js and has nothing to do with how the
  // sound is made.
  let localUtter = null;
  let localStartedAt = 0;       // when the CURRENT utterance began speaking
  let localEstMs = 0;           // its estimated length at its rate
  let localDeferTimer = 0;      // one pending "start after the last word" slot
  // Chrome loads the machine's voice table asynchronously: the first call
  // returns an empty array and the list announces itself later on
  // "voiceschanged". Asking once at load starts that fetch long before the
  // first cue; the cached copy is what the lookup below reads. Without it a
  // cue arriving during the gap finds nothing, and the line is spoken by the
  // default voice while the menus name the one that was picked.
  let localVoices = [];
  let localVoicesTake = null;    // the voiceschanged listener, so goOrphan can drop it
  (function primeLocalVoices() {
    try {
      const synth = typeof window !== "undefined" && window.speechSynthesis;
      // Somebody else's pause is still our silence, and the flag outlives the
      // page that set it: a previous instance of this script (or another
      // extension) can have been torn down mid-pause, and nothing else will
      // ever clear it. Costs nothing when the engine is already running.
      try { if (synth) synth.resume(); } catch (_e) { /* ignore */ }
      if (!synth) return;
      const take = () => {
        if (orphaned) return;         // an orphaned script keeps no state warm
        try { localVoices = synth.getVoices() || []; } catch (_e) { /* keep the last good list */ }
      };
      take();
      localVoicesTake = take;
      synth.addEventListener("voiceschanged", take);
    } catch (_e) { /* no local engine here: the API path is unaffected */ }
  })();
  // One rulebook for "which machine voice will speak": the live list when it
  // answers, the primed copy when it does not, the stored name first, then a
  // voice that at least speaks the language (the system default is chosen for
  // the SYSTEM — an English voice reading Chinese is its ordinary outcome).
  // Extracted so the sizing can ask about the voice BEFORE speaking: whether
  // it is a networked one decides the window budget below.
  function pickLocalVoice(synth, voiceName, lang) {
    const all = (synth.getVoices() || []);
    const pool = all.length ? all : localVoices;
    let v = voiceName ? pool.find((x) => x && x.name === voiceName) : null;
    if (!v && pool.length) {
      const base = String(lang || "").split("-")[0].toLowerCase();
      const speaks = (x) => x && String(x.lang || "").toLowerCase().split("-")[0] === base;
      // A voice that stays on this machine first. The stored voice can vanish
      // (a system update, another computer); the fallback must not quietly
      // turn "nothing leaves this machine" into a networked voice — the
      // privacy page says the text goes only where the user chose.
      v = pool.find((x) => speaks(x) && x.localService) || pool.find(speaks);
    }
    return v || null;
  }
  function ttsSpeakLocal(text, lang, voiceName, myEpoch, idx) {
    const synth = window.speechSynthesis;
    if (!synth) {
      ttsSkipped++; ttsErr = "noSynth"; ttsFailRun++;
      ttsTraceAdd({ k: "skip", i: idx, why: "nosynth" });
      return;
    }
    // Size the line BEFORE speaking it, from the estimate the watchdog already
    // trusts. This path shipped with none of the audio path's three tiers —
    // rate never set, fit never sent, cancel() unconditional — so on the
    // engine every fresh install starts with, a dense line lost its last words
    // to the next one, every time. The estimate is rough; the tiers only need
    // it to be the right order of magnitude.
    const est = Math.max(300, String(text || "").length * ttsLocalCharMs(text));
    // The watchdog keeps the generous ceiling: it guards against a voice that
    // never fires `end`, and releasing the duck early is the worse fault there.
    const estGuard = Math.max(est, String(text || "").length * TTS_LOCAL_PER_CHAR_MS);
    let rate = 1, fit, estAtRate = est;
    const doSpeak = () => {
    // The full set of guards, not just the epoch. The QA round found every
    // one of these missing here (the audio takeover got the same pause/ad
    // door in D156's review, not before): a
    // grace timer that expired during a pause spoke over the frozen frame
    // (doSpeak's resume() even pulled the engine back up to do it), an ad or
    // the switch going off mid-defer changed neither epoch nor claim, and a
    // catch-up already checks the same list one layer up. Same answers, same
    // door.
    if (myEpoch !== ttsEpoch || orphaned || !settings.ttsEnabled) return;
    const vv = getVideo();
    if (!vv || vv.paused || isAdShowing()) return;
    // Sized HERE, not when the wait began: the audio path measures its window
    // at takeover time, and a deferred line that measured early spoke at a
    // rate chosen for a window that no longer existed — the grace ate the
    // margin its own maths had counted on, and a same-cue seek during the
    // wait had the same effect for free.
    // Same measurement as the audio takeover, at the same moment: how late
    // this line is going on air, off the video's own clock.
    if (idx != null) ttsDebtMs = Math.min(TTS_DEBT_MAX_MS, ttsLatenessMs(idx));
    const nx = idx != null ? ttsWindowEnd(idx) : null;
    // Networked built-ins ("Google …", localService === false) fetch their
    // audio between speak() and `start` — seconds, measured live (D34) — and
    // that latency burns the very window this sizing counts on: the line then
    // overruns and the next one cuts it, however right the maths were.
    // Budget the hole up front: the measured average once one exists, a
    // conservative default before it. A machine voice starts at once.
    const chosenVoice = pickLocalVoice(synth, voiceName, lang);
    let localSpeakAt = 0;
    const netPenalty = chosenVoice && chosenVoice.localService === false
      ? Math.min(TTS_LOCAL_NET_PENALTY_MAX, ttsLocalNetEma || TTS_LOCAL_NET_PENALTY_MS)
      : 0;
    const ownMs = nx && nx.start != null
      ? Math.max(300, nx.start - vv.currentTime * 1000 - netPenalty) : 0;
    // Same base-rate rule as ttsFitFor: never size against our own slowdown.
    const vRate = ttsUserBase || vv.playbackRate || 1;
    const ownNeed = ownMs ? (est * vRate) / ownMs : 0;
    ttsCruiseNote(ownNeed);                             // structural need
    let leftMs = ownMs, needRate = ownNeed;
    // Same last-tier rule as the audio path, on half the budget: this length
    // is an estimate, not a measurement, and the rate cannot be changed once
    // the voice is speaking — an underestimate here becomes debt that nothing
    // can work off. Half a budget it may be wrong about beats a whole one it
    // cannot correct.
    rate = 1; fit = undefined;
    const rateCap = ttsRateMaxFor(vRate);           // same rate-following
    if (ownNeed > rateCap / TTS_VIDEO_FLOOR && ownMs) {   // ceiling as audio
      fit = settings.ttsComplete                    // same complete-mode floor
        ? Math.max(vRate * TTS_COMPLETE_FLOOR,      // as the audio path above
            Math.min((rateCap * ownMs) / est, vRate * TTS_VIDEO_FLOOR))
        : vRate * TTS_VIDEO_FLOOR;                  // same free tier first
      const wallHave = ownMs / fit;
      const wallWant = est / rateCap;
      const borrow = Math.min(Math.max(0, wallWant - wallHave),
        Math.max(0, TTS_DEBT_MAX_MS - ttsDebtMs) * 0.5);
      leftMs = (wallHave + borrow) * fit;
      needRate = est / (wallHave + borrow);
    }
    if (needRate > 1) {
      rate = Math.min(rateCap, needRate);           // no urgent gear on an
      if (needRate > rateCap && fit == null) {      // estimate (deliberate)
        fit = (rateCap * leftMs) / est;
      }
    }
    if (ttsDebtMs > TTS_DEBT_CLEAR_MS) rate = ttsCruiseSpeech(rate, rateCap);
    if (ttsCruising) {
      rate = ttsCruiseSpeech(rate, rateCap);
      fit = ttsCruiseFit(fit, vRate);
    }
    estAtRate = est / rate;
    // The cancel below is this path's takeover: when OUR utterance is still
    // mid-line, note how much of it the estimate says was thrown away.
    if (localUtter && localStartedAt) {
      const rem = localEstMs - (Date.now() - localStartedAt);
      if (isFinite(rem) && rem > 150) {
        // Same event as the audio path's takeover cut, so the same counter:
        // `over` used to describe only one of the two engines, and the local
        // half's cut tails were invisible in every diagnostic read.
        ttsOverran++;
        ttsTraceAdd({ k: "cut", by: "lcancel", i: idx, cutMs: Math.round(rem) });
      }
    }
    ttsTraceAdd({ k: "lfit", i: idx, vt: Math.round(vv.currentTime * 1000),
      est: Math.round(est), left: Math.round(leftMs), own: Math.round(ownMs),
      pen: netPenalty, debt: Math.round(ttsDebtMs),
      need: Math.round(needRate * 100) / 100, rate: Math.round(rate * 100) / 100,
      fit: fit == null ? -1 : Math.round(fit * 100) / 100, cru: ttsCruising });
    try { synth.cancel(); } catch (_e) { /* ignore */ }
    // Somebody else's pause is still our silence. The flag is global — another
    // extension, a stray call, our own pause across a video change — and a
    // speak() into a paused engine queues without a sound. Costs nothing when
    // it is already running. Safe HERE because the guards above just refused
    // a paused video: this cannot be the arm that lifts our own follow-pause.
    try { synth.resume(); } catch (_e) { /* ignore */ }
    const u = new SpeechSynthesisUtterance(text);
    if (lang) u.lang = lang;
    u.rate = rate;
    u.volume = Math.max(0, Math.min(1, settings.ttsVolume / 100));
    // Chosen once, above, where the sizing needed to know whether the voice
    // is networked; the rulebook lives in pickLocalVoice.
    if (chosenVoice) u.voice = chosenVoice;
    // The guard comes FIRST. cancel() makes Chrome fire end on the utterance it
    // stopped, and that end lands after the next line has already armed its own
    // watchdog — clearing the timer before checking whose end this is would let
    // every line disarm the one after it.
    const done = () => {
      if (myEpoch !== ttsEpoch || localUtter !== u) return;
      clearTimeout(localTimer);
      localTimer = 0;
      localUtter = null;
      localStartedAt = 0;
      ttsDuckOffOrHold(idx);         // a near-touching next line keeps the duck
    };
    // The line never began. Not the same event as done(): nothing was said, so
    // it is a skip with a reason rather than a line that finished — and the
    // utterance is STILL QUEUED, so it has to be stopped here. Left alone it
    // starts late and speaks its whole line at full volume over a video that
    // has just been given its sound back.
    const neverBegan = () => {
      if (myEpoch !== ttsEpoch || localUtter !== u) return;
      ttsSkipped++;
      ttsTraceAdd({ k: "skip", i: idx, why: "neverBegan" });
      ttsErr = "noAudio";
      ttsFailRun++;
      try { synth.cancel(); } catch (_e) { /* nothing left to stop */ }
      done();
    };
    u.addEventListener("end", () => {
      if (myEpoch === ttsEpoch && localUtter === u && localStartedAt) {
        const real = Date.now() - localStartedAt;
        ttsLocalCharLearn(text, real, rate);
        ttsTraceAdd({ k: "lend", i: idx, est: Math.round(estAtRate), real: Math.round(real) });
      }
      done();
    });
    u.addEventListener("error", done);
    // Chrome does not always fire `end` for a local utterance — a long known
    // quirk of speechSynthesis, and there is no `ended` element to fall back
    // on here as there is on the audio path. Without a watchdog the duck stays
    // down for good: the video's own sound sits at the read-aloud level with
    // nothing reading, until read-aloud is switched off or the video changes.
    //
    // Two clocks, because there are two ways for this to go quiet. The
    // estimate below is of SPEECH, so it may only start when the speech does:
    // Chrome's own "Google …" voices fetch their audio, and seconds can pass
    // between speak() and the first sound. Timing that gap as if it were
    // speech gave the video its sound back before the voice had said a word,
    // and then the voice talked under it for the whole line. Until `start`
    // arrives the only thing worth guarding against is a line that never
    // begins at all, and the ceiling covers that.
    u.addEventListener("start", () => {
      if (myEpoch !== ttsEpoch || localUtter !== u) return;
      // A line counts as read when it starts being read. Counting it at
      // handover instead made the one engine that ships by default incapable
      // of reporting its own commonest failure: Chrome's cancel-then-speak
      // wedge leaves speechSynthesis accepting utterances and making no
      // sound, and every silent line both raised "spoken" and reset the run
      // of failures — so the popup said "read-aloud on, twelve lines, none
      // skipped" over total silence.
      ttsSpoken++;
      ttsFailRun = 0;
      localStartedAt = Date.now();
      localEstMs = estAtRate;          // honest: this answers "how much is left"
      // Feed the start-latency budget with what actually happened — only for
      // networked voices; a machine voice's ~0 would drag the average under
      // what the "Google …" voices really cost.
      if (localSpeakAt && chosenVoice && chosenVoice.localService === false) {
        const lat = Date.now() - localSpeakAt;
        if (lat >= 0 && lat < 15000) {
          ttsLocalNetEma = ttsLocalNetEma
            ? Math.round(0.7 * ttsLocalNetEma + 0.3 * lat) : lat;
        }
      }
      clearTimeout(localTimer);
      // The GUARD estimate, not the honest one. This timer exists for a voice
      // that never fires `end`; firing it early is not a small error, because
      // done() hands the slot back and the next line then cancel-then-speaks
      // over an utterance that is still sounding — the wedge documented on the
      // `start` handler, heard as total silence. Measured 2026-09-10: with the
      // honest Latin ruler here (80ms/char) the watchdog fired at a third of a
      // real English line and every browser voice went quiet.
      localTimer = setTimeout(done, Math.min(TTS_LOCAL_MAX_MS,
        Math.max(TTS_LOCAL_MIN_MS,
          // Slack past the tuned ceiling: the estimate's fixed overheads do
          // not shrink with rate, and some machine voices clamp the rate we
          // asked for — a halved watchdog then un-ducked mid-sentence.
          rate > TTS_RATE_MAX ? (estGuard / rate) * 1.25 + 150 : estGuard / rate)));
    });
    localUtter = u;
    clearTimeout(localTimer);
    localTimer = setTimeout(neverBegan, TTS_LOCAL_START_MS);
    // Mirror the audio path's takeover: the module-level fit is what a live
    // duck-depth change resends. Without it, dragging the original-volume
    // slider during local speech shipped a fitless duck and undid the slowdown.
    ttsFit = fit;
    ttsDuck(true, fit);            // sized up front, same three tiers as audio
    localSpeakAt = Date.now();
    try { synth.speak(u); } catch (_e) { neverBegan(); }
    };
    // GRACE: the audio path has let a finishing line say its last word since
    // the takeover was written; this path cancelled it mid-syllable. When OUR
    // utterance is speaking and its estimate says it is within a breath of
    // done, wait that breath out. Only ours — a foreign utterance has no
    // estimate and keeps the old behaviour. Newest line wins the one slot:
    // a third line clears the wait and re-decides.
    clearTimeout(localDeferTimer);
    localDeferTimer = 0;
    if (localUtter && localStartedAt) {
      const remain = localEstMs - (Date.now() - localStartedAt);
      // Same budget as the audio arm, on this path's estimate — and the same
      // half share of it, for the same reason the sizing above takes half.
      const lateNow = idx != null ? ttsLatenessMs(idx) : 0;
      const graceMax = Math.max(TTS_LOCAL_GRACE_MS,
        Math.min(900, (TTS_DEBT_MAX_MS - lateNow) * 0.5));
      // Wait for as much of the tail as the budget covers. A tail longer than
      // that is still cut — but the part that was waited out was said, where
      // an all-or-nothing test threw the whole tail away over one ms.
      const wait = Math.min(remain, graceMax);
      if (wait > 30) {
        ttsTraceAdd({ k: "ldefer", left: Math.round(remain),
          wait: Math.round(wait), gm: Math.round(graceMax) });
        const myClaim = ttsSpokenIdx;
        localDeferTimer = setTimeout(() => {
          localDeferTimer = 0;
          if (ttsSpokenIdx !== myClaim) return;   // a newer line took the slot
          doSpeak();                              // …which re-checks everything else
        }, wait + 40);
        return;
      }
    }
    doSpeak();
  }

  function ttsOnCue(idx, cue, enteredAtMs) {
    if (!settings.ttsEnabled || orphaned) return;
    if (idx === ttsSpokenIdx) return;
    const text = cueSpeechText(idx);
    // Claim this line's audio BEFORE the window slides past it — the fill
    // drops everything at or behind the cue on air, this one included.
    const pre = text ? ttsAheadTake(idx, text) : null;
    // Nothing to speak (a stage note, a lyric marker, a translation that
    // deduped away) — but the window still has to move. That return used to be
    // above the fill, which meant a run of such lines left the window frozen
    // and stale, and the next real line paid a full round trip.
    if (text == null) { ttsFillAhead(idx); return; }
    // Not ready at cue start: skipped, never caught up on. Same reason the
    // fill still runs — a line whose own translation has not landed is exactly
    // the case the chain has to survive.
    if (!text) {
      ttsSkipped++;
      ttsTraceAdd({ k: "skip", i: idx, why: "noText" });
      const g = cueToGroup && cueToGroup[idx] != null ? cueToGroup[idx] : -1;
      if (g >= 0) {
        if (g === ttsSkipGroup) ttsSkipCharged++;
        else { ttsSkipGroup = g; ttsSkipCharged = 1; }
      }
      ttsFillAhead(idx);
      return;
    }
    // A sentence group hands the same translation to every cue it covers, and
    // this used to dedupe on the cue index alone — so a three-cue group read
    // one sentence three times. Only inside the group: the same words in a
    // later group are a real repetition and get said again.
    if (ttsSpokenIdx >= 0 && text === ttsSpokenText && cueToGroup &&
        cueToGroup[idx] != null && cueToGroup[idx] === cueToGroup[ttsSpokenIdx]) {
      // The claim above took this line out of the window and out of its byte
      // accounting, so nothing else can reach it any more — not ttsStop, not
      // the next fill. Whatever this path decides, the bytes go back here or
      // they are held until the tab closes.
      if (pre) { try { URL.revokeObjectURL(pre.url); } catch (_e) { /* ignore */ } }
      ttsFillAhead(idx);
      return;
    }
    ttsSpokenIdx = idx;
    ttsSpokenText = text;
    // The line is claimed after all, so the skips billed while its words were
    // missing were provisional — take them back. Only for THIS sentence: a
    // skip in an earlier one was final the moment its window closed.
    if (cueToGroup && cueToGroup[idx] != null && cueToGroup[idx] === ttsSkipGroup) {
      ttsSkipped = Math.max(0, ttsSkipped - ttsSkipCharged);
      // The why-tally must follow, or reasons long since refunded keep the
      // majority vote and the popup names a fault that healed itself. Group
      // refunds only ever charge noText (ttsSkipGroup is set nowhere else).
      ttsSkipWhy.noText = Math.max(0, (ttsSkipWhy.noText || 0) - ttsSkipCharged);
      ttsSkipGroup = -1;
      ttsSkipCharged = 0;
    }
    const myEpoch = ttsEpoch;
    if (pre) {
      ttsPlay(idx, cue, pre.audio, pre.url, myEpoch, enteredAtMs);
      ttsFillAhead(idx);
      return;
    }
    // From here the line on screen needs the network, and the fill is deferred
    // until its reply lands. pump is single-flight per lane and awaits the send
    // inline, so a look-ahead request issued first does not merely queue ahead
    // — it OWNS the lane until it returns, and the urgent job waits out its
    // whole round trip however urgent it is. Arming the look-ahead in the same
    // breath as a line that is already late is the one ordering that makes the
    // lateness worse.
    extCall(() => chrome.runtime.sendMessage(
      // urgent: this is the line on screen. The worker's read-aloud lane sheds
      // what it is allowed to shed while it waits out a rate limit, and an
      // unflagged request is a shedable one — so without this, the one line
      // that has no second chance is the one it throws away.
      { type: "ttsSpeak", text, targetLang: settings.targetLang, urgent: true }, (resp) => {
      // The lane is free again whatever the answer was, so the look-ahead goes
      // out now — on every path, including the ones that give up on this line.
      const fillNow = () => {
        if (myEpoch !== ttsEpoch || !settings.ttsEnabled || orphaned) return;
        // activeCueIdx is -1 for every gap BETWEEN cues, and a reply landing in
        // a gap is the ordinary case, not a corner one: the round trip is what
        // overshot the cue in the first place. Gated on it, the window was
        // never armed again for the rest of the video — every line took the
        // network path, every reply arrived in the next gap, and read-aloud
        // went quiet with nothing counted and nothing said, which is the exact
        // failure this whole stack exists to remove. Fall back to the cue this
        // reply was for; it is always a real index.
        ttsFillAhead(activeCueIdx >= 0 ? activeCueIdx : idx);
      };
      if (chrome.runtime.lastError) {
        // The worker went away between the ask and this reply: nothing was
        // said, and the card must not read as if it had been.
        if (myEpoch === ttsEpoch && ttsClaimStillCurrent(idx)) {
          ttsSkipped++; ttsErr = "failed"; ttsFailRun++;
          ttsTraceAdd({ k: "skip", i: idx, why: "worker" });
        }
        fillNow(); return;
      }
      if (myEpoch !== ttsEpoch || !ttsClaimStillCurrent(idx)) { fillNow(); return; }
      // The switch can go off between the ask and this reply — the menu made
      // that a one-press window. The fill already checked it; the speaking
      // path did not, and it is the audible half.
      // Survives mutation, deliberately kept: in today's wiring the menu's own
      // ttsStop (epoch) or onChanged's (also epoch) always gets there first,
      // so no rig scenario can make this line the only barrier. It stays
      // because every OTHER off-path is one refactor away from opening the
      // race this line closes, and the QA review asked for both halves.
      if (!settings.ttsEnabled) { return; }
      if (resp && resp.ok && resp.local) {
        // The keyless local engine: the reply is "say this yourself", so there
        // is nothing a look-ahead could hold. Learn it here — this is the
        // earliest the answer exists — or the window spends two round trips a
        // line on the DEFAULT provider, for the whole video.
        ttsAheadOff = true;
        ttsAheadClear();
        ttsSpeakLocal(text, resp.lang, resp.voice, myEpoch, idx);
        return;
      }
      if (!resp || !resp.ok || !resp.b64) {
        // "stale" is the worker saying it retired this job because a newer
        // line arrived — the extension's own doing, not the provider's. Two
        // tabs playing at once can produce it while THIS cue is still on
        // screen, and reporting it would paint a red "connection failed" for
        // something nothing is wrong with.
        if (!resp || resp.code !== "stale") {
          // Keep going — one bad line must not stop the run — but remember WHY,
          // so the popup can say it instead of leaving the user with silence.
          ttsSkipped++;
          ttsTraceAdd({ k: "skip", i: idx,
            why: (resp && resp.code) || "failed" });
          ttsErr = (resp && resp.code) || "failed";
          ttsFailRun++;
        }
        fillNow();
        return;
      }
      try {
        const d = ttsDecode(resp.b64, resp.mime);
        ttsPlay(idx, cue, d.audio, d.url, myEpoch, enteredAtMs);
      } catch (_e) {
        // Bytes that will not decode at all. This only gave the video its sound
        // back — no skip counted, no reason kept — while ttsSpokenIdx had
        // already been written, so the line was never retried either. It
        // vanished, and the popup went on saying nothing was wrong. Its
        // neighbour two lines up, the Audio element that fails LATER, has
        // reported all three since it was written; there is no reason for the
        // earlier failure to be quieter than the later one.
        ttsSkipped++;
        ttsTraceAdd({ k: "skip", i: idx, why: "decode" });
        ttsErr = "noAudio";
        ttsFailRun++;
        ttsDuck(false);
      }
      fillNow();
    }));
  }

  function cueTick() {
    if (!settings.enabled || !cueList) return;
    const video = getVideo();
    if (!video) return;
    ttsFollowPause(!!video.paused);
    // An advertisement is not this video. Treated exactly like a gap between
    // cues — clear the overlay, stop the line — because that is what it is:
    // a stretch of time this track has nothing to say about.
    if (isAdShowing()) {
      // Also in a gap between cues: a finishing line or a duck hold window
      // would otherwise talk over the advert until it ended by itself.
      if (activeCueIdx !== -1 || ttsSpokenIdx >= 0 || ttsHoldTimer) {
        activeCueIdx = -1;
        activeGroupIdx = -1;
        forceBlankLines();
        ttsStop();
      }
      ttsTickVid = -1;      // the ad runs its own clock; leaving it is not a jump
      return;
    }
    // Sample the viewer's own rate only while nothing of ours is on the rate:
    // we are asking for nothing AND inject says it is holding nothing. The
    // second half is the one the element cannot supply — clearing a fit and
    // the player giving the rate back are different moments, and the ticks
    // between them read exactly like a viewer who chose 0.85. The old gate
    // asked "is a fit applied", which a dense stretch keeps true on every
    // line, so it was shut for the whole passage (采样器根修-方案 §二 bug 1);
    // inject's report is what covers that stretch now.
    //
    // AFTER the advert check, not before it. An advert plays at its own rate,
    // and the stop above has just cleared our fit — so every tick of every
    // advert used to be sampled as if the viewer had chosen it. Someone
    // watching at 1.5x had that written down as 1.0 by the first ad break,
    // and every line after it was sized against a rate they never picked.
    if (!ttsAsked && !ttsHeld) {
      const live = video.playbackRate || 0;
      if (live > 0) ttsUserBase = live;
    }
    const t = video.currentTime * 1000;
    // Judge the jump BEFORE the cue transition below: the residual of the old
    // place has to be gone before the new place claims the speaker.
    {
      const wall = Date.now();
      if (ttsTickVid >= 0) {
        const expected = video.paused ? 0
          : (wall - ttsTickWall) * (video.playbackRate || 1);
        // 1500, not smaller: the arrow keys move 5s and a double-tap 10s —
        // the jumps worth cutting for are all far past it — while a sub-1.5s
        // scrub usually stays inside the sentence, where cutting is wrong
        // anyway. The 40% term keeps a clamped background tick at 2× honest.
        if (Math.abs((t - ttsTickVid) - expected) > Math.max(1500, 0.4 * expected)) {
          ttsOnTimeJump(t);
        }
      }
      ttsTickWall = wall; ttsTickVid = t;
    }

    const idx = activeCueIdxAt(t);

    if (idx < 0) {
      if (activeCueIdx !== -1) {
        activeCueIdx = -1;
        activeGroupIdx = -1;              // no cue ⟹ no group (explicit invariant)
        setOriginal("");
        setTranslation("", "");
      }
      return;
    }

    if (idx === activeCueIdx) return;     // same sentence — no re-render, no jitter
    activeCueIdx = idx;
    // set BEFORE rendering: group gtx callbacks paint iff activeGroupIdx matches
    activeGroupIdx = (cueToGroup && cueToGroup[idx] != null) ? cueToGroup[idx] : -1;

    const cue = cueList[idx];
    setOriginal(cue.text);
    renderTranslationForCue(idx, cue);
    prefetchFrom(idx);                    // warm upcoming translations (gtx mode)
    // How far into this line the playhead already was when the line became the
    // current one. On an ordinary play-through this is one poll interval; after
    // a seek it is however far in the viewer landed. Measured HERE, at the
    // transition, so that a slow synthesis cannot be mistaken for a seek.
    // How far into the LINE, not the slice: a seek landing on the third slice
    // of a sentence is deep into the sentence, and measuring from the slice
    // said "just arrived" — the whole sentence then played from the top
    // against a window that only had its tail left.
    ttsOnCue(idx, cue, Math.max(0, t - ttsLineStartMs(idx)));
  }

  // What the translation line shows when there is nothing to translate:
  // nothing (the original line already carries the text) — or the text itself
  // when the user hides the original line, so the video still has subtitles.
  function sameLangLine(origText) {
    return settings.showOriginal ? "" : origText;
  }

  // YouTube translates each fragment of a track on its own, and when one
  // sentence spans two cues the whole translation lands in the first — leaving
  // the second holding nothing but the mark that closed it. A line that carries
  // nothing but PUNCTUATION is that stranded tail, not a translation of the
  // words beside it. Two things it deliberately is not: a symbol is not a mark
  // (a music cue's "♪" is that cue's own line, and ♪ is a symbol, not
  // punctuation), and "..." -> "……" is a real translation — so the ORIGINAL has
  // to have had a word in it before any of this applies.
  const WORDISH = /[\p{L}\p{N}]/u;
  const MARKS_ONLY = /^[\p{P}\s]+$/u;

  function isStrandedMark(trans, origText) {
    const t = String(trans || "").trim();
    return !!t && MARKS_ONLY.test(t) && WORDISH.test(String(origText || ""));
  }

  // A "translation" identical to its original adds nothing — this happens when
  // the source language matched the target in a way the upstream lang check
  // could not see. Render it as the same-language case.
  function dedupeTrans(trans, origText) {
    if (trans && origText && trans.trim() === origText.trim()) {
      return sameLangLine(origText);
    }
    return trans;
  }

  function renderTranslationForCue(idx, cue) {
    const origText = cue.text;

    // (0) same-language track (flagged by inject.js): nothing to translate.
    // The text already sits on the original line; when that line is hidden,
    // carry it on the translation line so the video still has subtitles.
    if (cueSameLang) {
      setTranslation(sameLangLine(origText), origText);
      return;
    }

    // (1) aligned tlang translation — paired by event order in inject.js and
    // carried on the cue itself, so re-sorting cueList cannot desync it.
    if (cueAligned && typeof cue.trans === "string" && cue.trans) {
      // On a scrolling track YouTube translates each fragment alone, and the
      // cut lands wherever the fragment ended: a line reads "…并无本质区别。在"
      // — a whole sentence plus the first character of the next one, stranded.
      // Show the SENTENCE instead, repainted unchanged as its fragments go by.
      // This is what the gtx path has always done with its own sentence groups
      // (see (2) below), so the two engines now read the same way; the original
      // line still scrolls fragment by fragment underneath.
      if (cueToSpan && speechSpans && cueToSpan[idx] != null) {
        const span = speechSpans[cueToSpan[idx]];
        const whole = span ? tlangSpanText(span) : "";
        if (whole) { setTranslation(whole, origText); return; }
      }
      // Spans only exist on a scrolling track (they are built for the voice),
      // so on a MANUAL track this is where the stranded mark arrived on screen:
      // the yellow line under "around the world every year." read "。" for the
      // two seconds that cue was up, wiping the sentence it belongs to. Leave
      // the line alone — the sentence already on it is this cue's sentence,
      // which is exactly what the span path above holds on a scrolling track.
      if (isStrandedMark(cue.trans, origText)) return;
      setTranslation(dedupeTrans(cue.trans, origText), origText);
      return;
    }

    // (1b) tlang present but MISALIGNED (length mismatch): positional indexing
    // would paint wrong-but-plausible lines, so match by timestamp instead.
    // Pick the tcue whose start is closest to this cue's start within a
    // tolerance; if none qualifies, fall through to the gtx/cache path.
    if (tcueList && cueAligned === false) {
      const m = nearestTcue(cue.start);
      if (m) {
        // Same cut, matched by timestamp instead of by index.
        if (isStrandedMark(m.text, origText)) return;
        setTranslation(dedupeTrans(m.text, origText), origText);
        return;
      }
      // no good timestamp match -> fall through (do NOT index positionally)
    }

    // (2) gtx backend (or no usable tlang data).
    if (activeGroupIdx >= 0) {
      // Aligned mode filled a line for this very cue: prefer it, so the
      // translation changes in step with the original.
      const perCue = transCache.get(cueVideoId + " " + idx);
      if (perCue !== undefined) {
        setTranslation(dedupeTrans(perCue, origText), origText);
        return;
      }
      // sentence-group mode: the whole rebuilt sentence translates as one unit.
      // Same text repaints across the group's cues — textContent is idempotent,
      // so there is no visible flicker.
      const gCached = transCache.get(groupKey(activeGroupIdx));
      if (gCached !== undefined) {
        // "" is the group-echo marker (see gtxRequestGroup): this sentence
        // already speaks the target language — render as the same-language
        // case so a hidden original line still leaves visible text.
        setTranslation(gCached === "" ? sameLangLine(origText) : gCached, origText);
        return;
      }
      gtxRequestGroup(activeGroupIdx, true);  // the sentence being watched — fast lane
      return;
    }
    // per-cue path: serves the misaligned-tlang fall-through above.
    const key = cueVideoId + " " + idx;
    const cached = transCache.get(key);
    if (cached !== undefined) {
      setTranslation(dedupeTrans(cached, origText), origText);
      return;
    }
    // Not cached yet — request it now (deduped via transInflight). Prefetch
    // usually warms this ahead of time so it's already cached. Keep the previous
    // translation on screen until the response arrives (gtxRequest paints it).
    gtxRequest(idx);
  }

  // Fire a gtx translation for one cue, deduped by cache + in-flight set, caching
  // the result and painting it iff that cue is still active. Shared by the active
  // (on-demand) path and the look-ahead prefetch.
  function gtxRequest(idx) {
    if (!cueList) return;
    const cue = cueList[idx];
    if (!cue || !cue.text) return;
    const key = cueVideoId + " " + idx;
    if (transCache.has(key) || transInflight.has(idx)) return;
    transInflight.add(idx);
    const reqVid = cueVideoId;
    const reqEpoch = cueEpoch;
    const sent = extCall(() => chrome.runtime.sendMessage(
      { type: "translate", text: cue.text, targetLang: settings.targetLang },
      (resp) => {
        transInflight.delete(idx);
        if (chrome.runtime.lastError) return;       // worker asleep; retried on demand
        if (reqEpoch !== cueEpoch) return;          // loop restarted / re-config
        if (reqVid !== cueVideoId) return;          // navigated away
        if (resp && resp.ok && resp.translated) {
          transCache.set(key, resp.translated);
          if (activeCueIdx === idx) {
            setTranslation(dedupeTrans(resp.translated, cue.text), cue.text);
          }
        }
        // on failure: leave cache empty so it can be retried when next active
      }
    ));
    // The call never left: clear the in-flight mark so nothing waits on a reply
    // that cannot come.
    if (!sent) transInflight.delete(idx);
  }

  // Warm upcoming cues' gtx translations so the translation line is ready the
  // moment a sentence appears — fixes the ~1s lag when tlang is unavailable.
  // Only runs when there is NO tlang data at all (cueAligned == null), i.e. the
  // gtx backend or a tlang failure; aligned/misaligned tlang is handled inline.
  // Window-bounded to stay gentle on the unofficial endpoint.
  function prefetchFrom(startIdx) {
    if (cueSameLang) return;                    // nothing to translate at all
    if (cueAligned != null) return;             // tlang handles the translation
    if (!settings.enabled || !cueList) return;
    if (cueToGroup && sentGroups) {
      // group mode: warm the next few SENTENCES (same ~28s lookahead as the
      // per-cue window, at a third of the requests). The active group itself is
      // handled by renderTranslationForCue on the urgent lane.
      const at = Math.max(0, Math.min(startIdx, cueToGroup.length - 1));
      const g0 = cueToGroup[at];
      if (g0 == null || g0 < 0) return;
      const gEnd = Math.min(sentGroups.length - 1, g0 + PREFETCH_GROUPS);
      for (let g = g0 + 1; g <= gEnd; g++) gtxRequestGroup(g, false);
      return;
    }
    const from = Math.max(0, startIdx);
    const to = Math.min(cueList.length - 1, from + PREFETCH_AHEAD);
    for (let i = from; i <= to; i++) gtxRequest(i);
  }

  // Timestamp-match a translation cue for a given original start (ms), used
  // only when orig/tlang counts differ (cueAligned === false). Returns the
  // closest tcue within tolerance, or null.
  function nearestTcue(startMs) {
    if (!tcueList || !tcueList.length) return null;
    let best = null, bestDelta = Infinity;
    for (const tc of tcueList) {
      const d = Math.abs(tc.start - startMs);
      if (d < bestDelta) { bestDelta = d; best = tc; }
    }
    // Only trust a match within ~1.2s; re-segmentation shifts starts a little
    // but a far-off match is almost certainly the wrong sentence.
    if (best && bestDelta <= 1200 && best.text) return best;
    return null;
  }

  // Compute an effective end for each (already start-sorted) cue. Handles
  // zero/near-zero-duration cues (extend to the next cue's start, or a floor
  // for the final cue) so they are not treated as a permanent gap.
  function computeCueEnds(list) {
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      let end = c.start + (c.dur > 0 ? c.dur : 0);
      if (c.dur <= 0) {
        if (i + 1 < list.length) end = list[i + 1].start;
        else end = c.start + ZERO_DUR_FLOOR_MS;
        // guard against a non-positive window if the next cue shares the start
        if (end <= c.start) end = c.start + ZERO_DUR_FLOOR_MS;
      }
      c.end = end;
    }
  }

  // ---- sentence groups (gtx smart-sentence mode) ---------------------------
  // Rebuild sentences from (start-sorted, ends-computed) cues. Boundary rules:
  //   1. sentence-final punctuation on the cue (manual tracks; ASR has none)
  //   2. real speech pause > PAUSE_BREAK_MS — measured word-level, from the
  //      LAST WORD of a cue to the start of the next. ASR rolling windows
  //      overlap by seconds, so cue-gap math is useless; lastOff (from
  //      inject.js) is the only honest pause signal.
  //   3. word/char caps, cutting back at the largest pause seen in the group.
  // Manual tracks degrade naturally to one-cue groups via rules 1 and 2
  // (lastOff === start there, so the "pause" spans the whole cue).
  // The live overlay keeps its groups in module state; export needs the same
  // grouping over a DIFFERENT cue array (the complete track fetched for the
  // download), so the algorithm itself is pure and both callers own their result.
  function buildSentenceGroups(list) {
    const built = computeSentenceGroups(list);
    sentGroups = built.groups;
    cueToGroup = built.cueToGroup;
  }

  function computeSentenceGroups(list) {
    const groups = [];
    const toGroup = new Array(list.length);
    const wc = (t2) => t2.split(/\s+/).filter(Boolean).length;
    let s = 0, words = 0, chars = 0, maxPause = -1, maxPauseAt = -1;

    const flush = (endIdx) => {                 // cues [s..endIdx] become a group
      const g = groups.length;
      const parts = [];
      for (let k = s; k <= endIdx; k++) { toGroup[k] = g; parts.push(list[k].text); }
      groups.push({
        startIdx: s, endIdx,
        text: parts.join(" "),
        start: list[s].start, end: list[endIdx].end
      });
      s = endIdx + 1; words = 0; chars = 0; maxPause = -1; maxPauseAt = -1;
    };

    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      words += wc(c.text);
      chars += c.text.length + 1;
      const isLast = i === list.length - 1;
      // clamp: defends against a corrupt lastOff earlier than the cue start
      const anchor = Math.max(c.start, typeof c.lastOff === "number" ? c.lastOff : c.start);
      const pause = isLast ? Infinity : list[i + 1].start - anchor;

      if (isLast || pause > PAUSE_BREAK_MS || SENT_END_RE.test(c.text)) {
        flush(i);
        continue;
      }
      if (pause > maxPause) { maxPause = pause; maxPauseAt = i; }

      const next = list[i + 1];
      if (words + wc(next.text) > MAX_GROUP_WORDS ||
          chars + next.text.length > MAX_GROUP_CHARS) {
        // over cap: cut at the best pause recorded inside this group, then
        // REPLAY from the cut (s advances every flush ⟹ the loop terminates)
        const cut = maxPauseAt >= s ? maxPauseAt : i;
        flush(cut);
        i = cut;
      }
    }
    return { groups, cueToGroup: toGroup };
  }

  function groupKey(gIdx) { return cueVideoId + " g" + gIdx; }

  function clearPendingTimer() {
    if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
  }

  // gtx looks network-dead (blocked endpoint / offline / shields): in auto mode
  // re-request this video with YouTube's own translation so the user still gets
  // a second line. Once per video; a genuine 429/503 never lands here (those
  // are temporary and handled by the background's backoff).
  function maybeFallBackToTlang() {
    if (tlangGated) return;      // the gate outranks this fallback (see injectMode)
    if (gtxFellBack || settings.engine !== "auto") return;
    if (gtxNetFails < GTX_FALLBACK_FAILS) return;
    gtxFellBack = true;
    transCache.clear();
    transInflight.clear();
    clearPendingTimer();
    tcueList = null;
    cueAligned = null;
    cueEpoch++;
    activeGroupIdx = -1;
    if (cueTimer) {
      activeCueIdx = -1;
      setTranslation("", "");
    }
    sendConfig();                    // sendConfig sees gtxFellBack -> mode "tlang"
  }

  // Translate one sentence group, deduped by cache + in-flight set, painting the
  // result iff a cue of that group is still active. The active sentence goes on
  // the background's urgent lane; prefetch rides the normal lane.
  function gtxRequestGroup(gIdx, urgent) {
    if (!sentGroups || gIdx == null || gIdx < 0 || gIdx >= sentGroups.length) return;
    const g = sentGroups[gIdx];
    if (!g.text) return;
    const key = groupKey(gIdx);
    const ik = "g" + gIdx;           // string — never collides with numeric cue idx
    if (transCache.has(key)) return;
    // Aligned mode already answered for this group if its first cue has a line.
    if (transCache.has(cueVideoId + " " + g.startIdx)) return;
    // The active sentence may sit in the rate-limit queue for a while. Show an
    // honest "…" instead of leaving the PREVIOUS sentence next to new original
    // text (a mismatched pair reads as a wrong translation).
    if (urgent) {
      clearPendingTimer();
      const pVid = cueVideoId, pEpoch = cueEpoch;
      pendingTimer = setTimeout(() => {
        pendingTimer = null;
        if (pEpoch !== cueEpoch || pVid !== cueVideoId) return;
        if (activeGroupIdx !== gIdx || activeCueIdx < 0 || !cueList) return;
        if (transCache.has(key)) return;
        if (transCache.has(cueVideoId + " " + activeCueIdx)) return;   // aligned landed
        setTranslation("…", cueList[activeCueIdx].text);
      }, PENDING_ELLIPSIS_MS);
    }
    if (transInflight.has(ik)) return;
    transInflight.add(ik);
    const reqVid = cueVideoId;
    const reqEpoch = cueEpoch;
    // Aligned mode (own-key engines only): ask for one line per cue so the
    // translation line turns over with the original instead of standing still
    // for the whole sentence. A single-cue group is already aligned by
    // definition, so it takes the plain path.
    const nCues = g.endIdx - g.startIdx + 1;
    const wantAligned = settings.engine === "byo" && nCues > 1;
    const request = wantAligned
      ? {
          type: "translateAligned",
          texts: cueList.slice(g.startIdx, g.endIdx + 1).map((c) => c.text),
          targetLang: settings.targetLang,
          urgent: !!urgent
        }
      : { type: "translate", text: g.text, targetLang: settings.targetLang, urgent: !!urgent };
    const sent = extCall(() => chrome.runtime.sendMessage(
      request,
      (resp) => {
        transInflight.delete(ik);
        if (chrome.runtime.lastError) return;       // worker asleep; retried on demand
        if (reqEpoch !== cueEpoch) return;          // loop restarted / re-config
        if (reqVid !== cueVideoId) return;          // navigated away
        // Aligned answer: one line per cue, cached per cue so the normal
        // per-cue render path serves it from here on.
        if (resp && resp.ok && resp.aligned && Array.isArray(resp.values) &&
            resp.values.length === nCues) {
          gtxNetFails = 0;
          for (let k = 0; k < nCues; k++) {
            transCache.set(cueVideoId + " " + (g.startIdx + k), resp.values[k]);
          }
          if (activeGroupIdx === gIdx && activeCueIdx >= g.startIdx &&
              activeCueIdx <= g.endIdx && cueList) {
            const orig = cueList[activeCueIdx].text;
            setTranslation(dedupeTrans(resp.values[activeCueIdx - g.startIdx], orig), orig);
            ttsCatchUp(gIdx);
          }
          return;
        }
        if (resp && resp.ok && resp.translated) {
          gtxNetFails = 0;
          // gtx echoing the whole sentence back (source language == target)
          // must not be painted next to the original: the group text differs
          // from the single cue on the original line, so the per-cue dedupe
          // can't catch it. Cache "" as an echo marker (a real gtx result is
          // never empty here) so the group is not re-requested; paints go
          // through the same-language rendering instead.
          const out = resp.translated.trim() === g.text.trim() ? "" : resp.translated;
          transCache.set(key, out);
          if (activeGroupIdx === gIdx && activeCueIdx >= 0 && cueList) {
            const orig = cueList[activeCueIdx].text;
            setTranslation(out === "" ? sameLangLine(orig) : out, orig);
            ttsCatchUp(gIdx);
          }
          return;
        }
        // failure: leave cache empty — re-requested when next active.
        if (resp && resp.netfail) {
          gtxNetFails++;
          maybeFallBackToTlang();
        } else if (resp && !resp.shed) {
          gtxNetFails = 0;           // a real HTTP answer — the endpoint is reachable
        }
      }
    ));
    if (!sent) transInflight.delete(ik);   // nothing left; do not wait on a reply
  }

  function onCues(data) {
    if (data.videoId && data.videoId !== currentVideoId) return; // stale (videoId)
    if (typeof data.nonce === "number" && data.nonce !== configNonce) return; // stale (nonce)
    nocuesFallback = false;
    stopFallback();                 // cue mode wins; stop scraping
    blankRecoveries = 0;            // recovery worked (or was never needed):
    blankNextAt = 0;                // the paced budget refills on real cues
    // The viewer's rate, before any line has asked for anything: the sampler
    // below runs on the cue tick, and the first line can be sized before the
    // first tick. (Not separately provable in the rig — the tick lands inside
    // the same 250ms, so removing this line stays green. It is kept for the
    // window it closes, not for a test it passes: 采样器根修-方案 §二 bug 2.)
    if (!ttsUserBase) {
      const v0 = getVideo();
      const live0 = v0 && v0.playbackRate;
      if (live0 > 0) ttsUserBase = live0;
    }
    // Why the translation leg is missing, when it is. A 429 feeds the worker's
    // cross-video gate; a track that DID bring its translation clears it.
    cueTlangStatus = Number(data.tlangStatus) || 0;
    if (cueTlangStatus === 429) {
      tlangGated = true;
      tlangGateEra++;
      extCall(() => chrome.runtime.sendMessage({ type: "tlangLimited" }, () => {
        if (chrome.runtime.lastError) { /* worker asleep: the flag still holds here */ }
      }));
    } else if (data.aligned === true && tlangGated) {
      // Lazy on this side too: a healthy aligned track normally has nothing to
      // clear, and reporting anyway would break the zero-worker-calls run the
      // aligned path is pinned to. The one aligned track that arrives while
      // this tab believes the gate holds IS the expiry probe succeeding — that
      // is the moment the worker must hear about.
      tlangGated = false;
      extCall(() => chrome.runtime.sendMessage({ type: "tlangCleared" }, () => {
        if (chrome.runtime.lastError) { /* ignore */ }
      }));
    }

    // cues arrive in json3 EVENT ORDER, with the aligned translation already
    // paired onto each cue as cue.trans (done in inject.js BEFORE any sort).
    // We sort the SINGLE cue array here; because the translation rides on the
    // cue, sorting can never desync orig vs translation.
    cueList = Array.isArray(data.cues) ? data.cues.slice() : [];
    cueList.sort((a, b) => a.start - b.start);
    computeCueEnds(cueList);

    cueAligned = data.aligned;
    // Keep tcueList only for the misaligned timestamp-match fallback. When
    // aligned, cue.trans is authoritative and tcueList is unused.
    tcueList = (cueAligned === false && Array.isArray(data.tcues))
      ? data.tcues.slice().sort((a, b) => a.start - b.start)
      : null;
    cueVideoId = data.videoId || currentVideoId;
    cueTrackKind = data.trackKind === "asr" ? "asr"
                 : data.trackKind ? "manual" : "";
    // Answers computed for a target the reader has since changed away from are
    // not answers. A capture in flight when the language changed carries a
    // sameLang verdict about the OLD target and aligned translations in the OLD
    // language; the popup then says "this video needs no translation" over a
    // target that plainly does (reported on a real machine 2026-09-10, after
    // switching target away and back). The cues themselves are still the source
    // track, so keep them and drop only what was decided for the wrong target —
    // the fresh capture the language change already asked for will replace it.
    const forOurTarget = !data.forLang || data.forLang === settings.targetLang;
    cueSameLang = !!data.sameLang && forOurTarget;
    if (!forOurTarget) {
      cueAligned = null;                       // its trans are in the old language
      tcueList = null;
      for (const c of cueList) if (c) c.trans = "";
      ttsTraceAdd({ k: "stale", why: "lang", was: String(data.forLang || ""),
        now: String(settings.targetLang || "") });
    }

    if (!cueList.length) { onNoCues(data); return; }
    // A different TRACK on the same video (user switched the CC language, or
    // the auto-dub mismatch fix changed tracks) must not read the previous
    // track's cached translations: the group/cue cache keys collide while the
    // text they were translated from is gone. Adopt the id only on a NON-EMPTY
    // cue set (an empty post falls to nocues above and must not swallow the
    // clear that the retry will need); in-flight callbacks from the old track
    // are dropped by the cueEpoch bump in startCueLoop below — this whole
    // function is synchronous, so none can interleave before that.
    if (data.trackId && data.trackId !== cueTrackId) {
      if (cueTrackId) { transCache.clear(); transInflight.clear(); ttsStop(); }
      // The summary panel's source text goes with the track. Only HERE, on a
      // real track change: a page load delivers the same track more than
      // once, and a hand-rolled videoId compare closed the confirm between
      // opening it and pressing start (measured live).
      if (cueTrackId && sumEl) sumClose();
      // Not the guard — the key check in openSummary already makes a summary
      // of the old track unreachable (its track no longer matches). This is
      // so the text of a track nobody is watching stops being held in memory.
      // Mutation-tested: removing it keeps every assertion green, which is
      // exactly what "redundant on purpose" looks like.
      if (cueTrackId) sumForget();
      cueTrackId = data.trackId;
      paintLineLangs();          // a new track can be a new language
    }
    // Track-level echo detection: an aligned "translation" that repeats the
    // original on every cue means the track already speaks the target language
    // in a way the URL lang check could not prove (e.g. a bare "zh" track whose
    // script happens to match a zh-Hans target — we must REQUEST the tlang
    // because it might have been a Hans<->Hant conversion, but when it comes
    // back as a pure echo, render it as the same-language case).
    if (!cueSameLang && cueAligned === true &&
        cueList.some((c) => c.trans) &&
        cueList.every((c) => !c.trans || c.trans.trim() === (c.text || "").trim())) {
      cueSameLang = true;
    }
    // Sentence groups exist ONLY when there is no tlang data at all (gtx engine,
    // auto on an ASR track, or a failed tlang fetch). aligned true/false means
    // the tlang paths render — groups stay dormant (null). A same-language
    // track never translates at all, so it never needs groups either.
    if (cueAligned == null && !cueSameLang) buildSentenceGroups(cueList);
    else { sentGroups = null; cueToGroup = null; }
    // The voice's own grouping, for the case above: YouTube's translation on a
    // scrolling ASR track. Same sentence detection, different consumer — only
    // the read-aloud path ever looks at it.
    if (cueAligned != null && !cueSameLang && cueTrackKind === "asr") {
      const built = computeSentenceGroups(cueList);
      speechSpans = built.groups;
      cueToSpan = built.cueToGroup;
    } else { speechSpans = null; cueToSpan = null; }
    startCueLoop();
  }

  // =========================================================================
  // FALLBACK MODE (v1 rendered-scrape)
  // =========================================================================
  function scheduleTranslate(text) {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      if (text !== lastSource) return;        // caption already moved on
      if (text === lastTransSource) return;   // identical text already shown
      const token = ++lastReqToken;
      extCall(() => chrome.runtime.sendMessage(
        { type: "translate", text, targetLang: settings.targetLang },
        (resp) => {
          if (chrome.runtime.lastError) return;
          if (token !== lastReqToken) return;
          if (text !== lastSource) return;
          if (resp && resp.ok && resp.translated) {
            // scrape mode never knows the track language, so the identical-
            // output dedupe is the only same-language guard on this path
            setTranslation(dedupeTrans(resp.translated, text), text);
          }
        }
      ));
    }, DEBOUNCE_MS);
  }

  function fallbackTick() {
    if (!settings.enabled) return;
    const text = readNativeCaption();
    fallbackPace(!!text);
    if (text === lastSource) return;
    lastSource = text;

    if (!text) {
      if (debounceTimer) clearTimeout(debounceTimer);
      setOriginal("");
      setTranslation("", "");
      return;
    }

    setOriginal(text);
    scheduleTranslate(text);
  }

  // The on-screen scrape runs five times a second so a caption that appears is
  // picked up in the same breath. On a video that has NO caption track it finds
  // nothing, every tick, until the reader moves on — a querySelectorAll five
  // times a second for the length of a film, for an answer that is not coming.
  // So it backs off: after a sustained empty stretch it drops to one look a
  // second, and snaps straight back the moment there is text (the reader
  // turning CC on mid-video is exactly that moment). Backing off rather than
  // stopping is deliberate — stopping needs something to restart it, and the
  // thing that would have to notice is this loop.
  const FALLBACK_FAST_MS = 200;
  const FALLBACK_SLOW_MS = 1000;
  const FALLBACK_EMPTY_BEFORE_SLOW = 75;      // 15s of nothing at the fast rate
  let fallbackEmptyRun = 0;
  let fallbackEveryMs = FALLBACK_FAST_MS;
  function fallbackPace(hasText) {
    if (hasText) {
      fallbackEmptyRun = 0;
      if (fallbackEveryMs !== FALLBACK_FAST_MS && pollTimer) {
        fallbackEveryMs = FALLBACK_FAST_MS;
        clearInterval(pollTimer);
        pollTimer = setInterval(fallbackTick, fallbackEveryMs);
      }
      return;
    }
    if (fallbackEveryMs !== FALLBACK_FAST_MS) return;        // already slow
    if (++fallbackEmptyRun < FALLBACK_EMPTY_BEFORE_SLOW) return;
    if (!pollTimer) return;
    fallbackEveryMs = FALLBACK_SLOW_MS;
    clearInterval(pollTimer);
    pollTimer = setInterval(fallbackTick, fallbackEveryMs);
  }

  function startFallback() {
    if (pollTimer) return;
    ensureOverlay();
    fallbackEmptyRun = 0;
    fallbackEveryMs = FALLBACK_FAST_MS;
    pollTimer = setInterval(fallbackTick, fallbackEveryMs);
  }

  function stopFallback() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    fallbackEmptyRun = 0;
    fallbackEveryMs = FALLBACK_FAST_MS;
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    lastSource = "";
    lastTransSource = "";
  }

  function onNoCues(data) {
    if (data && data.videoId && data.videoId !== currentVideoId) return;
    if (data && typeof data.nonce === "number" && data.nonce !== configNonce) return;
    // inject.js only posts nocues after 6s with NO timedtext URL captured at
    // all. On a healthy player that never happens — it always fetches a track —
    // so this is the precise signature of the restored-tab case, and a much
    // better trigger than any wall-clock guess: a slow video still gets its
    // capture and posts cues instead. One shot per video; if CC was not already
    // pressed there is nothing to re-arm and we fall through as before.
    if (!rearmedForVideo && rearmCaptions()) {
      rearmedForVideo = true;
      return;                       // wait for the capture the toggle forces
    }
    nocuesFallback = true;
    stopCueLoop();
    cueList = null;
    tcueList = null;
    sentGroups = null;
    cueToGroup = null;
    speechSpans = null;
    cueToSpan = null;
    activeGroupIdx = -1;
    cueTrackKind = "";
    cueSameLang = false;
    clearPendingTimer();
    if (settings.enabled) startFallback();
  }

  // =========================================================================
  // EXPORT (SRT download)
  // =========================================================================
  // Triggered from the popup via chrome.tabs.sendMessage. We build an .srt from
  // the cue data and download it via a Blob + <a download> (no extra permission).

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg) return;
    // popup's "try dragging" button: point at the grip for people who already
    // used up their first-run hints.
    if (msg.type === "flashHandle") {
      sendResponse({ ok: flashHandle(3600) });
      return;                                               // sync reply
    }
    // The popup's "summarize this video" button. It opens the SAME panel the
    // player menu's Summary row opens — deliberately not a second entry point
    // with its own idea of when summarising is possible: openSummary already
    // asks the worker what is configured and draws "you need your own service"
    // or the spend confirmation itself. Duplicating that predicate in the popup
    // is how a card ends up promising what the engine will not do.
    if (msg.type === "openSummary") {
      openSummary();
      sendResponse({ ok: true });
      return;                                               // sync reply
    }
    if (msg.type === "engineStatus") {
      // popup status line: which engine is ACTUALLY rendering this video (the
      // resolved outcome, not the setting — tlang can fail into gtx and auto
      // can fall back the other way).
      // The client-side path is shared by gtx and BYO, so which of the two is
      // rendering comes from the setting, not from the cue data.
      let engine = "";
      if (cueList && cueList.length) {
        if (cueAligned != null) engine = "tlang";
        else engine = settings.engine === "byo" ? "byo" : "gtx";
      }
      sendResponse({
        ok: true,
        engine,
        provider: settings.engine === "byo" ? settings.byoProvider : "",
        same: !!(cueList && cueList.length && cueSameLang),
        track: cueTrackKind || "none",
        // Whether this page has a player at all. The popup shows its summary
        // button only here: on the home page or search results the panel has
        // nowhere to open, and a button that does nothing is worse than none.
        video: !!getPlayer(),
        // inject.js gave up waiting for a track (6 s, nothing captured, and
        // re-pressing CC did not help) and the on-screen fallback has found
        // no caption text either: the commonest support question, "no
        // subtitles at all", answered on the status line instead of by silence.
        noTrack: !!nocuesFallback && !lastSource && !(cueList && cueList.length),
        // The language of the original line, as the caption track declares it
        // (the same value the overlay's lang attribute carries). The popup's
        // font picker uses it to say which fonts cannot draw this line.
        lang: trackLang(),
        fellBack: gtxFellBack,
        // "gtx because YouTube's own translation is rate-limited" — either
        // this track's own 429, or the cross-video gate steering new videos
        // clear. The popup says so instead of a bare "smart sentences".
        tlangLimited: cueTlangStatus === 429 || tlangGated,
        // The caption track is missing and the paced recovery (recoverIfBlank)
        // is working on it. The popup says so instead of standing silent over
        // a frozen overlay — the 2026-08-31 freeze was invisible end to end.
        trackWait: blankRecoveries > 0 && (!cueList || !cueList.length),
        // Read-aloud, for the popup's status line: is a line sounding right
        // now, and how this video went so far (skips answer "why the gaps").
        tts: settings.ttsEnabled ? {
          speaking: !!(ttsAudio && !ttsAudio.paused && !ttsAudio.ended) || !!localUtter,
          spoken: ttsSpoken,
          skipped: ttsSkipped,
          // The commonest reason those lines were skipped, so the status line
          // can say it instead of leaving a bare count to be read as a fault.
          skipWhy: (() => {
            let top = "", n = 0;
            for (const k of Object.keys(ttsSkipWhy)) {
              if (ttsSkipWhy[k] > n) { n = ttsSkipWhy[k]; top = k; }
            }
            return top;
          })(),
          // Nothing spoken at all is a configuration that cannot work, and
          // that needs words at the first failure. After a line has worked,
          // one bad line is a hiccup the counts already cover — but a second
          // in a row is the provider having stopped working mid-video, and
          // staying quiet about that reads as "no error, so no problem".
          err: (!ttsSpoken || ttsFailRun >= TTS_FAIL_RUN_LOUD) ? ttsErr : "",
          // The takeover trace (see ttsTraceAdd): which line was cut, by how
          // much, and what the sizing believed at the time. Cue indexes and
          // numbers only — reading a cut-tails report off a live video.
          cru: ttsCruising,
          uRate: ttsUserBase,
          asked: ttsAsked,
          debt: Math.round(ttsDebtMs),
          over: ttsOverran,
          jumps: ttsJumpCuts,
          trace: ttsTrace.slice(-30)
        } : null,
        // For the popup's diagnostic bundle. The popup cannot read tab.url
        // (no tabs/host permission — a deliberate non-permission, see the SRT
        // export notes), so the page names itself. Query params beyond v are
        // dropped: the video id is the diagnosis, playlists are not.
        href: location.origin + location.pathname +
          (new URLSearchParams(location.search).get("v")
            ? "?v=" + new URLSearchParams(location.search).get("v") : "")
      });
      return;                                               // sync reply
    }
    // What an own-key download would cost, so the popup can say it out loud
    // before spending anything.
    if (msg.type === "exportPlan") {
      planByoExport()
        .then(sendResponse)
        .catch(() => sendResponse({ ok: false, reason: "nocues" }));
      return true;                                          // async reply
    }
    // Polled by the popup while a download runs — and once when it opens, so a
    // popup that was closed mid-download re-attaches to the one in progress
    // instead of offering to start a second.
    if (msg.type === "exportStatus") {
      sendResponse({
        ok: true,
        running: !!exportRun,
        done: exportRun ? exportRun.done : 0,
        total: exportRun ? exportRun.total : 0,
        waitUntil: exportRun ? (exportRun.waitUntil || 0) : 0,
        result: exportRun ? null : exportLast
      });
      return;                                               // sync reply
    }
    if (msg.type === "exportCancel") {
      // The request already in flight cannot be recalled, but no further chunk
      // is sent and nothing is downloaded.
      if (exportRun) exportRun.cancel = true;
      sendResponse({ ok: true });
      return;                                               // sync reply
    }
    if (msg.type !== "exportSrt") return;                   // not ours — ignore
    handleExport(msg.variant, msg.byo)
      .then(sendResponse)
      .catch(() => sendResponse({ ok: false, reason: "nocues" }));
    return true;                                            // async reply
  });

  // Ask inject.js for a COMPLETE bilingual cue set. inject reuses the captured
  // pot-bearing URL to fetch the whole-track translation, so the download is
  // complete even when the live overlay runs in gtx mode. Resolves with the
  // inject reply, or { ok:false } on timeout.
  function requestExportData(targetLang) {
    return new Promise((resolve) => {
      const exportId = ++exportSeq;
      const timer = setTimeout(() => {
        exportWaiters.delete(exportId);
        resolve({ ok: false });
      }, 9000);
      exportWaiters.set(exportId, { resolve, timer });
      try {
        window.postMessage(
          { source: "ytds-content", type: "export-request", targetLang, exportId },
          "*"
        );
      } catch (_e) {
        clearTimeout(timer);
        exportWaiters.delete(exportId);
        resolve({ ok: false });
      }
    });
  }

  function resolveExportData(d) {
    const w = exportWaiters.get(d.exportId);
    if (!w) return;
    clearTimeout(w.timer);
    exportWaiters.delete(d.exportId);
    w.resolve(d);
  }

  // ms -> "HH:MM:SS,mmm"
  function srtTime(ms) {
    let n = Math.round(Number(ms));
    if (!isFinite(n) || n < 0) n = 0;
    const h = Math.floor(n / 3600000);
    const m = Math.floor((n % 3600000) / 60000);
    const s = Math.floor((n % 60000) / 1000);
    const ms3 = n % 1000;
    const p = (v, w) => String(v).padStart(w, "0");
    return p(h, 2) + ":" + p(m, 2) + ":" + p(s, 2) + "," + p(ms3, 3);
  }

  // A file is one translated line per cue — that is what both lanes write and
  // what a player expects. So the stranded mark (see isStrandedMark) has no
  // line of its own to be: give it back to the sentence it closes and leave
  // this cue its original text alone, rather than writing an entry whose whole
  // translation is "。". Deliberately NOT done here: painting the sentence
  // across a scrolling track's fragments the way the overlay does. The overlay
  // is a live reading aid and can hold a line still; the own-key lane writes
  // one line per cue, and a file where three consecutive entries repeat the
  // same sentence would not match it.
  function exportTrans(cues) {
    const out = cues.map((c) => Object.assign({}, c));
    for (let i = 0; i < out.length; i++) {
      const tr = (out[i].trans || "").trim();
      if (!isStrandedMark(tr, out[i].text)) continue;
      const prev = i > 0 ? out[i - 1] : null;
      if (prev && (prev.trans || "").trim()) prev.trans = (prev.trans || "").trim() + tr;
      out[i].trans = "";
    }
    return out;
  }

  // Build SRT text from start-sorted cues (ends computed). Returns {text,count}.
  // "orig" | "trans" | "bi"; bilingual line order follows the user's order pref.
  function buildSrt(cues, variant) {
    if (variant !== "orig") cues = exportTrans(cues);
    const out = [];
    let n = 0;
    for (let i = 0; i < cues.length; i++) {
      const c = cues[i];
      let body;
      if (variant === "orig") {
        body = (c.text || "").trim();
      } else if (variant === "trans") {
        body = (c.trans || "").trim();
      } else {
        const o = (c.text || "").trim();
        const tr = (c.trans || "").trim();
        if (tr && tr === o) {
          body = o;               // same-language echo — don't write the line twice
        } else {
          const top = settings.order === "trans-top" ? tr : o;
          const bottom = settings.order === "trans-top" ? o : tr;
          body = [top, bottom].filter(Boolean).join("\n");
        }
      }
      if (!body) continue;
      n++;
      let end = (c.end != null)
        ? c.end
        : c.start + (c.dur > 0 ? c.dur : ZERO_DUR_FLOOR_MS);
      // Trim overlap: auto-generated (ASR) tracks use rolling cues whose windows
      // overlap the next one, so a strict player would show two lines at once.
      // Clamp each end to the next cue's start. Manual tracks don't overlap, so
      // this leaves them untouched. (cues is start-sorted; the next array item is
      // the right boundary even if it was skipped above for an empty body.)
      const next = cues[i + 1];
      if (next && next.start > c.start && end > next.start) end = next.start;
      out.push(String(n), srtTime(c.start) + " --> " + srtTime(end), body, "");
    }
    return { text: out.join("\n"), count: n };
  }

  function videoTitle() {
    const el = document.querySelector(
      "h1.ytd-watch-metadata yt-formatted-string, h1.title yt-formatted-string"
    );
    if (el && el.textContent.trim()) return el.textContent.trim();
    return (document.title || "").replace(/\s*-\s*YouTube\s*$/i, "").trim();
  }

  function srtFilename(variant) {
    const vid = cueVideoId || currentVideoId || "";
    let title = videoTitle() || vid || "youtube";
    title = title.replace(/[\\/:*?"<>|\n\r\t]+/g, "_").replace(/\s+/g, " ").trim().slice(0, 80);
    const tag = variant === "orig" ? "orig"
              : variant === "trans" ? settings.targetLang
              : settings.targetLang + "+orig";
    return title + (vid ? " [" + vid + "]" : "") + "." + tag + ".srt";
  }

  function triggerDownload(text, filename) {
    try {
      // Prepend a BOM so editors/players detect UTF-8 (matters for CJK text).
      const blob = new Blob(["\ufeff" + text], { type: "application/x-subrip;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { try { URL.revokeObjectURL(url); a.remove(); } catch (_e) { /* ignore */ } }, 2000);
      return true;
    } catch (_e) {
      return false;
    }
  }

  // When orig/tlang counts differ, fill each cue's translation by nearest
  // timestamp (same tolerance as the live misaligned path).
  function fillTransByTimestamp(cues, tcues) {
    if (!tcues || !tcues.length) return;
    for (const c of cues) {
      let best = null, bd = Infinity;
      for (const tc of tcues) {
        const d = Math.abs(tc.start - c.start);
        if (d < bd) { bd = d; best = tc; }
      }
      if (best && bd <= 1200 && best.text) c.trans = best.text;
    }
  }

  // =========================================================================
  // EXPORT WITH THE OWN-KEY ENGINE
  // =========================================================================
  // Playback only ever sends the sentences actually watched. A download is the
  // opposite: the whole track, at once, on the user's own key — so it is opt-in
  // per download, it says what it will cost before it starts, and it can be
  // stopped. YouTube's whole-track translation is fetched first regardless and
  // kept underneath as the fallback layer: a chunk the provider fails on leaves
  // those cues with YouTube's line instead of a hole.
  // Measured against real models on a real 20-minute ASR track (see
  // tests/export-live.js): line fidelity, not context length, is what breaks
  // first. qwen-flash — one of the recommended presets — returns 32/35 and
  // 40/50 labels but is clean at 24; deepseek-v4-flash holds 35 and slips at
  // 50. It is a size wall, not a protocol one: the same models fail the same
  // way with the live flat numbering. So the cap is set below the weakest
  // verified preset rather than at the biggest request that fits, because a
  // dropped line costs a halving cascade (one 50-line chunk cost qwen-flash 17
  // requests and 35s) and every unverified provider is assumed no better.
  const EXPORT_MAX_LINES = 25;    // cues per request
  const EXPORT_MAX_CHARS = 4000;  // second cap: source characters per request
                                  // (only binds on tracks with very long cues)

  let exportRun = null;           // { total, done, cancel } while one is running
  let exportLast = null;          // last finished result, for a re-opened popup
  let exportPlan = null;          // { videoId, targetLang, cues, chunks, lines }

  // Translations already paid for during playback, keyed by start+text so they
  // survive the re-fetch of the track (the export cue array is a fresh parse).
  // transCache is cleared whenever the provider or model changes, so anything
  // still in it came from the engine now selected.
  function watchedTranslations() {
    const m = new Map();
    if (!cueList || !cueList.length) return m;
    const put = (c, v) => { if (c && v) m.set(c.start + "|" + c.text, v); };
    for (let i = 0; i < cueList.length; i++) {
      put(cueList[i], transCache.get(cueVideoId + " " + i));       // aligned mode
    }
    if (sentGroups) {
      for (let g = 0; g < sentGroups.length; g++) {
        // A one-cue sentence is cached under the group key and is, by
        // definition, already a per-cue translation.
        const grp = sentGroups[g];
        if (grp.startIdx === grp.endIdx) put(cueList[grp.startIdx], transCache.get(groupKey(g)));
      }
    }
    return m;
  }

  // Split the track into requests. A sentence is never split across two
  // requests, and a sentence whose cues are ALL already translated is dropped
  // entirely; a partly-translated one is re-sent whole, because a sentence with
  // a hole in it translates worse than it saves.
  function buildExportChunks(cues) {
    const built = computeSentenceGroups(cues);
    const known = watchedTranslations();
    const chunks = [];
    let cur = [], lines = 0, chars = 0;

    for (const g of built.groups) {
      const idxs = [];
      let allKnown = true;
      for (let i = g.startIdx; i <= g.endIdx; i++) {
        const hit = known.get(cues[i].start + "|" + cues[i].text);
        if (hit) cues[i].trans = hit; else allKnown = false;
        idxs.push(i);
      }
      if (allKnown) continue;
      const over = cur.length &&
        (lines + idxs.length > EXPORT_MAX_LINES ||
         chars + g.text.length > EXPORT_MAX_CHARS);
      if (over) { chunks.push(cur); cur = []; lines = 0; chars = 0; }
      cur.push(idxs);
      lines += idxs.length;
      chars += g.text.length;
    }
    if (cur.length) chunks.push(cur);
    return chunks;
  }

  // Fetch the complete track (original + YouTube's translation as the fallback
  // layer) and work out what the download would cost. Cached for the confirm
  // step that follows, so the track is fetched once per download, not twice.
  async function planByoExport() {
    if (settings.engine !== "byo") return { ok: false, reason: "notbyo" };
    if (cueSameLang) return { ok: false, reason: "same" };
    const cues = await exportCues();
    if (!cues || !cues.length) return { ok: false, reason: "nocues" };
    const chunks = buildExportChunks(cues);
    const lines = chunks.reduce((n, c) => n + c.reduce((k, g) => k + g.length, 0), 0);
    exportPlan = {
      videoId: cueVideoId || currentVideoId,
      targetLang: settings.targetLang,
      cues, chunks, lines
    };
    return { ok: true, cues: cues.length, lines, requests: chunks.length };
  }

  function planIsFresh() {
    return !!exportPlan &&
      exportPlan.videoId === (cueVideoId || currentVideoId) &&
      exportPlan.targetLang === settings.targetLang;
  }

  function sendExportChunk(groups) {
    return new Promise((resolve) => {
      const sent = extCall(() => chrome.runtime.sendMessage(
        { type: "exportTranslate", groups, targetLang: settings.targetLang },
        (resp) => {
          if (chrome.runtime.lastError) { resolve({ ok: false, code: "worker" }); return; }
          resolve(resp || { ok: false, code: "worker" });
        }
      ));
      if (!sent) resolve({ ok: false, code: "worker" });
    });
  }

  // Codes worth stopping the whole download for: every remaining chunk would
  // fail the same way, so asking the provider 30 more times is pure noise.
  // Anything that the next chunk cannot possibly do better. "quota" and
  // "forbidden" were missing: a wallet that is empty on chunk one is empty on
  // chunk thirty, and an account that may not call this model never may. So
  // was "badRequest" — one typo in a model name used to spend the whole track.
  const EXPORT_FATAL = new Set(["auth", "forbidden", "noKey", "noPerm", "noProvider",
                                "noModel", "quota", "badRequest",
                                "badBaseUrl", "unsupportedTarget"]);

  async function runByoExport(variant) {
    if (!planIsFresh()) {
      const p = await planByoExport();
      if (!p.ok) return { ok: false, reason: p.reason || "nocues" };
    }
    const plan = exportPlan;
    const cues = plan.cues;
    const run = { total: plan.chunks.length, done: 0, cancel: false, waitUntil: 0 };
    exportRun = run;
    exportLast = null;

    let failed = 0, code = "";
    try {
      // The own-key lane keeps a rate-limit gate of its own (429s from the
      // provider). Firing thirty chunks into a shut door spends thirty tries to
      // learn what the worker already knows, and the popup meanwhile shows a
      // progress line that never moves — which reads as a hang. Wait it out
      // once, with the countdown the whole-track path already shows, and let
      // the stop button through. D88 left this half open because the rig could
      // not reach session storage; it can now.
      const askByoGate = () => new Promise((resolve) => {
        const sent = extCall(() => chrome.runtime.sendMessage({ type: "byoGate" },
          (resp) => resolve(chrome.runtime.lastError ? null : resp)));
        if (!sent) resolve(null);
      });
      const gate = await askByoGate();
      if (gate && gate.ok && gate.gated && gate.gateUntil > Date.now()) {
        let until = gate.gateUntil;
        let ticks = 0;
        run.waitUntil = until;
        // …and ask again every couple of seconds rather than sitting out the
        // first answer. That lane also carries the live translation of the
        // video, and its backoff is cleared by the first request that gets
        // through — so the door can open long before the number we were given,
        // and waiting out a stale number is waiting for nothing. `exportRun`
        // in the condition is the other half: a second download replaces this
        // run, and the one left behind must not wake up and start sending.
        while (Date.now() < until && !run.cancel && exportRun === run) {
          await new Promise((r) => setTimeout(r, 500));
          if (++ticks % 4) continue;
          const again = await askByoGate();
          if (!again || !again.ok) continue;      // asleep: keep the old number
          until = (again.gated && again.gateUntil > Date.now()) ? again.gateUntil : 0;
          run.waitUntil = until;
        }
        run.waitUntil = 0;
        if (run.cancel || exportRun !== run) {
          return finishExport({ ok: false, reason: "cancelled" });
        }
      }
      for (const chunk of plan.chunks) {
        // Replaced as well as cancelled: a run that is no longer the current
        // one has nobody waiting for its file, and every chunk it still sends
        // spends the reader's quota on a download they abandoned.
        if (run.cancel || exportRun !== run) {
          return finishExport({ ok: false, reason: "cancelled" });
        }
        const groups = chunk.map((idxs) => idxs.map((i) => cues[i].text));
        const resp = await sendExportChunk(groups);
        if (resp && resp.ok && Array.isArray(resp.values) && resp.values.length === chunk.length) {
          for (let g = 0; g < chunk.length; g++) {
            const row = resp.values[g] || [];
            chunk[g].forEach((i, k) => { if (row[k]) cues[i].trans = row[k]; });
          }
        } else {
          failed++;
          code = (resp && resp.code) || "failed";
          // Falling back to YouTube's line for one chunk is a degraded file;
          // carrying on past a key/permission problem is 30 doomed requests.
          if (EXPORT_FATAL.has(code)) {
            return finishExport({ ok: false, reason: "byofail", code });
          }
        }
        run.done++;
      }
    } finally {
      if (exportRun === run) exportRun = null;
    }

    // Stop pressed while the last chunk was in flight: that request cannot be
    // recalled, but handing over the file anyway would ignore the button. The
    // loop's own check only covers a stop between chunks.
    if (run.cancel) return finishExport({ ok: false, reason: "cancelled" });

    // Every chunk failed and nothing was translated earlier: the download would
    // be YouTube's translation under a label that promises the user's engine.
    if (failed && failed === plan.chunks.length && !cues.some((c) => c.trans)) {
      return finishExport({ ok: false, reason: "byofail", code: code || "failed" });
    }
    if (!cues.some((c) => c.trans)) return finishExport({ ok: false, reason: "notrans" });

    const v = variant === "trans" ? "trans" : "bi";
    const built = buildSrt(cues, v);
    if (!built.count) return finishExport({ ok: false, reason: "notrans" });
    exportPlan = null;               // consumed: the next download re-plans
    return finishExport(
      triggerDownload(built.text, srtFilename(v))
        ? { ok: true, count: built.count, variant: v, byo: true, failedChunks: failed, code }
        : { ok: false, reason: "notrans" }
    );
  }

  function finishExport(result) {
    exportRun = null;
    exportLast = Object.assign({ ts: Date.now() }, result);
    return result;
  }

  // The complete track, translation included where YouTube has one. Shared by
  // both export paths.
  // Set when the last exportCues() could not get YouTube's translation because
  // the endpoint was rate limiting us — the difference between "this video has
  // no translation" and "come back in a minute".
  let exportTransLimited = false;

  async function exportCues() {
    const data = await requestExportData(settings.targetLang);
    exportTransLimited = !!(data && data.transStatus === 429);
    // The export leg is allowed through the gate (someone is waiting for a
    // file), but what it LEARNS belongs to the gate like every other 429:
    // dropping this report was pure information loss — the next videos would
    // knock on a door the export had just found shut.
    if (exportTransLimited) {
      tlangGated = true;
      tlangGateEra++;
      extCall(() => chrome.runtime.sendMessage({ type: "tlangLimited" }, () => {
        if (chrome.runtime.lastError) { /* worker asleep: the flag still holds */ }
      }));
    }
    if (data && data.ok && Array.isArray(data.cues) && data.cues.length) {
      const cues = data.cues.slice().sort((a, b) => a.start - b.start);
      computeCueEnds(cues);
      if (data.aligned === false && Array.isArray(data.tcues)) {
        fillTransByTimestamp(cues, data.tcues.slice().sort((a, b) => a.start - b.start));
      }
      return cues;
    }
    return (cueList && cueList.length) ? cueList : null;
  }

  // Main export entry. Returns a serializable result for the popup:
  //   { ok:true, count, variant } | { ok:false, reason:"nocues"|"notrans" }
  async function handleExport(variant, useByo) {
    const v = (variant === "orig" || variant === "trans") ? variant : "bi";

    // ORIGINAL: the live cue list already holds the full original track.
    if (v === "orig") {
      if (!cueList || !cueList.length) return { ok: false, reason: "nocues" };
      const built = buildSrt(cueList, "orig");
      if (!built.count) return { ok: false, reason: "nocues" };
      return triggerDownload(built.text, srtFilename("orig"))
        ? { ok: true, count: built.count, variant: "orig" }
        : { ok: false, reason: "nocues" };
    }

    // OWN-KEY ENGINE: opt-in per download (the popup has already shown the
    // estimate and taken a confirmation), and pointless on a same-language
    // track — there is nothing to translate.
    if (useByo && settings.engine === "byo" && !cueSameLang) {
      return runByoExport(v);
    }

    // TRANSLATION / BILINGUAL.
    let cues = null;
    // Same-language track: the "translation" IS the original text. Export
    // offline from the live cue list (bilingual collapses to single lines in
    // buildSrt) instead of re-fetching a tlang echo that produceCues skipped.
    if (cueSameLang && cueList && cueList.length) {
      cues = cueList.map((c) => ({ ...c, trans: c.text }));
    }
    // Fast path: the live overlay already has a fully-aligned tlang translation.
    else if (cueAligned === true && cueList && cueList.length && cueList.some((c) => c.trans)) {
      cues = cueList;
    } else {
      // The whole-track fetch can sit behind YouTube's rate-limit gate for
      // minutes. This path now runs under a run object of its own — the popup
      // polls it for a countdown (waitUntil) and its stop button flips the
      // same cancel — and it WAITS the gate out instead of burning its tries
      // on a door the worker already knows is shut (the half of D83 that
      // stayed open). One fresh 429 buys one wait-and-retry; a second refusal
      // falls through to the ordinary "limited" answer instead of looping.
      const run = { total: 0, done: 0, cancel: false, waitUntil: 0 };
      exportRun = run;
      try {
        const queryGate = () => new Promise((resolve) => {
          const sent = extCall(() => chrome.runtime.sendMessage({ type: "tlangGate" },
            (resp) => resolve(chrome.runtime.lastError ? null : resp)));
          if (!sent) resolve(null);
        });
        const waitOut = async (until) => {
          run.waitUntil = until;
          // exportRun === run: same reason as the own-key path — a second
          // download replaces this one, and the run left waiting must not come
          // back to life when its number is up.
          while (Date.now() < until && !run.cancel && exportRun === run) {
            await new Promise((r) => setTimeout(r, 500));
          }
          run.waitUntil = 0;
          return !run.cancel && exportRun === run;
        };
        const g = await queryGate();
        if (g && g.gated && g.gateUntil > Date.now()) {
          if (!(await waitOut(g.gateUntil))) return { ok: false, reason: "cancelled" };
        }
        cues = await exportCues();
        if (run.cancel) return { ok: false, reason: "cancelled" };
        // Only when the gate ANSWERS: a silent worker means no countdown to
        // show and no honest length to wait, so the old immediate "limited"
        // stands rather than a blind half-minute.
        if (exportTransLimited && (!cues || !cues.some((c) => c.trans))) {
          const g2 = await queryGate();
          if (g2 && g2.ok) {
            const until = g2.gated && g2.gateUntil > Date.now()
              ? g2.gateUntil : Date.now() + 5000;
            if (!(await waitOut(until))) return { ok: false, reason: "cancelled" };
            cues = await exportCues();
          }
        }
      } finally {
        if (exportRun === run) exportRun = null;
      }
    }

    if (!cues || !cues.length) return { ok: false, reason: "nocues" };
    if (!cues.some((c) => c.trans)) {
      return { ok: false, reason: exportTransLimited ? "limited" : "notrans" };
    }

    const built = buildSrt(cues, v);
    if (!built.count) return { ok: false, reason: "notrans" };
    return triggerDownload(built.text, srtFilename(v))
      ? { ok: true, count: built.count, variant: v }
      : { ok: false, reason: "notrans" };
  }

  // ---- one-shot in-player notice (auto-dub caption mismatch) ---------------
  // inject.js posts "trackwarn" when a video's caption list holds only the ASR
  // of AI-dubbed audio tracks with no original-language track to switch to —
  // the overlay would pair a dub's captions with the original audio. Shown at
  // most once per video, auto-fades, never intercepts clicks.
  let warnedForVid = "";

  function showTrackWarn() {
    if (!settings.enabled || warnedForVid === currentVideoId) return;
    warnedForVid = currentVideoId;
    const player = getPlayer();
    if (!player) return;
    const el = document.createElement("div");
    el.className = "ytds-toast";
    el.setAttribute("role", "status");
    el.textContent = t("trackWarnDubOnly",
      "提示：此视频只有 AI 配音的自动字幕，没有原声语言的字幕轨，双语字幕可能和声音对不上。");
    player.appendChild(el);
    requestAnimationFrame(() => el.classList.add("ytds-toast-show"));
    setTimeout(() => {
      el.classList.remove("ytds-toast-show");
      setTimeout(() => { try { el.remove(); } catch (_e) { /* ignore */ } }, 400);
    }, 9000);
  }

  // =========================================================================
  // BRIDGE <- inject.js
  // =========================================================================
  function onInjectMessage(evt) {
    // Late cues from inject.js would restart the whole cue loop — a 120ms timer
    // ticking forever in a tab whose extension is gone.
    if (orphaned) return;
    if (evt.source !== window) return;
    const d = evt.data;
    if (!d || d.source !== "ytds-inject") return;
    // Export replies are handled even when the overlay is disabled (they are a
    // direct response to a user-initiated download, not the live cue stream).
    if (d.type === "exportdata") { resolveExportData(d); return; }
    if (!settings.enabled) return;

    if (d.type === "ttsrate") {
      // Who owns the rate, from the only side that can tell. A report arrives
      // on every duck and every release — which is every line boundary — so a
      // viewer who reaches for the speed menu is noticed within one line even
      // in a dense stretch, where the old element-sampling was shut for the
      // whole passage because every line carried a fit.
      const base = Number(d.base) || 0;
      // …unless an advert is playing: its own rate (usually 1.0) is not the
      // reader's chosen speed, and the first line after the ad would be paced
      // from it. cueTick's sampler already skips adverts; this path did not.
      if (base > 0 && !isAdShowing()) ttsUserBase = base;
      ttsHeld = Number(d.applied) || 0;
      return;
    }
    if (d.type === "cues") onCues(d);
    else if (d.type === "nocues") onNoCues(d);
    else if (d.type === "trackwarn") {
      if (!d.videoId || d.videoId === currentVideoId) showTrackWarn();
    }
  }

  // Fold our engine setting into the 3-value protocol inject.js speaks.
  function injectMode() {
    if (settings.engine === "byo") return "gtx";        // "give me the original"
    // The rate-limit gate outranks the gtx->tlang fallback: three dead gtx
    // calls used to kick auto back onto tlang, straight into the very 429 the
    // gate exists to stop repeating. Explicit "tlang" chosen by hand is NOT
    // gated — the user named it, it knocks once per video, and a refusal
    // inside the window does not double it.
    if (settings.engine === "auto" && tlangGated) return "gtx";
    if (settings.engine === "auto" && gtxFellBack) return "tlang";
    return settings.engine;
  }

  // Ask the worker whether the gate still holds — LAZILY. A tab that has
  // never seen a 429 does not ask: the aligned-track path can play a whole
  // video without one worker call, and that silence is a pinned invariant
  // (the "silent" reload scenarios). The cost is one knock per fresh tab
  // while a gate holds elsewhere — which is exactly the probe the gate's
  // own expiry schedule allows, and the worker refuses to double inside the
  // window however many tabs knock. Expiry never flips the CURRENT video
  // back (the same no-mid-video rule as everywhere else): the answer only
  // steers the next sendConfig.
  let tlangGateEra = 0;          // a fresh 429 outranks any answer already in flight
  function refreshTlangGate() {
    if (!settings.enabled) return;
    if (!tlangGated) return;               // never limited here: nothing to refresh
    const era = tlangGateEra;
    extCall(() => chrome.runtime.sendMessage({ type: "tlangGate" }, (resp) => {
      if (chrome.runtime.lastError) return;
      // A slow answer from a cold worker can arrive AFTER this tab just met a
      // brand-new 429; "the window had expired" is then stale news and must
      // not un-gate what the refusal re-gated.
      if (era !== tlangGateEra) return;
      if (resp && resp.ok) tlangGated = !!resp.gated;
    }));
  }

  function sendConfig() {
    try {
      const nonce = ++configNonce;
      window.postMessage({
        source: "ytds-content",
        type: "config",
        targetLang: settings.targetLang,
        // inject resolves "auto" against the captured track's kind (asr/manual).
        // After a network-dead gtx this video runs plain tlang instead.
        // inject's protocol stays the 3-value one: "byo" means "don't fetch
        // YouTube's translation, hand me the original" — exactly what "gtx"
        // asks for, so it maps onto it and inject.js needs no change.
        mode: injectMode(),
        nonce
      }, "*");
    } catch (_e) { /* ignore */ }
  }

  // =========================================================================
  // STATE / TEARDOWN / SPA NAV
  // =========================================================================
  function teardownAll() {
    sumClose();                      // the panel is a surface like the overlay
    stopCueLoop();
    stopFallback();
    pendingOrig = null;              // held text belongs to the old video
    pendingTrans = null;
    removeOverlay();
    cueList = null;
    tcueList = null;
    cueAligned = null;
    cueVideoId = "";
    activeCueIdx = -1;
    sentGroups = null;
    cueToGroup = null;
    speechSpans = null;
    cueToSpan = null;
    activeGroupIdx = -1;
    cueTrackKind = "";
    cueSameLang = false;
    clearPendingTimer();
    nocuesFallback = false;
    transInflight.clear();
    cueEpoch++;                       // invalidate any in-flight gtx callbacks
    ttsStop();                        // a spoken line belongs to the video it came from
  }

  function applyStateToDom() {
    ensureToggleButton(10);            // keep the control-bar toggle present + in sync
    document.documentElement.classList.toggle("ytds-active", !!settings.enabled);
    if (!settings.enabled) {
      teardownAll();
    } else {
      // ensure overlay exists; cue mode will fill it once cues arrive,
      // fallback fills it if we end up scraping.
      ensureOverlay();
      if (nocuesFallback) startFallback();
      sendConfig();
    }
  }

  function onNav() {
    if (orphaned) return;
    sumClose();                      // the summary belongs to the video being left

    // Whatever is still queued belongs to the video being left: we would throw
    // the answers away (cueEpoch), and on a run of shorts those requests are
    // what earns the rate limit that the NEXT one waits out.
    extCall(() => chrome.runtime.sendMessage({ type: "videoLeft" }, () => {
      if (chrome.runtime.lastError) return;   // worker asleep: nothing queued anyway
    }));
    currentVideoId = videoIdFromLocation();
    hintedThisVideo = false;    // a new video may spend one more first-run hint
    menuHintedThisVideo = false; // and one more arrow pulse, same budget shape
    hideMenuBubble();            // a callout must not outlive its video
    blankRecoveries = 0;        // and a fresh budget for blank-overlay recovery
    blankNextAt = 0;
    ttsStop(true);              // never carry a speaking line across videos
    ttsUserBase = 0;            // the next video is told afresh
    ttsAsked = 0;
    ttsSpoken = 0;              // the popup's counts describe THIS video
    ttsSkipped = 0;
    ttsSkipWhy = Object.create(null);   // the reasons belonged to that video
    ttsErr = "";                // and so does the reason they stayed silent
    ttsFailRun = 0;
    // These two belong to the video as much as the counts above do, and were
    // the only ones left running for the life of the tab. The popup's prompt
    // divides over by spoken and calls the answer "this video at this speed":
    // with spoken reset here and over carried across, one dense 2x video could
    // open the prompt on the next healthy video a dozen lines in — and the
    // "don't show again" it offers is permanent.
    ttsOverran = 0;
    ttsJumpCuts = 0;
    // …and the takeover trace with them. It only ever pushed and shifted, so
    // the diagnostic bundle's "last five cuts" could be five cuts from the
    // previous video under a "cut-short 0" for this one.
    ttsTrace.length = 0;
    rearmedForVideo = false;    // and one CC re-arm allowance
    armBlankWatch();            // re-arm the still-blank watchdog for this video
    transCache.clear();
    cueTrackId = "";            // the id describes transCache — reset together
                                // (NOT in teardownAll: a disable/enable cycle
                                // keeps the cache, so it must keep the id too)
    // A download in progress belongs to the video that was on screen: finishing
    // it here would name the file after the new one and keep spending on a
    // track nobody is watching any more.
    if (exportRun) exportRun.cancel = true;
    exportPlan = null;
    gtxNetFails = 0;
    gtxFellBack = false;        // the fallback is per-video
    cueTlangStatus = 0;         // the status describes the departed track
    refreshTlangGate();         // has the rate-limit window expired? ask, don't knock
    weEnabledCC = false;        // fresh video — re-evaluate caption state
    teardownAll();
    ensureToggleButton(10);     // control-bar toggle persists across videos
    if (settings.enabled) {
      ensureOverlay();
      sendConfig();             // ask inject.js for cues on the new video
      syncCaptions();           // auto-turn on YouTube CC so subs actually show
    }
  }

  // single listener instances (added once; never accumulate)
  window.addEventListener("yt-navigate-finish", onNav, true);
  window.addEventListener("message", onInjectMessage, false);

  // Belt-and-braces nav watcher (mirrors inject.js): shorts swipes change the
  // URL rapidly and the yt-navigate-finish timing there is less battle-tested
  // than on watch pages, so also poll the location. Only a genuine videoId
  // change triggers; the event handler stays authoritative otherwise.
  navPollTimer = setInterval(() => {
    try {
      // Liveness rides on a timer that already exists: in tlang mode a whole
      // video can play without one chrome.* call, so an orphaned script would
      // otherwise keep running — and keep the old overlay on screen — until
      // something finally threw.
      if (!extensionAlive()) { goOrphan(); return; }
      const v = videoIdFromLocation();
      if (v && v !== currentVideoId) onNav();
    } catch (_e) { /* ignore */ }
  }, 500);

  // ---- blank-overlay recovery ----------------------------------------------
  // Reported case: a tab left on a video and restored when Chrome reopens shows
  // no subtitles, while a freshly opened tab is fine. On that path the player
  // can be back in place before our sniffer is listening, so no caption request
  // is ever seen and the run commits to the scrape fallback with nothing to
  // scrape. Rather than guess which of those happens, re-ask whenever the page
  // is restored or revealed with an empty overlay. sendConfig() bumps the nonce,
  // so a late reply from the previous attempt is discarded; the counter keeps a
  // genuinely caption-less video from looping.
  // Root cause of the reported case, confirmed by the user's own workaround
  // (only a manual CC toggle fixed it): a restored tab comes back with
  // YouTube's CC already pressed, so ensureCaptionsOn sees "already on" and
  // never clicks — and the player has no reason to re-request the track, so
  // inject.js never sees a timedtext URL and the overlay stays blank. Toggling
  // CC off and straight back on is exactly the hand fix; do that instead of
  // waiting for something that will not happen. End state is unchanged (on), so
  // weEnabledCC is deliberately left alone.
  function rearmCaptions() {
    const player = getPlayer();
    const cc = player && player.querySelector(".ytp-subtitles-button");
    if (!cc) return false;
    if (cc.getAttribute("aria-disabled") === "true") return false;
    if (cc.getAttribute("aria-pressed") !== "true") return false;   // not our case
    cc.click();                                                     // off
    setTimeout(() => {
      const p2 = getPlayer();
      const cc2 = p2 && p2.querySelector(".ytp-subtitles-button");
      if (cc2 && cc2.getAttribute("aria-pressed") !== "true") cc2.click();   // on
    }, 250);
    return true;
  }

  function recoverIfBlank(why) {
    if (orphaned) return;
    if (!settings.enabled) return;
    if (!videoIdFromLocation()) return;               // not a video page
    // "Already working" used to be just "cueList has entries" — and a tab
    // restored from the back/forward cache carries the OLD video's cue list
    // back in its frozen heap, so the guard called a blank screen healthy and
    // every recovery trigger fell through. Cues only count as working when
    // something is actually painted: an empty overlay on a video page with
    // "cues" in hand is exactly the restored-tab disease.
    if (cueList && cueList.length &&
        !(overlay && overlay.classList.contains("ytds-empty"))) return;
    if (dragging) return;                             // don't fight a gesture
    // The budget used to be a lifetime three, twenty seconds apart — and a
    // YouTube-side limit window outlives all three (measured 2026-08-31: three
    // runs of eleven froze, each dead for the rest of the video with the
    // overlay holding its last line and the status row saying nothing). So it
    // paces instead of conceding: past the three quick shots the interval
    // widens (blankDelayMs), and cues actually arriving refills the budget
    // (onCues). Event-driven callers (bfcache, visibility) ride the same
    // pacing, so a burst of triggers cannot machine-gun the player either.
    if (Date.now() < blankNextAt) return;
    blankRecoveries++;
    blankNextAt = Date.now() + blankDelayMs();
    nocuesFallback = false;                           // let cue mode win again
    sendConfig();                                     // arm inject with a fresh nonce
    if (!rearmCaptions()) syncCaptions();              // else CC never armed at all
    void why;                                         // kept for debugging reads
  }

  // 20s for the three quick shots, then 40/80/160/300s capped — wide enough to
  // sit out a rate-limit window, alive enough to notice the moment it lifts.
  function blankDelayMs() {
    if (blankRecoveries <= MAX_BLANK_RECOVERIES) return 20000;
    return Math.min(20000 * Math.pow(2, blankRecoveries - MAX_BLANK_RECOVERIES), 300000);
  }

  // The reported case never fires visibilitychange — the tab is already visible
  // when the window comes back — so the real trigger is time: still blank a few
  // seconds after load means it is not coming.
  // Backstop only. The real trigger is inject.js's nocues (see onNoCues), which
  // fires at 6s and knows whether a caption request was ever made. This timer
  // exists for the case where nocues never arrives at all — e.g. the config
  // never reached inject — so it can afford to be slow and quiet.
  function armBlankWatch() {
    if (blankWatchTimer) clearTimeout(blankWatchTimer);
    blankWatchTimer = setTimeout(() => {
      blankWatchTimer = null;
      recoverIfBlank("timeout");
      // Persistent, not only mid-recovery: a pipe that dies MID-video (a track
      // refetch that never comes back) had no watcher at all once startup's
      // shots were spent — the other half of the same 2026-08-31 measurement.
      // Cheap while healthy: the guard above returns before touching anything.
      if (!orphaned && settings.enabled) armBlankWatch();
    }, blankDelayMs());
  }

  window.addEventListener("pageshow", (e) => {
    if (e && e.persisted) {
      // Back/forward cache. The heap comes back frozen-as-left: overlay blank,
      // CC reading "pressed", and the player never re-requests the caption
      // track on its own — measured live, with a manual CC off-then-on as the
      // instant cure. onNav() alone left the cure to the 20s watchdog (and the
      // stale-cue guard above used to block even that). Fire it now, and once
      // more after YouTube has had a moment to repaint on its own.
      blankRecoveries = 0;
      blankNextAt = 0;
      onNav();
      recoverIfBlank("bfcache");
      setTimeout(() => recoverIfBlank("bfcache-late"), 1200);
    } else armBlankWatch();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") recoverIfBlank("visible");
  });
  armBlankWatch();

  // ---- boot ----------------------------------------------------------------
  loadSettings().then(() => {
    applyStateToDom();
    syncCaptions();            // auto-enable YouTube CC so subtitles show on load
  });
})();
