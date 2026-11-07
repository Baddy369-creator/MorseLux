/* Morse Lux website: translator, playback (sound, light, vibration), WAV download, share links. No dependencies. */
(function () {
  "use strict";

  var CODE = {
    A: ".-", B: "-...", C: "-.-.", D: "-..", E: ".", F: "..-.", G: "--.", H: "....", I: "..", J: ".---",
    K: "-.-", L: ".-..", M: "--", N: "-.", O: "---", P: ".--.", Q: "--.-", R: ".-.", S: "...", T: "-",
    U: "..-", V: "...-", W: ".--", X: "-..-", Y: "-.--", Z: "--..",
    "0": "-----", "1": ".----", "2": "..---", "3": "...--", "4": "....-", "5": ".....", "6": "-....",
    "7": "--...", "8": "---..", "9": "----.",
    ".": ".-.-.-", ",": "--..--", "?": "..--..", "'": ".----.", "!": "-.-.--", "/": "-..-.", "(": "-.--.",
    ")": "-.--.-", "&": ".-...", ":": "---...", ";": "-.-.-.", "=": "-...-", "+": ".-.-.", "-": "-....-",
    "_": "..--.-", "\"": ".-..-.", "$": "...-..-", "@": ".--.-.",
    "Ä": ".-.-", "Ö": "---.", "Ü": "..--", "ß": "...--..", "Ñ": "--.--", "É": "..-..", "À": ".--.-", "È": ".-..-"
  };
  var DECODE = {};
  Object.keys(CODE).forEach(function (k) { if (!DECODE[CODE[k]]) DECODE[CODE[k]] = k; });
  var FOLD = { "Á": "A", "Í": "I", "Ó": "O", "Ú": "U", "Â": "A", "Ê": "E", "Î": "I", "Ô": "O", "Û": "U", "Ç": "C", "Ë": "E", "Ï": "I" };

  function toMorse(text) {
    return text.toUpperCase().replace(/ẞ/g, "ß").split(/\s+/).filter(Boolean).map(function (word) {
      return Array.from(word).map(function (ch) {
        if (CODE[ch]) return CODE[ch];
        if (FOLD[ch]) return CODE[FOLD[ch]];
        return "";
      }).filter(Boolean).join(" ");
    }).filter(Boolean).join(" / ");
  }

  /* How Morse is shown: round dot and dash on one line, like in the app. Copies stay as .- */
  function display(m) { return m.replace(/[.·∙⋅*]/g, "•").replace(/[-–—―_]/g, "−"); }
  function ascii(m) { return normalizeMorse(m).replace(/•/g, "."); }
  function shapes(m) {
    var items = [];
    ascii(m).trim().split("/").forEach(function (word, wi) {
      if (wi) items.push('<i class="mw">/</i>');
      word.trim().split(/\s+/).forEach(function (letter) {
        var sig = Array.from(letter).map(function (c) { return c === "." ? '<i class="md"></i>' : c === "-" ? '<i class="mh"></i>' : ""; }).join("");
        if (sig) items.push('<span class="ml">' + sig + "</span>");
      });
    });
    return '<span class="m" aria-hidden="true">' + items.join("") + "</span>";
  }

  function normalizeMorse(s) {
    return s.replace(/[·•∙⋅*]/g, ".").replace(/[−–—―_]/g, "-").replace(/\|/g, "/");
  }

  function looksLikeMorse(s) {
    var t = s.trim();
    return t.length > 0 && /^[.\-·•∙⋅*−–—―_\/|\s]+$/.test(t);
  }

  function fromMorse(morse) {
    return normalizeMorse(morse).trim().split(/\s*\/\s*|\s{3,}/).map(function (word) {
      return word.trim().split(/\s+/).map(function (sym) { return sym ? (DECODE[sym] || "�") : ""; }).join("");
    }).join(" ");
  }

  /* ---------- Timing ---------- */
  function timeline(morse, wpm) {
    var unit = 1200 / wpm, events = [], t = 0;
    var words = normalizeMorse(morse).trim().split(/\s*\/\s*/);
    words.forEach(function (word, wi) {
      var letters = word.trim().split(/\s+/);
      letters.forEach(function (letter, li) {
        Array.from(letter).forEach(function (s, si) {
          var len = s === "." ? unit : s === "-" ? unit * 3 : 0;
          if (!len) return;
          events.push([t, len]);
          t += len;
          if (si < letter.length - 1) t += unit;
        });
        if (li < letters.length - 1) t += unit * 3;
      });
      if (wi < words.length - 1) t += unit * 7;
    });
    return { events: events, total: t };
  }

  /* ---------- Sound ---------- */
  var ctx = null, active = [], timers = [];
  function copyFail() { toast(L.copyFail || "Copying is not possible here"); }

  function audio() {
    /* iPhone: play the sound even when the ring/silent switch is on (Safari 16.4+) */
    try { if (navigator.audioSession && navigator.audioSession.type !== "play-and-record") navigator.audioSession.type = "playback"; } catch (e) {}
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  }
  function stopAll() {
    active.forEach(function (o) { try { o.stop(); } catch (e) {} });
    active = [];
    timers.forEach(clearTimeout);
    timers = [];
    var f = document.getElementById("flash");
    if (f) f.classList.remove("on", "show");
    if (navigator.vibrate) navigator.vibrate(0);
    document.querySelectorAll("[data-playing]").forEach(function (b) { b.removeAttribute("data-playing"); });
  }
  function playSound(morse, wpm, freq) {
    var ac = audio(), tl = timeline(morse, wpm), start = ac.currentTime + 0.08;
    tl.events.forEach(function (ev) {
      var o = ac.createOscillator(), g = ac.createGain(), s = start + ev[0] / 1000, e = s + ev[1] / 1000;
      o.type = "sine"; o.frequency.value = freq;
      g.gain.setValueAtTime(0, s);
      g.gain.linearRampToValueAtTime(0.35, s + 0.005);
      g.gain.setValueAtTime(0.35, e - 0.005);
      g.gain.linearRampToValueAtTime(0, e);
      o.connect(g); g.connect(ac.destination);
      o.start(s); o.stop(e + 0.01);
      active.push(o);
    });
    return tl.total + 100;
  }
  function playLight(morse, wpm) {
    var f = document.getElementById("flash"), tl = timeline(morse, wpm);
    if (!f) return 0;
    f.classList.add("show");
    tl.events.forEach(function (ev) {
      timers.push(setTimeout(function () { f.classList.add("on"); }, ev[0] + 80));
      timers.push(setTimeout(function () { f.classList.remove("on"); }, ev[0] + ev[1] + 80));
    });
    timers.push(setTimeout(function () { f.classList.remove("show"); }, tl.total + 400));
    return tl.total + 400;
  }
  function playVibration(morse, wpm) {
    if (!navigator.vibrate) return 0;
    var tl = timeline(morse, wpm), pattern = [], last = 0;
    tl.events.forEach(function (ev) { pattern.push(Math.round(ev[0] - last), Math.round(ev[1])); last = ev[0] + ev[1]; });
    pattern[0] = Math.max(pattern[0], 1);
    navigator.vibrate(pattern);
    return tl.total;
  }

  /* ---------- WAV ---------- */
  function wavBlob(morse, wpm, freq) {
    var rate = 22050, tl = timeline(morse, wpm), n = Math.ceil((tl.total + 300) / 1000 * rate);
    var data = new Int16Array(n), ramp = Math.round(rate * 0.005);
    tl.events.forEach(function (ev) {
      var s = Math.round(ev[0] / 1000 * rate) + Math.round(rate * 0.1), len = Math.round(ev[1] / 1000 * rate);
      for (var i = 0; i < len && s + i < n; i++) {
        var env = Math.min(1, i / ramp, (len - i) / ramp);
        data[s + i] = Math.round(Math.sin(2 * Math.PI * freq * i / rate) * env * 0.5 * 32767);
      }
    });
    var buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
    function w(o, s) { for (var i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); }
    w(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); w(8, "WAVE"); w(12, "fmt ");
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    w(36, "data"); v.setUint32(40, n * 2, true);
    for (var i = 0; i < n; i++) v.setInt16(44 + i * 2, data[i], true);
    return new Blob([buf], { type: "audio/wav" });
  }

  /* ---------- Share links (#m=...) ---------- */
  function encodeShare(text) {
    return btoa(unescape(encodeURIComponent(text))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function decodeShare(s) {
    try { return decodeURIComponent(escape(atob(s.replace(/-/g, "+").replace(/_/g, "/")))); } catch (e) { return ""; }
  }

  function toast(msg) {
    var t = document.getElementById("toast");
    if (!t) return;
    t.textContent = msg; t.classList.add("show");
    setTimeout(function () { t.classList.remove("show"); }, 2200);
  }

  /* ---------- Translator widget ---------- */
  function initTranslator(root) {
    var L = window.ML_I18N || {};
    var textEl = root.querySelector("#t-text"), morseEl = root.querySelector("#t-morse");
    var wpmEl = root.querySelector("#t-wpm"), wpmOut = root.querySelector("#t-wpm-out");
    var freqEl = root.querySelector("#t-freq"), freqOut = root.querySelector("#t-freq-out");
    var lock = false;

    function sync(from, pasted) {
      if (lock) return;
      lock = true;
      if (from === "text") {
        /* Morse pasted into the text box is moved to the Morse box and decoded. */
        if (pasted && looksLikeMorse(textEl.value) && /[.\-·•−–—―_]/.test(textEl.value)) {
          morseEl.value = display(normalizeMorse(textEl.value).trim()); textEl.value = fromMorse(textEl.value);
        } else morseEl.value = display(toMorse(textEl.value));
      } else {
        /* typed . and - are shown as • and −; one character each, so the cursor stays put */
        var pos = morseEl.selectionStart, shown = display(morseEl.value);
        if (shown !== morseEl.value) { morseEl.value = shown; try { morseEl.setSelectionRange(pos, pos); } catch (e) {} }
        textEl.value = fromMorse(morseEl.value);
      }
      lock = false;
    }
    textEl.addEventListener("input", function (e) { sync("text", e.inputType === "insertFromPaste" || e.inputType === "insertFromDrop"); });
    morseEl.addEventListener("input", function () { sync("morse"); });
    function wpm() { return +wpmEl.value || 15; }
    function freq() { return +freqEl.value || 600; }
    wpmEl.addEventListener("input", function () { wpmOut.textContent = wpmEl.value; });
    freqEl.addEventListener("input", function () { freqOut.textContent = freqEl.value; });

    function run(btn, fn) {
      stopAll();
      var m = morseEl.value.trim();
      if (!m) { toast(L.empty || "Type something first"); return; }
      btn.setAttribute("data-playing", "");
      var d = fn(m);
      timers.push(setTimeout(function () { btn.removeAttribute("data-playing"); }, d));
    }
    root.querySelector("[data-act=sound]").addEventListener("click", function () { var b = this; run(b, function (m) { return playSound(m, wpm(), freq()); }); });
    root.querySelector("[data-act=light]").addEventListener("click", function () { var b = this; run(b, function (m) { return playLight(m, wpm()); }); });
    root.querySelector("[data-act=vibrate]").addEventListener("click", function () {
      if (!navigator.vibrate) { toast(L.noVibrate || "Vibration is not supported in this browser"); return; }
      var b = this; run(b, function (m) { return playVibration(m, wpm()); });
    });
    root.querySelector("[data-act=stop]").addEventListener("click", stopAll);
    root.querySelector("[data-act=copy]").addEventListener("click", function () {
      if (!morseEl.value.trim()) { toast(L.empty || "Type something first"); return; }
      navigator.clipboard.writeText(ascii(morseEl.value)).then(function () { toast(L.copied || "Copied"); }, copyFail);
    });
    root.querySelector("[data-act=wav]").addEventListener("click", function () {
      var m = morseEl.value.trim();
      if (!m) { toast(L.empty || "Type something first"); return; }
      var a = document.createElement("a");
      a.href = URL.createObjectURL(wavBlob(m, wpm(), freq()));
      a.download = "morse.wav"; document.body.appendChild(a); a.click(); a.remove();
      if (window.gtag) gtag("event", "download_wav");
    });
    root.querySelector("[data-act=share]").addEventListener("click", function () {
      var t = textEl.value.trim();
      if (!t) { toast(L.empty || "Type something first"); return; }
      var url = location.origin + location.pathname + "#m=" + encodeShare(t);
      var msg = (L.shareText || "Can you decode this Morse message?") + "\n" + toMorse(t) + "\n";
      if (navigator.share) navigator.share({ title: "Morse", text: msg, url: url }).catch(function () {});
      else navigator.clipboard.writeText(msg + url).then(function () { toast(L.linkCopied || "Link copied"); }, copyFail);
    });
    root.querySelectorAll("[data-key]").forEach(function (k) {
      k.addEventListener("click", function () {
        var v = k.getAttribute("data-key");
        if (v === "back") morseEl.value = morseEl.value.replace(/\s*\/\s*$|.$/, "");
        else morseEl.value += v;
        sync("morse");
        if (v === "." || v === "-") playSound(v, 20, freq());
      });
    });
    root.querySelector("[data-act=clear]").addEventListener("click", function () { stopAll(); textEl.value = ""; morseEl.value = ""; textEl.focus(); });

    /* Secret message from a share link */
    var m = location.hash.match(/#m=([A-Za-z0-9_-]+)/);
    if (m) {
      var secret = decodeShare(m[1]);
      if (secret) {
        var box = document.getElementById("secret");
        morseEl.value = display(toMorse(secret));
        textEl.value = "";
        if (box) {
          box.hidden = false;
          box.querySelector("[data-secret-morse]").innerHTML = shapes(toMorse(secret));
          box.querySelector("[data-act=reveal]").addEventListener("click", function () {
            textEl.value = secret;
            box.querySelector("[data-secret-answer]").textContent = secret;
            box.classList.add("revealed");
          });
          box.querySelector("[data-act=secret-play]").addEventListener("click", function () {
            var b = this; run(b, function (mm) { return playSound(mm, wpm(), freq()); });
          });
        }
        (box || root).scrollIntoView({ block: "center" });
      }
    }
  }

  /* ---------- Name in Morse code (cards + PNG download) ---------- */
  function initNameTool(root) {
    var L = window.ML_I18N || {};
    var input = root.querySelector("#n-input"), out = root.querySelector("#n-out"), line = root.querySelector("#n-line");
    function letters() {
      return Array.from(input.value.toUpperCase().replace(/ẞ/g, "ß")).filter(function (c) { return c === " " || CODE[c] || FOLD[c]; });
    }
    function code(c) { return CODE[c] || CODE[FOLD[c]] || ""; }
    function render() {
      var ls = letters();
      out.innerHTML = "";
      ls.forEach(function (c) {
        var d = document.createElement("div");
        d.className = c === " " ? "ncard gap" : "ncard";
        if (c !== " ") {
          var b = document.createElement("b"); b.textContent = c;
          var s = document.createElement("span"); s.innerHTML = shapes(code(c));
          d.appendChild(b); d.appendChild(s);
        }
        out.appendChild(d);
      });
      line.innerHTML = shapes(toMorse(input.value));
    }
    input.addEventListener("input", render);
    root.querySelector("[data-act=n-play]").addEventListener("click", function () {
      var m = toMorse(input.value); if (!m) { toast(L.empty || "Type something first"); return; }
      stopAll(); var b = this; b.setAttribute("data-playing", "");
      var d = playSound(m, 15, 600); timers.push(setTimeout(function () { b.removeAttribute("data-playing"); }, d));
    });
    root.querySelector("[data-act=n-copy]").addEventListener("click", function () {
      var m = toMorse(input.value); if (!m) { toast(L.empty || "Type something first"); return; }
      navigator.clipboard.writeText(m).then(function () { toast(L.copied || "Copied"); }, copyFail);
    });
    root.querySelector("[data-act=n-png]").addEventListener("click", function () {
      var ls = letters().filter(function (c, i, a) { return c !== " " || (i && a[i - 1] !== " "); });
      if (!ls.join("").trim()) { toast(L.empty || "Type something first"); return; }
      var dot = 18, dash = 50, gap = 12, pad = 60, h = 420;
      var widths = ls.map(function (c) {
        if (c === " ") return 60;
        var total = 0;
        Array.from(code(c)).forEach(function (s, k) { total += (s === "." ? dot : dash) + (k ? gap : 0); });
        return Math.max(110, total + 44);
      });
      var inner = widths.reduce(function (a, b) { return a + b; }, 0), w = Math.max(600, inner + pad * 2);
      var cv = document.createElement("canvas"); cv.width = w; cv.height = h;
      var g = cv.getContext("2d");
      var grad = g.createLinearGradient(0, 0, 0, h); grad.addColorStop(0, "#0f2a3c"); grad.addColorStop(1, "#081722");
      g.fillStyle = grad; g.fillRect(0, 0, w, h);
      var left = (w - inner) / 2;
      ls.forEach(function (c, i) {
        var cx = left + widths[i] / 2; left += widths[i];
        if (c === " ") return;
        g.fillStyle = "#eef3f6"; g.font = "bold 76px -apple-system,Segoe UI,Roboto,Arial,sans-serif"; g.textAlign = "center";
        g.fillText(c, cx, 170);
        var sym = code(c), total = 0;
        Array.from(sym).forEach(function (s, k) { total += (s === "." ? dot : dash) + (k ? gap : 0); });
        var x = cx - total / 2;
        g.fillStyle = "#ffc96b";
        Array.from(sym).forEach(function (s) {
          if (s === ".") { g.beginPath(); g.arc(x + dot / 2, 250, dot / 2, 0, Math.PI * 2); g.fill(); x += dot + gap; }
          else { var r = 9; g.beginPath(); g.moveTo(x + r, 241); g.arcTo(x + dash, 241, x + dash, 259, r); g.arcTo(x + dash, 259, x, 259, r); g.arcTo(x, 259, x, 241, r); g.arcTo(x, 241, x + dash, 241, r); g.fill(); x += dash + gap; }
        });
      });
      g.fillStyle = "rgba(255,201,107,.55)"; g.font = "600 22px -apple-system,Segoe UI,Roboto,Arial,sans-serif"; g.textAlign = "center";
      g.fillText("Morse Lux", w / 2, h - 36);
      cv.toBlob(function (blob) {
        var a = document.createElement("a"); a.href = URL.createObjectURL(blob);
        var fname = input.value.trim().replace(/[äÄ]/g, "ae").replace(/[öÖ]/g, "oe").replace(/[üÜ]/g, "ue").replace(/ß/g, "ss")
          .normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\w-]+/g, "_");
        a.download = (fname || "morse") + "-morse.png";
        document.body.appendChild(a); a.click(); a.remove();
      }, "image/png");
    });
    render();
  }

  /* ---------- Play buttons in tables (data-morse) ---------- */
  function initPlayButtons() {
    document.addEventListener("click", function (e) {
      var b = e.target.closest("[data-morse]");
      if (!b) return;
      stopAll();
      b.setAttribute("data-playing", "");
      var d = playSound(b.getAttribute("data-morse"), +(b.getAttribute("data-wpm") || 18), 600);
      timers.push(setTimeout(function () { b.removeAttribute("data-playing"); }, d));
    });
  }

  /* ---------- Language hint (no redirect, so search engines see every version) ---------- */
  function initLangHint() {
    var hint = document.getElementById("langhint");
    if (!hint) return;
    try { if (localStorage.getItem("ml-langhint")) return; } catch (e) {}
    var pageLang = document.documentElement.lang.slice(0, 2);
    var want = (navigator.language || "en").slice(0, 2);
    var link = document.querySelector('link[rel=alternate][hreflang="' + want + '"]');
    if (want === pageLang || !link) return;
    var a = hint.querySelector("a[data-lang=" + want + "]");
    if (!a) return;
    a.hidden = false; a.href = link.href; hint.hidden = false;
    var tool = document.querySelector("main.tool-page");
    if (tool) { tool.insertBefore(hint, tool.firstChild); hint.classList.add("inline"); }   /* on tools it must not cover the buttons */
    else document.body.classList.add("has-langhint");                 /* leave room at the bottom, so the hint covers nothing */
    hint.querySelector("button").addEventListener("click", function () {
      hint.hidden = true; document.body.classList.remove("has-langhint");
      try { localStorage.setItem("ml-langhint", "1"); } catch (e) {}
    });
  }

  /* Every page opens at the top (unless a link points to a spot on the page),
     also inside preview windows that would otherwise keep the old scroll position. */
  try { if ("scrollRestoration" in history) history.scrollRestoration = "manual"; } catch (e) {}
  function jumpTop() {
    try { window.scrollTo({ top: 0, left: 0, behavior: "instant" }); } catch (e) { window.scrollTo(0, 0); }
    try { document.body.scrollIntoView({ block: "start", behavior: "instant" }); } catch (e) {}
  }
  function toTop() {
    if (location.hash && !/^#m=/.test(location.hash)) return;
    if (/^#m=/.test(location.hash)) return; /* secret links scroll to the message themselves */
    jumpTop();
  }

  /* Internal links: jump to the top first (allowed during the tap, also in preview
     windows that keep their scroll position), then open the new page. */
  function initTopLinks() {
    document.addEventListener("click", function (e) {
      var a = e.target.closest("a[href]");
      if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      if (a.target && a.target !== "_self") return;
      var href = a.getAttribute("href");
      if (!href || href.charAt(0) === "#" || /^(mailto:|tel:|blob:|data:)/.test(href) || a.hasAttribute("download")) return;
      var dest = new URL(href, location.href);
      if (dest.origin !== location.origin || /\.(pdf|png|wav|xml|txt)$/i.test(dest.pathname)) return;
      if (dest.pathname === location.pathname && dest.hash) return;
      e.preventDefault();
      document.documentElement.classList.add("leaving"); /* hide the old page at once */
      jumpTop();
      location.href = dest.href;
    });
  }

  /* Coming back with the browser's back button shows the page again. */
  window.addEventListener("pageshow", function () { document.documentElement.classList.remove("leaving"); });

  /* Phone: the menu scrolls sideways. Show the current page and a hint that there is more. */
  function initNav() {
    var nav = document.querySelector("nav.main");
    if (!nav) return;
    var cur = nav.querySelector("[aria-current]");
    if (cur && nav.scrollWidth > nav.clientWidth) nav.scrollLeft = Math.max(0, cur.offsetLeft - (nav.clientWidth - cur.offsetWidth) / 2);
    function edges() {
      nav.classList.toggle("more-right", nav.scrollLeft + nav.clientWidth < nav.scrollWidth - 4);
      nav.classList.toggle("more-left", nav.scrollLeft > 4);
    }
    nav.addEventListener("scroll", edges, { passive: true });
    window.addEventListener("resize", edges);
    edges();
  }

  document.addEventListener("DOMContentLoaded", function () {
    toTop();
    initNav();
    initTopLinks();
    var tr = document.getElementById("translator");
    if (tr) initTranslator(tr);
    var nt = document.getElementById("nametool");
    if (nt) initNameTool(nt);
    initPlayButtons();
    initLangHint();
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") stopAll(); });
    var flash = document.getElementById("flash");
    if (flash) flash.addEventListener("click", stopAll);
  });

  window.MorseLux = { toMorse: toMorse, fromMorse: fromMorse, CODE: CODE, DECODE: DECODE, shapes: shapes, display: display,
    playSound: playSound, stopAll: stopAll, toast: toast, audio: audio, timeline: timeline,
    later: function (fn, ms) { timers.push(setTimeout(fn, ms)); } };
})();
