/* Morse Lux website: audio decoder (microphone and audio files) and Morse trainer. No dependencies, runs in the browser only. */
(function (root) {
  "use strict";

  /* ======================================================================
     Decoder core: finds the tone, turns it into on/off marks and learns the
     speed. Works sample by sample, so the microphone and files use the same code.
     ====================================================================== */
  var KOCH = "KMRSUAPTLOWI.NJEF0Y,VG5/Q9ZH38B?427C1D6X";

  function Decoder(sampleRate, decode) {
    this.sr = sampleRate;
    this.decodeTable = decode;
    this.hop = Math.max(64, Math.round(sampleRate * 0.004));      /* one step = 4 ms */
    this.win = Math.round(sampleRate * 0.012);                     /* tone filter looks at 12 ms */
    this.freqs = [];
    for (var f = 300; f <= 1300; f += 20) this.freqs.push(f);
    this.coef = this.freqs.map(function (fr) { return 2 * Math.cos(2 * Math.PI * fr / sampleRate); });
    this.avg = this.freqs.map(function () { return 0; });
    this.buf = new Float32Array(this.win);
    this.bufPos = 0; this.filled = 0; this.sinceHop = 0;
    this.lock = -1;
    this.floor = null; this.peak = null;
    this.on = false; this.pending = 0; this.runMs = 0;
    this.events = [];           /* [isMark, ms] */
    this.committed = "";
    this.committedMorse = "";
    this.stepMs = this.hop / sampleRate * 1000;
    this.level = 0; this.snr = 0;
    this.dotMs = 0;
    this.hist = [];             /* loudness of the last 6 s, to look again when the noise level was misjudged */
    this.liveSteps = 0; this.checked = false;
  }

  /* Look at a stretch of the loudness history again, with the noise level and the tone level measured
     from that stretch. Used (1) once after the first 2 s of sound, because the noise level is not known
     yet at the very start, and (2) when a "signal" lasts 1.5 s — that is really background noise. */
  Decoder.prototype.resegment = function (n, fromScratch) {
    var vals = this.hist.slice(-n);
    var sorted = vals.slice().sort(function (a, b) { return a - b; });
    var floor = sorted[Math.floor(vals.length * 0.3)], peak = sorted[Math.floor(vals.length * 0.97)];
    this.floor = floor; this.peak = Math.max(peak, floor);
    if (fromScratch) this.events = [];
    var range = peak - floor;
    if (range < 13) { this.on = false; this.runMs = vals.length * this.stepMs; this.pending = 0; return; }
    var thr = floor + range * 0.5, hyst = range * 0.1, on = false, run = 0, segs = [];
    for (var i = 0; i < vals.length; i++) {
      var want = on ? vals[i] > thr - hyst : vals[i] > thr + hyst;
      if (want !== on) { if (run > 0) segs.push([on ? 1 : 0, run]); run = 0; on = want; }
      run += this.stepMs;
    }
    for (i = 0; i < segs.length; i++) { this.on = !!segs[i][0]; this.endRun(segs[i][1]); }
    this.on = on; this.runMs = run; this.pending = 0;
  };

  Decoder.prototype.goertzel = function (k) {
    var c = this.coef[k], s1 = 0, s2 = 0, n = this.win, b = this.buf, p = this.bufPos;
    for (var i = 0; i < n; i++) {
      var x = b[(p + i) % n];
      var s0 = x + c * s1 - s2; s2 = s1; s1 = s0;
    }
    return (s1 * s1 + s2 * s2 - c * s1 * s2) / (n * n);
  };

  Decoder.prototype.feed = function (samples) {
    for (var i = 0; i < samples.length; i++) {
      this.buf[this.bufPos] = samples[i];
      this.bufPos = (this.bufPos + 1) % this.win;
      if (this.filled < this.win) this.filled++;
      if (++this.sinceHop >= this.hop) { this.sinceHop = 0; if (this.filled === this.win) this.step(); }
    }
  };

  Decoder.prototype.step = function () {
    var n = this.freqs.length, best = 0, bestK = 0, pw = new Array(n);
    for (var k = 0; k < n; k++) {
      pw[k] = this.goertzel(k);
      this.avg[k] += (pw[k] - this.avg[k]) * 0.004;            /* ~1 s memory: which tone is used */
      if (this.avg[k] > best) { best = this.avg[k]; bestK = k; }
    }
    this.lock = bestK;
    var lo = Math.max(0, bestK - 1), hi = Math.min(n - 1, bestK + 1), p = 0;
    for (k = lo; k <= hi; k++) p = Math.max(p, pw[k]);
    var db = Math.max(-100, 10 * Math.log10(p + 1e-12));       /* digital silence counts as very quiet, not as -infinity */
    if (this.floor === null) { this.floor = db; this.peak = db; }
    /* noise level = average of the quiet parts; peak = how loud the tone is */
    /* a "signal" that never stops (> 1.5 s) is background noise: the floor moves up to it quickly */
    if (!this.on) this.floor += (db - this.floor) * (db < this.floor ? 0.05 : 0.01);
    else this.floor += (db - this.floor) * 0.0008;
    this.hist.push(db); if (this.hist.length > 1500) this.hist.shift();
    if (!this.checked) {
      if (db > -99 || this.liveSteps) this.liveSteps++;
      if (this.liveSteps * this.stepMs >= 2000) { this.checked = true; this.resegment(this.liveSteps, true); return; }
    }
    if (this.on && this.runMs > 1500) { this.resegment(Math.min(this.hist.length, Math.round(this.runMs / this.stepMs)), false); return; }
    if (db > this.peak) this.peak += (db - this.peak) * 0.3; else this.peak += (this.floor - this.peak) * 0.0012;
    var range = this.peak - this.floor;
    this.snr = range; this.level = Math.max(0, Math.min(1, (db - this.floor) / Math.max(range, 14)));
    var thr = this.floor + range * 0.5, hyst = range * 0.1;
    var want = range > 13 && (this.on ? db > thr - hyst : db > thr + hyst);
    if (want !== this.on) {
      this.pending++;
      if (this.pending >= 2) {                                   /* ignore clicks shorter than 8 ms */
        var carry = this.pending * this.stepMs;
        this.endRun(Math.max(0, this.runMs - carry + this.stepMs));
        this.on = want; this.runMs = carry; this.pending = 0;
        return;
      }
    } else this.pending = 0;
    this.runMs += this.stepMs;
  };

  Decoder.prototype.endRun = function (ms) {
    if (ms <= 0) return;
    if (!this.on && !this.events.length) return;                /* silence before the first signal */
    this.events.push([this.on ? 1 : 0, ms]);
    if (this.events.length > 260) {                              /* keep the text, forget old timing */
      var dot = this.estimate(this.events).dot, cut = -1;
      for (var i = 120; i < this.events.length - 20; i++) if (!this.events[i][0] && this.events[i][1] > dot * 2.5) { cut = i; break; }
      if (cut < 0) return;
      var head = this.events.splice(0, cut + 1);
      var r = this.decodeEvents(head, 0, true);
      this.committed += r.text; this.committedMorse += r.morse;
      if (head[head.length - 1][1] > dot * 5 && this.committed.slice(-1) !== " ") { this.committed += " "; this.committedMorse += "/ "; }
    }
  };

  /* Speed estimate from the recent marks: split them into short (dots) and long (dashes). */
  Decoder.prototype.estimate = function (evs) {
    var marks = [], i;
    for (i = evs.length - 1; i >= 0 && marks.length < 60; i--) if (evs[i][0]) marks.push(evs[i][1]);
    if (!marks.length) return { dot: this.dotMs || 80 };
    var logs = marks.map(function (m) { return Math.log(m); }).sort(function (a, b) { return a - b; });
    var bestSplit = -1, bestScore = 0;
    for (i = 1; i < logs.length; i++) {
      var a = logs.slice(0, i), b = logs.slice(i);
      var ma = a.reduce(function (s, x) { return s + x; }, 0) / a.length, mb = b.reduce(function (s, x) { return s + x; }, 0) / b.length;
      var score = a.length * b.length * (mb - ma) * (mb - ma);
      if (score > bestScore) { bestScore = score; bestSplit = i; }
    }
    if (bestSplit > 0) {
      var lowMean = Math.exp(logs.slice(0, bestSplit).reduce(function (s, x) { return s + x; }, 0) / bestSplit);
      var highMean = Math.exp(logs.slice(bestSplit).reduce(function (s, x) { return s + x; }, 0) / (logs.length - bestSplit));
      if (highMean / lowMean > 1.9) { this.dotMs = (lowMean + highMean / 3) / 2; return { dot: this.dotMs, split: Math.sqrt(lowMean * highMean) }; }
    }
    /* all marks look alike: dots or dashes? compare with what we knew before, otherwise assume dots */
    var mean = Math.exp(logs.reduce(function (s, x) { return s + x; }, 0) / logs.length);
    if (this.dotMs && mean > this.dotMs * 2) return { dot: this.dotMs };
    if (!this.dotMs) return { dot: mean < 220 ? mean : mean / 3 };
    return { dot: this.dotMs };
  };

  /* very short blips (clicks, noise) are not signals: merge them into the surrounding pause */
  function clean(evs, minMark) {
    var out = [];
    for (var i = 0; i < evs.length; i++) {
      var e = evs[i];
      if (e[0] && e[1] > 1500) e = [0, e[1]];                    /* a tone longer than 1.5 s is a carrier or noise, not Morse */
      if (e[0] && e[1] < minMark) { if (out.length && !out[out.length - 1][0]) out[out.length - 1] = [0, out[out.length - 1][1] + e[1]]; else out.push([0, e[1]]); continue; }
      if (!e[0] && out.length && !out[out.length - 1][0]) out[out.length - 1] = [0, out[out.length - 1][1] + e[1]];
      else out.push([e[0], e[1]]);
    }
    while (out.length && !out[0][0]) out.shift();
    return out;
  }

  Decoder.prototype.decodeEvents = function (evs, trailingSilence, final) {
    evs = clean(evs, 16);
    var est = this.estimate(evs), dot = est.dot;
    evs = clean(evs, Math.max(16, dot * 0.3));
    var split = est.split || dot * 2;
    var gaps = [], i;
    for (i = 0; i < evs.length; i++) if (!evs[i][0] && evs[i][1] > dot * 2) gaps.push(evs[i][1]);
    gaps.sort(function (a, b) { return a - b; });
    var letterGap = gaps.length ? gaps[Math.floor(gaps.length / 2)] : dot * 3;
    var wordThr = Math.max(dot * 5, Math.min(letterGap * 1.7, dot * 12));
    var text = "", morse = "", sym = "";
    var self = this;
    function flush() { if (sym) { text += self.decodeTable[sym] || "#"; morse += sym + " "; sym = ""; } }
    for (i = 0; i < evs.length; i++) {
      var e = evs[i];
      if (e[0]) sym += e[1] < split ? "." : "-";
      else if (e[1] > wordThr) { flush(); if (text && text.slice(-1) !== " ") { text += " "; morse += "/ "; } }
      else if (e[1] > dot * 2) flush();
    }
    if (final || trailingSilence > dot * 2.5) flush();
    if (trailingSilence > wordThr && text && text.slice(-1) !== " ") { text += " "; morse += "/ "; }
    return { text: text, morse: morse, open: sym, wpm: Math.round(1200 / dot) };
  };

  Decoder.prototype.result = function (final) {
    var silence = this.on ? 0 : this.runMs;
    var r = this.decodeEvents(this.events, silence, final);
    return { text: (this.committed + r.text).replace(/\s+$/, final ? "" : " ").replace(/^\s+/, ""),
             morse: (this.committedMorse + r.morse).trim(), open: r.open,
             wpm: this.events.some(function (e) { return e[0]; }) ? r.wpm : 0,
             freq: this.lock >= 0 && this.snr > 9 ? this.freqs[this.lock] : 0, level: this.level, on: this.on };
  };

  Decoder.prototype.finish = function () {
    if (!this.checked && this.liveSteps) { this.checked = true; this.resegment(this.liveSteps, true); }
    if (this.runMs > 0) { this.endRun(this.runMs); this.runMs = 0; }
    var r = this.decodeEvents(this.events, 0, true);
    return { text: (this.committed + r.text).trim(), morse: (this.committedMorse + r.morse).trim(), wpm: r.wpm };
  };

  /* Synthetic Morse audio (used for the example and for tests) */
  function synth(morseStr, wpm, freq, sr, noise, farnsworth) {
    var unit = 1.2 / wpm, gapUnit = farnsworth ? 1.2 / farnsworth : unit, segs = [], t = 0.3;
    morseStr.trim().split(/\s*\/\s*/).forEach(function (word, wi, words) {
      word.trim().split(/\s+/).forEach(function (letter, li, letters) {
        Array.from(letter).forEach(function (s, si) {
          var d = s === "." ? unit : unit * 3; segs.push([t, d]); t += d;
          if (si < letter.length - 1) t += unit;
        });
        if (li < letters.length - 1) t += gapUnit * 3;
      });
      if (wi < words.length - 1) t += gapUnit * 7;
    });
    var n = Math.ceil((t + 0.4) * sr), out = new Float32Array(n), ramp = sr * 0.004;
    segs.forEach(function (sg) {
      var s = Math.round(sg[0] * sr), len = Math.round(sg[1] * sr);
      for (var i = 0; i < len; i++) {
        var env = Math.min(1, i / ramp, (len - i) / ramp);
        out[s + i] = Math.sin(2 * Math.PI * freq * (s + i) / sr) * env * 0.5;
      }
    });
    if (noise) for (var j = 0; j < n; j++) out[j] += (Math.random() * 2 - 1) * noise;
    return out;
  }

  if (typeof module !== "undefined" && module.exports) { module.exports = { Decoder: Decoder, synth: synth, KOCH: KOCH }; return; }

  var ML = root.MorseLux, L = root.ML_I18N || {};
  function $(sel, el) { return (el || document).querySelector(sel); }
  function store(key, val) {
    try {
      if (val === undefined) return JSON.parse(localStorage.getItem(key) || "null");
      localStorage.setItem(key, JSON.stringify(val));
    } catch (e) { return null; }
  }

  /* ======================================================================
     Decoder widget
     ====================================================================== */
  function initDecoder(box) {
    var D = L.dec || {};
    var out = $("#d-text", box), morseOut = $("#d-morse", box), status = $("#d-status", box);
    var meter = $("#d-meter i", box), tape = $("#d-tape", box), stats = $("#d-stats", box);
    var micBtn = $("[data-act=d-mic]", box), demoBtn = $("[data-act=d-demo]", box), fileIn = $("#d-file", box);
    var dec = null, ac = null, node = null, stream = null, src = null, running = "", raf = 0, history = [];
    var tg = tape.getContext("2d");

    function setStatus(msg, kind) { status.textContent = msg; status.className = "d-status" + (kind ? " " + kind : ""); }
    function show(r) {
      out.value = r.text + (r.open ? "…" : "");
      morseOut.innerHTML = ML.shapes(r.morse + (r.open ? " " + r.open : ""));
      stats.innerHTML = (r.wpm ? "<b>" + r.wpm + "</b> WPM" : "— WPM") + " · " + (r.freq ? "<b>" + r.freq + "</b> Hz" : "— Hz");
      out.scrollTop = out.scrollHeight;
    }
    function drawTape() {
      var w = tape.width, h = tape.height;
      tg.clearRect(0, 0, w, h);
      tg.fillStyle = "rgba(255,201,107,.12)"; tg.fillRect(0, h / 2 - 1, w, 2);
      tg.fillStyle = "#ffc96b";
      for (var i = 0; i < history.length; i++) if (history[i]) tg.fillRect(w - history.length + i, h * 0.25, 1, h * 0.5);
    }
    function loop() {
      if (!dec) return;
      var r = dec.result(false);
      show(r);
      meter.style.width = Math.round(r.level * 100) + "%";
      history.push(r.on ? 1 : 0); if (history.length > tape.width) history.shift();
      drawTape();
      raf = requestAnimationFrame(loop);
    }
    function stop(silent) {
      cancelAnimationFrame(raf);
      if (node) { try { node.disconnect(); } catch (e) {} node.onaudioprocess = null; node = null; }
      if (src) { try { src.stop(); } catch (e) {} try { src.disconnect(); } catch (e) {} src = null; }
      if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
      if (dec) { var r = dec.finish(); out.value = r.text; morseOut.innerHTML = ML.shapes(r.morse); }
      running = ""; box.removeAttribute("data-running");
      micBtn.textContent = D.mic || "Start microphone"; demoBtn.textContent = D.demo || "Try an example";
      if (!silent) setStatus(out.value ? (D.done || "Stopped.") : (D.idle || "Ready."));
    }
    function start(kind) {
      ML.stopAll();
      ac = ML.audio();
      dec = new Decoder(ac.sampleRate, ML.DECODE);
      history = []; out.value = ""; morseOut.innerHTML = "";
      node = ac.createScriptProcessor(2048, 1, 1);
      node.onaudioprocess = function (e) { if (dec) dec.feed(e.inputBuffer.getChannelData(0)); };
      var mute = ac.createGain(); mute.gain.value = 0;
      node.connect(mute); mute.connect(ac.destination);
      running = kind; box.setAttribute("data-running", kind);
      loop();
    }

    micBtn.addEventListener("click", function () {
      if (running) { stop(); return; }
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { setStatus(D.noMic || "This browser cannot use the microphone.", "err"); return; }
      setStatus(D.asking || "Allow the microphone…");
      navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } }).then(function (s) {
        start("mic");
        stream = s;
        src = null;
        var input = ac.createMediaStreamSource(s);
        input.connect(node);
        micBtn.textContent = D.stop || "Stop";
        setStatus(D.listening || "Listening… hold the phone close to the sound.", "live");
      }).catch(function () { setStatus(D.denied || "No access to the microphone. Allow it in your browser settings and try again.", "err"); });
    });

    demoBtn.addEventListener("click", function () {
      if (running) { stop(); return; }
      start("demo");
      var text = D.demoText || "CQ CQ DE MORSE LUX";
      var samples = synth(ML.toMorse(text), 18, 640, ac.sampleRate, 0.06);
      var buf = ac.createBuffer(1, samples.length, ac.sampleRate); buf.copyToChannel(samples, 0);
      src = ac.createBufferSource(); src.buffer = buf;
      var vol = ac.createGain(); vol.gain.value = 0.6;
      src.connect(node); src.connect(vol); vol.connect(ac.destination);
      src.onended = function () { if (running === "demo") { src = null; stop(true); setStatus(D.demoDone || "That was the example. Now try your own sound."); } };
      src.start();
      demoBtn.textContent = D.stop || "Stop";
      setStatus(D.demoPlaying || "Playing an example and decoding it…", "live");
    });

    fileIn.addEventListener("change", function () {
      var f = fileIn.files && fileIn.files[0];
      if (!f) return;
      if (running) stop(true);
      ML.stopAll();
      ac = ML.audio();
      setStatus((D.reading || "Reading") + " " + f.name + "…");
      f.arrayBuffer().then(function (ab) {
        return new Promise(function (res, rej) { var pr = ac.decodeAudioData(ab, res, rej); if (pr && pr.catch) pr.catch(function () {}); });
      }).then(function (buf) {
        var ch = buf.numberOfChannels, len = buf.length, data = new Float32Array(len);
        for (var c = 0; c < ch; c++) { var d = buf.getChannelData(c); for (var i = 0; i < len; i++) data[i] += d[i] / ch; }
        dec = new Decoder(buf.sampleRate, ML.DECODE);
        var pos = 0, chunk = buf.sampleRate * 2;
        (function next() {
          var end = Math.min(len, pos + chunk);
          dec.feed(data.subarray(pos, end)); pos = end;
          setStatus((D.reading || "Reading") + " " + f.name + "… " + Math.round(pos / len * 100) + "%");
          show(dec.result(false));
          if (pos < len) setTimeout(next, 0);
          else {
            var r = dec.finish(); out.value = r.text; morseOut.innerHTML = ML.shapes(r.morse);
            stats.innerHTML = (r.wpm ? "<b>" + r.wpm + "</b> WPM" : "— WPM");
            setStatus(r.text ? (D.fileDone || "Done.") : (D.nothing || "No Morse found in this file."), r.text ? "" : "err");
            dec = null;
          }
        })();
      }).catch(function () { setStatus(D.badFile || "This file can't be read. Try an MP3, WAV or M4A file.", "err"); });
      fileIn.value = "";
    });

    $("[data-act=d-copy]", box).addEventListener("click", function () {
      if (!out.value.trim()) { ML.toast(L.empty || "Nothing to copy yet"); return; }
      navigator.clipboard.writeText(out.value.trim().replace(/…$/, "")).then(function () { ML.toast(D.copied || "Text copied"); });
    });
    $("[data-act=d-clear]", box).addEventListener("click", function () {
      if (running) stop(true);
      dec = null; out.value = ""; morseOut.innerHTML = ""; stats.innerHTML = "— WPM · — Hz"; meter.style.width = "0";
      history = []; drawTape(); setStatus(D.idle || "Ready.");
    });
    window.addEventListener("pagehide", function () { if (running) stop(true); });
    drawTape();
  }

  /* ======================================================================
     Trainer (Koch method: start with two characters, add one at 90 %)
     ====================================================================== */
  function initTrainer(box) {
    var T = L.trn || {};
    var KEY = "ml-trainer-v1", ROUND = 20;
    var st = store(KEY) || { level: 2, wpm: 20, stats: {} };
    if (!st.stats) st.stats = {};
    var cur = null, answered = false, session = { right: 0, total: 0, wrongs: {} };
    var keys = $("#k-keys", box), fb = $("#k-feedback", box), lvl = $("#k-level", box), learned = $("#k-learned", box);
    var bar = $("#k-progress i", box), count = $("#k-count", box), playBtn = $("[data-act=k-play]", box);
    var speedSel = $("#k-speed", box), summary = $("#k-summary", box), introBox = $("#k-intro", box);

    function chars() { return KOCH.slice(0, st.level).split(""); }
    function code(c) { return ML.CODE[c]; }
    function save() { store(KEY, st); }
    function label(c) { return c; }
    function renderKeys() {
      keys.innerHTML = chars().map(function (c) { return '<button class="btn kkey" type="button" data-k="' + c + '">' + label(c) + "</button>"; }).join("");
    }
    function clearKeys() { keys.querySelectorAll(".ok,.no").forEach(function (b) { b.classList.remove("ok", "no"); }); }
    function mark(c, cls) { var b = keys.querySelector('[data-k="' + CSS.escape(c) + '"]'); if (b) b.classList.add(cls); }
    function render() {
      lvl.textContent = (T.level || "Level") + " " + (st.level - 1) + " / " + (KOCH.length - 1);
      learned.innerHTML = chars().map(function (c) {
        var s = st.stats[c] || [0, 0], acc = s[1] ? s[0] / s[1] : -1;
        var cls = acc < 0 ? "" : acc >= 0.9 ? " good" : acc < 0.7 ? " weak" : "";
        return '<span class="kchip' + cls + '" title="' + (acc < 0 ? "–" : Math.round(acc * 100) + " %") + '"><b>' + label(c) + "</b>" + ML.shapes(code(c)) + "</span>";
      }).join("");
      count.textContent = session.total + " / " + ROUND;
      bar.style.width = Math.round(session.total / ROUND * 100) + "%";
      speedSel.value = String(st.wpm);
    }
    function pick() {
      var cs = chars(), newest = cs[cs.length - 1];
      if (Math.random() < 0.3) return newest;
      var weights = cs.map(function (c) { var s = st.stats[c] || [0, 0]; var acc = s[1] ? s[0] / s[1] : 0.5; return 1 + 3 * (1 - acc); });
      var sum = weights.reduce(function (a, b) { return a + b; }, 0), r = Math.random() * sum;
      for (var i = 0; i < cs.length; i++) { r -= weights[i]; if (r <= 0) return cs[i]; }
      return newest;
    }
    function play(c) {
      ML.stopAll();
      return ML.playSound(code(c), st.wpm, 620);
    }
    function next() {
      summary.hidden = true; introBox.hidden = true;
      var prev = cur;
      cur = pick(); if (cur === prev && chars().length > 2 && Math.random() < 0.6) cur = pick();
      answered = false; clearKeys();
      fb.className = "k-feedback"; fb.innerHTML = T.question || "What did you hear?";
      box.setAttribute("data-state", "asking");
      playBtn.textContent = "🔊 " + (T.replay || "Play again");
      play(cur);
    }
    function answer(c) {
      if (!cur || answered) return;
      answered = true;
      var s = st.stats[cur] || [0, 0], ok = c === cur;
      s[1]++; if (ok) s[0]++; st.stats[cur] = s.slice(-2);
      session.total++; if (ok) session.right++; else session.wrongs[cur] = (session.wrongs[cur] || 0) + 1;
      save();
      mark(c, ok ? "ok" : "no");
      if (ok) {
        fb.className = "k-feedback ok";
        fb.innerHTML = "✓ " + label(cur) + " " + ML.shapes(code(cur));
        ML.later(function () { session.total >= ROUND ? finish() : next(); }, 650);
      } else {
        fb.className = "k-feedback no";
        fb.innerHTML = "✗ " + (T.itWas || "It was") + " <b>" + label(cur) + "</b> " + ML.shapes(code(cur)) + " · " + (T.youChose || "you chose") + " <b>" + label(c) + "</b> " + ML.shapes(code(c));
        mark(cur, "ok");
        play(cur);
        playBtn.textContent = (T.next || "Next") + " →";
        box.setAttribute("data-state", "wrong");
      }
      render();
    }
    function playList(list, times) {
      ML.stopAll();
      var d = 0;
      for (var n = 0; n < times; n++) list.forEach(function (c) {
        (function (at) { ML.later(function () { ML.playSound(code(c), st.wpm, 620); }, at); })(d);
        d += ML.timeline(code(c), st.wpm).total + 700;
      });
    }
    function intro(list, title, autoplay) {
      introBox.hidden = false;
      introBox.setAttribute("data-chars", list.join(""));
      $("[data-intro-title]", introBox).textContent = title;
      $("[data-intro-list]", introBox).innerHTML = list.map(function (c) {
        return '<span class="kintro"><b>' + label(c) + "</b>" + ML.shapes(code(c)) + "</span>";
      }).join("");
      if (autoplay) playList(list, 3);
    }
    function finish() {
      var acc = session.total ? session.right / session.total : 0, pct = Math.round(acc * 100);
      summary.hidden = false; box.setAttribute("data-state", "done");
      var up = acc >= 0.9 && st.level < KOCH.length;
      $("[data-sum-score]", summary).textContent = pct + " %";
      var msg;
      if (up) {
        st.level++; save();
        msg = (T.unlocked || "Great! New character unlocked:") + " <b>" + label(chars()[st.level - 1]) + "</b>";
      } else if (st.level >= KOCH.length && acc >= 0.9) msg = T.allDone || "You know all 40 characters. Fantastic!";
      else msg = (T.again || "Reach 90 % to unlock the next character. Practice once more:") + " " + Object.keys(session.wrongs).map(function (c) { return "<b>" + label(c) + "</b>"; }).join(" ");
      $("[data-sum-msg]", summary).innerHTML = msg;
      session = { right: 0, total: 0, wrongs: {} };
      cur = null;
      playBtn.textContent = "▶ " + (T.startRound || "Next round");
      renderKeys(); render();
      if (up) intro([chars()[st.level - 1]], T.newChar || "New character", true);
    }

    playBtn.addEventListener("click", function () {
      if (cur && !answered) { play(cur); return; }
      next();
    });
    keys.addEventListener("click", function (e) { var b = e.target.closest("[data-k]"); if (b) answer(b.getAttribute("data-k")); });
    document.addEventListener("keydown", function (e) {
      if (e.metaKey || e.ctrlKey || e.altKey || /input|textarea|select/i.test(e.target.tagName)) return;
      var k = e.key.toUpperCase();
      if (k === " " || k === "ENTER") {
        var r = box.getBoundingClientRect(); if (r.bottom < 0 || r.top > innerHeight) return;
        e.preventDefault(); playBtn.click(); return;
      }
      if (cur && !answered && chars().indexOf(k) >= 0) { e.preventDefault(); answer(k); }
    });
    speedSel.addEventListener("change", function () { st.wpm = +speedSel.value || 20; save(); });
    $("[data-act=k-reset]", box).addEventListener("click", function () {
      if (!confirm(T.resetAsk || "Start again from the beginning?")) return;
      st = { level: 2, wpm: st.wpm, stats: {} }; save(); session = { right: 0, total: 0, wrongs: {} }; cur = null;
      summary.hidden = true; renderKeys(); intro(["K", "M"], T.firstChars || "Your first characters", false); fb.className = "k-feedback"; fb.textContent = T.start || "Press Start and listen.";
      playBtn.textContent = "▶ " + (T.startBtn || "Start"); box.setAttribute("data-state", "idle"); render();
    });
    $("[data-act=k-intro-play]", introBox).addEventListener("click", function () { playList((introBox.getAttribute("data-chars") || "").split(""), 1); });
    renderKeys(); render();
    if (st.level === 2 && !Object.keys(st.stats).length) intro(["K", "M"], T.firstChars || "Your first characters", false);
  }

  document.addEventListener("DOMContentLoaded", function () {
    if (!root.MorseLux) return;
    var d = document.getElementById("decoder"); if (d) initDecoder(d);
    var t = document.getElementById("trainer"); if (t) initTrainer(t);
  });
})(typeof window !== "undefined" ? window : this);
