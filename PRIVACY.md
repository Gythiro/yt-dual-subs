# Privacy Policy — Dual Subtitles for YouTube™

**Effective date:** 4 July 2026
**Extension:** Dual Subtitles for YouTube™ (Chrome / Chromium browser extension)
**Developer:** Gythiro · Source code: https://github.com/Gythiro/yt-dual-subs

This extension is built to be private by design. It has **no account system, no analytics, no tracking, no advertising, and no server operated by the developer.** Everything runs locally in your browser.

---

## What the extension does NOT collect

The developer does **not** collect, store, receive, sell, or share any personal or sensitive user data. Specifically, the extension does **not** collect:

- personally identifiable information (name, email, address, ID numbers);
- authentication information, passwords, or cookies;
- financial or payment information;
- health information;
- your personal communications;
- your location;
- your general web browsing history or activity across sites.

There is **no developer-operated backend**. No data is ever sent to the developer.

---

## Data the extension processes locally

### 1. Your settings (stored locally in your browser)
Your display preferences — target language, translation engine, subtitle position, fonts, colors, sizes, and on/off state — are saved using the browser's `chrome.storage.sync` API. This data stays in your own browser profile and is synced by **your browser account** across your own devices. It is **not transmitted to the developer** and contains no personal information.

### 2. Caption text (sent only to the translation service, only to translate)
To show a translated line, the extension reads the caption/subtitle text of the video you are **currently watching** and sends that text to a translation service **solely to obtain the translation**, which is then displayed back to you as an overlay. Depending on the engine you select in the settings:

- **Whole-sentence engine (default):** the translation is requested from **YouTube's own** caption-translation endpoint (`youtube.com/api/timedtext`), reusing the request the YouTube player itself already makes.
- **Per-sentence engine (fallback):** the caption text is sent to **Google's public Translate endpoint** (`translate.googleapis.com`) to be translated.

Only the caption text of the video you are actively watching is transmitted, and only for the purpose of translating it. The extension does **not** log, store, or transmit this text anywhere else, and the developer never receives it. These requests are handled by Google/YouTube under Google's own privacy policy: https://policies.google.com/privacy

---

## Permissions and why they are needed

- **`storage`** — to save your subtitle preferences locally (see above).
- **Host access to `www.youtube.com`** (content scripts) — to display the bilingual subtitle overlay inside the YouTube player and read the active caption track of the video you are watching.
- **Host access to `translate.googleapis.com`** — to fetch machine translations of caption text for the per-sentence fallback engine.

The extension requests the narrowest permissions needed for these features and nothing more. It does not request access to your tabs, browsing history, or any other websites.

---

## Data sharing

No user data is sold or shared with third parties. The only outbound data is the caption text of the currently-watched video, sent to the chosen translation service (YouTube's own translation, or Google Translate) **exclusively to produce the translation you asked for.**

---

## Limited Use

The use of information received through this extension adheres to the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq), including the **Limited Use** requirements. Caption text is used only to provide the extension's single, user-facing purpose — displaying bilingual subtitles — and is never used for any other purpose, transferred to the developer, or sold.

---

## Children's privacy

The extension collects no personal data from anyone, including children.

## Changes to this policy

If this policy changes, the updated version will be posted at this URL with a revised effective date.

## Contact

Questions or concerns: please open an issue at https://github.com/Gythiro/yt-dual-subs/issues

---

*Not affiliated with, endorsed by, or sponsored by YouTube or Google LLC. "YouTube" is a trademark of Google LLC.*
