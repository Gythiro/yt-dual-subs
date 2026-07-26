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
  const t = (k, fb) => (chrome.i18n && chrome.i18n.getMessage(k)) || fb;

  // ---- shared settings model (MUST match popup.js DEFAULTS) ----------------
  const DEFAULTS = {
    enabled: true,
    targetLang: "zh-CN",
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

  // Font key -> font-family stack (shared with popup preview).
  const FONT_STACKS = {
    system:  'system-ui, -apple-system, "Segoe UI", sans-serif',
    roboto:  'Roboto, "YouTube Noto", sans-serif',
    noto:    '"Noto Sans", "YouTube Noto", sans-serif',
    arial:   'Arial, Helvetica, sans-serif',
    georgia: 'Georgia, "Times New Roman", serif',
    times:   '"Times New Roman", Times, serif',
    mono:    '"Courier New", ui-monospace, monospace',
    cjk:     '"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif',
      inter:   'Inter, "Segoe UI Variable", system-ui, sans-serif',
      verdana: 'Verdana, Geneva, sans-serif',
      tahoma:  'Tahoma, Geneva, Verdana, sans-serif',
      trebuchet: '"Trebuchet MS", Tahoma, sans-serif',
      garamond: 'Garamond, "Palatino Linotype", "Book Antiqua", serif',
      cjkserif: '"Songti SC", SimSun, "Noto Serif CJK SC", serif',
      cjkround: '"Yuanti SC", "Microsoft YaHei UI", "Noto Sans CJK SC", sans-serif'
  };
  function fontStack(key) {
    return FONT_STACKS[key] || FONT_STACKS.system;
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
  let activeGroupIdx = -1;      // group of the active cue (-1 when none/per-cue)
  let cueTrackKind = "";        // "asr" | "manual" | "" — from inject's captured URL
  let cueSameLang = false;      // track already speaks the target language —
                                // nothing to translate, render single-line
  let cueTrackId = "";          // normKey of the track the caches were filled
                                // for — a switch invalidates them
  let gtxNetFails = 0;          // consecutive network-dead gtx failures (group mode)
  let gtxFellBack = false;      // this video: auto engine fell back to tlang
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
  let blankRecoveries = 0;      // bounded re-asks when the overlay stays empty
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

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    let needRecue = false;
    for (const k of Object.keys(changes)) {
      if (k in settings) {
        const oldV = settings[k];
        settings[k] = changes[k].newValue;
        if (k === "engine") settings.engine = normalizeEngine(settings);
        if (RECUE_KEYS.has(k) && oldV !== settings[k]) {
          needRecue = true;
        }
      }
    }
    applyStateToDom();
    if (overlay) styleOverlay();   // position/fonts/colors/bg/stroke/sizes apply live
    if ("enabled" in changes) syncCaptions();   // master switch flipped from popup
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
  });

  // ---- generic helpers -----------------------------------------------------
  function videoIdFromLocation() {
    try {
      const u = new URL(location.href);
      // Shorts URLs carry the id in the path, not in ?v=.
      const m = u.pathname.match(/^\/shorts\/([A-Za-z0-9_-]{6,})/);
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
  function getPlayer() {
    if (isShorts()) {
      return document.getElementById("shorts-player") ||
             document.querySelector(".html5-video-player");
    }
    return document.querySelector("#movie_player") ||
           document.querySelector(".html5-video-player");
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
    origEl = document.createElement("div");
    origEl.className = "ytds-line ytds-orig";

    overlay.appendChild(transEl);
    overlay.appendChild(origEl);
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
  function scheduleLift() {
    if (liftRaf) return;
    liftRaf = requestAnimationFrame(() => { liftRaf = 0; computeLift(); });
  }

  function observePlayerControls(player) {
    if (liftObserver) liftObserver.disconnect();
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

  function styleOverlay() {
    if (!overlay) return;

    // spacing + order
    overlay.style.gap = (Number(settings.rowGap) || 0) + "px";
    if (settings.order === "trans-top") {
      overlay.style.flexDirection = "column";         // trans first (on top)
    } else {
      overlay.style.flexDirection = "column-reverse"; // orig first (on top)
    }

    // original line
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
    if (!empty) maybeHintHandle();
    // Synchronously, in the same task as the text change: leaving this to the
    // rAF in scheduleLift() let a taller line paint one frame outside the
    // player before being pulled back (measured 76px of overflow for a frame
    // at a large font size).
    clampCustomIntoView();
    scheduleLift();                // text height changed — re-check the bar gap
  }

  function setOriginal(text) {
    if (!ensureOverlay()) return;
    origEl.textContent = text || "";
    updateEmptyState();
  }

  function setTranslation(text, forSource) {
    if (!ensureOverlay()) return;
    transEl.textContent = text || "";
    if (arguments.length > 1) lastTransSource = forSource || "";
    updateEmptyState();
  }

  // ---- in-player quick toggle (YouTube control bar) ------------------------
  // A small button in the player's right-controls that flips the whole
  // extension on/off without opening the popup — handy when a video has
  // burned-in subtitles and the overlay would just overlap them.
  let toggleBtn = null;
  let controlsObserver = null;

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
    rc.insertBefore(toggleBtn, rc.firstChild);   // leftmost of the right group
    updateToggleState();
    observeControls(rc);
  }

  function onToggleClick(e) {
    e.preventDefault();
    e.stopPropagation();
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
  function observeControls(rc) {
    if (controlsObserver) return;
    controlsObserver = new MutationObserver(() => {
      if (!toggleBtn || !toggleBtn.isConnected) {
        toggleBtn = null;
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

  function cueTick() {
    if (!settings.enabled || !cueList) return;
    const video = getVideo();
    if (!video) return;
    const t = video.currentTime * 1000;

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
  }

  // What the translation line shows when there is nothing to translate:
  // nothing (the original line already carries the text) — or the text itself
  // when the user hides the original line, so the video still has subtitles.
  function sameLangLine(origText) {
    return settings.showOriginal ? "" : origText;
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
    cueSameLang = !!data.sameLang;

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
      if (cueTrackId) { transCache.clear(); transInflight.clear(); }
      cueTrackId = data.trackId;
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

  function startFallback() {
    if (pollTimer) return;
    ensureOverlay();
    pollTimer = setInterval(fallbackTick, 200);
  }

  function stopFallback() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
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
        fellBack: gtxFellBack
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

  // Build SRT text from start-sorted cues (ends computed). Returns {text,count}.
  // "orig" | "trans" | "bi"; bilingual line order follows the user's order pref.
  function buildSrt(cues, variant) {
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
  const EXPORT_FATAL = new Set(["auth", "noKey", "noPerm", "noProvider", "noModel",
                                "badBaseUrl", "unsupportedTarget"]);

  async function runByoExport(variant) {
    if (!planIsFresh()) {
      const p = await planByoExport();
      if (!p.ok) return { ok: false, reason: p.reason || "nocues" };
    }
    const plan = exportPlan;
    const cues = plan.cues;
    const run = { total: plan.chunks.length, done: 0, cancel: false };
    exportRun = run;
    exportLast = null;

    let failed = 0, code = "";
    try {
      for (const chunk of plan.chunks) {
        if (run.cancel) return finishExport({ ok: false, reason: "cancelled" });
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
  async function exportCues() {
    const data = await requestExportData(settings.targetLang);
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
      // Fetch a complete paired set from inject (works in any backend mode).
      cues = await exportCues();
    }

    if (!cues || !cues.length) return { ok: false, reason: "nocues" };
    if (!cues.some((c) => c.trans)) return { ok: false, reason: "notrans" };

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
      "提示:此视频只有 AI 配音的自动字幕,没有原声语言的字幕轨,双语字幕可能和声音对不上。");
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

    if (d.type === "cues") onCues(d);
    else if (d.type === "nocues") onNoCues(d);
    else if (d.type === "trackwarn") {
      if (!d.videoId || d.videoId === currentVideoId) showTrackWarn();
    }
  }

  // Fold our engine setting into the 3-value protocol inject.js speaks.
  function injectMode() {
    if (settings.engine === "byo") return "gtx";        // "give me the original"
    if (settings.engine === "auto" && gtxFellBack) return "tlang";
    return settings.engine;
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
    stopCueLoop();
    stopFallback();
    removeOverlay();
    cueList = null;
    tcueList = null;
    cueAligned = null;
    cueVideoId = "";
    activeCueIdx = -1;
    sentGroups = null;
    cueToGroup = null;
    activeGroupIdx = -1;
    cueTrackKind = "";
    cueSameLang = false;
    clearPendingTimer();
    nocuesFallback = false;
    transInflight.clear();
    cueEpoch++;                       // invalidate any in-flight gtx callbacks
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
    currentVideoId = videoIdFromLocation();
    hintedThisVideo = false;    // a new video may spend one more first-run hint
    blankRecoveries = 0;        // and a fresh budget for blank-overlay recovery
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
    if (cueList && cueList.length) return;            // already working
    if (dragging) return;                             // don't fight a gesture
    if (blankRecoveries >= MAX_BLANK_RECOVERIES) return;
    blankRecoveries++;
    nocuesFallback = false;                           // let cue mode win again
    sendConfig();                                     // arm inject with a fresh nonce
    if (!rearmCaptions()) syncCaptions();              // else CC never armed at all
    void why;                                         // kept for debugging reads
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
      if (blankRecoveries > 0 && blankRecoveries < MAX_BLANK_RECOVERIES) armBlankWatch();
    }, 20000);
  }

  window.addEventListener("pageshow", (e) => {
    if (e && e.persisted) { blankRecoveries = 0; onNav(); }   // back/forward cache
    else armBlankWatch();
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
