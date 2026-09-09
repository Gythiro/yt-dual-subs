// fonts.js — the one place that knows about subtitle fonts, shared by the
// content script (which only renders), the popup (which offers) and the
// options page (which manages).
//
// Three jobs:
//   1. PROBE — for each target language, the letters a font has to be able to
//      draw before it may be offered for a line in that language. A font that
//      is offered and cannot draw the line is worse than none: the browser
//      swaps glyphs in from somewhere else, silently, and the picker looks
//      like it worked. The user's rule (2026-09-04): what can be picked must
//      exist on this computer and must really draw this line.
//   2. css() — the ONE way a stored font value becomes a CSS font-family. A
//      font name is a string that came from outside (the OS, or later a file
//      the user imported), and font-family is the only place this extension
//      writes an outside string into CSS. Measured 2026-09-04: an unescaped
//      name can carry arbitrary declarations into YouTube's subtitle layer.
//   3. probe() — measures whether a font can draw a language's PROBE string,
//      using two tiny fonts this extension ships as rulers (fonts/anchor-*.ttf).
//      Why rulers of our own: the browser fills in missing glyphs from the
//      NEXT family in the list. Put the candidate first and one of our rulers
//      second, and every letter the candidate lacks is drawn by the ruler.
//      The wide ruler and the narrow ruler have different advance widths, so
//      the line measures the same under both exactly when the candidate drew
//      every letter itself. System fonts cannot be the ruler: which one the
//      OS falls through to differs per platform, and an earlier attempt
//      built on that could not tell 87% of the non-Latin cases apart.
//
// Values stored in origFont / transFont:
//   "system", "roboto", … the fifteen keys that shipped through 3.6 (LEGACY)
//   "f:<fontId>"          a font from this computer, by the id the browser
//                         uses in CSS. NOT the display name: on a Chinese
//                         Windows the list says 「微软雅黑」 but CSS only
//                         resolves "Microsoft YaHei" (21 such pairs measured on
//                         a real Windows 11, 2026-09-04).

(function (root) {
  "use strict";

  // ---- 1. what each language's line needs ---------------------------------
  // Base letters per writing system, then the letters a particular language
  // adds. Vietnamese is the reason this is per language and not per script:
  // its stacked tones (ế ữ ộ) are precomposed code points that many Latin
  // fonts simply do not carry — a French-capable font is not a
  // Vietnamese-capable one. Measured 2026-09-04: with one shared ASCII probe,
  // 21% of the fonts offered for French could not draw French.
  const LATIN = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.,!?:;'\"()-";
  const CYRL = "АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдежзийклмнопрстуфхцчшщъыьэюя";
  const GREK = "ΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩαβγδεζηθικλμνξοπρστυφχψωςάέήίόύώϊϋΐΰ";
  // Simplified Chinese: everyday characters, weighted towards the forms that
  // only exist in the simplified set (这 们 说 会 …) — those are the ones a
  // Japanese or Traditional-only font lacks.
  const HANS = "的一是不了在人有我他这个们中来上大为和国说时要就出会可也你对生能过发后作里用道行学如都现当没动面还进关点业将两问头体见产讨论电话车马书语汉让谢什么";
  // Traditional: the same everyday set in its traditional forms, plus 臺灣.
  const HANT = "的一是不了在人有我他這個們中來上大為和國說時要就出會可也你對生能過發後作裡用道行學如都現當沒動面還進關點業將兩問頭體見產討論電話車馬書語漢讓謝什麼臺灣";
  // Japanese: both kana sets, everyday kanji, and a few kokuji / Japanese
  // simplifications (気 込 働 畑 枠) that a Chinese font does not carry.
  const JPAN = "あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをんがぎぐげござじずぜぞだぢづでどばびぶべぼぱぴぷぺぽぁぃぅぇぉっゃゅょアイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲンガギグゲゴザジズゼゾダヂヅデドバビブベボパピプペポァィゥェォッャュョー日本語字幕私達彼女言葉時間今度直角骨社会気込働畑枠";
  const HANG = "가나다라마바사아자차카타파하한국어자막언어번역글씨체영상시간됐었겠읽";
  const ARAB = "ابتثجحخدذرزسشصضطظعغفقكلمنهويءآأؤإئةىلا";
  const FARS = "پچژگکی";
  const HEBR = "אבגדהוזחטיךכלםמןנסעףפץצקרשת";
  const THAI = "กขคฆงจฉชซฌญฎฏฐฑฒณดตถทธนบปผฝพฟภมยรลวศษสหฬอฮะัาำิีึืุูเแโใไๅๆ็่้๊๋์ํ๐๑๒";
  const DEVA = "अआइईउऊएऐओऔकखगघङचछजझञटठडढणतथदधनपफबभमयरलवशषसहक्षज्ञड़ढ़ािीुूेैोौंःँ्";
  const BENG = "অআইঈউঊঋএঐওঔকখগঘঙচছজঝঞটঠডঢণতথদধনপফবভমযরলশষসহড়ঢ়য়ৎািীুূৃেৈোৌংঃঁ্";
  const TAML = "அஆஇஈஉஊஎஏஐஒஓஔகஙசஞடணதநபமயரலவழளறனஜஷஸஹாிீுூெேைொோௌ்ஃ";
  const TELU = "అఆఇఈఉఊఋఎఏఐఒఓఔకఖగఘఙచఛజఝఞటఠడఢణతథదధనపఫబభమయరలవశషసహళాిీుూృెేైొోౌం్";

  const PROBE = {
    "zh-CN": HANS,
    "zh-TW": HANT,
    en: LATIN,
    ja: JPAN,
    ko: HANG,
    es: LATIN + "áéíóúüñÁÉÍÓÚÑ¿¡",
    fr: LATIN + "àâæçéèêëîïôœùûüÀÂÇÉÈÊËÎÏÔŒÙÛÜ",
    de: LATIN + "äöüßÄÖÜ",
    ru: CYRL + "ёЁ",
    pt: LATIN + "ãõçáâêéíóôúÃÕÇÁÂÊÉÍÓÔÚ",
    it: LATIN + "àèéìòùÀÈÉÌÒÙ",
    ar: ARAB,
    hi: DEVA,
    id: LATIN,
    th: THAI,
    vi: LATIN + "ăâđêôơưĂÂĐÊÔƠƯáàảãạắằẳẵặấầẩẫậéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵ",
    nl: LATIN + "éëïöüÉËÏÖÜ",
    pl: LATIN + "ąćęłńóśźżĄĆĘŁŃÓŚŹŻ",
    tr: LATIN + "çğıİöşüÇĞÖŞÜ",
    uk: CYRL + "ґєіїҐЄІЇ",
    sv: LATIN + "åäöÅÄÖ",
    da: LATIN + "æøåÆØÅ",
    no: LATIN + "æøåÆØÅ",
    fi: LATIN + "äöåÄÖÅ",
    cs: LATIN + "áčďéěíňóřšťúůýžÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ",
    el: GREK,
    hu: LATIN + "áéíóöőúüűÁÉÍÓÖŐÚÜŰ",
    ro: LATIN + "ăâîșțĂÂÎȘȚ",
    bg: CYRL,
    sk: LATIN + "áäčďéíĺľňóôŕšťúýžÁÄČĎÉÍĹĽŇÓÔŔŠŤÚÝŽ",
    sl: LATIN + "čšžČŠŽ",
    hr: LATIN + "čćđšžČĆĐŠŽ",
    sr: CYRL + "ђјљњћџЂЈЉЊЋЏ",
    lt: LATIN + "ąčęėįšųūžĄČĘĖĮŠŲŪŽ",
    lv: LATIN + "āčēģīķļņšūžĀČĒĢĪĶĻŅŠŪŽ",
    et: LATIN + "äöõüšžÄÖÕÜŠŽ",
    iw: HEBR,
    fa: ARAB + FARS,
    bn: BENG,
    ta: TAML,
    te: TELU,
    mr: DEVA + "ळ",
    ur: ARAB + FARS + "ٹڈڑںھےۓ",
    ms: LATIN,
    fil: LATIN + "ñÑ",
    sw: LATIN,
    af: LATIN + "êëïôöûÊËÏÔÖÛ",
    ca: LATIN + "àçèéíïòóúüÀÇÈÉÍÏÒÓÚÜ·",
    eu: LATIN + "ñÑ",
    is: LATIN + "áðéíóúýþæöÁÐÉÍÓÚÝÞÆÖ"
  };

  // Writing-system group of each language, for the default-order table.
  const SCRIPT = {
    "zh-CN": "hans", "zh-TW": "hant", ja: "jpan", ko: "hangul",
    ru: "cyrillic", uk: "cyrillic", bg: "cyrillic", sr: "cyrillic",
    el: "greek", ar: "arabic", fa: "arabic", ur: "urdu", iw: "hebrew", th: "thai",
    hi: "deva", mr: "deva", bn: "bengali", ta: "tamil", te: "telugu"
  };
  const scriptOf = (lang) => SCRIPT[lang] || (PROBE[lang] ? "latin" : "");

  // ---- default order per writing system -----------------------------------
  // Which of a computer's fonts a brand-new list starts with, in order of
  // preference. Every name here was seen on a real macOS 26 or a real Windows
  // 11 or is a stock Linux font; none is invented. It is
  // NOT a CSS stack — it is matched against the installed list first, and only
  // the ones that exist are offered. Per group: system UI faces lead the Latin
  // group, no Kaiti, Thonburi before Sukhumvit, Cyrillic is its own group.
  const DEFAULT_ORDER = {
    latin: ["Segoe UI Variable Text", "Segoe UI", "Helvetica Neue", "Verdana", "Tahoma",
      "Arial", "Calibri", "Lucida Grande", "Noto Sans", "Roboto", "DejaVu Sans",
      "Liberation Sans", "Georgia"],
    cyrillic: ["Segoe UI", "PT Sans", "Verdana", "Tahoma", "Arial", "Calibri",
      "Helvetica Neue", "Noto Sans", "DejaVu Sans"],
    greek: ["Segoe UI", "Helvetica Neue", "Arial", "Verdana", "Tahoma", "Calibri",
      "Lucida Grande", "Noto Sans", "Palatino Linotype"],
    hans: ["PingFang SC", "Microsoft YaHei", "Noto Sans SC", "Noto Sans CJK SC",
      "Hiragino Sans GB", "Heiti SC", "DengXian", "WenQuanYi Micro Hei", "Songti SC", "STSong"],
    hant: ["PingFang TC", "Microsoft JhengHei", "Hiragino Sans TC", "Heiti TC",
      "Noto Sans TC", "Noto Sans CJK TC", "Songti TC"],
    jpan: ["Hiragino Sans", "Yu Gothic", "YuGothic", "BIZ UDGothic", "Toppan Bunkyu Gothic",
      "MS PGothic", "Noto Sans CJK JP", "Hiragino Mincho ProN", "YuMincho"],
    hangul: ["Apple SD Gothic Neo", "Malgun Gothic", "Nanum Gothic", "Noto Sans KR",
      "Noto Sans CJK KR", "AppleGothic"],
    arabic: ["Geeza Pro", "Segoe UI", "Dubai", "Tahoma", "Arial", "Al Nile", "Damascus",
      "Noto Naskh Arabic", "Noto Sans Arabic"],
    urdu: ["Noto Nastaliq Urdu", "Urdu Typesetting", "Geeza Pro", "Segoe UI", "Dubai", "Tahoma"],
    hebrew: ["Segoe UI", "Arial Hebrew", "Arial", "Tahoma", "New Peninim MT", "Raanana",
      "Noto Sans Hebrew"],
    thai: ["Thonburi", "Leelawadee UI", "Ayuthaya", "Tahoma", "Noto Sans Thai", "Sukhumvit Set"],
    deva: ["Kohinoor Devanagari", "Nirmala UI", "Devanagari Sangam MN", "ITF Devanagari",
      "Noto Sans Devanagari", "Devanagari MT", "Shobhika"],
    bengali: ["Kohinoor Bangla", "Nirmala UI", "Bangla Sangam MN", "Bangla MN",
      "Noto Sans Bengali", "Lohit Bengali"],
    tamil: ["Tamil Sangam MN", "Nirmala UI", "InaiMathi", "Tamil MN", "Noto Sans Tamil",
      "Lohit Tamil"],
    telugu: ["Kohinoor Telugu", "Nirmala UI", "Telugu Sangam MN", "Telugu MN",
      "Noto Sans Telugu", "Lohit Telugu"]
  };

  // Chrome on Linux puts these three fontconfig aliases into getFontList
  // unconditionally. They are not fonts; they resolve to whatever the system
  // maps them to, and the probe cannot tell that apart from a real face.
  const ALIASES = new Set(["Monospace", "Sans", "Serif"]);

  // ---- 2. the fifteen keys that shipped through 3.6 -----------------------
  // Kept so a stored value keeps rendering exactly as it did. They are no
  // longer offered as choices: four of them (Roboto, Noto Sans, Inter,
  // Garamond) did not exist on the reference Mac at all, and a category such
  // as 「适合中文」 is a stack, not a font. The label of a legacy key is what
  // the popup shows while it is still the stored value.
  const SYSTEM_STACK = 'system-ui, -apple-system, "Segoe UI", sans-serif';
  const LEGACY = {
    system:  { stack: SYSTEM_STACK, i18n: "fontSystem", label: "System default" },
    roboto:  { stack: 'Roboto, "YouTube Noto", sans-serif', label: "Roboto" },
    noto:    { stack: '"Noto Sans", "YouTube Noto", sans-serif', label: "Noto Sans" },
    arial:   { stack: "Arial, Helvetica, sans-serif", label: "Arial" },
    georgia: { stack: 'Georgia, "Times New Roman", serif', label: "Georgia" },
    times:   { stack: '"Times New Roman", Times, serif', label: "Times New Roman" },
    mono:    { stack: '"Courier New", ui-monospace, monospace', i18n: "fontMono", label: "Monospace" },
    cjk:     { stack: '"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif', i18n: "fontCjk", label: "CJK-friendly" },
    inter:   { stack: 'Inter, "Segoe UI Variable", system-ui, sans-serif', label: "Inter" },
    verdana: { stack: "Verdana, Geneva, sans-serif", label: "Verdana" },
    tahoma:  { stack: "Tahoma, Geneva, Verdana, sans-serif", label: "Tahoma" },
    trebuchet: { stack: '"Trebuchet MS", Tahoma, sans-serif', label: "Trebuchet MS" },
    garamond: { stack: 'Garamond, "Palatino Linotype", "Book Antiqua", serif', label: "Garamond" },
    cjkserif: { stack: '"Songti SC", SimSun, "Noto Serif CJK SC", serif', i18n: "fontCjkSerif", label: "Chinese serif" },
    cjkround: { stack: '"Yuanti SC", "Microsoft YaHei UI", "Noto Sans CJK SC", sans-serif', i18n: "fontCjkRound", label: "Chinese rounded" }
  };

  const PREFIX = "f:";
  const isFont = (v) => typeof v === "string" && v.indexOf(PREFIX) === 0 && v.length > PREFIX.length;
  const idOf = (v) => (isFont(v) ? v.slice(PREFIX.length) : "");
  const valueOf = (id) => PREFIX + id;

  // A family name inside a CSS string: only the backslash and the quote are
  // special there, and a control character or newline would end the string
  // early. Strip the latter, escape the former, wrap in quotes. Nothing else
  // in this extension puts an outside string into CSS.
  function quote(id) {
    const clean = String(id).replace(/[\u0000-\u001f\u007f]/g, "");
    return '"' + clean.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
  }

  // The stored value -> what goes into style.fontFamily. A font that is not on
  // this computer (a value synced from another machine) falls through to the
  // same stack "System default" uses, so the line degrades to the default
  // rather than to whatever the browser feels like.
  function css(value) {
    if (isFont(value)) return quote(idOf(value)) + ", " + SYSTEM_STACK;
    const l = LEGACY[value];
    return l ? l.stack : SYSTEM_STACK;
  }

  // ---- installed fonts -----------------------------------------------------
  // chrome.fontSettings.getFontList — the only silent way to learn what is
  // installed (no install-time warning, no runtime prompt; measured on both of
  // the reference machines). The same permission also carries set*/clear*
  // methods that would change the browser's default fonts for every site;
  // this extension never calls them, and docs-consistency fails the build if
  // a call appears (it is the one line that keeps PRIVACY.md's promise true).
  async function list() {
    const fs = root.chrome && root.chrome.fontSettings;
    if (!fs || typeof fs.getFontList !== "function") return null;
    let raw;
    try { raw = await fs.getFontList(); } catch (_e) { return null; }
    if (!Array.isArray(raw)) return null;
    const out = [];
    const seen = new Set();
    for (const f of raw) {
      const id = f && typeof f.fontId === "string" ? f.fontId.trim() : "";
      if (!id || id[0] === "." || ALIASES.has(id) || seen.has(id)) continue;
      seen.add(id);
      out.push({ id, name: (f.displayName && String(f.displayName).trim()) || id });
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  // A brand-new list: the first fonts of this computer that the default-order
  // table prefers for the languages given (the translation language first,
  // then the reader's own, then Latin — original lines are so often English).
  function defaults(installed, langs) {
    const have = new Set((installed || []).map((f) => f.id));
    const groups = [];
    for (const lang of langs || []) {
      const g = scriptOf(lang);
      if (g && groups.indexOf(g) < 0) groups.push(g);
    }
    if (groups.indexOf("latin") < 0) groups.push("latin");
    const out = [];
    groups.forEach((g, i) => {
      let n = 0;
      for (const id of DEFAULT_ORDER[g] || []) {
        if (!have.has(id) || out.indexOf(id) >= 0) continue;
        out.push(id);
        if (++n >= (i === 0 ? 5 : 3)) break;
      }
    });
    return out.slice(0, 8);
  }

  // ---- 3. can this font draw that language? --------------------------------
  const WIDE = "YTDS Anchor Wide", NARROW = "YTDS Anchor Narrow";
  // Where the ruler files live: next to this script. Read while the script
  // runs (currentScript is null afterwards, and null in the content script —
  // where the rulers must never be added to YouTube's document; the probe is
  // not run there).
  const HERE = (typeof document !== "undefined" && document.currentScript &&
    document.currentScript.src) || "";
  const memo = new Map();
  const faces = { wide: null, narrow: null };
  let ready = null;

  // The rulers are made here as FontFace objects and added to the document,
  // NOT declared in CSS. A CSS-connected face that no element uses is dropped
  // again on the next style rebuild — a viewport change was enough — and
  // document.fonts.load() then resolves with a face whose status is
  // "unloaded"; measured 2026-09-04, 3 of 5 page loads, every font reported
  // as unable to draw anything. A face this module holds stays loaded.
  function rulers(doc) {
    if (ready) return ready;
    ready = (async () => {
      try {
        if (!HERE || !doc.fonts || typeof FontFace !== "function") return false;
        if (!faces.wide) {
          faces.wide = new FontFace(WIDE, "url(" + new URL("fonts/anchor-wide.ttf", HERE).href + ")");
          faces.narrow = new FontFace(NARROW, "url(" + new URL("fonts/anchor-narrow.ttf", HERE).href + ")");
          doc.fonts.add(faces.wide);
          doc.fonts.add(faces.narrow);
        }
        await Promise.all([faces.wide.load(), faces.narrow.load()]);
        return loaded();
      } catch (_e) { return false; }
    })();
    return ready;
  }
  const loaded = () => !!(faces.wide && faces.narrow &&
    faces.wide.status === "loaded" && faces.narrow.status === "loaded");

  // true / false, or null when the rulers are not available — in which case
  // nothing may be filtered on the strength of this (an unknown is offered,
  // not hidden).
  async function probe(ids, langs, doc) {
    doc = doc || root.document;
    const out = Object.create(null);
    for (const id of ids) out[id] = Object.create(null);
    const unknown = () => {
      for (const id of ids) for (const l of langs) out[id][l] = null;
      ready = null;                 // so the next call tries the rulers again
      return out;
    };
    if (!doc || !(await rulers(doc))) return unknown();
    const canvas = doc.createElement("canvas");
    const ctx = canvas.getContext("2d");
    const width = (id, ruler, text) => {
      ctx.font = "40px " + quote(id) + ', "' + ruler + '"';
      // A font string the canvas could not parse leaves the previous one in
      // place, and both measurements would then agree for the wrong reason.
      if (ctx.font.indexOf(ruler) < 0) return NaN;
      return ctx.measureText(text).width;
    };
    // Self-check every run: a name no computer has must come out "cannot".
    // If it comes out "can", the rulers are not doing their job (not loaded,
    // blocked, or the measurement is being short-circuited) and the only
    // honest answer for everything else is "unknown".
    const ghost = "YTDS No Such Font 0";
    const gw = width(ghost, WIDE, LATIN), gn = width(ghost, NARROW, LATIN);
    const sane = Number.isFinite(gw) && Number.isFinite(gn) && Math.abs(gw - gn) > 1;
    for (const id of ids) {
      for (const l of langs) {
        const text = PROBE[l];
        if (!text) { out[id][l] = null; continue; }
        const k = id + "\u0000" + l;
        if (!sane) { out[id][l] = null; continue; }
        if (memo.has(k)) { out[id][l] = memo.get(k); continue; }
        const w = width(id, WIDE, text), n = width(id, NARROW, text);
        const can = Number.isFinite(w) && Number.isFinite(n) && Math.abs(w - n) < 0.5;
        memo.set(k, can);
        out[id][l] = can;
      }
    }
    // Still loaded after measuring? If a style rebuild dropped a ruler
    // mid-run, some of the numbers above were taken against the system's
    // fallback and mean nothing. Forget them and say so.
    if (!loaded()) {
      for (const id of ids) for (const l of langs) memo.delete(id + "\u0000" + l);
      return unknown();
    }
    return out;
  }

  // ---- 4. fonts the reader imported ---------------------------------------
  // A font file the reader hands over is COPIED into the extension's own
  // IndexedDB (this machine, this profile) — not pointed at. Pointing at the
  // file was measured first: the handle's permission dies with the popup, and
  // re-granting on every open breaks the one-hop rule. The copy is the only
  // thing this extension keeps; the original can move or go.
  //
  // An imported font is registered under a family name of our own making
  // (IMPORT_PREFIX + random), never under the name inside the file: a file
  // called "Noto Sans SC" must not shadow or merge with an installed Noto
  // Sans SC, and a name we minted cannot collide with anything, or carry
  // anything, into CSS. The file's own family name is what the reader sees.
  const IMPORT_PREFIX = "YTDS-Import-";
  const isImport = (id) => typeof id === "string" && id.indexOf(IMPORT_PREFIX) === 0;
  const IMPORT_MAX = 25 * 1024 * 1024;
  const DB_NAME = "ytds-fonts", DB_STORE = "files";

  function openDb() {
    return new Promise((resolve, reject) => {
      try {
        const req = root.indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE, { keyPath: "id" });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error("indexedDB"));
      } catch (e) { reject(e); }
    });
  }
  function dbOp(mode, fn) {
    return openDb().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, mode);
      const req = fn(tx.objectStore(DB_STORE));
      tx.oncomplete = () => { db.close(); resolve(req ? req.result : undefined); };
      tx.onerror = () => { db.close(); reject(tx.error || new Error("indexedDB")); };
      tx.onabort = () => { db.close(); reject(tx.error || new Error("indexedDB")); };
    }));
  }
  const importGet = (id) => dbOp("readonly", (st) => st.get(id));
  const importPut = (rec) => dbOp("readwrite", (st) => st.put(rec));
  const importDrop = (id) => dbOp("readwrite", (st) => st.delete(id));

  // The list the pickers read (storage.local, no bytes): [{id, name, size, kind, added}].
  function imports() {
    return new Promise((res) => {
      try { root.chrome.storage.local.get({ fontImports: [] }, (g) => res((g && Array.isArray(g.fontImports)) ? g.fontImports : [])); }
      catch (_e) { res([]); }
    });
  }
  function setImports(list) {
    return new Promise((res) => {
      try { root.chrome.storage.local.set({ fontImports: list }, () => res()); } catch (_e) { res(); }
    });
  }

  // What kind of font file this is, by its first bytes — the extension in
  // the file name is a claim, not a fact.
  function sniff(u8) {
    const tag = String.fromCharCode(u8[0], u8[1], u8[2], u8[3]);
    if (tag === "OTTO") return "otf";
    if (tag === "true" || tag === "ttcf") return "ttf";
    if (u8[0] === 0 && u8[1] === 1 && u8[2] === 0 && u8[3] === 0) return "ttf";
    if (tag === "wOFF") return "woff";
    if (tag === "wOF2") return "woff2";
    return "";
  }

  // The family name in the file's `name` table (typographic family 16, else
  // family 1; English first). WOFF wraps the same table, zlib-compressed;
  // WOFF2 is Brotli, which the browser exposes no decoder for, so those keep
  // the file's name. Anything unreadable also keeps the file's name — a bad
  // name is not a reason to refuse a font that loads.
  async function familyOf(u8, kind) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const u16 = (o) => dv.getUint16(o), u32 = (o) => dv.getUint32(o);
    const tag = (o) => String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]);
    let nameTable = null;
    try {
      if (kind === "ttf" || kind === "otf") {
        let base = 0;
        if (tag(0) === "ttcf") base = u32(12);           // first face of a collection
        const n = u16(base + 4);
        for (let i = 0; i < n; i++) {
          const o = base + 12 + i * 16;
          if (tag(o) === "name") { nameTable = u8.subarray(u32(o + 8), u32(o + 8) + u32(o + 12)); break; }
        }
      } else if (kind === "woff") {
        const n = u16(12);
        for (let i = 0; i < n; i++) {
          const o = 44 + i * 20;
          if (tag(o) !== "name") continue;
          const off = u32(o + 4), comp = u32(o + 8), orig = u32(o + 12);
          const raw = u8.subarray(off, off + comp);
          if (comp >= orig) { nameTable = raw; break; }
          const ds = new root.DecompressionStream("deflate");
          const out = new Response(new Blob([raw]).stream().pipeThrough(ds));
          nameTable = new Uint8Array(await out.arrayBuffer());
          break;
        }
      }
      if (!nameTable) return "";
      const nv = new DataView(nameTable.buffer, nameTable.byteOffset, nameTable.byteLength);
      const count = nv.getUint16(2), strOff = nv.getUint16(4);
      let best = "", bestScore = -1;
      for (let i = 0; i < count; i++) {
        const r = 6 + i * 12;
        const plat = nv.getUint16(r), enc = nv.getUint16(r + 2), lang = nv.getUint16(r + 4), nid = nv.getUint16(r + 6);
        const len = nv.getUint16(r + 8), off = nv.getUint16(r + 10);
        if (nid !== 1 && nid !== 16) continue;
        const start = strOff + off;
        if (start + len > nameTable.byteLength) continue;
        const bytes = nameTable.subarray(start, start + len);
        let text = "";
        if (plat === 3 || plat === 0) {
          for (let k = 0; k + 1 < bytes.length; k += 2) text += String.fromCharCode((bytes[k] << 8) | bytes[k + 1]);
        } else if (plat === 1 && enc === 0) {
          for (let k = 0; k < bytes.length; k++) text += String.fromCharCode(bytes[k]);
        } else continue;
        text = text.replace(/[\u0000-\u001f]/g, "").trim();
        if (!text) continue;
        // Prefer: typographic family, English, Windows platform.
        const score = (nid === 16 ? 4 : 0) + (lang === 0x409 || lang === 0 ? 2 : 0) + (plat === 3 ? 1 : 0);
        if (score > bestScore) { best = text; bestScore = score; }
      }
      return best;
    } catch (_e) { return ""; }
  }

  // Bytes <-> text, for the one hop the bytes make (worker -> content script).
  function b64(u8) {
    let s = "";
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function unb64(str) {
    const s = atob(str);
    const u8 = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
    return u8;
  }

  // Import one File. Resolves {ok:true, id, name} or {ok:false, why} with
  // why = "kind" (not a font file) | "size" (over IMPORT_MAX) | "store".
  async function importFile(file) {
    if (!file || typeof file.arrayBuffer !== "function") return { ok: false, why: "kind" };
    if (file.size > IMPORT_MAX) return { ok: false, why: "size" };
    const buf = await file.arrayBuffer();
    const u8 = new Uint8Array(buf);
    const kind = u8.length > 44 ? sniff(u8) : "";
    if (!kind) return { ok: false, why: "kind" };
    const stem = String(file.name || "").replace(/\.[A-Za-z0-9]+$/, "").trim();
    const name = (await familyOf(u8, kind)) || stem || "Font";
    const id = IMPORT_PREFIX + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    try {
      await importPut({ id, name, kind, size: u8.length, added: Date.now(), bytes: buf });
    } catch (_e) { return { ok: false, why: "store" }; }
    const list = (await imports()).filter((f) => f && f.id !== id);
    list.push({ id, name, kind, size: u8.length, added: Date.now() });
    await setImports(list);
    return { ok: true, id, name };
  }

  async function importRemove(id) {
    try { await importDrop(id); } catch (_e) { /* the list entry still goes */ }
    await setImports((await imports()).filter((f) => f && f.id !== id));
  }

  // Register an imported font in a document (once), from the copy in
  // IndexedDB. Extension pages only — a content script cannot reach this
  // origin's IndexedDB and asks the worker for the bytes instead.
  const ensured = new Map();   // id -> Promise<boolean>
  function ensureImported(doc, id) {
    if (!isImport(id)) return Promise.resolve(false);
    if (ensured.has(id)) return ensured.get(id);
    const p = (async () => {
      try {
        if ([...doc.fonts].some((f) => f.family === id)) return true;
        const rec = await importGet(id);
        if (!rec || !rec.bytes) return false;
        const face = new root.FontFace(id, rec.bytes);
        await face.load();
        doc.fonts.add(face);
        return true;
      } catch (_e) { return false; }
    })();
    ensured.set(id, p);
    p.then((ok) => { if (!ok) ensured.delete(id); });
    return p;
  }

  // Label of a stored value for a picker: the installed display name when the
  // list has it, the legacy label otherwise, the bare id as a last resort.
  function label(value, installed, tr) {
    if (isFont(value)) {
      const id = idOf(value);
      const hit = (installed || []).find((f) => f.id === id);
      return hit ? hit.name : id;
    }
    const l = LEGACY[value] || LEGACY.system;
    return (l.i18n && tr && tr(l.i18n, l.label)) || l.label;
  }

  root.YTDS_FONTS = {
    PROBE, SCRIPT, DEFAULT_ORDER, LEGACY, ALIASES,
    scriptOf, isFont, idOf, valueOf, quote, css, list, defaults, probe, label,
    RULERS: { wide: WIDE, narrow: NARROW },
    IMPORT_PREFIX, IMPORT_MAX, isImport, sniff, familyOf, b64, unb64,
    imports, importFile, importRemove, importGet, ensureImported
  };
})(typeof self !== "undefined" ? self : this);
