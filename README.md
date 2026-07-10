<div align="center">

<a href="https://gythiro.github.io/yt-dual-subs/"><img src="https://gythiro.github.io/yt-dual-subs/img/icon128.png" width="110" alt="Dual Subtitles for YouTube icon"></a>

# Dual Subtitles for YouTube™

**Watch in two languages at once — the original and your translation in one clean, non‑overlapping layer that switches sentence by sentence.**

[![Chrome Web Store version](https://img.shields.io/chrome-web-store/v/ndifcigakimmibkgeabchfaolhjpcmge?style=flat-square&logo=googlechrome&logoColor=white&label=chrome%20web%20store)](https://chromewebstore.google.com/detail/dual-subtitles-for-youtub/ndifcigakimmibkgeabchfaolhjpcmge)
[![License: MIT](https://img.shields.io/badge/license-MIT-green?style=flat-square)](LICENSE)

<a href="https://chromewebstore.google.com/detail/dual-subtitles-for-youtub/ndifcigakimmibkgeabchfaolhjpcmge"><img src="https://img.shields.io/badge/Install-Chrome%20Web%20Store-4285F4?style=for-the-badge&logo=googlechrome&logoColor=white" alt="Install from the Chrome Web Store"></a>&nbsp;&nbsp;<a href="https://gythiro.github.io/yt-dual-subs/"><img src="https://img.shields.io/badge/Official%20Website-gythiro.github.io-2ea44f?style=for-the-badge" alt="Official Website"></a>&nbsp;&nbsp;<a href="README.zh-CN.md"><img src="https://img.shields.io/badge/%E4%B8%AD%E6%96%87%E6%96%87%E6%A1%A3-README.zh--CN-orange?style=for-the-badge" alt="中文文档"></a>

English | [简体中文](README.zh-CN.md)

<br>

<img src="https://gythiro.github.io/yt-dual-subs/img/screenshot-overlay.png" width="800" alt="Dual-language subtitles shown over a YouTube video — original English line above, translated line below, in a single overlay">

<sub>A clean‑room, open‑source <b>Manifest V3</b> extension. It reads the video's real caption track, translates it, and renders both languages in one tidy overlay you can fully style and drag.</sub>

</div>

---

> [!IMPORTANT]
> **No analytics, no tracking, no accounts.** Caption text is sent *only* to the translation service in use (YouTube's own, or Google Translate — picked per video by Auto mode, or pinned by you) to be translated. Settings live in `chrome.storage.sync` — nothing else leaves your browser.

## ✨ What you get

<table>
<tr>
<td width="50%" valign="top" align="center">

<h3>One layer. Zero overlap. Zero flicker.</h3>

<img src="https://gythiro.github.io/yt-dual-subs/img/compare-en.png" width="400" alt="Before and after: other tools let the two caption lines collide; Dual Subtitles for YouTube keeps them cleanly separated">

</td>
<td width="50%" valign="top" align="center">

<h3>Every line, styled your way.</h3>

<img src="https://gythiro.github.io/yt-dual-subs/img/screenshot-popup.png" width="320" alt="The settings popup with live preview: target language, engine toggle, and layout controls">

</td>
</tr>
<tr>
<td valign="top">

- **Dual subtitles, one layer** — original on one line, your language on the other. YouTube's own caption layer is hidden, so the two never overlap.
- **Per‑sentence, no jitter** — renders from the timed caption *cues* (not the rolling on‑screen text), so lines switch by whole sentence instead of flickering word by word.
- **Two engines, smart default** — YouTube's own whole‑track translation whenever the video supports it, with a much smarter fallback: fragmented captions are **rebuilt into full sentences** before Google translates them, so ASR fragments stop reading like word salad. Prefetched ahead of playback.
- **16 target languages** to choose from.

</td>
<td valign="top">

- **Fully customizable** — per‑line font, size, text colour, background colour + opacity, outline, line spacing, and which line sits on top. Live preview in the popup.
- **Draggable** — drop the subtitle box anywhere on the video; it persists, double‑click to reset. Works in fullscreen.
- **One‑click toggle** — a button right in the player's control bar turns everything on/off (and YouTube's CC with it).
- **Export to SRT** — download the current video's subtitles as `.srt`: original, translation, or bilingual.
- **Robust by design** — survives SPA navigation, falls back to reading the on‑screen caption text if the cue fetch ever fails, and turns YouTube captions on for you automatically.

</td>
</tr>
</table>

## 🚀 Install

**[➜ Install from the Chrome Web Store](https://chromewebstore.google.com/detail/dual-subtitles-for-youtub/ndifcigakimmibkgeabchfaolhjpcmge)** — one click, and it auto‑updates.

Then open any YouTube video with captions: the dual subtitles appear automatically (the extension turns captions on for you).

Works on **Chrome, Edge, and other Chromium browsers**, version 111+ (required for the MAIN‑world content script).

<details>
<summary><b>🧑‍💻 Load unpacked (for developers)</b></summary>

1. **Download the latest release ZIP** from the [Releases page](https://github.com/Gythiro/yt-dual-subs/releases/latest) and unzip it. *(Prefer the command line? `git clone` works too.)*
1. Open `chrome://extensions`.
1. Turn on **Developer mode** (top‑right).
1. Click **Load unpacked** and select the unzipped folder.
1. Open a YouTube video with captions — the subtitles appear automatically.

> ⚠️ **Getting "Manifest file is missing or unreadable"?** This almost always means the archive was extracted into a **nested folder** (`yt-dual-subs\yt-dual-subs\`). Keep opening the folder until you see `manifest.json` directly inside, and select *that* level. Prefer the ZIP from the **Releases page** (it unzips to a single folder) over the green **Code** button's source download, and make sure you actually **extracted** the ZIP rather than loading from inside the archive.

</details>

## 🌐 Official Website

**[gythiro.github.io/yt-dual-subs](https://gythiro.github.io/yt-dual-subs/)** — the extension's home page, in **English and 中文**: a visual tour of the features, install links, and the latest updates, all on one page. If you're sending this extension to a friend, send them there.

## ⚙️ Usage

- **Toolbar icon** → settings popup: target language, translation engine, line order, position, spacing, and per‑line styling — all with a live preview.
- **Control‑bar button** (the caption icon next to the gear): one‑click on/off. Blue = on, grey = off.
- **Drag** the subtitle box by its handle (appears top‑left when you hover the player); **double‑click** the handle to reset its position.
- **Export** (popup → *Export*): download the subtitles as an `.srt` file — choose original, translation, or bilingual.

## 📖 The fine print

<details>
<summary><b>🔬 How it works</b></summary>

YouTube serves caption tracks from an `/api/timedtext` endpoint that now requires a per‑request **proof‑of‑origin token** (`pot`). An extension can't just fetch a track URL on its own — it gets an empty response. So instead:

1. A MAIN‑world script (`inject.js`) passively watches the page (XHR, `fetch`, and Resource Timing) and captures the **player's own** timedtext request, which already carries a valid `pot`.
1. It re‑fetches that exact URL as `json3` for the original cues, and again with `&tlang=` for YouTube's translation — aligned cue‑for‑cue.
1. `content.js` drives an overlay off `video.currentTime`, showing the right sentence and its translation at the right moment, and hides YouTube's native caption layer so there's a single, non‑overlapping line set.
1. If the cue fetch ever fails, it falls back to reading the on‑screen caption text directly.

</details>

<details>
<summary><b>🔁 Translation engines compared</b></summary>

The default **Auto** mode uses Whole‑track whenever the video's track can be translated, and switches to Smart sentences when it can't. Either engine can also be pinned manually in the popup — Smart sentences is worth a try when the whole‑track wording reads badly.

| | Whole‑track (YouTube) | Smart sentences (Google) |
|---|---|---|
| Source | YouTube's own server‑side track translation | Google Translate's free endpoint |
| How | Translates the whole track server‑side — perfectly aligned, cue for cue | **Rebuilds full sentences** from the caption fragments first, then translates whole sentences |
| Best for | Most videos — the default | Tracks YouTube can't translate, or fragmented auto‑captions whose whole‑track wording reads badly |
| Note | Quality varies with how YouTube segments the track | Unofficial endpoint — heavy use may be briefly rate‑limited; the extension paces itself and retries on its own |

</details>

<details>
<summary><b>⏳ Translations occasionally pause?</b></summary>

The Smart‑sentences engine uses Google's free public endpoint. Under heavy use — long videos, lots of seeking — it may briefly rate‑limit your IP. The extension notices, slows down, and retries on its own: the translation line shows "…" while it waits, and translations resume automatically, usually within seconds to a couple of minutes. Already‑translated sentences stay cached. If the video supports it, pinning **Whole‑track (YouTube)** in the popup avoids the free endpoint entirely. SRT export is unaffected — it uses a different path.

</details>

<details>
<summary><b>⚠️ Limitations</b></summary>

- Needs a real caption track. **Burned‑in** subtitles (baked into the video pixels) can't be hidden — use the control‑bar toggle to switch the overlay off for those videos.
- The Smart‑sentences engine uses an unofficial Google endpoint with no SLA; heavy use may be briefly rate‑limited (the extension backs off and recovers on its own).
- Depends on YouTube's current behaviour; a major YouTube change may require a selector update.

</details>

<details>
<summary><b>🛠 Development</b></summary>

Plain vanilla JS/CSS — no build step, no dependencies.

| File | Role |
|---|---|
| `inject.js` | MAIN‑world sniffer: captures the player's pot‑bearing timedtext URL, fetches cues + translation |
| `content.js` | Overlay, cue engine, drag, control‑bar toggle, rendered‑scrape fallback |
| `background.js` | Translation service worker (Google endpoint) |
| `popup.html/.css/.js` | Settings UI with live preview |
| `content.css` | Overlay styling + native‑caption suppression |

Issues and pull requests are welcome — [open one here](https://github.com/Gythiro/yt-dual-subs/issues).

</details>

## 🔒 Privacy

No analytics, no tracking, no accounts. Caption text is sent **only** to the translation service you choose; settings are stored in `chrome.storage.sync`. Full policy: [PRIVACY.md](PRIVACY.md).

## 🙏 Credits

A clean‑room reimplementation inspired by the (closed‑source, discontinued) *YouTube™ Dual Subtitles* — built from scratch without using its code, with the overlap and word‑by‑word jitter problems solved at the source.

## 📜 License

[MIT](LICENSE).

---

<sub>*Not affiliated with, endorsed by, or sponsored by YouTube or Google LLC. "YouTube" is a trademark of Google LLC, used here only to describe compatibility.*</sub>

<p align="right"><a href="#readme">↑ Back to top</a></p>
