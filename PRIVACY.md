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
Your display preferences — translation language, translation engine, subtitle position, fonts, colors, sizes, and on/off state — are saved using the browser's `chrome.storage.sync` API. This data stays in your own browser profile and is synced by **your browser account** across your own devices. It is **not transmitted to the developer** and contains no personal information.

### 2. Caption text (sent only to the service you chose — to translate, or, on your explicit click, to summarize)
To show a translated line, the extension reads the caption/subtitle text of the video you are **currently watching** and sends that text to a translation service **solely to obtain the translation**, which is then displayed back to you as an overlay. Depending on the engine selected in the settings — chosen by you, or picked per video by the default **Auto** mode:

- **Whole-track engine:** the translation is requested from **YouTube's own** caption-translation endpoint (`youtube.com/api/timedtext`), reusing the request the YouTube player itself already makes.
- **Smart-sentences engine:** the caption text is sent to **Google's public Translate endpoint** (`translate.googleapis.com`) to be translated.
- **Auto (default):** uses the Whole-track engine whenever the video's track can be translated, and the Smart-sentences engine otherwise. With no API key of your own configured, those two endpoints are the only ones ever contacted.
- **Your own provider (optional, off by default):** if — and only if — you enter an API key on the settings page and pick a provider, caption text is sent to **that provider's endpoint instead**, and to no one else. Which provider that is, is entirely your choice; their handling of the text is governed by their own privacy policy.
- **Your own custom endpoint (optional, off by default):** the "Custom (OpenAI-compatible)" provider sends caption text to **whatever server address you type in** — including a model server running on your own computer (`http://localhost` / `http://127.0.0.1`, e.g. Ollama or LM Studio; loopback requests do not leave the machine, which is why these two are the only plain-http addresses the field accepts). Where that text goes is decided by the address you entered, and by nothing else.

Only the caption text of the video you are actively watching is transmitted, and only for the purpose of translating it. The extension does **not** log, store, or transmit this text anywhere else, and the developer never receives it. Requests to YouTube's and Google's endpoints are handled by them under Google's own privacy policy: https://policies.google.com/privacy

**One exception, and it is announced before it happens:** when you export a video's subtitles as an SRT file *and* tick "translate with my own key", the **whole caption track** of that video is sent to your provider — not just the part you have watched. The extension shows you how many requests that will take and asks you to confirm before anything is sent, and the option is off by default.

**The video-summary feature works the same way, and is likewise announced first:** choosing "Summary" in the player menu sends the **whole caption track** to the translation provider **you** configured — your own key, or your own custom endpoint; the free engines are never used for this — solely to produce the chapter summary shown back to you. The panel names that provider and the number of parts before anything is sent, nothing at all is sent until you press the button, and the developer never receives the text.

### 3. Read-aloud text (optional, off by default)

The extension can read translated subtitle lines aloud (text-to-speech). This feature is **off by default** and only works after you enter your own speech API key on the settings page. While it is on, the **translated text of the line currently on screen** is sent to the **one speech provider you selected** — OpenAI, Google Cloud Text-to-Speech, Alibaba Cloud Model Studio (Qwen-TTS), ElevenLabs, or Microsoft Azure Speech — solely to synthesize the audio that is played back to you. If you choose **the browser's own voices** instead, the extension makes no request of its own and no key is involved — it hands the line to the browser and the browser decides how to speak it. Most of those voices are installed on your computer and speak the line there, so it goes nowhere. **A few are not.** Chrome also offers its own online voices (the ones whose names begin with "Google"), and for those the browser sends the line to its maker to be synthesized. The Web Speech API marks the difference with `localService`; the extension does not choose the voice for you, so which kind you are using depends on which voice you picked in the settings page. The text goes to no one else, is not stored by the extension beyond a small in-memory replay cache, and the developer never receives it. The provider's handling of the text is governed by its own privacy policy. Turning the feature off, or removing the key, stops all such requests.

### 4. Your own API key (optional)

If you choose to use your own translation or speech provider, the key you enter is stored with `chrome.storage.local` **on that machine only**. It is deliberately **not** put in `chrome.storage.sync`, so it is never uploaded to your browser account or copied to your other devices. It is used for one thing: the authorization header of requests to the endpoint you selected. It is never sent to the developer — there is no server to send it to — and it is never shared with any other provider. Clearing it in the settings page removes it from the machine.

---

## Permissions and why they are needed

- **`storage`** — to save your subtitle preferences locally (see above), and an API key you choose to add.
- **Host access to `www.youtube.com`** (content scripts) — to display the bilingual subtitle overlay inside the YouTube player and read the active caption track of the video you are watching.
- **Host access to `translate.googleapis.com`** — to fetch machine translations of caption text for the Smart-sentences engine (used automatically when YouTube's own track translation is unavailable, or when selected manually).
- **Optional host access to translation and speech providers** — the extension ships with access to none of them. Each provider's domain (including the endpoints used only for speech — `texttospeech.googleapis.com`, `*.tts.speech.microsoft.com` and `api.elevenlabs.io` — and the two loopback hosts `http://localhost` / `http://127.0.0.1`, which exist solely so a model server on your own machine can be used and whose traffic does not leave that machine) is listed as an *optional* host permission, and Chrome asks you to grant it at the moment you press "Save and test" for that provider. A provider you never choose is never contacted and never granted anything. A custom endpoint on any other domain is not in this list at all: requests to it are only possible if that server itself opts in via CORS.

The extension requests the narrowest permissions needed for these features and nothing more. It does not request access to your tabs, browsing history, or any other websites.

---

## Data sharing

No user data is sold or shared with third parties. The only outbound data is caption text — sent to the translation service **you** have chosen (YouTube's own translation or Google Translate by default, or your own provider if you configured one) **exclusively to produce the translation you asked for**, and, only if you turned read-aloud on, the translated line sent to the speech provider you picked, exclusively to synthesize its audio. Your API key travels with those requests as their authorization header and nowhere else.

---

## Limited Use

The use of information received through this extension adheres to the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq), including the **Limited Use** requirements. Caption text is used only to provide the extension's single, user-facing purpose — displaying bilingual subtitles — and is never used for any other purpose, transferred to the developer, or sold.

---

## The project's website, which is not the extension

Everything above is about the extension. The project also has a website
(the GitHub Pages site linked from the store listing and the repository), and
that is a separate thing with a separate answer: **the website loads Cloudflare
Web Analytics.** The extension does not carry it. But the pages themselves are
ordinary web pages and are counted like ordinary web pages — including the
"what's new" page the extension opens for you after an update, which means the
update does show up there as a visit.

This is stated here because this document is what the website calls its privacy
policy. A policy that only describes the extension, linked from a page that
also measures its readers, would be answering a narrower question than the one
being asked.

## Children's privacy

The extension collects no personal data from anyone, including children.

## Changes to this policy

If this policy changes, the updated version will be posted at this URL with a revised effective date.

## Contact

Questions or concerns: please open an issue at https://github.com/Gythiro/yt-dual-subs/issues

---

*Not affiliated with, endorsed by, or sponsored by YouTube or Google LLC. "YouTube" is a trademark of Google LLC.*
