// inject.js — MAIN world, document_start.
// Hooks XMLHttpRequest + fetch to capture the YouTube player's OWN
// /api/timedtext request URL (which carries a valid "pot"), then reuses that
// exact URL to fetch json3 cues — and, optionally, a tlang-aligned translation.
//
// NEVER throw into the page: every hook body is wrapped in try/catch.
(() => {
  "use strict";

  // ---- guard against double injection -------------------------------------
  if (window.__ytdsInjected) return;
  window.__ytdsInjected = true;

  const TIMEDTEXT_MARK = "/api/timedtext";

  // Most recently seen timedtext URL of any kind.
  let lastTimedtextUrl = "";
  // The player's ORIGINAL-track fetch: a timedtext URL WITHOUT a "tlang" param.
  // This is the only URL whose "pot" we may reuse.
  let sourceUrl = "";
  // The videoId that sourceUrl was captured for. produceCues bails if this no
  // longer matches the current location video, so a stale (previous-video) URL
  // can never be fetched and posted under the new videoId.
  let sourceVid = "";
  // Identity of the captured source track, IGNORING fmt/tlang. Used so our own
  // json3 re-fetches (and pot rotations on the same track) are not mistaken for
  // a brand-new source — which would otherwise re-trigger produceCues in a loop.
  let sourceKey = "";

  let currentVideoId = videoIdFromLocation();

  // pending config from content.js (set once popup config arrives)
  let cfg = null;            // { targetLang, mode: "auto"|"tlang"|"gtx" }
  let nocuesTimer = null;    // fires if no timedtext URL shows up
  let producedForUrl = "";   // dedupe: last sourceUrl we produced cues for
  // Monotonic request token echoed back to content.js so it can drop any
  // 'cues'/'nocues' that does not correspond to its latest sendConfig().
  let reqNonce = 0;

  // ---- helpers -------------------------------------------------------------
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

  function isShortsPage() {
    try { return /^\/shorts\//.test(location.pathname); } catch (_e) { return false; }
  }

  // The player element that is actually driving THIS page. A shorts page keeps
  // a hidden #movie_player around (preloaded watch player), so id order matters.
  function activePlayer() {
    return isShortsPage()
      ? document.getElementById("shorts-player")
      : document.getElementById("movie_player");
  }

  // tlang code map: YouTube uses zh-Hans / zh-Hant for translation targets.
  function mapTlang(code) {
    if (code === "zh-CN") return "zh-Hans";
    if (code === "zh-TW") return "zh-Hant";
    return code;
  }

  function hasTlang(url) {
    try {
      return new URL(url, location.href).searchParams.has("tlang");
    } catch (_e) {
      return /[?&]tlang=/.test(url);
    }
  }

  function isTimedtext(url) {
    return typeof url === "string" && url.indexOf(TIMEDTEXT_MARK) !== -1;
  }

  // Track identity ignoring the params that rotate or that WE vary. "pot" (the
  // proof-of-origin token) is rotated by the player periodically for the SAME
  // track — if we kept it in the key, each rotation would look like a brand-new
  // source and re-trigger produceCues, causing the overlay to flicker. So strip
  // pot/fmt/tlang; what remains (v, lang, kind, ...) is the stable track id.
  function normKey(url) {
    try {
      const u = new URL(url, location.href);
      u.searchParams.delete("fmt");
      u.searchParams.delete("tlang");
      u.searchParams.delete("pot");
      return u.toString();
    } catch (_e) {
      return url;
    }
  }

  // Track kind of a captured timedtext URL: auto-generated (ASR) tracks carry
  // kind=asr; human tracks have no kind param. Drives the "auto" engine choice.
  function trackKindOf(url) {
    try {
      return new URL(url, location.href).searchParams.get("kind") === "asr"
        ? "asr" : "manual";
    } catch (_e) {
      return "manual";
    }
  }

  // Language code of a captured timedtext URL — the track's own language.
  function trackLangOf(url) {
    try {
      return new URL(url, location.href).searchParams.get("lang") || "";
    } catch (_e) {
      return "";
    }
  }

  // True when translating this track into `target` is a KNOWN no-op: the track
  // already speaks the target language, so tlang would just echo the original
  // back and both lines would show the same text (and gtx likewise). Chinese
  // needs script-level care — zh-CN/zh-SG pair with zh-Hans, zh-TW/zh-HK/zh-MO
  // with zh-Hant. Any OTHER zh pairing (Hans<->Hant, and a bare "zh" track vs
  // either script) stays a real translation: Hans<->Hant is a genuine
  // conversion, and a bare "zh" track hides which script it uses, so skipping
  // here would rob e.g. a zh-Hant target of the Simplified->Traditional
  // conversion. When the track's script happens to MATCH the target, the tlang
  // response is a per-cue echo of the original — content.js detects that
  // track-level and renders single-line (see the echo check in onCues).
  // For everything else a base-language match (en-US vs en, pt-BR vs pt) is a
  // no-op; YouTube offers no regional conversion there.
  function isSameLang(track, target) {
    const norm = (c) => {
      c = String(c || "").toLowerCase();
      if (c === "zh-cn" || c === "zh-sg" || c === "zh-my" || c === "zh-hans") return "zh-hans";
      if (c === "zh-tw" || c === "zh-hk" || c === "zh-mo" || c === "zh-hant") return "zh-hant";
      if (c === "in") return "id";   // YouTube still serves legacy ISO codes
      if (c === "iw") return "he";   // on some tracks
      return c;
    };
    const a = norm(track), b = norm(target);
    if (!a || !b) return false;
    if (a === b) return true;
    const ab = a.split("-")[0], bb = b.split("-")[0];
    if (ab !== bb) return false;
    if (ab === "zh") return false;   // differing zh forms: let tlang convert
    return true;
  }

  // Parse the "v" param off a captured timedtext URL when present; otherwise
  // fall back to the current location video id.
  function vidOfUrl(url) {
    try {
      const u = new URL(url, location.href);
      return u.searchParams.get("v") || videoIdFromLocation();
    } catch (_e) {
      return videoIdFromLocation();
    }
  }

  // Build a fetch URL from the captured source URL: preserve every param
  // (including pot + signature), force fmt=json3, drop any stray tlang.
  function buildUrl(base, tlangTarget) {
    const u = new URL(base, location.href);
    u.searchParams.delete("tlang");
    u.searchParams.set("fmt", "json3");
    if (tlangTarget) u.searchParams.set("tlang", tlangTarget);
    return u.toString();
  }

  // Parse json3 into cue objects. Robust against missing/empty segs.
  // Preserves json3 EVENT ORDER (do not sort here): the orig and tlang
  // responses are aligned cue-for-cue by event order, so the i-th surviving
  // event of the orig response corresponds to the i-th of the tlang response.
  function parseJson3(json) {
    const cues = [];
    if (!json || !Array.isArray(json.events)) return cues;
    for (const ev of json.events) {
      if (!ev || !Array.isArray(ev.segs)) continue;
      let text = "";
      let off = 0;
      for (const s of ev.segs) {
        if (s && typeof s.utf8 === "string") {
          text += s.utf8;
          // Track the last NON-BLANK word's offset. ASR tracks carry per-word
          // tOffsetMs; blank segs ("\n") may carry one too and would inflate it.
          if (s.utf8.trim() && typeof s.tOffsetMs === "number") off = s.tOffsetMs;
        }
      }
      text = text.replace(/\s+/g, " ").trim();
      // Auto-generated tracks carry the broadcast captioning convention for a
      // change of speaker — ">>", and ">>>" for a change of topic. It means
      // nothing to someone reading subtitles under a video, and it does not
      // stay put: it goes to the translator as text and comes back sitting in
      // front of the Chinese line too. Strip it where cue text is born, so the
      // overlay, the translation and the exported SRT all agree.
      text = text.replace(/(^|\s)>{2,}\s*/g, "$1").trim();
      if (!text) continue;          // skip style/window/blank events
      const start = typeof ev.tStartMs === "number" ? ev.tStartMs : 0;
      const dur = typeof ev.dDurationMs === "number" ? ev.dDurationMs : 0;
      // lastOff = absolute time of the event's last word. Manual tracks have no
      // per-word segs, so lastOff === start — sentence grouping in content.js
      // reads the pause as (next.start - lastOff), which for manual tracks is
      // roughly the cue duration and therefore almost always a sentence break.
      cues.push({ start, dur, text, lastOff: start + off });
    }
    return cues;
  }

  // Our own timedtext fetches go through the very hooks that sniff the player's,
  // so without this they look like "the player just asked again" — which now
  // means something (it triggers the translation's second chance) and would
  // spend an extra request on our own footsteps.
  let selfFetching = 0;

  // page-context fetch — same-origin youtube.com so pot/signature stay valid.
  async function fetchJson3(url) {
    selfFetching++;
    let res;
    try {
      res = await fetch(url, { method: "GET", credentials: "include" });
    } finally {
      selfFetching--;
    }
    if (!res.ok) {
      const err = new Error("timedtext http " + res.status);
      err.status = res.status;        // lets the retry tell a 429 from a 404
      throw err;
    }
    const txt = await res.text();
    if (!txt) throw new Error("timedtext empty body");
    return JSON.parse(txt);
  }

  // One hiccup used to cost the whole video. When the tlang fetch throws,
  // produceCues concedes `tcues = null`; content.js reads that as "this track
  // has no YouTube translation" and runs the rest of the video on the
  // per-sentence gtx path — which is why switching the engine to YouTube and
  // back appears to "fix" it (a fresh config forces a fresh fetch). So retry
  // the failures that are hiccups: a dropped connection, a 429 from a burst, a
  // 5xx, a rotated pot, the empty body YouTube serves when it is unhappy, or a
  // truncated response. A 4xx that is not 429 is an answer, not a hiccup —
  // spending two more requests on it would only delay the fallback.
  const RETRY_DELAYS_MS = [300, 800];

  function isHiccup(err, retry429) {
    const s = err && err.status;
    if (typeof s !== "number") return true;   // network error / empty / bad JSON
    if (s === 429) return !!retry429;
    return s >= 500;
  }

  // retry429: for the ORIGINAL track, where being rate-limited means no
  // subtitles at all, waiting a moment is worth it. NOT for the translation:
  // measured on a real short, a 429 there was still a 429 twenty-one seconds
  // later, so retrying inside the request only holds the first line back by
  // another second before conceding to the sentence path anyway. That one gets
  // the deferred second chance instead.
  async function fetchJson3Retry(url, wantVid, retry429) {
    for (let i = 0; ; i++) {
      try {
        return await fetchJson3(url);
      } catch (err) {
        if (i >= RETRY_DELAYS_MS.length || !isHiccup(err, retry429)) throw err;
        await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[i]));
        // Navigated away mid-retry: the caller discards the result anyway, and
        // the next video's own produce is already on its way.
        if (wantVid && wantVid !== currentVideoId) throw err;
      }
    }
  }

  // ---- bridge to content.js ------------------------------------------------
  function post(type, extra) {
    try {
      window.postMessage(Object.assign(
        { source: "ytds-inject", type, videoId: currentVideoId, nonce: reqNonce },
        extra || {}
      ), "*");
    } catch (_e) { /* never throw */ }
  }

  function clearNocuesTimer() {
    if (nocuesTimer) { clearTimeout(nocuesTimer); nocuesTimer = null; }
  }

  // Produce cues (+ optional aligned translation) from the captured source URL.
  async function produceCues(force) {
    if (!cfg || !sourceUrl) return;
    // The captured source URL must belong to the CURRENT video. Without this,
    // a config round-trip on SPA nav could refetch the previous video's URL and
    // post it stamped with the new videoId.
    if (sourceVid !== currentVideoId) return;
    if (!force && producedForUrl === sourceUrl) return;
    producedForUrl = sourceUrl;
    clearNocuesTimer();

    const vid = currentVideoId;
    // Capture the nonce NOW, at produce start. post() must stamp the reply with
    // THIS nonce, not the live global reqNonce at send-time: otherwise two
    // produces running concurrently (e.g. boot + yt-navigate-finish both send
    // config) would both be stamped with the latest nonce and both accepted by
    // content.js -> double cue-loop restart -> startup flicker.
    const myNonce = reqNonce;
    // Which engine wants the tlang track? Everything except explicit "gtx".
    // Measured across videos (2026-07): YouTube's whole-track translation is
    // usually solid even on ASR, so "auto" stays on it and the sentence-group
    // gtx path serves as the (much better than per-cue) fallback when a track
    // isn't translatable — plus as the user's manual choice.
    const kind = trackKindOf(sourceUrl);
    // Track already in the target language: skip translation entirely (tlang
    // AND gtx would only echo the original — the "double identical lines" bug
    // on e.g. a Chinese video with a Chinese target). content.js renders a
    // single line when this flag rides along with the cues.
    const sameLang = isSameLang(trackLangOf(sourceUrl), cfg.targetLang);
    const wantTlang = !sameLang && cfg.mode !== "gtx";
    // Pin ONE pot-bearing URL for both legs: sourceUrl is refreshed on every
    // pot rotation, so reading it twice could pair an original fetched with one
    // token against a translation fetched with the next.
    const src = sourceUrl;
    let tlangFailed = false;
    let tlangStatus = 0;            // 429 means "come back much later"
    try {
      const origJson = await fetchJson3Retry(buildUrl(src, null), vid, true);
      const cues = parseJson3(origJson);

      let tcues = null;
      if (wantTlang) {
        try {
          const target = mapTlang(cfg.targetLang);
          const transJson = await fetchJson3Retry(buildUrl(src, target), vid, false);
          tcues = parseJson3(transJson);
        } catch (err) {
          tcues = null;             // translation failed; orig still usable
          tlangFailed = true;
          tlangStatus = (err && err.status) || 0;
        }
      }

      // ignore if we navigated away mid-fetch (or the source no longer matches)
      if (vid !== currentVideoId || sourceVid !== currentVideoId) return;

      if (!cues.length) {
        producedForUrl = "";        // allow a retry if the track later yields cues
        post("nocues", { nonce: myNonce });
        return;
      }

      // Pair orig+tlang by EVENT ORDER while alignment is known, BEFORE any
      // sorting downstream. content.js then sorts the single cue array and
      // reads cue.trans, so re-sorting can never desync the translation.
      const aligned = tcues ? (cues.length === tcues.length) : null;
      if (tcues && aligned) {
        for (let i = 0; i < cues.length; i++) {
          cues[i].trans = tcues[i] ? tcues[i].text : "";
        }
      }

      post("cues", {
        cues, tcues, aligned, trackKind: kind, sameLang,
        // stable track identity (normKey strips pot/fmt/tlang): lets content.js
        // drop cached translations when the TRACK changes on the same video
        // (CC language switch / auto-dub mismatch fix) — same cache keys,
        // different text.
        trackId: normKey(src),
        nonce: myNonce
      });
      // Rendering gtx right now is correct — but come back for the translation
      // once, instead of leaving the whole video on it.
      if (tlangFailed) scheduleTlangReproduce(normKey(src), tlangStatus);
      checkTrackMismatch(vid, src);
    } catch (_e) {
      // could not fetch/parse — let content.js fall back to scraping, but only
      // if we are still on the same video the fetch was started for.
      if (vid !== currentVideoId || sourceVid !== currentVideoId) return;
      producedForUrl = "";          // allow a retry on next capture
      post("nocues", { nonce: myNonce });
    }
  }

  // Produce a COMPLETE bilingual cue set for SRT export, on demand. Unlike
  // produceCues (which drives the live overlay and honours the user's backend
  // choice), this ALWAYS fetches the whole-track tlang translation by reusing
  // the captured pot-bearing source URL — so a full translation is available for
  // download even when the live overlay is running in gtx (per-sentence) mode.
  // Orig+tlang are paired by EVENT ORDER here, before content.js sorts, so the
  // translation can never desync from the original. Posts an "exportdata" reply
  // correlated by exportId; never throws into the page.
  async function produceExport(targetLang, exportId) {
    if (!sourceUrl || sourceVid !== currentVideoId) {
      post("exportdata", { ok: false, exportId });
      return;
    }
    const vid = currentVideoId;
    let transStatus = 0;
    try {
      const origJson = await fetchJson3Retry(buildUrl(sourceUrl, null), vid, true);
      const cues = parseJson3(origJson);
      if (!cues.length) { post("exportdata", { ok: false, exportId }); return; }

      let tcues = null;
      let aligned = null;
      if (targetLang) {
        try {
          // Unlike playback, an export has no sentence path to fall back on and
          // a person waiting for a file, so a rate limit is worth the retries.
          const transJson = await fetchJson3Retry(buildUrl(sourceUrl, mapTlang(targetLang)), vid, true);
          tcues = parseJson3(transJson);
          aligned = cues.length === tcues.length;
          if (aligned) {
            for (let i = 0; i < cues.length; i++) {
              cues[i].trans = tcues[i] ? tcues[i].text : "";
            }
          }
        } catch (err) {
          tcues = null; aligned = null;   // translation failed; orig still usable
          transStatus = (err && err.status) || 0;
        }
      }

      // transStatus rides along so the popup can say "rate limited, try again in
      // a moment" instead of "try another language", which is not the problem.
      post("exportdata", { ok: true, cues, tcues, aligned, transStatus, exportId });
    } catch (_e) {
      post("exportdata", { ok: false, exportId });
    }
  }

  // ---- auto-dub caption mismatch (checked once per video) ------------------
  // Some videos ship YouTube's auto-dubbing: N dubbed audio tracks, and the
  // caption list holds the ASR of each DUB — sometimes with no track in the
  // original language at all. With no default marked, the player enables the
  // alphabetically first track (observed: Arabic on an English-original video),
  // so the overlay would show a dub's ASR against the original audio.
  // If a track matching the original audio's language exists, switch to it via
  // the player API (the new timedtext fetch is then sniffed as usual); if none
  // exists, tell content.js to show a one-shot notice.
  let mismatchFor = "";

  function playerResponseFor(vid) {
    try {
      const pr = window.ytInitialPlayerResponse;
      if (pr && pr.videoDetails && pr.videoDetails.videoId === vid) return pr;
    } catch (_e) { /* ignore */ }
    try {
      const p = activePlayer();
      if (p && typeof p.getPlayerResponse === "function") {
        const pr = p.getPlayerResponse();
        if (pr && pr.videoDetails && pr.videoDetails.videoId === vid) return pr;
      }
    } catch (_e) { /* ignore */ }
    return null;
  }

  function checkTrackMismatch(vid, srcUrl) {
    try {
      if (mismatchFor === vid) return;
      mismatchFor = vid;
      const pr = playerResponseFor(vid);
      const r = pr && pr.captions && pr.captions.playerCaptionsTracklistRenderer;
      if (!r || !Array.isArray(r.captionTracks) || !r.captionTracks.length) return;
      const audio = Array.isArray(r.audioTracks) ? r.audioTracks : [];
      const defIdx = typeof r.defaultAudioTrackIndex === "number" ? r.defaultAudioTrackIndex : -1;
      const a = defIdx >= 0 ? audio[defIdx] : null;
      // audioTrackId looks like "en-US.4" / "ar.10" — language prefix + suffix.
      const origLang = a && typeof a.audioTrackId === "string" ? a.audioTrackId.split(".")[0] : "";
      if (!origLang) return;
      const base = (s) => String(s || "").toLowerCase().split("-")[0];
      let curLang = "";
      try { curLang = new URL(srcUrl, location.href).searchParams.get("lang") || ""; } catch (_e) { /* ignore */ }
      if (!curLang || base(curLang) === base(origLang)) return;  // already the original's language
      const match = r.captionTracks.find((t2) => base(t2.languageCode) === base(origLang));
      if (match) {
        const p = activePlayer();
        if (p && typeof p.setOption === "function") {
          p.setOption("captions", "track", { languageCode: match.languageCode });
          return;                       // silent fix; the new fetch re-produces
        }
      }
      post("trackwarn", { reason: "dubonly", curLang, origLang });
    } catch (_e) { /* never throw */ }
  }

  // Called whenever we capture a fresh source URL.
  function onSourceCaptured() {
    if (!cfg) return;               // wait for config before fetching
    produceCues(false);
  }

  // Record a timedtext URL seen on the wire.
  function noteTimedtext(url) {
    try {
      if (!isTimedtext(url)) return;
      if (selfFetching) return;              // our own request, not the player's
      lastTimedtextUrl = url;
      if (!hasTlang(url)) {
        // The player's original-track fetch — the only pot we may reuse.
        // Always keep the freshest exact URL (pot can rotate), but only treat
        // it as a NEW source (and re-produce) when the track identity changes.
        const key = normKey(url);
        sourceUrl = url;
        sourceVid = vidOfUrl(url);
        if (key !== sourceKey) {
          sourceKey = key;
          onSourceCaptured();
        } else if (tlangRetryTimer && key === tlangRetriedFor) {
          // Same track, fresh capture — so a fresh pot — while a translation
          // retry is still pending. This is a better moment for it than the
          // timer's: whatever went wrong, it is now being asked again with the
          // token the player itself just used.
          clearTlangRetry();
          producedForUrl = "";
          produceCues(true);
        }
      }
    } catch (_e) { /* never throw */ }
  }

  // A failed tlang fetch is STICKY, and that is what users report as "auto keeps
  // falling back to Google": produceCues stamps producedForUrl at start, and a
  // later pot rotation on the same track does not re-produce (normKey is
  // deliberately pot-blind), so nothing tries again for the rest of the video —
  // switching the engine by hand is the only recovery, which is exactly the
  // workaround people find. The in-request backoff only covers about a second.
  // Give the track ONE more attempt a few seconds later, with whatever pot is
  // freshest by then; if that fails too, gtx really is the answer.
  // Measured on a real short (2026-07-27): YouTube answers the tlang endpoint
  // with 429 for a sustained stretch — still 429 twenty-one seconds later — so
  // the ordinary four-second second-chance would be spent on a door that is
  // still shut. Rate limiting gets its own, longer wait; everything else stays
  // quick, because most other failures are a blip.
  const TLANG_RETRY_MS = 4000;
  const TLANG_RETRY_RATELIMIT_MS = 25000;
  let tlangRetriedFor = "";
  let tlangRetryTimer = null;

  function clearTlangRetry() {
    if (tlangRetryTimer) { clearTimeout(tlangRetryTimer); tlangRetryTimer = null; }
  }

  function scheduleTlangReproduce(trackKey, status) {
    if (!trackKey || tlangRetriedFor === trackKey) return;   // one shot per track
    tlangRetriedFor = trackKey;
    clearTlangRetry();
    const vid = currentVideoId;
    const wait = status === 429 ? TLANG_RETRY_RATELIMIT_MS : TLANG_RETRY_MS;
    tlangRetryTimer = setTimeout(() => {
      tlangRetryTimer = null;
      if (!cfg || cfg.mode === "gtx") return;              // gtx is what was asked for
      // Covers a video change too: that clears sourceUrl, and the next video's
      // capture has a different track key.
      if (!sourceUrl || normKey(sourceUrl) !== trackKey) return;
      producedForUrl = "";                                 // let the same URL through
      produceCues(true);
    }, wait);
  }

  // ---- video-change reset --------------------------------------------------
  // Returns true if a change was detected and state was reset.
  function checkVideoChange() {
    try {
      const v = videoIdFromLocation();
      if (v && v !== currentVideoId) {
        currentVideoId = v;
        lastTimedtextUrl = "";
        sourceUrl = "";
        sourceVid = "";
        sourceKey = "";
        producedForUrl = "";
        clearNocuesTimer();
        // The latch itself is keyed by track, so the next video gets its own
        // second chance without resetting anything; this just stops a pending
        // timer from waking up for a video nobody is watching.
        clearTlangRetry();
        return true;
      }
    } catch (_e) { /* never throw */ }
    return false;
  }
  setInterval(checkVideoChange, 500);

  // ---- nocues watchdog -----------------------------------------------------
  // The shorts player is chromeless (no CC button anywhere in its subtree), so
  // content.js cannot click captions on. If a short produced no timedtext
  // within the window, nudge the captions module ONCE via the player API and
  // give it one more window before conceding nocues.
  let nudgedForVid = "";

  // The only way captions can be turned on inside a short: there is no CC
  // button for content.js to click. loadModule alone does NOT arm them —
  // measured 2026-07-27 on a short with one caption track, with the account's
  // CC preference off: the module loaded, the player kept "Subtitles/CC turned
  // off", and no timedtext was ever fetched, through two full nocues windows.
  // SELECTING a track is what arms them (same call the auto-dub track fix
  // makes). loadModule still goes first — it is what makes the captions module,
  // and therefore the tracklist, available to ask; the track is picked a beat
  // later, once it has loaded.
  // What tracks does this video actually have? Two sources, and on shorts the
  // obvious one lies: measured 2026-07-27 on a short whose only track is
  // auto-generated, getOption("captions","tracklist") stayed EMPTY — before
  // loadModule and six seconds after it — while the player's own response
  // listed en/asr the whole time. Selecting that track by language code works
  // perfectly; we just have to know it is there.
  function captionTracksOf(p) {
    try {
      const list = p.getOption("captions", "tracklist");
      if (Array.isArray(list) && list.length) return list;
    } catch (_e) { /* ignore */ }
    try {
      const pr = playerResponseFor(currentVideoId);
      const r = pr && pr.captions && pr.captions.playerCaptionsTracklistRenderer;
      if (r && Array.isArray(r.captionTracks) && r.captionTracks.length) return r.captionTracks;
    } catch (_e) { /* ignore */ }
    return null;
  }

  function nudgeCaptions() {
    try {
      const p = activePlayer();
      if (!p) return;
      if (typeof p.loadModule === "function") p.loadModule("captions");
      const vidAtNudge = currentVideoId;
      setTimeout(() => {
        try {
          if (sourceUrl) return;                    // the module alone did it
          if (vidAtNudge !== currentVideoId) return;
          const p2 = activePlayer();
          if (!p2 || typeof p2.getOption !== "function" ||
                     typeof p2.setOption !== "function") return;
          // Already on a track (the early nudge got there first, or the user
          // did): re-selecting it would restart the caption download for
          // nothing. Whatever is wrong here, another track switch won't fix it.
          const cur = p2.getOption("captions", "track");
          if (cur && cur.languageCode) return;
          const list = captionTracksOf(p2);
          // Nothing on either source = a short with genuinely no captions.
          // Selecting nothing is correct; the second window concedes nocues.
          if (!list) return;
          // First track: shorts carry one in practice, and if the player picked
          // the wrong language of several, checkTrackMismatch corrects it as
          // soon as the resulting fetch is sniffed.
          p2.setOption("captions", "track", { languageCode: list[0].languageCode });
        } catch (_e) { /* ignore */ }
      }, 400);
    } catch (_e) { /* ignore */ }
  }

  // Waiting out the 6s nocues window before touching the player costs about
  // seven seconds of blank video on EVERY short whose captions are off — the
  // window exists for the watch page, where a slow player can still fetch
  // captions by itself and 6s of patience is cheaper than fighting it. On a
  // short nothing else is coming: there is no CC button, so if no track is
  // selected, no fetch will ever happen. Start asking as soon as the player can
  // answer, and poll briefly because the captions module is usually not loaded
  // yet at config time. The 6s watchdog stays as the backstop.
  const EARLY_TRIES = 8;        // 8 × 500ms ≈ 4s of asking
  const EARLY_PATIENCE = 3;     // …of which the first ~1.5s just waits
  let earlyRearmedFor = "";
  let earlyRearmPending = false;

  function scheduleEarlyNudge(triesLeft) {
    if (!isShortsPage() || triesLeft <= 0) return;
    const vid = currentVideoId;
    setTimeout(() => {
      if (vid !== currentVideoId || sourceUrl) return;   // navigated / already flowing
      if (earlyRearmPending) { scheduleEarlyNudge(triesLeft - 1); return; }
      let done = false;
      try {
        const p = activePlayer();
        if (p && typeof p.getOption === "function" && typeof p.setOption === "function") {
          const cur = p.getOption("captions", "track");
          if (cur && cur.languageCode) {
            // A selected track normally means the player's own fetch is on its
            // way, and switching under it would restart the download — so wait
            // first. But swiping shorts quickly leaves the PREVIOUS short's
            // selection in place while nothing is fetched for the new one:
            // measured on Lee's machine as cur=en/asr, no timedtext, a minute
            // of blank video, and swiping past and back fixed it. So patience
            // has a limit: turn captions off and straight back ON — the same
            // track, never a different language — which is what makes the
            // player go and fetch.
            if (triesLeft <= EARLY_TRIES - EARLY_PATIENCE && earlyRearmedFor !== vid) {
              earlyRearmedFor = vid;
              earlyRearmPending = true;
              const lang = cur.languageCode;
              p.setOption("captions", "track", {});
              setTimeout(() => {
                earlyRearmPending = false;
                try {
                  if (vid !== currentVideoId || sourceUrl) return;
                  const p2 = activePlayer();
                  if (p2 && typeof p2.setOption === "function") {
                    p2.setOption("captions", "track", { languageCode: lang });
                  }
                } catch (_e) { /* ignore */ }
              }, 300);
            }
          } else {
            const list = captionTracksOf(p);
            if (list) {
              p.setOption("captions", "track", { languageCode: list[0].languageCode });
              done = true;
            } else if (typeof p.loadModule === "function") {
              p.loadModule("captions");   // nothing to select yet — ask for the module
            }
          }
        }
      } catch (_e) { /* ignore */ }
      if (!done) scheduleEarlyNudge(triesLeft - 1);
    }, 500);
  }

  function armNocuesTimer() {
    clearNocuesTimer();
    const vid = currentVideoId;
    const nonceAtArm = reqNonce;
    nocuesTimer = setTimeout(() => {
      nocuesTimer = null;
      if (vid !== currentVideoId) return;
      if (nonceAtArm !== reqNonce) return;
      if (sourceUrl) return;               // a capture raced the timer — all good
      if (isShortsPage() && nudgedForVid !== vid) {
        nudgedForVid = vid;
        nudgeCaptions();
        armNocuesTimer();                  // one extra window after the nudge
        return;
      }
      post("nocues");                      // never saw the player fetch captions
    }, 6000);
  }

  // ---- receive config from content.js --------------------------------------
  window.addEventListener("message", (evt) => {
    try {
      if (evt.source !== window) return;
      const d = evt.data;
      if (!d || d.source !== "ytds-content") return;

      if (d.type === "config") {
        // Treat the config message as the authoritative nav signal: reset any
        // stale capture synchronously if the location video changed, rather
        // than waiting up to 500ms for the poll. This closes the cross-video
        // contamination window — produceCues will only run for a sourceUrl
        // captured for the now-current video.
        checkVideoChange();
        currentVideoId = videoIdFromLocation();
        cfg = {
          targetLang: d.targetLang,
          // "auto" | "tlang" | "gtx" — anything unrecognized lands on auto.
          mode: (d.mode === "tlang" || d.mode === "gtx") ? d.mode : "auto"
        };
        // Adopt the content-supplied nonce so our posts correlate to THIS
        // sendConfig(); content.js drops any reply with an older nonce.
        if (typeof d.nonce === "number") reqNonce = d.nonce;
        producedForUrl = "";            // force re-produce under new config
        if (sourceUrl && sourceVid === currentVideoId) {
          produceCues(true);            // already captured for this video
        } else {
          armNocuesTimer();             // wait for player's timedtext fetch
          scheduleEarlyNudge(EARLY_TRIES);   // …but on a short, ask the player now
        }
      } else if (d.type === "export-request") {
        // On-demand SRT export: build a COMPLETE bilingual cue set regardless of
        // the live backend mode (see produceExport). Correlated by exportId.
        // Sync video state first so a just-navigated tab can't export the
        // previous video's captured URL.
        checkVideoChange();
        currentVideoId = videoIdFromLocation();
        produceExport(d.targetLang, d.exportId);
      }
    } catch (_e) { /* never throw */ }
  }, false);

  // ---- hook XMLHttpRequest --------------------------------------------------
  try {
    const XHR = XMLHttpRequest.prototype;
    const origOpen = XHR.open;
    const origSend = XHR.send;

    XHR.open = function (method, url) {
      try { this.__ytdsUrl = url; } catch (_e) { /* ignore */ }
      return origOpen.apply(this, arguments);
    };

    XHR.send = function () {
      try { noteTimedtext(this.__ytdsUrl); } catch (_e) { /* ignore */ }
      return origSend.apply(this, arguments);
    };
  } catch (_e) { /* never throw */ }

  // ---- hook fetch -----------------------------------------------------------
  try {
    const origFetch = window.fetch;
    if (typeof origFetch === "function") {
      window.fetch = function (input, init) {
        try {
          let url = "";
          if (typeof input === "string") url = input;
          else if (input && typeof input.url === "string") url = input.url;
          noteTimedtext(url);
        } catch (_e) { /* ignore */ }
        return origFetch.apply(this, arguments);
      };
    }
  } catch (_e) { /* never throw */ }

  // ---- robust capture via Resource Timing ----------------------------------
  // Hook-independent fallback: the player's /api/timedtext request shows up in
  // Resource Timing with its FULL url (incl. pot) regardless of whether it used
  // XHR or fetch — and even if another extension (e.g. an older dual-subtitles
  // build) has locked XMLHttpRequest.prototype.open so our XHR hook never
  // installs. This is the mechanism the rewrite was validated against.
  try {
    const scan = (entries) => {
      for (const e of entries) {
        if (e && typeof e.name === "string" && isTimedtext(e.name)) {
          noteTimedtext(e.name);
        }
      }
    };
    try { scan(performance.getEntriesByType("resource")); } catch (_e) { /* ignore */ }
    if (typeof PerformanceObserver === "function") {
      const po = new PerformanceObserver((list) => {
        try { scan(list.getEntries()); } catch (_e) { /* ignore */ }
      });
      po.observe({ type: "resource", buffered: true });
    }
  } catch (_e) { /* never throw */ }
})();
