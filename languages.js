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

  // One line per target language for the read-aloud preview: pressing Preview
  // should let you hear the voice speaking the language you actually read in,
  // not English. Written to be natural in each language rather than translated
  // word for word from one original, and long enough (8-14 words) to carry
  // some prosody. Not i18n strings — these follow the TRANSLATION language,
  // not the interface one, so they live here beside the language table.
  const TTS_SAMPLE = {
    "zh-CN": "这就是朗读出来的声音，你可以先听一听。",
    "zh-TW": "這就是朗讀出來的聲音，你可以先聽看看。",
    "en": "This is the reading voice, so you can hear how it sounds.",
    "ja": "読み上げるとこんな声になります、少し聞いてみてください。",
    "ko": "이게 읽어 주는 목소리예요, 한번 들어 보세요.",
    "es": "Así suena la voz que leerá la traducción, escúchala un momento.",
    "fr": "C'est la voix qui lira la traduction, écoutez-la un instant.",
    "de": "So klingt die Stimme, die den Text vorliest, hör selbst mal hin.",
    "ru": "Так звучит этот голос, которым будет читаться перевод, послушайте.",
    "pt": "Assim soa a voz que vai ler a tradução, ouça um pouco.",
    "it": "Questa è la voce che leggerà la traduzione, ascoltala un attimo.",
    "ar": "هذا هو الصوت الذي سيقرأ الترجمة، استمع إليه قليلا.",
    "hi": "यह अनुवाद पढ़कर सुनाने वाली आवाज़ है, एक बार सुन लीजिए।",
    "id": "Ini suara yang akan membacakan terjemahan, silakan didengar sebentar.",
    "th": "นี่คือเสียงที่จะอ่านออกมา ลองฟังดูสักครู่",
    "vi": "Đây là giọng đọc phần dịch, bạn hãy nghe thử một chút.",
    "nl": "Dit is de voorleesstem, zodat je kunt horen hoe die klinkt.",
    "pl": "Tak brzmi głos, który przeczyta tłumaczenie, posłuchaj chwilę.",
    "tr": "İşte çeviriyi okuyan ses, nasıl olduğunu biraz dinleyin.",
    "uk": "Ось так звучить голос, яким читатиметься переклад, послухайте.",
    "sv": "Så här låter rösten som läser upp texten, lyssna en stund.",
    "da": "Sådan lyder stemmen, der læser teksten op, lyt selv efter.",
    "no": "Slik høres stemmen ut når den leser teksten, så du kan lytte.",
    "fi": "Tämä on ääni, jolla käännös luetaan, kuuntele miltä se kuulostaa.",
    "cs": "Toto je hlas, kterým se bude číst překlad, poslechněte si ho.",
    "el": "Αυτή είναι η φωνή που θα διαβάζει τη μετάφραση, ακούστε την.",
    "hu": "Így hangzik a felolvasó hang, hallgasd meg egy kicsit.",
    "ro": "Așa sună vocea care va citi traducerea, ascultați-o puțin.",
    "bg": "Това е гласът, с който ще се чете преводът, послушайте.",
    "sk": "Toto je hlas, ktorým sa bude čítať preklad, vypočujte si ho.",
    "sl": "To je glas, s katerim se bo bral prevod, poslušajte ga.",
    "hr": "Ovo je glas kojim će se čitati prijevod, poslušajte ga.",
    "sr": "Ово је глас којим ће се читати превод, послушајте га.",
    "lt": "Tai balsas, kuriuo bus skaitomas vertimas, paklausykite jo.",
    "lv": "Šī ir balss, ar kuru lasīs tulkojumu, paklausieties to.",
    "et": "See on ettelugemise hääl, et saaksid kuulata, kuidas see kõlab.",
    "iw": "ככה נשמע הקול שיקריא את התרגום, האזינו רגע.",
    "fa": "این همان صدایی است که ترجمه را می‌خواند، گوش کنید.",
    "bn": "এটাই সেই কণ্ঠস্বর যা অনুবাদ পড়ে শোনাবে, একবার শুনে দেখুন।",
    "ta": "இதுதான் மொழிபெயர்ப்பை உரக்கப் படிக்கும் குரல், ஒருமுறை கேட்டுப் பாருங்கள்.",
    "te": "ఇదే అనువాదాన్ని బిగ్గరగా చదివే స్వరం, ఒకసారి విని చూడండి.",
    "mr": "हा भाषांतर वाचून सांगणारा आवाज आहे, एकदा ऐकून पाहा।",
    "ur": "یہ ترجمہ پڑھ کر سنانے والی آواز ہے، ذرا سن کر دیکھیں۔",
    "ms": "Ini suara yang akan membaca terjemahan, sila dengar sekejap.",
    "fil": "Ganito ang tunog ng boses na magbabasa, pakinggan ninyo sandali.",
    "sw": "Hii ndiyo sauti ya kusoma tafsiri, sikiliza jinsi inavyosikika.",
    "af": "Dit is die voorleesstem, sodat jy kan hoor hoe dit klink.",
    "ca": "Aquesta és la veu que llegirà la traducció, així la pots sentir.",
    "eu": "Hau da itzulpena irakurriko duen ahotsa, entzun pixka bat.",
    "is": "Svona hljómar röddin sem les textann, svo þú getir hlustað."
  };


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
    // Object.create(null), not {}: the caller looks this up BY THE TARGET
    // LANGUAGE CODE, and a plain object answers "constructor" and "toString"
    // with a function. That function's source would then be interpolated into
    // the system prompt. Only our own pages write the target today, so this is
    // a lock rather than a fix — but a lookup table keyed by data has no
    // business inheriting anything.
    englishNames: () => {
      const out = Object.create(null);
      for (const l of LANGS) out[l.code] = l.en;
      return out;
    },
    // A line to speak when previewing a voice, in the language being read.
    sample: (code) => TTS_SAMPLE[code] || TTS_SAMPLE.en,
    // DeepL's own codes; absent means DeepL cannot do it and must say so
    // Same reason, and here the failure is quieter: an inherited function
    // lands in `tl`, JSON.stringify drops it, and the request goes out with no
    // target at all.
    deeplTargets: () => {
      const out = Object.create(null);
      for (const l of LANGS) if (l.deepl) out[l.code] = l.deepl;
      return out;
    }
  };

  root.YTDS_LANGS = API;
})(typeof self !== "undefined" ? self : this);
