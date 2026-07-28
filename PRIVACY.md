# Privacy Policy — Dual Subtitles for YouTube™

**Effective date:** 27 July 2026
**Extension:** Dual Subtitles for YouTube™ (Chrome / Chromium browser extension)
**Developer:** Gythiro · Source code: https://github.com/Gythiro/yt-dual-subs

This extension is built to be private by design. It has **no account system, no analytics, no tracking, no advertising, and no server operated by the developer.** Everything runs locally in your browser.

---

## What the extension does NOT collect

The developer does **not** collect, store, receive, sell, or share any personal or sensitive user data. Specifically, the extension does **not** collect:

- personally identifiable information (name, email, address, ID numbers);
- authentication information, passwords, or cookies. If you choose to use your
  own translation provider, the API key you enter is stored on your own machine
  and sent only to that provider — it is never transmitted to the developer, who
  has no server to receive it (see "Your own API key" below);
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
To show a translated line, the extension reads the caption/subtitle text of the video you are **currently watching** and sends that text to a translation service **solely to obtain the translation**, which is then displayed back to you as an overlay. Depending on the engine selected in the settings — chosen by you, or picked per video by the default **Auto** mode:

- **Whole-track engine:** the translation is requested from **YouTube's own** caption-translation endpoint (`youtube.com/api/timedtext`), reusing the request the YouTube player itself already makes.
- **Smart-sentences engine:** the caption text is sent to **Google's public Translate endpoint** (`translate.googleapis.com`) to be translated.
- **Auto (default):** uses the Whole-track engine whenever the video's track can be translated, and the Smart-sentences engine otherwise. With no API key of your own configured, those two endpoints are the only ones ever contacted.
- **Your own provider (optional, off by default):** if — and only if — you enter an API key on the settings page and pick a provider, caption text is sent to **that provider's endpoint instead**, and to no one else. Which provider that is, is entirely your choice; their handling of the text is governed by their own privacy policy.

Only the caption text of the video you are actively watching is transmitted, and only for the purpose of translating it. The extension does **not** log, store, or transmit this text anywhere else, and the developer never receives it. Requests to YouTube's and Google's endpoints are handled by them under Google's own privacy policy: https://policies.google.com/privacy

**One exception, and it is announced before it happens:** when you export a video's subtitles as an SRT file *and* tick "translate with my own key", the **whole caption track** of that video is sent to your provider — not just the part you have watched. The extension shows you how many requests that will take and asks you to confirm before anything is sent, and the option is off by default.

### 3. Your own API key (optional)

If you choose to use your own translation provider, the key you enter is stored with `chrome.storage.local` **on that machine only**. It is deliberately **not** put in `chrome.storage.sync`, so it is never uploaded to your browser account or copied to your other devices. It is used for one thing: the authorization header of requests to the endpoint you selected. It is never sent to the developer — there is no server to send it to — and it is never shared with any other provider. Clearing it in the settings page removes it from the machine.

---

## Permissions and why they are needed

- **`storage`** — to save your subtitle preferences locally (see above), and an API key you choose to add.
- **Host access to `www.youtube.com`** (content scripts) — to display the bilingual subtitle overlay inside the YouTube player and read the active caption track of the video you are watching.
- **Host access to `translate.googleapis.com`** — to fetch machine translations of caption text for the Smart-sentences engine (used automatically when YouTube's own track translation is unavailable, or when selected manually).
- **Optional host access to translation providers** — the extension ships with access to none of them. Each provider's domain is listed as an *optional* host permission, and Chrome asks you to grant exactly one of them at the moment you press "Save and test" for that provider. A provider you never choose is never contacted and never granted anything.

The extension requests the narrowest permissions needed for these features and nothing more. It does not request access to your tabs, browsing history, or any other websites.

---

## Data sharing

No user data is sold or shared with third parties. The only outbound data is caption text, sent to the translation service **you** have chosen — YouTube's own translation or Google Translate by default, or your own provider if you configured one — **exclusively to produce the translation you asked for.** Your API key travels with those requests as their authorization header and nowhere else.

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
