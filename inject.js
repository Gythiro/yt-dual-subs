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
  // The source-track URL whose "pot" we reuse. Usually the player's own
  // original-track fetch (no "tlang" param); when the player's selected track
  // is a YouTube auto-translate one, derived from that fetch by dropping its
  // tlang — the pot holds either way (see noteTimedtext).
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
      // Shorts URLs carry the id in the path, not in ?v=. So does /embed/,
      // which the manifest matches and therefore injects into when it is
      // opened as a top-level page. That one used to fall through to ?v=,
      // return "", and leave sourceVid !== currentVideoId true forever —
      // produceCues returned at its second line every time and the extension
      // did nothing at all, without a word.
      // …but not /embed/videoseries (the documented playlist embed) or
      // /embed/live_stream: both are eleven legal id characters, so without
      // the exclusion they parse as a video id that never changes, every post
      // carries a made-up videoId, and produceCues returns forever on exactly
      // the shape this arm was added to cover.
      const m = u.pathname.match(
        /^\/(?:shorts|embed)\/(?!videoseries\b|live_stream\b)([A-Za-z0-9_-]{6,})/);
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
  // The exact URLs we ourselves have on the wire, counted. This used to be a
  // bare counter, which answers "is one of ours in flight" rather than "is
  // THIS one ours" — so any track the PLAYER asked for while we were fetching
  // was discarded along with it, and that track was then never captured at
  // all. On a fast swipe to the next short, that is the difference between
  // subtitles and twenty seconds of nothing (the blank watchdog is the only
  // thing left to notice). Ours always carry fmt=json3, so they cannot
  // collide with the player's own request for the same track.
  const selfUrls = new Map();
  // How long a URL stays "ours" after its fetch settles. The PerformanceObserver
  // reports a request only once its body has finished — later than the
  // `finally` below — so a map cleared there had already forgotten the URL by
  // the time the observer echoed it back, and the echo read as the player
  // fetching a fresh pot. On the tlang branch that fired the deferred retry at
  // once instead of a few seconds later: one extra produce and a duplicate
  // cues post per translation hiccup.
  const SELF_URL_LINGER_MS = 5000;

  // page-context fetch — same-origin youtube.com so pot/signature stay valid.
  async function fetchJson3(url) {
    selfUrls.set(url, (selfUrls.get(url) || 0) + 1);
    let res;
    try {
      // An upper bound, for the same reason the worker's synthesis fetch has
      // one: a request that opens and then goes quiet leaves the `finally`
      // below unreached, so `producing` stays true and this tab never produces
      // cues again — not for this video and not for the next one. Chrome
      // usually fails it eventually; "usually" was the only thing standing
      // between here and a page that has silently stopped working.
      res = await fetch(url, {
        method: "GET", credentials: "include", signal: AbortSignal.timeout(TT_FETCH_TIMEOUT_MS)
      });
    } finally {
      setTimeout(() => {
        const n = (selfUrls.get(url) || 1) - 1;
        if (n > 0) selfUrls.set(url, n); else selfUrls.delete(url);
      }, SELF_URL_LINGER_MS);
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
  const TT_FETCH_TIMEOUT_MS = 20000;
  const RETRY_DELAYS_MS = [300, 800];

  // A 429 from timedtext is the ENDPOINT saying no, not this video. The retries
  // above are per-request and remember nothing, so a run of twenty shorts spent
  // its own three attempts each on an endpoint that had already refused —
  // which is what keeps it refusing. The worker has had a lane with persisted
  // backoff for this since 3.4; this side had nothing at all.
  //
  // What is deliberately NOT done: making a video WAIT. Whatever backoff we
  // guessed would be a guess, and stranding a video for a minute on a guess is
  // worse than one refused request. While the endpoint is known to be
  // rate-limiting, each track gets one attempt instead of three, and the first
  // success clears the mark.
  const TT_LIMIT_MEMORY_MS = 25000;
  let ttLimitedUntil = 0;
  const ttLimited = () => Date.now() < ttLimitedUntil;

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
    // One attempt while the endpoint is known to be refusing; the full three
    // otherwise.
    const tries = ttLimited() ? 0 : RETRY_DELAYS_MS.length;
    for (let i = 0; ; i++) {
      try {
        const out = await fetchJson3(url);
        ttLimitedUntil = 0;            // it answered — stop holding back
        return out;
      } catch (err) {
        // Only from the leg that treats a 429 as worth retrying — the
        // ORIGINAL track. The translation leg's 429s are routine and
        // sticky by this file's own measurement, and are already handled
        // by the deferred second chance; letting them arm this would
        // disarm the orig leg's retries, which is the leg where being
        // refused means no subtitles at all.
        if (retry429 && err && err.status === 429) {
          ttLimitedUntil = Date.now() + TT_LIMIT_MEMORY_MS;
        }
        if (i >= tries || !isHiccup(err, retry429)) throw err;
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

  // One produce at a time. Three separate paths force a re-produce — a config
  // message arriving, the tlang retry timer, and a fresh pot token on the same
  // track — and producedForUrl only ever guarded the NON-forced call. So two
  // of them could run on top of each other: each captured its own nonce, both
  // posted cues, content.js accepted both, and the cue loop restarted twice in
  // the same breath. That is the startup flicker, and the second timedtext
  // fetch is traffic nobody asked for.
  let producing = false;
  let produceAgain = false;
  let produceAgainForce = false;
  async function produceCues(force) {
    if (producing) {
      // Queued, not dropped — and that has to include the NON-forced call.
      // onSourceCaptured() is the only path that turns a freshly sniffed
      // timedtext URL into cues, and it does not force. Dropping it means a
      // viewer who swipes to the next short while the previous video's
      // produce is still in flight gets no cues for the new one until the 20s
      // blank watchdog notices — nothing cheaper can recover, because the
      // nocues timer sees sourceUrl set (it is the NEW video's) and returns.
      // A redundant non-forced replay is free: produceCuesOnce's own
      // `producedForUrl === sourceUrl` guard makes it a no-op.
      produceAgain = true;
      if (force) produceAgainForce = true;
      return;
    }
    producing = true;
    try {
      await produceCuesOnce(force);
    } finally {
      producing = false;
      if (produceAgain) {
        produceAgain = false;
        const again = produceAgainForce;
        produceAgainForce = false;
        produceCues(again);
      }
    }
  }

  // Produce cues (+ optional aligned translation) from the captured source URL.
  async function produceCuesOnce(force) {
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
        // Why the translation leg is missing, when it is: 0 = it isn't (or was
        // never asked), 429 = YouTube is rate-limiting it, anything else = that
        // HTTP status. content.js turns 429 into the cross-video gate and the
        // status line's honest "translation unavailable (rate limited)" — the
        // export leg has carried transStatus for the same reason since it was
        // built.
        tlangStatus: tlangFailed ? tlangStatus : 0,
        // stable track identity (normKey strips pot/fmt/tlang): lets content.js
        // drop cached translations when the TRACK changes on the same video
        // (CC language switch / auto-dub mismatch fix) — same cache keys,
        // different text.
        trackId: normKey(src),
        nonce: myNonce
      });
      // Rendering gtx right now is correct — but come back for the translation
      // once, instead of leaving the whole video on it.
      // 429 is deliberately NOT rescheduled here any more: the same-video
      // 25s force was measured to just meet the same 429 again (the window is
      // minutes, not seconds), and each poke deepens the limit. The cross-
      // video gate in the worker owns rate-limit recovery now; this retry is
      // for hiccups — the blip that a few seconds genuinely fixes.
      if (tlangFailed && tlangStatus !== 429) {
        scheduleTlangReproduce(normKey(src), tlangStatus);
      }
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
      // Ask for the data BEFORE spending the one check this video gets. After a
      // navigation the player's response can still belong to the video being
      // left, or the element can be mid-swap; both answer null for a moment.
      // Marking the video as checked first meant that moment used up its only
      // chance, and every later call — including the ones that would have found
      // the answer — returned at the door. A video that hit it played to the
      // end with captions in a language its audio was never in, and the
      // function whose whole job is to say so said nothing.
      const pr = playerResponseFor(vid);
      const r = pr && pr.captions && pr.captions.playerCaptionsTracklistRenderer;
      if (!r || !Array.isArray(r.captionTracks) || !r.captionTracks.length) return;
      mismatchFor = vid;
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
      if (selfUrls.has(url)) return;         // this exact request is ours
      // Only this page's video. A preview player hovered on the home page, or
      // another player on the page, fetches its own track through the same
      // hook; letting it replace the source made exports fail and language
      // changes fall into the scrape path for the rest of the video (D156).
      const vidHere = videoIdFromLocation();
      if (vidHere && vidOfUrl(url) !== vidHere) return;
      if (hasTlang(url)) {
        // The player's selected track can be one of YouTube's OWN
        // auto-translate tracks ("Russian (auto-generated) >> English"):
        // then every request the player makes carries tlang=, and waiting
        // for a tlang-free URL means waiting forever — six seconds later the
        // video is declared cue-less while a perfectly reusable capture just
        // went by (reported 2026-09-01: a Russian video with that selection
        // preloaded showed no subtitles until a manual track change). The
        // URL minus its tlang IS the source-track URL: lang= still names the
        // source language, and the pot holds for both legs — produceCues has
        // always fetched original AND translation off one captured URL.
        // This branch used to return early on a same-track capture BEFORE
        // refreshing sourceUrl, on the theory that "pot refreshes keep riding
        // the tlang-free branch below". They do not: the whole reason this
        // branch exists is that with such a track selected EVERY player request
        // carries tlang, so every rotated pot landed here and was dropped, and
        // sourceUrl stayed pinned to the first one for the life of the video —
        // a later language change or SRT export then fetched with a stale
        // token. Mirror the plain branch instead: always keep the freshest
        // URL, and let only a track identity change re-produce.
        const key = normKey(url);
        let stripped = "";
        try {
          const u = new URL(url, location.href);
          u.searchParams.delete("tlang");
          stripped = u.toString();
        } catch (_e) { return; }
        sourceUrl = stripped;
        sourceVid = vidOfUrl(url);
        if (key !== sourceKey) {
          sourceKey = key;
          onSourceCaptured();
        } else if (tlangRetryTimer && key === tlangRetriedFor) {
          // Same track, fresh pot, a translation retry still pending — the
          // rescue the plain branch has always had, which this one never did.
          clearTlangRetry();
          if (cfg && cfg.mode !== "gtx") {      // gtx is what was asked for
            producedForUrl = "";
            produceCues(true);
          }
        }
        return;
      }
      // The player's original-track fetch — the plainest pot to reuse.
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
        if (cfg && cfg.mode !== "gtx") {        // gtx is what was asked for
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
  let tlangRetriedFor = "";
  let tlangRetryTimer = null;

  function clearTlangRetry() {
    if (tlangRetryTimer) { clearTimeout(tlangRetryTimer); tlangRetryTimer = null; }
  }

  function scheduleTlangReproduce(trackKey, status) {
    if (status === 429) return;          // rate limits are the gate's job, not a timer's
    if (!trackKey || tlangRetriedFor === trackKey) return;   // one shot per track
    tlangRetriedFor = trackKey;
    clearTlangRetry();
    const vid = currentVideoId;
    const wait = TLANG_RETRY_MS;   // 429 never reaches here: the early-return above
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
            // measured on a real profile as cur=en/asr, no timedtext, a minute
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
  // ---- read-aloud ducking + speed sharing -----------------------------------
  // Lower the player's own audio while a spoken line plays, through the
  // player's API rather than video.volume — YouTube rewrites the element's
  // volume from its own state, so the element is the wrong place to argue.
  // Restore is POLITE: only when the value still sits where we put it. A user
  // who grabbed a control mid-speech has expressed a preference, and stomping
  // it to "restore" would be the louder bug. Both halves therefore remember
  // what they actually SET — never recompute at restore time: the duck depth
  // is a live setting, and the player may snap a rate to its own steps.
  let duckSavedVol = -1;
  let duckRestoreTo = -1;       // give-back ramp's destination (-1 = no ramp):
                                // the only honest "user volume" mid-restore        // the user's volume, to give back
  let duckSetVol = -1;          // the level we are holding (the ramp's target)
  // The 25%↔100% square wave was audible on every dense passage, so the two
  // transitions ramp over ~200ms instead of stepping. Ownership is no longer
  // "volume equals the target" — mid-ramp it never is — but "volume equals
  // the LAST VALUE WE WROTE": any other reading means the user grabbed the
  // slider, and the ramp stops where it stands rather than fighting them
  // (their later duck-off then simply drops the capture, as before).
  let duckLastWrote = -1;       // the polite-ownership comparand
  let duckRampTimer = 0;
  const DUCK_RAMP_MS = 200;
  const DUCK_RAMP_STEPS = 4;
  function duckRampClear() {
    if (duckRampTimer) { clearTimeout(duckRampTimer); duckRampTimer = 0; }
  }
  // A chain of setTimeouts, not setInterval — everything inject schedules runs
  // on setTimeout (the test clock's stated contract), and the chain form means
  // a cleared timer stops the whole ramp mid-flight.
  function duckRampTo(p, target, onDone) {
    duckRampClear();
    const from = p.getVolume();
    if (from === target) { duckLastWrote = target; if (onDone) onDone(); return; }
    let step = 0;
    const tick = () => {
      duckRampTimer = 0;
      let cur;
      try { cur = p.getVolume(); } catch (_e) { return; }
      if (cur !== duckLastWrote && cur !== from) return;   // user grabbed it
      step++;
      const v = step >= DUCK_RAMP_STEPS ? target
        : Math.round(from + (target - from) * step / DUCK_RAMP_STEPS);
      duckLastWrote = v;
      try { p.setVolume(v); } catch (_e) { return; }
      if (step >= DUCK_RAMP_STEPS) { if (onDone) onDone(); return; }
      duckRampTimer = setTimeout(tick, DUCK_RAMP_MS / DUCK_RAMP_STEPS);
    };
    duckRampTimer = setTimeout(tick, DUCK_RAMP_MS / DUCK_RAMP_STEPS);
  }
  function duckVolume(p, on, pct) {
    if (typeof p.getVolume !== "function" || typeof p.setVolume !== "function") return;
    if (on) {
      const share = Math.max(0, Math.min(100, typeof pct === "number" ? pct : 25));
      // A duck landing while the give-back ramp is still climbing must not
      // read the player: mid-ramp it holds a half-restored value, and saving
      // THAT as "the user's volume" walked the audio down a step per line —
      // 80→20→15→5→0 in four boundaries on a real 2x run (2026-09-01), and
      // the zero stuck until the page reloaded. The user's volume is the
      // ramp's TARGET; adopt it and let this duck start from there.
      // …but adopt POLITELY, like every other path here. The ramp stops itself
      // when the user grabs the slider, and it used to leave duckRestoreTo
      // standing — so the next line adopted a value the user had already
      // overruled and pushed the audio back down to a share of it. Their
      // reading is the preference the moment it stops being ours.
      if (duckSavedVol < 0 && duckRestoreTo >= 0) {
        duckRampClear();
        let cur = -1;
        try { cur = p.getVolume(); } catch (_e) { cur = -1; }
        if (duckLastWrote >= 0 && cur === duckLastWrote) {
          duckSavedVol = duckRestoreTo;
          duckRestoreTo = -1;
          duckSetVol = Math.round(duckSavedVol * share / 100);
          duckLastWrote = duckSetVol;
          p.setVolume(duckSetVol);
          return;
        }
        duckRestoreTo = -1;      // not ours any more: drop it and read them
      }
      if (duckSavedVol >= 0) {
        // Already ducked, and the depth moved under us: the popup's two volume
        // sliders sit together, so this one has to answer as promptly as the
        // other — a chasing ramp would lag the drag, so this branch still
        // steps. Recompute from the SAVED volume, never from the ducked one —
        // compounding would walk the audio down to nothing over a long line.
        const want = Math.round(duckSavedVol * share / 100);
        if (want !== duckSetVol && p.getVolume() === duckLastWrote) {
          duckRampClear();
          duckSetVol = want;
          duckLastWrote = want;
          p.setVolume(want);
        }
        return;
      }
      const v = p.getVolume();
      duckSavedVol = v;
      duckSetVol = Math.round(v * share / 100);
      duckLastWrote = v;                 // the ramp starts from their value
      duckRampTo(p, duckSetVol);
    } else {
      if (duckSavedVol < 0) return;
      const giveBack = duckSavedVol;
      if (p.getVolume() === duckLastWrote) {
        duckRestoreTo = giveBack;
        duckRampTo(p, giveBack, () => { duckLastWrote = -1; duckRestoreTo = -1; });
      }
      duckSavedVol = -1; duckSetVol = -1;
    }
  }

  // Speed sharing, one line at a time: when even 1.4× speech cannot fit a cue,
  // content.js sends `fit` — the absolute video rate at which it just would —
  // and the video slows toward it, never below 76% of the user's own rate
  // (the clamp a 200k-user competitor shipped). The moment the rate turns up
  // anywhere we did not put it, the dial moved under us. That used to latch a
  // hands-off for the REST of the video — and the first muted completeness run
  // caught the latch tripping at second zero of a fresh video: YouTube's own
  // session-rate restore (the "remember my speed" write) landed while the
  // first line's fit was already held, read as "the user grabbed the dial",
  // and every rate ask for the whole video was ignored (applied:0, player
  // pinned). Anyone with a remembered non-1x speed and read-aloud on hit the
  // same latch every single video. So a move is an EVENT now, not a state:
  // let go, tell content the new base, and let the next line decide against
  // it. A viewer's explicit choice still wins every gap — we never overwrite
  // it while not holding — and a dense line slowing under them is exactly
  // what the sizing (and D114's completeness mode) is FOR.
  let rateSavedBase = -1;       // the user's own rate, to give back
  let rateSet = -1;             // what the player actually became after our set
  let rateMoved = false;        // the dial moved under a hold JUST NOW (edge,
                                // rides one report; never a lasting hands-off)
  // Who owns the rate right now, said out loud. This side is the only one that
  // knows: content used to work it out by watching the element and reading
  // back our own slowdown as the viewer's choice — three separate bugs from
  // one wrong signal (采样器根修-方案 §二). Quiet when nothing changed, so a
  // per-line duck does not turn into a message storm.
  let rateSaid = "";
  function rateReport(p) {
    let cur = 0;
    try {
      if (p && typeof p.getPlaybackRate === "function") cur = p.getPlaybackRate() || 0;
    } catch (_e) { /* a player mid-teardown answers nothing */ }
    const applied = rateSet >= 0 ? rateSet : 0;
    // The viewer's own rate: what we saved when we took the wheel, or simply
    // what the player is at when we are not holding it.
    const base = rateSavedBase >= 0 ? rateSavedBase : cur;
    const stamp = applied + "|" + base + "|" + (rateMoved ? 1 : 0);
    if (stamp === rateSaid) return;
    rateSaid = stamp;
    post("ttsrate", { applied: applied, base: base, touched: rateMoved });
    rateMoved = false;              // an edge: said once, then over
  }
  function rateRestore(p, cur) {
    if (rateSavedBase < 0) return;
    if (cur === rateSet) p.setPlaybackRate(rateSavedBase);
    else rateMoved = true;          // their new rate stays; content re-learns it
    rateSavedBase = -1; rateSet = -1;
    rateReport(p);
  }
  function shareRate(p, on, fit) {
    if (typeof p.getPlaybackRate !== "function" ||
        typeof p.setPlaybackRate !== "function") return;
    const cur = p.getPlaybackRate();
    if (!on || typeof fit !== "number" || !(fit > 0)) {
      rateRestore(p, cur);                      // line over, or this line fits
      return;
    }
    if (rateSet >= 0 && cur !== rateSet) {      // moved since we set it: let
      rateMoved = true;                         // go, re-learn, next line
      rateSavedBase = -1; rateSet = -1;         // decides against the new base
      // Redundant today — duck() reports after every message, so this state
      // reaches content either way, and a mutation removing this line stays
      // green. Kept because shareRate's own contract is "report what you
      // changed": the day anything else calls it, this is what makes it true.
      rateReport(p);
      return;
    }
    const base = rateSavedBase >= 0 ? rateSavedBase : cur;
    if (fit >= base) {                          // fits at the user's own rate
      rateRestore(p, cur);
      return;
    }
    if (rateSavedBase < 0) rateSavedBase = base;
    // Snap UP to the player's 0.05 steps ourselves: its own snapping rounds
    // DOWN (measured on the real player), which would cut under the floor.
    // The epsilon keeps float dust (0.9*20 = 18.000…004) from ceiling one
    // step too far.
    //
    // The floor here is DEFENSE, not policy: content's sizing already floors
    // its asks (0.76 of the user's rate normally, 0.25 in "read everything"
    // mode — D114). When this line still said 0.76 it silently clamped every
    // completeness ask back up, and the first muted 2x run read over=37/40
    // with the sizing believing fits it never got. A quarter of the user's
    // rate matches the deepest ask content can make; anything below that is
    // a malformed message and gets the old refusal.
    const want = Math.max(0.25 * base, fit);
    p.setPlaybackRate(Math.ceil(want * 20 - 1e-9) / 20);
    rateSet = p.getPlaybackRate();              // read back all the same: the
                                                // comparand is what it BECAME
    if (rateSet === rateSavedBase) { rateSavedBase = -1; rateSet = -1; }
    rateReport(p);
  }

  function duck(on, pct, fit, nav) {
    try {
      const p = activePlayer();
      if (p) {
        duckVolume(p, on, pct);
        shareRate(p, on, fit);
      } else if (!on) {
        // Nothing to hand the capture back to — and this is the ordinary shape
        // of leaving a video, not an edge case: content stops read-aloud, and
        // by the time the message lands YouTube has already replaced the
        // player. Dropping the capture is not merely tidy. Carried forward, the
        // stale saved volume makes the next video's first duck decide it is
        // "already ducked to the right place" and set nothing at all, so the
        // line speaks over full-volume audio with no sign of why.
        duckRampClear();
        // duckRestoreTo with them: a ramp destination that outlives its player
        // is a volume from the previous video waiting to be adopted on this one.
        duckSavedVol = -1; duckSetVol = -1; duckLastWrote = -1; duckRestoreTo = -1;
        rateSavedBase = -1; rateSet = -1;
      }
      if (nav) { rateMoved = false; rateSaid = ""; }  // new video, fresh slate
      if (p) rateReport(p);
    } catch (_e) {
      duckRampClear();
      duckSavedVol = -1; duckSetVol = -1; duckLastWrote = -1; duckRestoreTo = -1;
      rateSavedBase = -1; rateSet = -1;
    }
  }

  window.addEventListener("message", (evt) => {
    try {
      if (evt.source !== window) return;
      const d = evt.data;
      if (!d || d.source !== "ytds-content") return;

      if (d.type === "bye") {
        // The content script's extension was reloaded or removed. Without this
        // the config stayed and every later navigation still fetched and
        // parsed both tracks for a listener that was gone (D156).
        cfg = null;
        try { clearTlangRetry(); } catch (_e) { /* not armed */ }
        return;
      }
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
        // A new config re-produces on its own terms; a deferred translation
        // retry armed under the old one would only produce a second time.
        clearTlangRetry();
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
      } else if (d.type === "ttsDuck") {
        duck(!!d.on, d.pct, d.fit, !!d.nav);
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
