# YT Dual Subs

> Bilingual subtitles for YouTube — the original language and your translation shown together as a single, non‑overlapping layer that switches cleanly sentence by sentence.

**中文说明 → [README.zh-CN.md](README.zh-CN.md)**

A clean‑room, open‑source **Manifest V3** extension. It reads the video's real caption track, translates it, and renders both languages in one tidy overlay you can fully style and drag — no overlap, no word‑by‑word flicker.

---

## Features

- **Dual subtitles, one layer.** Original on one line, your language on the other. YouTube's own caption layer is hidden, so the two never overlap.
- **Per‑sentence, no jitter.** Renders from the timed caption *cues* (not the rolling on‑screen text), so lines switch by whole sentence instead of flickering word by word.
- **Two translation engines.** YouTube's own whole‑track translation (perfectly aligned, instant), with automatic fallback to Google Translate's free endpoint — prefetched ahead of playback so there's no lag.
- **Fully customizable.** Per‑line font, size, text colour, background colour + opacity, outline, line spacing, and which line sits on top. Live preview in the popup.
- **Draggable.** Grab the handle and drop the subtitle box anywhere on the video; it persists, double‑click to reset. Works in fullscreen.
- **One‑click toggle.** A button in the player's control bar turns the whole thing on/off (and YouTube's CC with it) — handy for videos with burned‑in subtitles.
- **Export to SRT.** Download the current video's subtitles as a standard `.srt` file — original, translation, or bilingual — straight from the popup.
- **Robust.** Survives SPA navigation, falls back to reading the on‑screen caption text if the cue fetch ever fails, and turns YouTube captions on for you automatically.

## How it works

YouTube serves caption tracks from an `/api/timedtext` endpoint that now requires a per‑request **proof‑of‑origin token** (`pot`). An extension can't just fetch a track URL on its own — it gets an empty response. So instead:

1. A MAIN‑world script (`inject.js`) passively watches the page (XHR, `fetch`, and Resource Timing) and captures the **player's own** timedtext request, which already carries a valid `pot`.
2. It re‑fetches that exact URL as `json3` for the original cues, and again with `&tlang=` for YouTube's translation — aligned cue‑for‑cue.
3. `content.js` drives an overlay off `video.currentTime`, showing the right sentence and its translation at the right moment, and hides YouTube's native caption layer so there's a single, non‑overlapping line set.
4. If the cue fetch ever fails, it falls back to reading the on‑screen caption text directly.

## Install (load unpacked)

1. **Download the latest release ZIP** from the [Releases page](https://github.com/Gythiro/yt-dual-subs/releases/latest) and unzip it. *(Prefer the command line? `git clone` works too.)*
2. Open `chrome://extensions`.
3. Turn on **Developer mode** (top‑right).
4. Click **Load unpacked** and select the unzipped folder.
5. Open a YouTube video with captions — the subtitles appear automatically (the extension turns captions on for you).

Works on Chrome, Edge, and other Chromium browsers. Requires Chrome 111+ (for the MAIN‑world content script).

## Usage

- **Toolbar icon** → settings popup: target language, translation engine, line order, position, spacing, and per‑line styling, all with a live preview.
- **Control‑bar button** (the caption icon next to the gear): one‑click on/off. Blue = on, grey = off.
- **Drag** the subtitle box by its handle (appears top‑left when you hover the player); **double‑click** the handle to reset its position.
- **Export** (popup → *Export*): download the subtitles as an `.srt` file — choose original, translation, or bilingual.

## Translation engines

| | Whole‑sentence (`tlang`) — default | Per‑sentence (`gtx`) |
|---|---|---|
| Source | YouTube's own server‑side translation | Google Translate's free endpoint |
| Alignment | Perfect, cue‑for‑cue | Per sentence (prefetched) |
| Best for | Highest quality + instant | When YouTube can't translate a track, or you prefer Google's wording |
| Note | Auto‑falls back to `gtx` when a track isn't translatable | Unofficial endpoint — heavy use may be rate‑limited |

## Limitations

- Needs a real caption track. **Burned‑in** subtitles (baked into the video pixels) can't be hidden — use the control‑bar toggle to switch the overlay off for those videos.
- The Google fallback uses an unofficial endpoint with no SLA; heavy use may be rate‑limited.
- Depends on YouTube's current behaviour; a major YouTube change may require a selector update.

## Privacy

No analytics, no tracking, no accounts. Caption text is sent **only** to the translation service you choose (YouTube's own, or Google Translate) to be translated. Settings are stored in `chrome.storage.sync`.

## Development

Plain vanilla JS/CSS — no build step, no dependencies.

| File | Role |
|---|---|
| `inject.js` | MAIN‑world sniffer: captures the player's pot‑bearing timedtext URL, fetches cues + translation |
| `content.js` | Overlay, cue engine, drag, control‑bar toggle, rendered‑scrape fallback |
| `background.js` | Translation service worker (Google endpoint) |
| `popup.html/.css/.js` | Settings UI with live preview |
| `content.css` | Overlay styling + native‑caption suppression |

## Credits

A clean‑room reimplementation inspired by the (closed‑source, discontinued) *YouTube™ Dual Subtitles* — built from scratch without using its code, with the overlap and word‑by‑word jitter problems solved at the source.

## License

[MIT](LICENSE).
