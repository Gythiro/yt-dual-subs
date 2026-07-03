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
    backend: "tlang",            // "tlang" | "gtx"
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
    cjk:     '"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif'
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
  const transCache = new Map(); // key `${videoId} ${idx}` -> translated text
  const transInflight = new Set(); // cue indices with an in-flight gtx request (dedupe)
  const PREFETCH_AHEAD = 12;    // warm this many upcoming cues' gtx translations
  const ZERO_DUR_FLOOR_MS = 1000; // min visible window for a trailing zero-dur cue

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
  let configNonce = 0;          // monotonic; echoed by inject.js to reject stale replies

  // export (SRT download) bookkeeping
  let exportSeq = 0;                  // correlation id for export-request round-trips
  const exportWaiters = new Map();   // exportId -> { resolve, timer }

  // ---- settings ------------------------------------------------------------
  function loadSettings() {
    return new Promise((resolve) => {
      chrome.storage.sync.get(DEFAULTS, (got) => {
        settings = { ...DEFAULTS, ...got };
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
  const RECUE_KEYS = new Set(["backend", "targetLang"]);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    let needRecue = false;
    for (const k of Object.keys(changes)) {
      if (k in settings) {
        const oldV = settings[k];
        settings[k] = changes[k].newValue;
        if (RECUE_KEYS.has(k) && oldV !== settings[k]) {
          needRecue = true;
        }
      }
    }
    applyStateToDom();
    if (overlay) styleOverlay();   // position/fonts/colors/bg/stroke/sizes apply live
    if ("enabled" in changes) syncCaptions();   // master switch flipped from popup
    // backend / targetLang changed: re-request cues from inject.js
    if (needRecue && settings.enabled) {
      transCache.clear();
      transInflight.clear();
      // The current cue loop is now running against stale translation data
      // (old tlang alignment / old gtx cache). Drop the translation source and
      // bump the epoch so the loop degrades cleanly (no wrong-but-plausible
      // lines) and stale in-flight gtx callbacks are ignored until fresh cues
      // arrive from inject.js.
      tcueList = null;
      cueAligned = null;
      cueEpoch++;
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
      return u.searchParams.get("v") || "";
    } catch (_e) {
      return "";
    }
  }

  function getPlayer() {
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
  // Read ONLY .ytp-caption-segment (the combined node would duplicate text).
  function readNativeCaption() {
    const segs = document.querySelectorAll(".ytp-caption-segment");
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
    player.appendChild(overlay);
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
    handleEl.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M12 2v20M2 12h20M12 2l-3 3M12 2l3 3M12 22l-3-3M12 22l3-3' +
      'M2 12l3-3M2 12l3 3M22 12l-3-3M22 12l-3 3"/></svg>';

    handleEl.addEventListener("pointerdown", onHandlePointerDown);
    handleEl.addEventListener("pointermove", onHandlePointerMove);
    handleEl.addEventListener("pointerup", onHandlePointerUp);
    handleEl.addEventListener("pointercancel", onHandlePointerUp);
    handleEl.addEventListener("dblclick", onHandleDblClick);

    overlay.appendChild(handleEl);
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
    const xpct = clampPct(((cx - rect.left) / rect.width) * 100);
    const ypct = clampPct(((cy - rect.top) / rect.height) * 100);
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
    try { handleEl.releasePointerCapture(e.pointerId); } catch (_e) { /* ignore */ }
    // Only persist when a REAL drag happened. A bare click (no movement) must
    // not flip posMode to custom or move the box, and must not race the
    // dblclick reset (which clears this timer anyway).
    if (!dragMoved) return;
    // persist ONCE (coalesced) at the end of the gesture
    if (dragSaveTimer) clearTimeout(dragSaveTimer);
    dragSaveTimer = setTimeout(() => {
      dragSaveTimer = null;
      chrome.storage.sync.set({
        posMode: "custom",
        posXpct: settings.posXpct,
        posYpct: settings.posYpct
      });
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
    chrome.storage.sync.set({ posMode: "preset" });
  }

  // Apply ONLY positioning (shared by styleOverlay + live drag feedback).
  function applyPosition() {
    if (!overlay) return;
    if (settings.posMode === "custom") {
      overlay.classList.remove("ytds-pos-bottom", "ytds-pos-center", "ytds-pos-top");
      const x = clampPct(settings.posXpct);
      const y = clampPct(settings.posYpct);
      overlay.style.left = x + "%";
      overlay.style.top = y + "%";
      overlay.style.bottom = "auto";
      overlay.style.transform = "translate(-50%, -50%)";
    } else {
      // preset: hand control back to the CSS classes
      overlay.style.left = "";
      overlay.style.top = "";
      overlay.style.bottom = "";
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
    overlay.classList.toggle("ytds-empty", oEmpty && tEmpty);
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
    try { chrome.storage.sync.set({ enabled: settings.enabled }); } catch (_e) { /* ignore */ }
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
    const cc = document.querySelector(".ytp-subtitles-button");
    if (!cc || cc.getAttribute("aria-pressed") === null) {
      if (retries > 0) setTimeout(() => ensureCaptionsOn(retries - 1), 600);
      return;                                   // button / state not ready yet
    }
    if (cc.getAttribute("aria-disabled") === "true") return;  // no captions on this video
    if (cc.getAttribute("aria-pressed") !== "true") {
      cc.click();
      weEnabledCC = true;
    }
  }

  function restoreCaptionsIfWeEnabled() {
    if (!weEnabledCC) return;
    weEnabledCC = false;
    const cc = document.querySelector(".ytp-subtitles-button");
    if (cc && cc.getAttribute("aria-pressed") === "true") cc.click();
  }

  function syncCaptions() {
    if (settings.enabled) ensureCaptionsOn(15);
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
        setOriginal("");
        setTranslation("", "");
      }
      return;
    }

    if (idx === activeCueIdx) return;     // same sentence — no re-render, no jitter
    activeCueIdx = idx;

    const cue = cueList[idx];
    setOriginal(cue.text);
    renderTranslationForCue(idx, cue);
    prefetchFrom(idx);                    // warm upcoming translations (gtx mode)
  }

  function renderTranslationForCue(idx, cue) {
    const origText = cue.text;

    // (1) aligned tlang translation — paired by event order in inject.js and
    // carried on the cue itself, so re-sorting cueList cannot desync it.
    if (cueAligned && typeof cue.trans === "string" && cue.trans) {
      setTranslation(cue.trans, origText);
      return;
    }

    // (1b) tlang present but MISALIGNED (length mismatch): positional indexing
    // would paint wrong-but-plausible lines, so match by timestamp instead.
    // Pick the tcue whose start is closest to this cue's start within a
    // tolerance; if none qualifies, fall through to the gtx/cache path.
    if (tcueList && cueAligned === false) {
      const m = nearestTcue(cue.start);
      if (m) {
        setTranslation(m.text, origText);
        return;
      }
      // no good timestamp match -> fall through (do NOT index positionally)
    }

    // (2) gtx backend (or no usable tlang data): cache by (videoId, idx).
    const key = cueVideoId + " " + idx;
    const cached = transCache.get(key);
    if (cached !== undefined) {
      setTranslation(cached, origText);
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
    chrome.runtime.sendMessage(
      { type: "translate", text: cue.text, targetLang: settings.targetLang },
      (resp) => {
        transInflight.delete(idx);
        if (chrome.runtime.lastError) return;       // worker asleep; retried on demand
        if (reqEpoch !== cueEpoch) return;          // loop restarted / re-config
        if (reqVid !== cueVideoId) return;          // navigated away
        if (resp && resp.ok && resp.translated) {
          transCache.set(key, resp.translated);
          if (activeCueIdx === idx) setTranslation(resp.translated, cue.text);
        }
        // on failure: leave cache empty so it can be retried when next active
      }
    );
  }

  // Warm upcoming cues' gtx translations so the translation line is ready the
  // moment a sentence appears — fixes the ~1s lag when tlang is unavailable.
  // Only runs when there is NO tlang data at all (cueAligned == null), i.e. the
  // gtx backend or a tlang failure; aligned/misaligned tlang is handled inline.
  // Window-bounded to stay gentle on the unofficial endpoint.
  function prefetchFrom(startIdx) {
    if (cueAligned != null) return;             // tlang handles the translation
    if (!settings.enabled || !cueList) return;
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

    if (!cueList.length) { onNoCues(data); return; }
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
      chrome.runtime.sendMessage(
        { type: "translate", text, targetLang: settings.targetLang },
        (resp) => {
          if (chrome.runtime.lastError) return;
          if (token !== lastReqToken) return;
          if (text !== lastSource) return;
          if (resp && resp.ok && resp.translated) {
            setTranslation(resp.translated, text);
          }
        }
      );
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
    nocuesFallback = true;
    stopCueLoop();
    cueList = null;
    tcueList = null;
    if (settings.enabled) startFallback();
  }

  // =========================================================================
  // EXPORT (SRT download)
  // =========================================================================
  // Triggered from the popup via chrome.tabs.sendMessage. We build an .srt from
  // the cue data and download it via a Blob + <a download> (no extra permission).

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.type !== "exportSrt") return;          // not ours — ignore
    handleExport(msg.variant)
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
        const top = settings.order === "trans-top" ? tr : o;
        const bottom = settings.order === "trans-top" ? o : tr;
        body = [top, bottom].filter(Boolean).join("\n");
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

  // Main export entry. Returns a serializable result for the popup:
  //   { ok:true, count, variant } | { ok:false, reason:"nocues"|"notrans" }
  async function handleExport(variant) {
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

    // TRANSLATION / BILINGUAL.
    let cues = null;
    // Fast path: the live overlay already has a fully-aligned tlang translation.
    if (cueAligned === true && cueList && cueList.length && cueList.some((c) => c.trans)) {
      cues = cueList;
    } else {
      // Fetch a complete paired set from inject (works in any backend mode).
      const data = await requestExportData(settings.targetLang);
      if (data && data.ok && Array.isArray(data.cues) && data.cues.length) {
        cues = data.cues.slice().sort((a, b) => a.start - b.start);
        computeCueEnds(cues);
        if (data.aligned === false && Array.isArray(data.tcues)) {
          fillTransByTimestamp(cues, data.tcues.slice().sort((a, b) => a.start - b.start));
        }
      } else if (cueList && cueList.length) {
        cues = cueList;                 // at least try whatever the overlay holds
      }
    }

    if (!cues || !cues.length) return { ok: false, reason: "nocues" };
    if (!cues.some((c) => c.trans)) return { ok: false, reason: "notrans" };

    const built = buildSrt(cues, v);
    if (!built.count) return { ok: false, reason: "notrans" };
    return triggerDownload(built.text, srtFilename(v))
      ? { ok: true, count: built.count, variant: v }
      : { ok: false, reason: "notrans" };
  }

  // =========================================================================
  // BRIDGE <- inject.js
  // =========================================================================
  function onInjectMessage(evt) {
    if (evt.source !== window) return;
    const d = evt.data;
    if (!d || d.source !== "ytds-inject") return;
    // Export replies are handled even when the overlay is disabled (they are a
    // direct response to a user-initiated download, not the live cue stream).
    if (d.type === "exportdata") { resolveExportData(d); return; }
    if (!settings.enabled) return;

    if (d.type === "cues") onCues(d);
    else if (d.type === "nocues") onNoCues(d);
  }

  function sendConfig() {
    try {
      const nonce = ++configNonce;
      window.postMessage({
        source: "ytds-content",
        type: "config",
        targetLang: settings.targetLang,
        useTlang: settings.backend === "tlang",
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
    currentVideoId = videoIdFromLocation();
    transCache.clear();
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

  // ---- boot ----------------------------------------------------------------
  loadSettings().then(() => {
    applyStateToDom();
    syncCaptions();            // auto-enable YouTube CC so subtitles show on load
  });
})();
