/* Morse Lux website: translator, playback (sound, light, vibration), WAV download, share links. No dependencies. */
(function () {
  "use strict";
  var L = window.ML_I18N || {};                                  /* texts in the page language */

  var CODE = {
    A: ".-", B: "-...", C: "-.-.", D: "-..", E: ".", F: "..-.", G: "--.", H: "....", I: "..", J: ".---",
    K: "-.-", L: ".-..", M: "--", N: "-.", O: "---", P: ".--.", Q: "--.-", R: ".-.", S: "...", T: "-",
    U: "..-", V: "...-", W: ".--", X: "-..-", Y: "-.--", Z: "--..",
    "0": "-----", "1": ".----", "2": "..---", "3": "...--", "4": "....-", "5": ".....", "6": "-....",
    "7": "--...", "8": "---..", "9": "----.",
    ".": ".-.-.-", ",": "--..--", "?": "..--..", "'": ".----.", "!": "-.-.--", "/": "-..-.", "(": "-.--.",
    ")": "-.--.-", "&": ".-...", ":": "---...", ";": "-.-.-.", "=": "-...-", "+": ".-.-.", "-": "-....-",
    "_": "..--.-", "\"": ".-..-.", "$": "...-..-", "@": ".--.-.",
    "Ä": ".-.-", "Ö": "---.", "Ü": "..--", "ß": "...--..", "Ñ": "--.--", "É": "..-..", "À": ".--.-", "È": ".-..-", "Ç": "-.-..", "Ğ": "--.-.", "Ş": ".--.."
  };
  var DECODE = {};
  Object.keys(CODE).forEach(function (k) { if (!DECODE[CODE[k]]) DECODE[CODE[k]] = k; });
  var FOLD = { "Å": "À", "Ø": "Ö", "Œ": "OE", "Æ": "AE", "Ã": "A", "Õ": "O", "Ý": "Y", "Ì": "I", "Ò": "O", "Ù": "U", "Á": "A", "Í": "I", "Ó": "O", "Ú": "U", "Â": "A", "Ê": "E", "Î": "I", "Ô": "O", "Û": "U", "Ë": "E", "Ï": "I", "İ": "I" };

  /* upper case, but ß stays ß (JavaScript would make SS of it) */
  function up(s) { return s.replace(/ß/g, "\u0001").replace(/ı/g, "I").toUpperCase().replace(/\u0001|ẞ/g, "ß"); }

  function toMorse(text) {
    return up(text).split(/\s+/).filter(Boolean).map(function (word) {
      return Array.from(word).map(function (ch) {
        if (CODE[ch]) return CODE[ch];
        if (FOLD[ch]) return Array.from(FOLD[ch]).map(function (c) { return CODE[c]; }).join(" ");
        return "";
      }).filter(Boolean).join(" ");
    }).filter(Boolean).join(" / ");
  }

  /* characters of a text that have no Morse code (shown as a note, so nothing vanishes silently) */
  function unknownChars(text) {
    var seen = {}, out = [];
    Array.from(up(text)).forEach(function (ch) {
      if (/\s/.test(ch) || CODE[ch] || FOLD[ch] || /[¿¡\u200d\ufe0f]/.test(ch) || seen[ch]) return;
      seen[ch] = 1; out.push(ch);
    });
    return out;
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
      return word.trim().split(/\s+/).map(function (sym) { return sym ? (DECODE[sym] || "?") : ""; }).join("");
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
  function copyText(text, okMsg) {
    if (!navigator.clipboard || !navigator.clipboard.writeText) { copyFail(); return; }
    navigator.clipboard.writeText(text).then(function () { toast(okMsg); }, copyFail);
  }
  function say(msg) {                                             /* for screen readers only */
    var r = document.getElementById("sr-live");
    if (!r) { r = document.createElement("div"); r.id = "sr-live"; r.className = "sr-only"; r.setAttribute("aria-live", "assertive"); document.body.appendChild(r); }
    r.textContent = msg;
  }
  var MAX_MS = 300000;                                            /* longest sound or light signal: 5 minutes */
  function tooLong(m, wpm) { if (timeline(m, wpm).total > MAX_MS) { toast(L.tooLong || "Too long to play – shorten the text (max. 5 minutes)"); return true; } return false; }

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
    if (f) f.classList.remove("on", "show", "full");
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
  /* Light: a lamp in the middle of a dark screen, never faster than 7 WPM, so it blinks at most about
     3 times per second (safe for people who are sensitive to flashing light). The first time, a short note comes first. */
  function playLight(morse, wpm, full) {
    var f = document.getElementById("flash");
    if (!f) return 0;
    var tl = timeline(morse, Math.min(wpm, 7)), lead = 80, note = f.querySelector(".flash-note"), seen = false;
    var t = document.getElementById("toast"); if (t) t.classList.remove("show");
    f.classList.toggle("full", !!full);
    say(L.lightOn || "Light signal running – tap or press Escape to stop");
    try { seen = localStorage.getItem("ml-light-ok") === "1"; localStorage.setItem("ml-light-ok", "1"); } catch (e) {}
    if (note) note.hidden = seen;
    if (!seen) lead = full ? 1500 : 3000;
    f.classList.add("show");
    if (note && !seen) timers.push(setTimeout(function () { note.hidden = true; }, lead - 200));
    tl.events.forEach(function (ev) {
      timers.push(setTimeout(function () { f.classList.add("on"); }, ev[0] + lead));
      timers.push(setTimeout(function () { f.classList.remove("on"); }, ev[0] + ev[1] + lead));
    });
    timers.push(setTimeout(function () { f.classList.remove("show"); }, tl.total + lead + 320));
    return tl.total + lead + 320;
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
    clearTimeout(toast.timer);
    toast.timer = setTimeout(function () { t.classList.remove("show"); }, 2200);
  }

  /* ---------- Translator widget ---------- */
  function initTranslator(root) {
    var L = window.ML_I18N || {};
    var textEl = root.querySelector("#t-text"), morseEl = root.querySelector("#t-morse");
    var wpmEl = root.querySelector("#t-wpm"), wpmOut = root.querySelector("#t-wpm-out");
    var freqEl = root.querySelector("#t-freq"), freqOut = root.querySelector("#t-freq-out");
    var lock = false;

    /* the boxes grow downwards with the text, so long messages never need scrolling inside the box;
       side by side (wide screens) both boxes get the same height */
    function grow() {
      var els = [textEl, morseEl], side = textEl.getBoundingClientRect().top === morseEl.getBoundingClientRect().top;
      els.forEach(function (el) { el.style.height = "auto"; });
      var hs = els.map(function (el) { return el.scrollHeight + 2; });
      els.forEach(function (el, i) { el.style.height = (side ? Math.max(hs[0], hs[1]) : hs[i]) + "px"; });
    }
    window.addEventListener("resize", function () { grow(); });

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
      grow();
      var bad = from === "text" ? unknownChars(textEl.value) : [];
      if (!note) { note = document.createElement("p"); note.className = "t-note small"; note.setAttribute("role", "status"); morseEl.parentNode.appendChild(note); }
      note.textContent = bad.length ? (L.noCode || "No Morse code for: {c}").replace("{c}", bad.slice(0, 12).join(" ")) : "";
      note.hidden = !bad.length;
    }
    var note = null;
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
      if (tooLong(m, Math.min(wpm(), btn.getAttribute("data-act") === "light" ? 7 : 99))) return;
      btn.setAttribute("data-playing", "");
      var d = fn(m);
      timers.push(setTimeout(function () { btn.removeAttribute("data-playing"); }, d));
    }
    root.querySelector("[data-act=sound]").addEventListener("click", function () { var b = this; run(b, function (m) { return playSound(m, wpm(), freq()); }); });
    root.querySelector("[data-act=light]").addEventListener("click", function () { var b = this; run(b, function (m) { return playLight(m, wpm()); }); });
    root.querySelector("[data-act=vibrate]").addEventListener("click", function () {
      if (!navigator.vibrate) {
        var ios = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
        toast((ios && L.noVibrateIOS) || L.noVibrate || "Vibration is not supported in this browser"); return;
      }
      var b = this; run(b, function (m) { return playVibration(m, wpm()); });
    });
    root.querySelector("[data-act=stop]").addEventListener("click", stopAll);
    root.querySelector("[data-act=copy]").addEventListener("click", function () {
      if (!morseEl.value.trim()) { toast(L.empty || "Type something first"); return; }
      copyText(ascii(morseEl.value), L.copied || "Copied");
      var tip = root.parentNode.querySelector(".kb-tip"), seenTip = true;
      try { seenTip = localStorage.getItem("ml-kbtip") === "1"; localStorage.setItem("ml-kbtip", "1"); } catch (e) {}
      if (tip && !seenTip && !/Android/i.test(navigator.userAgent)) tip.hidden = false;
    });
    root.querySelector("[data-act=wav]").addEventListener("click", function () {
      var m = morseEl.value.trim();
      if (!m) { toast(L.empty || "Type something first"); return; }
      if (tooLong(m, wpm())) return;
      var a = document.createElement("a");
      a.href = URL.createObjectURL(wavBlob(m, wpm(), freq()));
      a.download = "morse.wav"; document.body.appendChild(a); a.click(); a.remove();
    });
    root.querySelector("[data-act=share]").addEventListener("click", function () {
      var t = textEl.value.trim();
      if (!t) { toast(L.empty || "Type something first"); return; }
      var base = document.body.getAttribute("data-home") || (location.origin + location.pathname);   /* embedded copies link to the real page */
      var url = base + "#m=" + encodeShare(t);
      var msg = (L.shareText || "Can you decode this Morse message?") + "\n" + toMorse(t) + "\n";
      if (navigator.share) navigator.share({ title: "Morse", text: msg, url: url }).catch(function () {});
      else copyText(msg + url, L.linkCopied || "Link copied");
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
    root.querySelector("[data-act=clear]").addEventListener("click", function () { stopAll(); textEl.value = ""; morseEl.value = ""; grow(); textEl.focus(); });

    /* Secret message from a share link */
    var m = location.hash.match(/#m=([A-Za-z0-9_-]+)/);
    if (m) {
      var secret = decodeShare(m[1]);
      if (secret) {
        var box = document.getElementById("secret");
        morseEl.value = display(toMorse(secret));
        textEl.value = "";
        grow();
        if (box) {
          box.hidden = false;
          box.querySelector("[data-secret-morse]").innerHTML = shapes(toMorse(secret));
          box.querySelector("[data-act=reveal]").addEventListener("click", function () {
            textEl.value = secret; grow();
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
      return Array.from(up(input.value)).filter(function (c) { return c === " " || CODE[c] || (FOLD[c] && FOLD[c].length === 1); });
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
      copyText(m, L.copied || "Copied");
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
      g.fillText("morselux.com", w / 2, h - 36);
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
      var lb = e.target.closest("[data-light]");
      if (lb) { stopAll(); playLight(lb.getAttribute("data-light"), lb.hasAttribute("data-full") ? 6 : 7, lb.hasAttribute("data-full")); return; }
      var cb = e.target.closest("[data-copy]");
      if (cb) { copyText(cb.getAttribute("data-copy"), L.copied || "Morse code copied"); return; }
      var sb = e.target.closest("[data-secret]");
      if (sb) {                                                   /* share a word or phrase as a secret message (opens in the translator) */
        var txt = sb.getAttribute("data-secret"), url = new URL(sb.getAttribute("data-home") || "/", location.href).href + "#m=" + encodeShare(txt);
        var msg = (L.shareText || "Can you decode this Morse message?") + "\n" + toMorse(txt) + "\n";
        if (navigator.share) navigator.share({ title: "Morse", text: msg, url: url }).catch(function () {});
        else copyText(msg + url, L.linkCopied || "Link copied");
        return;
      }
      var b = e.target.closest("[data-morse]");
      if (!b) return;
      stopAll();
      b.setAttribute("data-playing", "");
      var d = playSound(b.getAttribute("data-morse"), +(b.getAttribute("data-wpm") || 18), 600);
      timers.push(setTimeout(function () { b.removeAttribute("data-playing"); }, d));
    });
  }

  /* ---------- Language hint (no redirect, so search engines see every version) ---------- */
  /* ---------- Android: the app is iPhone-only, so no dead App Store buttons ---------- */
  function initAndroid() {
    if (!/Android/i.test(navigator.userAgent || "")) return;
    document.documentElement.classList.add("is-android");
    var kb = document.querySelector(".kb-hero");
    var links = document.querySelectorAll("a.appstore");
    for (var i = 0; i < links.length; i++) {
      var a = links[i], p = document.createElement("p");
      p.className = "android-note";
      var full = (kb && L.androidKb) || L.android || "The app is iPhone-only.";
      p.textContent = (i === 0 && !a.closest("footer")) ? full : (L.androidShort || full);
      a.parentNode.replaceChild(p, a);
    }
  }

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
    var mainEl = document.querySelector("main");                     /* always at the top of the page, so it covers nothing */
    if (mainEl) { mainEl.insertBefore(hint, mainEl.firstChild); hint.classList.add("inline"); }
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
  var navBack = false;
  try { var ne = performance.getEntriesByType("navigation")[0]; navBack = !!ne && ne.type === "back_forward"; } catch (e) {}
  window.addEventListener("pagehide", function () { try { sessionStorage.setItem("ml-y:" + location.pathname, String(window.scrollY)); } catch (e) {} });
  function toTop() {
    if (navBack) {                                                /* back button: return to where the reader was */
      var y = 0; try { y = +sessionStorage.getItem("ml-y:" + location.pathname) || 0; } catch (e) {}
      if (y) { setTimeout(function () { window.scrollTo(0, y); }, 0); return; }
    }
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
      try { sessionStorage.setItem("ml-y:" + location.pathname, String(window.scrollY)); } catch (e2) {}
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

  /* language menu closes on a tap outside or Escape; the alphabet on the home page is open on wide screens;
     dots under the keyboard pictures show which one is in view */
  function initMenus() {
    var lm = document.querySelector(".langmenu");
    if (lm) {
      document.addEventListener("click", function (e) { if (lm.open && !lm.contains(e.target)) lm.open = false; });
      document.addEventListener("keydown", function (e) { if (e.key === "Escape") lm.open = false; });
    }
    if (window.innerWidth >= 800) document.querySelectorAll("details.fold").forEach(function (d) { d.open = true; });
    var ks = document.querySelector(".kbshots");
    if (ks) {
      var figs = ks.querySelectorAll("figure"), dots = document.createElement("div");
      dots.className = "kbdots"; dots.setAttribute("aria-hidden", "true");
      figs.forEach(function () { dots.appendChild(document.createElement("i")); });
      ks.parentNode.insertBefore(dots, ks.nextSibling);
      var upd = function () {
        var mid = ks.scrollLeft + ks.clientWidth / 2, best = 0, bd = 1e9;
        figs.forEach(function (f, i) { var d = Math.abs(f.offsetLeft - ks.offsetLeft + f.offsetWidth / 2 - mid); if (d < bd) { bd = d; best = i; } });
        dots.querySelectorAll("i").forEach(function (el, i) { el.classList.toggle("on", i === best); });
      };
      ks.addEventListener("scroll", upd, { passive: true }); upd();
    }
  }

  /* Keyboard demo: how the Morse Lux keyboard types (dot, dash, letter gap, space, delete) */
  function initKbDemo(box) {
    var out = box.querySelector("[data-kb-out]"), codeEl = box.querySelector("[data-kb-code]"), letterEl = box.querySelector("[data-kb-letter]");
    var text = "", code = "", timer = null;
    function render() {
      out.textContent = text;
      codeEl.innerHTML = code ? shapes(code) : "";
      letterEl.textContent = code ? (DECODE[code] || "?") : "";
      box.classList.toggle("has-text", !!text);
    }
    function commit() { if (code) { text += DECODE[code] || ""; code = ""; } }
    box.addEventListener("click", function (e) {
      var b = e.target.closest("[data-kb]"); if (!b) return;
      var k = b.getAttribute("data-kb");
      clearTimeout(timer);
      if (k === "." || k === "-") {
        if (code.length < 8) code += k;
        try { playSound(k, 22, 640); } catch (err) {}
        timer = setTimeout(function () { commit(); render(); }, 1400);   /* like the keyboard: a short pause ends the letter */
      } else if (k === "next") commit();
      else if (k === "space") { commit(); text += " "; }
      else if (k === "back") { if (code) code = code.slice(0, -1); else text = text.slice(0, -1); }
      render();
    });
    render();
  }

  /* Morse puzzle of the day: one word per day for everyone, 4 tries, spoiler-free sharing (like Wordle) */
  /* Morse puzzle of the day: one word per day and level for everyone, spoiler-free sharing (like Wordle).
     The word: days are counted from 1 Nov 2026 (local midnight); each level has its own word list in a fixed
     shuffled order, and day n takes word n of that order, so everybody gets the same word on the same day. */
  function initDaily(box) {
    var D = L.daily || {};
    var LEVELS = {
      easy: { max: 6, wpm: 12, shapes: true, hint: true, salt: 3.1 },
      medium: { max: 4, wpm: 15, shapes: true, hint: true, salt: 0 },
      hard: { max: 4, wpm: 20, shapes: false, hint: false, salt: 7.7 }
    };
    var start = Date.UTC(2026, 10, 1), now = new Date();
    var day = Math.floor((Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) - start) / 864e5), no = day + 1;
    var lang = document.documentElement.lang || "en", level = "medium";
    try { level = localStorage.getItem("ml-daily-level:" + lang) || "medium"; } catch (e) {}
    if (!LEVELS[level]) level = "medium";
    var input = box.querySelector("input"), grid = box.querySelector("[data-grid]"), msg = box.querySelector("[data-msg]");
    var endBox = box.querySelector("[data-end]"), codeEl = box.querySelector("[data-code]"), hintBtn = box.querySelector("[data-act=d-hint]");
    var cfg, answer, code, st, KEY;

    function orderFor(lv) {
      var words = (box.getAttribute("data-words-" + lv) || "").split(",").filter(Boolean), salt = LEVELS[lv].salt;
      return words.map(function (w, i) { var x = Math.sin(i * 12.9898 + 78.233 + salt) * 43758.5453; return [x - Math.floor(x), w]; })
        .sort(function (p, q) { return p[0] - q[0]; }).map(function (p) { return p[1]; });
    }
    function pick(order, d) { return order[((d % order.length) + order.length) % order.length].toUpperCase(); }
    function save() { try { localStorage.setItem(KEY, JSON.stringify(st)); } catch (e) {} }
    /* like Wordle: first the right letters in the right place (1), then right letters in the wrong place (2),
       but only as often as the letter is still left in the word */
    function marks(g) {
      var left = {}, m = [], i;
      for (i = 0; i < answer.length; i++) { if (g[i] === answer[i]) m[i] = 1; else { m[i] = 0; left[answer[i]] = (left[answer[i]] || 0) + 1; } }
      for (i = 0; i < answer.length; i++) { if (!m[i] && left[g[i]]) { m[i] = 2; left[g[i]]--; } }
      return m;
    }

    function setup(lv) {
      level = lv; cfg = LEVELS[lv];
      try { localStorage.setItem("ml-daily-level:" + lang, lv); } catch (e) {}
      box.querySelectorAll("[data-level]").forEach(function (b) { b.setAttribute("aria-pressed", b.getAttribute("data-level") === lv ? "true" : "false"); });
      var order = orderFor(lv);
      if (!order.length) return;
      answer = pick(order, day); code = toMorse(answer);
      KEY = "ml-daily-v2:" + lang + ":" + lv; st = {};
      try { st = JSON.parse(localStorage.getItem(KEY) || "{}"); } catch (e) {}
      st.stats = st.stats || { played: 0, won: 0, streak: 0, best: 0, last: -1 };
      if (st.day !== day || (st.answer && st.answer !== answer)) { st.day = day; st.guesses = []; st.done = false; st.hints = 0; st.revealed = false; }
      st.answer = answer;
      box.querySelector("[data-no]").textContent = "#" + no;
      box.querySelector("[data-len]").textContent = (D.letters || "{n} letters").replace("{n}", answer.length);
      box.querySelector("[data-level-note]").textContent = D["note_" + lv] || "";
      var yd = box.querySelector("[data-yday]");
      if (yd) yd.textContent = day > 0 ? (D.yesterday || "Yesterday's word: {w}").replace("{w}", pick(order, day - 1)) : "";
      hintBtn.hidden = !cfg.hint;
      input.maxLength = answer.length; input.value = ""; msg.textContent = "";
      confirmReveal = false; hintLabel();
      if (st.hints && !st.done) msg.textContent = (D.hintText || "First letter: {c}").replace("{c}", answer[0]);
      render();
    }
    function render() {
      /* hard: only the sound – the dots and dashes appear when the puzzle is over */
      codeEl.innerHTML = cfg.shapes || st.done ? shapes(code) : '<span class="dg-ear">🎧 ' + (D.earOnly || "Listen only") + "</span>";
      grid.innerHTML = st.guesses.map(function (g) {
        var m = marks(g);
        return '<div class="dg-row">' + g.split("").map(function (c, i) { return '<span class="dg-c s' + m[i] + '">' + c + "</span>"; }).join("") + "</div>";
      }).join("");
      box.querySelector("[data-left]").textContent = st.done ? "" : (D.left || "{n} tries left").replace("{n}", cfg.max - st.guesses.length);
      endBox.hidden = !st.done;
      hintBtn.hidden = !cfg.hint || st.done;
      box.querySelector("form").hidden = st.done;
      if (st.done) {
        var won = st.guesses[st.guesses.length - 1] === answer, s = st.stats;
        endBox.querySelector("[data-result]").innerHTML = (won ? (D.won || "Solved!") : st.revealed ? (D.revealed || "Revealed. The word was") : (D.lost || "The word was")) + " <b>" + answer + "</b>";
        endBox.querySelector("[data-stats]").textContent = (D.stats || "Played {p} · won {w} · streak {s} · best {b}")
          .replace("{p}", s.played).replace("{w}", s.won).replace("{s}", s.streak).replace("{b}", s.best);
        tick();
      }
    }
    function shareText() {
      var won = st.guesses[st.guesses.length - 1] === answer;
      var rows = st.guesses.map(function (g) { return marks(g).map(function (v) { return v === 1 ? "🟩" : v === 2 ? "🟨" : "⬛"; }).join(""); }).join("\n");
      return (D.shareTitle || "Morse puzzle") + " #" + no + " · " + (D["lv_" + level] || level) + " " + (won ? st.guesses.length : "X") + "/" + cfg.max + (st.revealed ? " 💡" : "") + "\n" + rows + "\n" + location.href.split("#")[0];
    }
    function tick() {
      var t = new Date(), next = new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1), ms = next - t;
      endBox.querySelector("[data-next]").textContent = (D.next || "Next puzzle in {h} h {m} min").replace("{h}", Math.floor(ms / 36e5)).replace("{m}", Math.floor(ms / 6e4) % 60);
    }
    box.querySelectorAll("[data-level]").forEach(function (b) {
      b.addEventListener("click", function () { stopAll(); setup(b.getAttribute("data-level")); });
    });
    box.querySelector("[data-act=d-play]").addEventListener("click", function () { stopAll(); playSound(code, cfg.wpm, 620); });
    var confirmReveal = false, confirmTimer = null;
    function hintLabel() { hintBtn.textContent = confirmReveal ? "⚠️ " + (D.revealSure || "Really show it? Your streak ends") : st.hints ? "👀 " + (D.reveal || "Show answer") : "💡 " + (D.hint || "Hint"); }
    /* 1st press: first letter · 2nd press: the answer (counts as not solved) */
    hintBtn.addEventListener("click", function () {
      if (st.done) return;
      if (!st.hints) {
        st.hints = 1; save(); hintLabel();
        msg.textContent = (D.hintText || "First letter: {c}").replace("{c}", answer[0]);
        return;
      }
      if (!confirmReveal) {                                       /* ask once more, so nobody loses a streak by accident */
        confirmReveal = true; hintLabel();
        clearTimeout(confirmTimer); confirmTimer = setTimeout(function () { confirmReveal = false; hintLabel(); }, 5000);
        return;
      }
      clearTimeout(confirmTimer); confirmReveal = false;
      st.hints = 2; st.revealed = true; st.done = true;
      var s = st.stats; s.played++; s.streak = 0;
      msg.textContent = ""; save(); render();
    });
    box.querySelector("form").addEventListener("submit", function (e) {
      e.preventDefault();
      if (st.done) return;
      var g = input.value.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9 ]/g, "").trim();
      if (g.length !== answer.length) { msg.textContent = (D.wrongLen || "The word has {n} letters.").replace("{n}", answer.length); return; }
      msg.textContent = ""; input.value = "";
      st.guesses.push(g);
      var won = g === answer;
      if (won || st.guesses.length >= cfg.max) {
        st.done = true; var s = st.stats; s.played++;
        if (won) { s.won++; s.streak = s.last === day - 1 ? s.streak + 1 : 1; s.best = Math.max(s.best, s.streak); s.last = day; } else s.streak = 0;
      }
      save(); render();
    });
    box.querySelector("[data-act=d-share]").addEventListener("click", function () {
      var txt = shareText();
      if (navigator.share) { navigator.share({ text: txt }).catch(function () {}); return; }
      copyText(txt, D.copied || "Result copied – paste it anywhere");
    });
    setup(level);
    /* the countdown runs; at midnight the new puzzle appears */
    setInterval(function () {
      var n = new Date(), d2 = Math.floor((Date.UTC(n.getFullYear(), n.getMonth(), n.getDate()) - start) / 864e5);
      if (d2 !== day) { day = d2; no = day + 1; setup(level); }
      else if (st && st.done) tick();
    }, 20000);
  }

  /* offline support (works after the first visit); not inside embedded copies on other websites */
  if ("serviceWorker" in navigator && location.protocol === "https:" && !(document.body && document.body.classList.contains("embedded"))) {
    window.addEventListener("load", function () { navigator.serviceWorker.register("/sw.js").catch(function () {}); });
  }

  document.addEventListener("DOMContentLoaded", function () {
    toTop();
    var dl = document.getElementById("daily");
    if (dl) initDaily(dl);
    var kb = document.getElementById("kbdemo");
    if (kb) initKbDemo(kb);
    initNav();
    initMenus();
    initTopLinks();
    var tr = document.getElementById("translator");
    if (tr) initTranslator(tr);
    var nt = document.getElementById("nametool");
    if (nt) initNameTool(nt);
    initPlayButtons();
    initLangHint();
    initAndroid();
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") stopAll(); });
    var flash = document.getElementById("flash");
    if (flash) flash.addEventListener("click", stopAll);
  });

  window.MorseLux = { toMorse: toMorse, fromMorse: fromMorse, CODE: CODE, DECODE: DECODE, shapes: shapes, display: display,
    playSound: playSound, stopAll: stopAll, toast: toast, copyText: copyText, audio: audio, timeline: timeline,
    later: function (fn, ms) { timers.push(setTimeout(fn, ms)); } };
})();
