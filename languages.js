// languages.js — the one list of target languages, shared by the popup, the
// options page and the worker.
//
// Each entry carries:
//   code    what we store and what YouTube / the free Google endpoint expect
//   native  the name in the language itself — a language is not a country, so
//           there are no flags here: Spanish has no single flag, Arabic has
//           twenty, and any choice for Chinese is a political statement rather
//           than a label. A native name identifies itself and needs no
//           translation into the other UI languages.
//   en      the English name, used in the LLM prompt ("translate into …") and
//           as the secondary line in the picker
//   deepl   DeepL's own target code, or null when DeepL has no target for it —
//           the adapter reports `unsupportedTarget` instead of guessing a
//           neighbouring language.
//
// The popup shows only the languages a user keeps (see DEFAULT_SHOWN); the rest
// live in the options page, which is where they can be added and removed. A
// forty-item native <select> in a 360px popup is not a picker, it is a wall.

(function (root) {
  "use strict";

  const LANGS = [
    // ---- the sixteen that shipped through 3.5 ---------------------------
    { code: "zh-CN", native: "中文（简体）", en: "Simplified Chinese", deepl: "ZH-HANS" },
    { code: "zh-TW", native: "中文（繁體）", en: "Traditional Chinese", deepl: "ZH-HANT" },
    { code: "en", native: "English", en: "English", deepl: "EN-US" },
    { code: "ja", native: "日本語", en: "Japanese", deepl: "JA" },
    { code: "ko", native: "한국어", en: "Korean", deepl: "KO" },
    { code: "es", native: "Español", en: "Spanish", deepl: "ES" },
    { code: "fr", native: "Français", en: "French", deepl: "FR" },
    { code: "de", native: "Deutsch", en: "German", deepl: "DE" },
    { code: "ru", native: "Русский", en: "Russian", deepl: "RU" },
    { code: "pt", native: "Português", en: "Portuguese", deepl: "PT-BR" },
    { code: "it", native: "Italiano", en: "Italian", deepl: "IT" },
    { code: "ar", native: "العربية", en: "Arabic", deepl: "AR" },
    { code: "hi", native: "हिन्दी", en: "Hindi", deepl: "HI" },
    { code: "id", native: "Bahasa Indonesia", en: "Indonesian", deepl: "ID" },
    { code: "th", native: "ไทย", en: "Thai", deepl: "TH" },
    { code: "vi", native: "Tiếng Việt", en: "Vietnamese", deepl: "VI" },

    // ---- added in 3.6 ---------------------------------------------------
    { code: "nl", native: "Nederlands", en: "Dutch", deepl: "NL" },
    { code: "pl", native: "Polski", en: "Polish", deepl: "PL" },
    { code: "tr", native: "Türkçe", en: "Turkish", deepl: "TR" },
    { code: "uk", native: "Українська", en: "Ukrainian", deepl: "UK" },
    { code: "sv", native: "Svenska", en: "Swedish", deepl: "SV" },
    { code: "da", native: "Dansk", en: "Danish", deepl: "DA" },
    { code: "no", native: "Norsk", en: "Norwegian", deepl: "NB" },
    { code: "fi", native: "Suomi", en: "Finnish", deepl: "FI" },
    { code: "cs", native: "Čeština", en: "Czech", deepl: "CS" },
    { code: "el", native: "Ελληνικά", en: "Greek", deepl: "EL" },
    { code: "hu", native: "Magyar", en: "Hungarian", deepl: "HU" },
    { code: "ro", native: "Română", en: "Romanian", deepl: "RO" },
    { code: "bg", native: "Български", en: "Bulgarian", deepl: "BG" },
    { code: "sk", native: "Slovenčina", en: "Slovak", deepl: "SK" },
    { code: "sl", native: "Slovenščina", en: "Slovenian", deepl: "SL" },
    { code: "hr", native: "Hrvatski", en: "Croatian", deepl: "HR" },
    { code: "sr", native: "Српски", en: "Serbian", deepl: "SR" },
    { code: "lt", native: "Lietuvių", en: "Lithuanian", deepl: "LT" },
    { code: "lv", native: "Latviešu", en: "Latvian", deepl: "LV" },
    { code: "et", native: "Eesti", en: "Estonian", deepl: "ET" },
    // "iw", not "he": that is the code YouTube's own caption list uses, and
    // Google's endpoint accepts both — so this is the one that keeps the
    // whole-track path working as well as the client-side one.
    { code: "iw", native: "עברית", en: "Hebrew", deepl: "HE" },
    { code: "fa", native: "فارسی", en: "Persian", deepl: "FA" },
    { code: "bn", native: "বাংলা", en: "Bengali", deepl: "BN" },
    { code: "ta", native: "தமிழ்", en: "Tamil", deepl: "TA" },
    { code: "te", native: "తెలుగు", en: "Telugu", deepl: "TE" },
    { code: "mr", native: "मराठी", en: "Marathi", deepl: "MR" },
    { code: "ur", native: "اردو", en: "Urdu", deepl: "UR" },
    { code: "ms", native: "Bahasa Melayu", en: "Malay", deepl: "MS" },
    { code: "fil", native: "Filipino", en: "Filipino", deepl: "TL" },
    { code: "sw", native: "Kiswahili", en: "Swahili", deepl: "SW" },
    { code: "af", native: "Afrikaans", en: "Afrikaans", deepl: "AF" },
    { code: "ca", native: "Català", en: "Catalan", deepl: "CA" },
    { code: "eu", native: "Euskara", en: "Basque", deepl: "EU" },
    { code: "is", native: "Íslenska", en: "Icelandic", deepl: "IS" }
  ];

  // What a fresh install offers. Exactly the sixteen that shipped through 3.5,
  // so an upgrade changes nothing until the user goes looking.
  const DEFAULT_SHOWN = [
    "zh-CN", "zh-TW", "en", "ja", "ko", "es", "fr", "de",
    "ru", "pt", "it", "ar", "hi", "id", "th", "vi"
  ];

  const byCode = new Map(LANGS.map((l) => [l.code, l]));

  const API = {
    all: () => LANGS.slice(),
    get: (code) => byCode.get(code) || null,
    // Keep the stored order the user arranged, drop anything unknown, and never
    // hand back an empty list — a picker with no options is a dead control.
    shown: (stored) => {
      const list = Array.isArray(stored) ? stored.filter((c) => byCode.has(c)) : [];
      return list.length ? list : DEFAULT_SHOWN.slice();
    },
    defaults: () => DEFAULT_SHOWN.slice(),
    // name -> LLM prompt ("Translate ... into Simplified Chinese")
    englishNames: () => {
      const out = {};
      for (const l of LANGS) out[l.code] = l.en;
      return out;
    },
    // DeepL's own codes; absent means DeepL cannot do it and must say so
    deeplTargets: () => {
      const out = {};
      for (const l of LANGS) if (l.deepl) out[l.code] = l.deepl;
      return out;
    }
  };

  root.YTDS_LANGS = API;
})(typeof self !== "undefined" ? self : this);
