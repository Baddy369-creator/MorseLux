/* Morse Lux website: audio decoder (microphone and audio files) and Morse trainer. No dependencies, runs in the browser only. */
(function (root) {
  "use strict";

  /* ======================================================================
     Decoder core: finds the tone, turns it into on/off marks and learns the
     speed. Works sample by sample, so the microphone and files use the same code.
     ====================================================================== */
  var KOCH = "KMRSUAPTLOWI.NJEF0Y,VG5/Q9ZH38B?427C1D6X";
  /* after the 40 characters: four procedural signs as bonus levels (sent as one sign, without gaps) */
  var PROSIGNS = { "<AR>": ".-.-.", "<BT>": "-...-", "<SK>": "...-.-", "<KN>": "-.--." };
  var KOCHL = KOCH.split("").concat(Object.keys(PROSIGNS));

  function Decoder(sampleRate, decode, opts) {
    opts = opts || {};
    this.gate = opts.gate || 13;                                  /* a signal must be this many dB above the noise */
    this.sr = sampleRate;
    /* prosigns that have no letter of their own are shown in angle brackets instead of "#" */
    var table = {}, k;
    for (k in decode) table[k] = decode[k];
    var extra = { "...-.-": "<SK>", "...-.": "<SN>", "........": "<HH>", "-.-.-": "<KA>", ".-...": "<AS>", "-.--.": "<KN>", ".-.-.": "<AR>", "-...-": "<BT>" };
    for (k in extra) table[k] = extra[k];                        /* in the decoder the prosign is the better reading */
    for (var d = 6; d <= 9; d++) table[new Array(d + 1).join(".")] = "<HH>";   /* "error": 8 dots, often sent as 6–9 */
    this.decodeTable = table;
    this.hop = Math.max(64, Math.round(sampleRate * 0.004));      /* one step = 4 ms */
    this.win = Math.round(sampleRate * (opts.win || 0.012));       /* tone filter looks at 12 ms (24 ms for weak signals in files) */
    this.markLog = [];          /* every beep length, for judging how clean a decoding is */
    this.freqs = [];
    for (var f = 300; f <= 3500; f += 20) this.freqs.push(f);     /* tones from 300 to 3500 Hz (buzzers, whistles, piezo beepers) */
    this.coef = this.freqs.map(function (fr) { return 2 * Math.cos(2 * Math.PI * fr / sampleRate); });
    this.bAvg = this.freqs.map(function () { return null; });     /* per tone: average loudness */
    this.bMod = this.freqs.map(function () { return 0; });        /* per tone: how much it switches on and off */
    this.bPow = new Float64Array(this.freqs.length);              /* per tone: loudness, slightly smoothed against noise */
    this.buf = new Float32Array(this.win);
    this.bufPos = 0; this.filled = 0; this.sinceHop = 0; this.stepNo = 0;
    this.lock = -1;
    this.floor = null; this.peak = null;
    this.on = false; this.pending = 0; this.runMs = 0;
    this.events = [];           /* [isMark, ms] */
    this.committed = "";
    this.committedMorse = "";
    this.stepMs = this.hop / sampleRate * 1000;
    this.level = 0; this.snr = 0;
    this.dotMs = 0; this.wpmDot = 0;
    this.hist = [];             /* loudness of the last 6 s, to look again when the noise level was misjudged */
    this.checked = false; this.early = null; this.half = 1;
  }

  /* Where is the line between "tone" and "no tone"? In the middle between noise and tone, but never more
     than 8 dB below the tone: echoes and room reverb are quieter than that and must not count as tone. */
  function threshold(floor, peak) {
    var range = peak - floor;
    return { thr: Math.max(floor + range * 0.5, peak - 8), hyst: Math.min(range * 0.1, 1.5), range: range };
  }

  /* Look at a stretch of the loudness history again, with the noise level and the tone level measured
     from that stretch. Used (1) once after the first 2 s of sound, because the noise level is not known
     yet at the very start, and (2) when a "signal" lasts 1.5 s — that is really background noise. */
  Decoder.prototype.resegment = function (n, fromScratch) {
    var vals = this.hist.slice(-n);
    var sorted = vals.slice().sort(function (a, b) { return a - b; });
    var floor = sorted[Math.floor(vals.length * 0.3)], peak = sorted[Math.floor(vals.length * 0.97)];
    this.floor = floor; this.peak = Math.max(peak, floor);
    if (fromScratch) { this.events = []; this.markLog = []; }
    var t = threshold(floor, peak);
    if (t.range < this.gate) { this.on = false; this.runMs = vals.length * this.stepMs; this.pending = 0; return; }
    /* the tone level is taken from the surrounding quarter second, so fading signals are followed */
    var w = 30, localPeak = new Float32Array(vals.length), dq = [];
    for (var i = 0; i < vals.length + w; i++) {
      if (i < vals.length) { while (dq.length && vals[dq[dq.length - 1]] <= vals[i]) dq.pop(); dq.push(i); }
      var c = i - w;
      if (c >= 0) { while (dq[0] < c - w) dq.shift(); localPeak[c] = Math.max(vals[dq[0]], floor + this.gate, peak - 6); }
    }
    var on = false, run = 0, segs = [];
    for (i = 0; i < vals.length; i++) {
      t = threshold(floor, Math.min(peak, localPeak[i]));
      var want = on ? vals[i] > t.thr - t.hyst : vals[i] > t.thr + t.hyst;
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
  function toDb(p) { return Math.max(-100, 10 * Math.log10(p + 1e-12)); }  /* digital silence counts as very quiet */

  Decoder.prototype.feed = function (samples) {
    for (var i = 0; i < samples.length; i++) {
      this.buf[this.bufPos] = samples[i];
      this.bufPos = (this.bufPos + 1) % this.win;
      if (this.filled < this.win) this.filled++;
      if (++this.sinceHop >= this.hop) { this.sinceHop = 0; if (this.filled === this.win) this.step(); }
    }
  };

  /* Which tone carries the Morse? Every 16 ms all tones are measured. Morse switches on and off, so we
     pick the tone whose loudness changes the most — a steady carrier or hum is ignored. A new tone is
     only chosen when it is clearly better, so the decoder does not jump between two signals. */
  Decoder.prototype.scan = function (alpha, free) {
    var best = -1e9, bestK = -1, row = new Float32Array(this.freqs.length);
    for (var k = 0; k < this.freqs.length; k++) {
      var pw = this.goertzel(k);
      row[k] = toDb(pw);
      this.bPow[k] += (pw - this.bPow[k]) * (free ? 0.4 : 0.7);
      var d = toDb(this.bPow[k]);
      if (this.bAvg[k] === null) this.bAvg[k] = d;
      this.bAvg[k] += (d - this.bAvg[k]) * 0.05;
      this.bMod[k] += (Math.abs(d - this.bAvg[k]) - this.bMod[k]) * alpha;
    }
    /* a slightly louder tone wins a tie: in strong noise the Morse tone is still the loudest on average */
    var mean = 0;
    for (k = 0; k < this.freqs.length; k++) mean += this.bAvg[k];
    mean /= this.freqs.length;
    for (k = 0; k < this.freqs.length; k++) {
      var sc = this.bMod[k] + 0.3 * (this.bAvg[k] - mean);
      if (sc > best) { best = sc; bestK = k; }
    }
    var cur = this.lock >= 0 ? this.bMod[this.lock] + 0.3 * (this.bAvg[this.lock] - mean) : 0;
    if (this.lock < 0 || free) this.lock = bestK;
    else if (Math.abs(bestK - this.lock) <= 4) { if (best > cur * 1.1) this.lock = bestK; }   /* follow a slowly drifting tone */
    else if (best > cur * 1.35 + 0.5) this.lock = bestK;                                    /* jump only to a clearly better signal */
    return row;
  };
  Decoder.prototype.lockDb = function (row) {
    var lo = Math.max(0, this.lock - this.half), hi = Math.min(row.length - 1, this.lock + this.half), m = -100;
    for (var k = lo; k <= hi; k++) m = Math.max(m, row[k]);
    return m;
  };
  /* At the start the right tone is not known yet. All tones of the first seconds are kept; as soon as the
     tone is clear (2 s of sound and a few beeps, at most 6 s), the start is decoded again with that tone. */
  Decoder.prototype.settle = function () {
    var self = this;
    this.checked = true;
    if (!this.early || !this.early.length) return;
    /* choose the tone again, from all of the first seconds: the one with the biggest difference
       between its quiet and its loud moments (slightly smoothed, so random noise does not win) */
    var rows = this.early, n = rows.length, bestK = this.lock, bestC = -1, cs = [];
    for (var k = 0; k < this.freqs.length; k++) {
      var v = new Float32Array(n), prev = 0;
      for (var i = 0; i < n; i++) { var pw = Math.pow(10, rows[i][k] / 10); prev = i ? prev + (pw - prev) * 0.5 : pw; v[i] = toDb(prev); }
      v.sort();
      var q = function (f) { return v[Math.min(n - 1, Math.floor(n * f))]; };
      /* Morse jumps between two levels (loud tone, quiet pause); speech and noise slide in between */
      var c = (q(0.95) - q(0.3)) - 1.5 * (q(0.97) - q(0.85)) + 0.3 * q(0.5);
      cs.push(c);
      if (c > bestC) { bestC = c; bestK = k; }
    }
    this.lock = bestK;
    /* how wide is the signal? a whistle wobbles over several neighbouring tones, a clean beep does not */
    this.half = 1;
    while (this.half < 4 && (cs[bestK - this.half - 1] > bestC * 0.6 || cs[bestK + this.half + 1] > bestC * 0.6)) this.half++;
    var vals = rows.map(function (row) { return self.lockDb(row); });
    this.hist = vals.slice(-1500);
    this.early = null;
    this.resegment(vals.length, true);
  };

  Decoder.prototype.step = function () {
    var db;
    if (!this.checked) {
      var row = this.scan(0.01, true);
      if (!this.early) this.early = [];
      db = this.lockDb(row);
      if (this.early.length || Math.max.apply(null, row) > -99) this.early.push(row);
    } else {
      if (this.stepNo++ % 4 === 0) this.scan(0.012, false);
      var n = this.freqs.length, lo = Math.max(0, this.lock - this.half), hi = Math.min(n - 1, this.lock + this.half), p = 0;
      for (var k = lo; k <= hi; k++) p = Math.max(p, this.goertzel(k));
      db = toDb(p);
    }
    if (this.floor === null) { this.floor = db; this.peak = db; }
    /* noise level = average of the quiet parts; peak = how loud the tone is */
    if (!this.on) this.floor += (db - this.floor) * (db < this.floor ? 0.05 : 0.01);
    else this.floor += (db - this.floor) * 0.0008;
    this.hist.push(db); if (this.hist.length > 1500) this.hist.shift();
    if (!this.checked && this.early.length) {
      var liveMs = this.early.length * this.stepMs, marks = 0;
      for (var i = 0; i < this.events.length; i++) if (this.events[i][0]) marks++;
      if ((liveMs >= 2000 && marks >= 6) || liveMs >= 6000) { this.settle(); return; }
    }
    if (this.on && this.runMs > 1500) { this.resegment(Math.min(this.hist.length, Math.round(this.runMs / this.stepMs)), false); return; }
    /* the tone level is remembered; during long pauses (> 1.2 s) it is not forgotten, so noise does not become letters */
    if (db > this.peak) this.peak += (db - this.peak) * 0.3;
    else if (this.on) this.peak += (db - this.peak) * 0.03;      /* during a tone: follow fading quickly */
    else if (this.runMs < 1200) {
      /* fading: within normal letter and word gaps the tone level is forgotten faster (signals that fade in and out
         within a second); after that only slowly, so long thinking pauses do not turn noise into letters */
      var fast = this.dotGuess > 0 && this.runMs < 7 * this.dotGuess;
      this.peak += (this.floor - this.peak) * (fast ? Math.max(0.0012, 0.003 * Math.min(1, 60 / this.dotGuess)) : 0.0012);
    }   /* fading: forget at the pace of the Morse */
    var t = threshold(this.floor, this.peak);
    this.snr = t.range; this.level = Math.max(0, Math.min(1, (db - this.floor) / Math.max(t.range, 14)));
    var want = t.range > this.gate && (this.on ? db > t.thr - t.hyst : db > t.thr + t.hyst);
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
    if (this.on) {
      this.markLog.push(ms);
      if (this.markLog.length % 4 === 0) {                        /* rough dot length, for the pace of forgetting */
        var last = this.markLog.slice(-40).filter(function (v) { return v >= 20; }).sort(function (a, b) { return a - b; });
        if (last.length >= 4) this.dotGuess = last[Math.floor(last.length * 0.25)];
      }
    }
    /* a long pause (a new transmission may follow, maybe faster or slower): freeze what was decoded so far,
       so a later change of speed cannot rewrite it */
    if (!this.on && this.checked) {
      var marks = 0;
      for (var m = 0; m < this.events.length; m++) if (this.events[m][0]) marks++;
      if (marks >= 20 && ms >= Math.max(1000, (this.dotMs || 80) * 10) &&
          ms > wordThreshold(this.events, this.estimate(this.events).dot)) {   /* only at a real break, not a long pause between letters */
        var all = this.events.splice(0, this.events.length), rr = this.decodeEvents(all.slice(0, -1), ms, true);
        this.committed += rr.text; this.committedMorse += rr.morse;
        if (this.committed && this.committed.slice(-1) !== " ") { this.committed += " "; this.committedMorse += "/ "; }
        return;
      }
    }
    if (this.events.length > 260) {                              /* keep the text, forget old timing */
      var dot = this.estimate(this.events).dot, cut = -1;
      for (var i = 120; i < this.events.length - 20; i++) if (!this.events[i][0] && this.events[i][1] > dot * 2.5) { cut = i; break; }
      if (cut < 0) return;
      var head = this.events.splice(0, cut + 1);
      var r = this.decodeEvents(head, 0, true);
      this.committed += r.text; this.committedMorse += r.morse;
      if (head[head.length - 1][1] > r.wordThr && this.committed.slice(-1) !== " ") { this.committed += " "; this.committedMorse += "/ "; }
    }
  };

  /* Split durations into a short and a long group (on a log scale). Returns null if they are all alike. */
  function twoGroups(values, minRatio, minCount) {
    minCount = minCount || 1;
    if (values.length < 2) return null;
    var logs = values.map(Math.log).sort(function (a, b) { return a - b; });
    var total = logs.reduce(function (s, x) { return s + x; }, 0), left = 0, bestSplit = -1, bestScore = 0;
    for (var i = 1; i < logs.length; i++) {
      left += logs[i - 1];
      if (i < minCount || logs.length - i < minCount) continue;
      var ma = left / i, mb = (total - left) / (logs.length - i), score = i * (logs.length - i) * (mb - ma) * (mb - ma);
      if (score > bestScore) { bestScore = score; bestSplit = i; }
    }
    if (bestSplit < 0) return null;
    var lo = 0, hi = 0;
    for (i = 0; i < logs.length; i++) if (i < bestSplit) lo += logs[i]; else hi += logs[i];
    lo = Math.exp(lo / bestSplit); hi = Math.exp(hi / (logs.length - bestSplit));
    return hi / lo > minRatio ? { low: lo, high: hi, split: Math.sqrt(lo * hi) } : null;
  }

  /* Speed estimate from the recent marks: split them into short (dots) and long (dashes). */
  Decoder.prototype.estimate = function (evs) {
    var marks = [], i;
    for (i = evs.length - 1; i >= 0 && marks.length < 60; i--) if (evs[i][0]) marks.push(evs[i][1]);
    if (!marks.length) return { dot: this.dotMs || 80 };
    var g = twoGroups(marks, 1.9);
    if (g) {
      this.dotMs = (g.low + g.high / 3) / 2;
      /* the tone filter makes every beep a little longer; the difference dash − dot is not affected */
      this.wpmDot = Math.min(g.low, Math.max(g.low * 0.6, (g.high - g.low) / 2));
      return { dot: this.dotMs, split: g.split };
    }
    /* all marks look alike: dots or dashes? compare with what we knew before, otherwise assume dots */
    var mean = Math.exp(marks.map(Math.log).reduce(function (s, x) { return s + x; }, 0) / marks.length);
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

  /* Where does a word end? Pauses longer than a dot are split into "between letters" and "between words".
     This also works with Farnsworth timing, where every pause is stretched. */
  function wordThreshold(evs, dot) {
    var gaps = [];
    for (var i = 0; i < evs.length - 1; i++) if (!evs[i][0] && evs[i][1] > dot * 2 && evs[i][1] < 10000) gaps.push(evs[i][1]);  /* the last pause may still be running */
    var g = twoGroups(gaps, 1.4), split = 0;
    /* there can be three kinds of pauses (letter, word, long break): keep splitting the shorter group */
    while (g) {
      split = g.split;
      var lower = gaps.filter(function (x) { return x < split; });
      g = twoGroups(lower, 1.8, Math.max(2, Math.ceil(lower.length * 0.15)));
      if (g && g.low < dot * 1.5) g = null;
    }
    if (split) return Math.max(dot * 4.5, split);
    if (!gaps.length) return dot * 5;
    var mean = Math.exp(gaps.map(Math.log).reduce(function (s, x) { return s + x; }, 0) / gaps.length);
    return Math.max(dot * 5, mean * 1.6);
  }

  /* a whistle with a ball flutters: tiny gaps inside one beep are not real pauses */
  function mergeShortGaps(evs, maxGap) {
    var out = [];
    for (var i = 0; i < evs.length; i++) {
      var e = evs[i];
      if (!e[0] && e[1] < maxGap && out.length && out[out.length - 1][0] && i + 1 < evs.length && evs[i + 1][0]) {
        out[out.length - 1] = [1, out[out.length - 1][1] + e[1] + evs[i + 1][1]]; i++; continue;
      }
      if (e[0] && out.length && out[out.length - 1][0]) out[out.length - 1] = [1, out[out.length - 1][1] + e[1]];
      else out.push([e[0], e[1]]);
    }
    return out;
  }

  Decoder.prototype.decodeEvents = function (evs, trailingSilence, final) {
    evs = mergeShortGaps(clean(evs, 16), 14);
    var est = this.estimate(evs), dot = est.dot;
    evs = mergeShortGaps(clean(evs, Math.max(16, dot * 0.3)), Math.min(40, dot * 0.35));
    var split = est.split || dot * 2, wordThr = wordThreshold(evs, dot);
    /* a single short blip in a long silence is noise, not an E */
    evs = evs.filter(function (e, i) {
      if (!e[0] || e[1] > dot * 1.6) return true;
      var lone = Math.max(2000, wordThr * 3);                    /* much longer than a normal pause between words */
      var before = i === 0 || evs[i - 1][1] > lone, after = i === evs.length - 1 ? trailingSilence > lone || final : evs[i + 1][1] > lone;
      return !(before && after && i > 0);
    });
    evs = clean(evs, 0);
    var text = "", morse = "", sym = "";
    var self = this;
    function flush() { if (sym) { text += self.decodeTable[sym] || "#"; morse += sym + " "; sym = ""; } }
    for (var i = 0; i < evs.length; i++) {
      var e = evs[i];
      if (e[0]) sym += e[1] < split ? "." : "-";
      else if (e[1] > wordThr) { flush(); if (text && text.slice(-1) !== " ") { text += " "; morse += "/ "; } }
      else if (e[1] > dot * 2) flush();
    }
    if (final || trailingSilence > dot * 2.5) flush();
    if (trailingSilence > wordThr && text && text.slice(-1) !== " ") { text += " "; morse += "/ "; }
    return { text: text, morse: morse, open: sym, wpm: Math.round(1200 / (this.wpmDot || dot)), wordThr: wordThr };
  };

  Decoder.prototype.result = function (final) {
    var silence = this.on ? 0 : this.runMs;
    var r = this.decodeEvents(this.events, silence, final);
    return { text: (this.committed + r.text).replace(/\s+$/, final ? "" : " ").replace(/^\s+/, ""),
             morse: (this.committedMorse + r.morse).trim().replace(/\s*\/$/, ""), open: r.open,
             wpm: this.events.some(function (e) { return e[0]; }) ? r.wpm : 0,
             freq: this.lock >= 0 && this.snr > 13 ? this.freqs[this.lock] : 0, level: this.level, on: this.on, events: this.events.length };
  };

  /* How clean is the decoding? Real Morse has two beep lengths, 1 : 3; noise read as Morse has
     lengths all over the place. Smaller is better. */
  Decoder.prototype.quality = function () {
    var all = this.markLog;
    if (all.length < 4) return 9;
    /* single clicks (much shorter than a dot) are dropped later anyway; they only count a little */
    var med = all.slice().sort(function (a, b) { return a - b; })[all.length >> 1], cut = Math.max(16, med * 0.3);
    var m = all.filter(function (v) { return v >= cut; }), clicks = all.length - m.length;
    if (m.length < 4) return 5;
    var g = twoGroups(m, 1.8);
    if (!g) return 5;
    var dev = 0;
    for (var i = 0; i < m.length; i++) dev += Math.min(Math.abs(Math.log(m[i] / g.low)), Math.abs(Math.log(m[i] / g.high)));
    return dev / m.length + 0.5 * Math.abs(Math.log(g.high / g.low / 3)) + 0.3 * clicks / all.length;
  };
  Decoder.prototype.finish = function () {
    if (!this.checked) this.settle();
    if (this.runMs > 0) { this.endRun(this.runMs); this.runMs = 0; }
    var r = this.decodeEvents(this.events, 0, true);
    return { text: (this.committed + r.text).trim(), morse: (this.committedMorse + r.morse).trim().replace(/\s*\/$/, ""), wpm: r.wpm };
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
  var isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  function audioSession(type) { try { if (navigator.audioSession) navigator.audioSession.type = type; } catch (e) {} }

  /* Audio from the microphone or a sound is passed on in blocks of 2048 samples. Uses an AudioWorklet
     where available (modern browsers), otherwise the older ScriptProcessor. */
  var workletReady = null;
  function makeTap(ac, onData) {
    if (ac.audioWorklet && window.AudioWorkletNode) {
      if (!workletReady) {
        var code = "class T extends AudioWorkletProcessor{constructor(){super();this.b=new Float32Array(2048);this.i=0;this.stop=false;this.port.onmessage=e=>{if(e.data==='stop')this.stop=true}}process(inp){if(this.stop)return false;var c=inp[0]&&inp[0][0];if(c){for(var j=0;j<c.length;j++){this.b[this.i++]=c[j];if(this.i===2048){this.port.postMessage(this.b.slice(0));this.i=0}}}return true}}registerProcessor('ml-tap',T);";
        var url = URL.createObjectURL(new Blob([code], { type: "application/javascript" }));
        workletReady = ac.audioWorklet.addModule(url);
      }
      return workletReady.then(function () {
        var n = new AudioWorkletNode(ac, "ml-tap", { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: "explicit" });
        n.port.onmessage = function (e) { onData(e.data); };
        n.stopTap = function () { n.port.onmessage = null; try { n.port.postMessage("stop"); } catch (e) {} };   /* the processor ends itself */
        return n;
      }).catch(function () { workletReady = null; return scriptTap(ac, onData); });
    }
    return Promise.resolve(scriptTap(ac, onData));
  }
  function scriptTap(ac, onData) {
    var n = ac.createScriptProcessor(2048, 1, 1);
    n.onaudioprocess = function (e) { onData(e.inputBuffer.getChannelData(0)); };
    n.stopTap = function () { n.onaudioprocess = null; };
    return n;
  }

  /* ======================================================================
     Decoder widget
     ====================================================================== */
  function initDecoder(box) {
    var D = L.dec || {};
    var out = $("#d-text", box), morseOut = $("#d-morse", box), status = $("#d-status", box), limitBox = $("#d-limit", box);
    var meter = $("#d-meter i", box), tape = $("#d-tape", box), stats = $("#d-stats", box), freeInfo = $("#d-free", box);
    var micBtn = $("[data-act=d-mic]", box), demoBtn = $("[data-act=d-demo]", box), fileIn = $("#d-file", box);
    var FREE_MS = 30000, LIMIT_KEY = "ml-mic-v1";
    var job = 0, mode = "", dec = null, ac = null, tap = null, stream = null, src = null, raf = 0;
    var history = [], lastShown = "", lastUi = 0, lastTape = 0, micStart = 0, stoppedAt = 0;
    var tg = tape.getContext("2d");
    if (isIOS) { var hint = $("[data-ios-hint]", box); if (hint) hint.hidden = false; }

    /* --- the free microphone time per day (saved in this browser) --- */
    function today() { var d = new Date(); return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate(); }
    function usedMs() { var u = store(LIMIT_KEY); return u && u.day === today() ? u.ms : 0; }
    function addUsed(ms) { store(LIMIT_KEY, { day: today(), ms: Math.min(FREE_MS, usedMs() + ms) }); }
    function leftMs() { return Math.max(0, FREE_MS - usedMs() - (mode === "mic" && micStart ? Date.now() - micStart : 0)); }
    function showFree() {
      var left = Math.ceil(leftMs() / 1000);
      micBtn.classList.toggle("spent", left <= 0 && mode !== "mic");
      if (left <= 0 && mode !== "mic") micBtn.textContent = D.micTomorrow || "🎙 Microphone: again tomorrow";
      freeInfo.textContent = (D.freeLeft || "Free microphone time today: {s} s").replace("{s}", left);
      freeInfo.classList.toggle("low", left <= 10);
    }

    function setStatus(msg, kind) { status.textContent = msg; status.className = "d-status" + (kind ? " " + kind : ""); }
    function statsHtml(wpm, freq) {
      return (wpm ? "<b>" + wpm + "</b> WPM" : "— WPM") + " &middot; " + (freq ? "<b>" + freq + "</b> Hz" : "— Hz");
    }
    function show(r, force) {
      var key = r.text + "|" + (r.open || "") + "|" + r.wpm + "|" + r.freq;
      if (!force && key === lastShown) return;                  /* only touch the page when something changed */
      lastShown = key;
      out.value = r.text + (r.open ? "…" : "");
      morseOut.innerHTML = ML.shapes(r.morse + (r.open ? " " + r.open : ""));
      stats.innerHTML = statsHtml(r.wpm, r.freq);
      out.scrollTop = out.scrollHeight;
      proHint();
    }
    /* <AR>, <SK> … are radio signs; a short note links to the page that explains them */
    function proHint() { var h = $("[data-pro-hint]", box); if (h) h.hidden = out.value.indexOf("<") < 0; }
    function drawTape() {
      var w = tape.width, h = tape.height;
      tg.clearRect(0, 0, w, h);
      tg.fillStyle = "rgba(255,201,107,.12)"; tg.fillRect(0, h / 2 - 1, w, 2);
      tg.fillStyle = "#ffc96b";
      for (var i = 0; i < history.length; i++) if (history[i]) tg.fillRect(w - history.length + i, h * 0.25, 1, h * 0.5);
    }
    function loop(now) {
      if (!dec || mode === "file" || !mode) return;
      var r = dec.result(false);
      /* the signal strip moves with time (one pixel per 10 ms), not with the screen's refresh rate */
      var cols = lastTape ? Math.min(60, Math.round((now - lastTape) / 10)) : 1;
      if (cols > 0) { for (var i = 0; i < cols; i++) history.push(r.on ? 1 : 0); lastTape = now; }
      while (history.length > tape.width) history.shift();
      drawTape();
      meter.style.width = Math.round(r.level * 100) + "%";
      if (now - lastUi > 120) {
        lastUi = now; show(r);
        if (mode === "mic") {
          if (micStart && Date.now() - micStart > 1000) { addUsed(Date.now() - micStart); micStart = Date.now(); }   /* saved as it goes: other tabs see it */
          showFree(); if (leftMs() <= 0) { limitReached(); return; }
        }
      }
      raf = requestAnimationFrame(loop);
    }
    function teardown() {
      job++;
      cancelAnimationFrame(raf);
      if (tap) { try { tap.stopTap(); tap.disconnect(); } catch (e) {} tap = null; }
      if (src) { try { src.onended = null; src.stop(); } catch (e) {} try { src.disconnect(); } catch (e) {} src = null; }
      if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
      if (mode === "mic" && micStart) { addUsed(Date.now() - micStart); micStart = 0; showFree(); }
      if (mode === "mic" || mode === "asking") audioSession("playback");
      mode = ""; box.removeAttribute("data-running");
      micBtn.textContent = D.mic || "Start microphone"; demoBtn.textContent = D.demo || "Try an example";
      showFree();
    }
    function finishDec() {
      if (!dec) return;
      var r = dec.finish(); out.value = r.text; morseOut.innerHTML = ML.shapes(r.morse);
      stats.innerHTML = statsHtml(r.wpm, 0); lastShown = "";
      dec = null;
    }
    function stop(msg) {
      var had = !!dec;
      teardown(); finishDec();
      if (msg !== false) setStatus(msg || (had && out.value ? (D.done || "Stopped.") : (D.idle || "Ready.")));
    }
    function begin(kind) {
      teardown(); dec = null;
      ML.stopAll();
      limitBox.hidden = true;
      ac = ML.audio();                                           /* created inside the tap, as iOS requires */
      ac.onstatechange = function () {                           /* a phone call or the lock screen interrupts the sound */
        if (ac.state === "interrupted" && (mode === "mic" || mode === "demo")) stop(D.interrupted || "Interrupted. Start again.");
      };
      history = []; out.value = ""; morseOut.innerHTML = ""; lastShown = ""; lastTape = 0;
      mode = kind; box.setAttribute("data-running", kind);
      return job;
    }
    function startDecoding(my) {
      dec = new Decoder(ac.sampleRate, ML.DECODE);
      return makeTap(ac, function (data) { if (my === job && dec) dec.feed(data); }).then(function (n) {
        if (my !== job) { try { n.stopTap(); } catch (e) {} return null; }
        tap = n;
        var mute = ac.createGain(); mute.gain.value = 0;
        n.connect(mute); mute.connect(ac.destination);
        raf = requestAnimationFrame(loop);
        return n;
      });
    }
    /* phones: while listening, the other buttons are hidden (CSS) and the page scrolls so that the
       Stop button, the signal and the text are all on screen at once */
    function bringIntoView() {
      if (window.innerWidth > 640) return;
      var head = document.querySelector("header"), h = head ? head.getBoundingClientRect().height : 0;
      window.scrollTo({ top: Math.max(0, micBtn.getBoundingClientRect().top + window.scrollY - h - 10), behavior: "smooth" });
    }
    function limitReached() {
      stop(D.limitStatus || "Your free microphone time for today is used up.");
      limitBox.hidden = false;                                    /* shown below the text; the page does not jump, the decoded text stays in view */
    }

    micBtn.addEventListener("click", function () {
      if (mode === "asking") return;                             /* a second tap while the permission is asked is ignored */
      if (mode === "mic") { stop(); stoppedAt = Date.now(); return; }
      if (Date.now() - stoppedAt < 700) return;                  /* a double tap on "Stop" must not start it again */
      if (leftMs() <= 0) { teardown(); limitBox.hidden = false; setStatus(D.limitStatus || "Your free microphone time for today is used up.", "err"); return; }
      if (!window.isSecureContext) { setStatus(D.needHttps || "The microphone only works on a secure (https) page.", "err"); return; }
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { setStatus(D.noMic || "This browser cannot use the microphone.", "err"); return; }
      var my = begin("asking");
      audioSession("play-and-record");
      micBtn.textContent = D.asking || "Allow the microphone…";
      setStatus(D.asking || "Allow the microphone…");
      navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } }).then(function (s) {
        if (my !== job) { s.getTracks().forEach(function (t) { t.stop(); }); return; }   /* stopped while asking */
        stream = s; mode = "mic"; box.setAttribute("data-running", "mic");
        if (ac.state !== "running") ac.resume();
        return startDecoding(my).then(function (n) {
          if (!n || my !== job) return;
          ac.createMediaStreamSource(s).connect(n);
          micStart = Date.now(); showFree(); micBtn.textContent = D.stop || "■ Stop";
          bringIntoView();
          setStatus(D.listening || "Listening… hold the device close to the sound.", "live");
        });
      }).catch(function (err) {
        if (my !== job) return;
        teardown();
        var n = err && err.name;
        setStatus(n === "NotFoundError" || n === "OverconstrainedError" ? (D.noDevice || "No microphone found.")
          : n === "NotReadableError" || n === "AbortError" ? (D.busy || "The microphone is being used by another app.")
          : (D.denied || "No access to the microphone."), "err");
      });
    });

    demoBtn.addEventListener("click", function () {
      if (mode === "demo") { stop(); return; }
      var my = begin("demo");
      audioSession("playback");
      demoBtn.textContent = D.stop || "■ Stop";
      setStatus(D.demoPlaying || "Playing an example and decoding it…", "live");
      bringIntoView();
      startDecoding(my).then(function (n) {
        if (!n || my !== job) return;
        var samples = synth(ML.toMorse(D.demoText || "CQ CQ DE MORSE LUX"), 18, 640, ac.sampleRate, 0.06);
        var buf = ac.createBuffer(1, samples.length, ac.sampleRate); buf.copyToChannel(samples, 0);
        src = ac.createBufferSource(); src.buffer = buf;
        var vol = ac.createGain(); vol.gain.value = 0.6;
        src.connect(n); src.connect(vol); vol.connect(ac.destination);
        src.onended = function () { if (my === job) { src = null; stop(D.demoDone || "That was the example."); } };
        src.start();
      });
    });

    fileIn.addEventListener("change", function () {
      var f = fileIn.files && fileIn.files[0];
      fileIn.value = "";
      if (!f) return;
      if (f.size > 60 * 1024 * 1024 && !confirm(D.bigFile || "This file is very large and may take a long time. Continue?")) return;
      var my = begin("file");
      setStatus(D.reading + " " + f.name);
      f.arrayBuffer().then(function (ab) {
        if (my !== job) return null;
        /* decode at 16 kHz: a 30-minute recording then needs about a quarter of the memory */
        var OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext, small = null;
        try { if (OAC) small = new OAC(1, 16000, 16000); } catch (e) { small = null; }
        var ctx = small || ac;
        return new Promise(function (res, rej) { var pr = ctx.decodeAudioData(ab, res, rej); if (pr && pr.catch) pr.catch(function () {}); })
          .catch(function (e) { if (ctx === ac) throw e; return new Promise(function (res, rej) { var pr = ac.decodeAudioData(ab, res, rej); if (pr && pr.catch) pr.catch(function () {}); }); });
      }).then(function (buf) {
        if (!buf || my !== job) return;
        var ch = buf.numberOfChannels, len = buf.length, data = new Float32Array(len), energy = 0, best = null, bestE = 0;
        for (var c = 0; c < ch; c++) {
          var d = buf.getChannelData(c), e = 0;
          for (var i = 0; i < len; i++) { data[i] += d[i] / ch; e += d[i] * d[i]; }
          if (e > bestE) { bestE = e; best = d; }
        }
        for (i = 0; i < len; i++) energy += data[i] * data[i];
        if (ch > 1 && energy < bestE * 0.1) data = best;           /* channels cancel each other out: use the louder one */
        dec = new Decoder(buf.sampleRate, ML.DECODE);
        /* a second reader with a longer tone filter and a lower gate is better for weak signals in noise;
           at the end the cleaner of the two decodings wins */
        var weak = new Decoder(buf.sampleRate, ML.DECODE, { win: 0.024, gate: 11 });
        var better = function () { return weak.quality() < dec.quality() - 0.02 ? weak : dec; };
        var pos = 0, chunk = buf.sampleRate * 2, lastPct = -10;
        (function next() {
          if (my !== job) return;                                  /* stopped, cleared or something else started */
          var end = Math.min(len, pos + chunk);
          dec.feed(data.subarray(pos, end)); weak.feed(data.subarray(pos, end)); pos = end;
          var pct = Math.floor(pos / len * 100);
          if (pct - lastPct >= 10) { lastPct = pct; setStatus(D.reading + " " + f.name + " – " + pct + " %"); show(better().result(false)); }
          if (pos < len) { setTimeout(next, 0); return; }
          var ra = dec.finish(), rw = weak.finish(), win = better(), r = win === weak ? rw : ra, hz = win.lock >= 0 ? win.freqs[win.lock] : 0; dec = null;
          out.value = r.text; morseOut.innerHTML = ML.shapes(r.morse); stats.innerHTML = statsHtml(r.wpm, hz); lastShown = ""; proHint();
          teardown();
          setStatus(r.text ? (D.fileDone || "Done.") : (D.nothing || "No Morse code found in this file."), r.text ? "" : "err");
        })();
      }).catch(function () { if (my === job) { teardown(); setStatus(D.badFile || "This file can't be read.", "err"); } });
    });

    $("[data-act=d-copy]", box).addEventListener("click", function () {
      var t = out.value.trim().replace(/…$/, "");
      if (!t) { ML.toast(D.nothingToCopy || L.empty || "Nothing to copy yet"); return; }
      if (!navigator.clipboard) { ML.toast(D.copyFail || "Copying is not possible here"); return; }
      navigator.clipboard.writeText(t).then(function () { ML.toast(D.copied || "Text copied"); }, function () { ML.toast(D.copyFail || "Copying is not possible here"); });
    });
    $("[data-act=d-clear]", box).addEventListener("click", function () {
      teardown(); dec = null;
      out.value = ""; morseOut.innerHTML = ""; stats.innerHTML = statsHtml(0, 0); meter.style.width = "0"; lastShown = ""; proHint();
      history = []; drawTape(); setStatus(D.idle || "Ready.");
    });
    document.addEventListener("visibilitychange", function () { if (document.hidden && mode === "mic") stop(); });
    window.addEventListener("pagehide", function () { if (mode) stop(false); });
    stats.innerHTML = statsHtml(0, 0);
    showFree();
    if (leftMs() <= 0) { limitBox.hidden = false; setStatus(D.limitStatus || "Your free microphone time for today is used up."); }
    drawTape();
  }

  /* ======================================================================
     Trainer (Koch method: start with two characters, add one at 90 %)
     ====================================================================== */
  function initTrainer(box) {
    var T = L.trn || {};
    var KEY = "ml-trainer-v1", ROUND = 20, WINDOW = 20;
    var st = store(KEY) || {};
    st.level = st.level || 2; st.wpm = st.wpm || 20; st.tone = st.tone || 620; st.mode = st.mode || "single";
    st.stats = st.stats || {};
    Object.keys(st.stats).forEach(function (c) {                 /* older format [right, total] → list of the last results */
      var v = st.stats[c];
      if (v.length === 2 && v[1] > 1 && !Array.isArray(v[0])) st.stats[c] = Array.from({ length: Math.min(v[1], WINDOW) }, function (_, i) { return i < Math.round(v[0] / v[1] * Math.min(v[1], WINDOW)) ? 1 : 0; });
    });
    var q = null, ownTimers = [];
    /* a round that was started is kept, so a reload (iPhone switching apps) does not lose it */
    var session = st.round && st.round.total > 0 && st.round.total < ROUND ? st.round : { right: 0, total: 0, wrongs: {} };
    var keys = $("#k-keys", box), fb = $("#k-feedback", box), lvl = $("#k-level", box), learned = $("#k-learned", box);
    var bar = $("#k-progress i", box), count = $("#k-count", box), playBtn = $("[data-act=k-play]", box);
    var speedSel = $("#k-speed", box), toneSel = $("#k-tone", box), modeSel = $("#k-mode", box), timeSel = $("#k-time", box), appBox = $("#k-appbox", box);
    var summary = $("#k-summary", box), introBox = $("#k-intro", box), slots = $("#k-slots", box);
    if (isIOS) { var hint = $("[data-ios-hint]", box); if (hint) hint.hidden = false; }

    function chars() { return KOCHL.slice(0, st.level); }
    function code(c) { return PROSIGNS[c] || ML.CODE[c]; }
    function esc(c) { return c.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
    function label(c) { return PROSIGNS[c] ? '<span class="pro">' + c.slice(1, -1) + "</span>" : esc(c); }
    /* the answer keys in a fixed, easy-to-find order: A–Z, then 0–9, then the signs */
    function keyOrder(c) { return PROSIGNS[c] ? 400 + KOCHL.indexOf(c) : /[A-Z]/.test(c) ? c.charCodeAt(0) : /[0-9]/.test(c) ? 200 + +c : PROSIGNS[c] ? 400 + KOCHL.indexOf(c) : 300 + ".,?/".indexOf(c); }
    function save() { st.round = session; store(KEY, st); }
    function acc(c) { var a = st.stats[c] || []; return a.length ? a.reduce(function (x, y) { return x + y; }, 0) / a.length : -1; }
    function record(c, val) { var a = st.stats[c] || []; a.push(val); while (a.length > WINDOW) a.shift(); st.stats[c] = a; }
    function later(fn, ms) { ownTimers.push(setTimeout(fn, ms)); }
    function clearOwn() { ownTimers.forEach(clearTimeout); ownTimers = []; }
    function groupMode() { return st.mode !== "single" && st.level >= 5; }

    function renderKeys() {
      keys.innerHTML = chars().slice().sort(function (a, b) { return keyOrder(a) - keyOrder(b); }).map(function (c) {
        var cls = /[0-9]/.test(c) ? " num" : PROSIGNS[c] ? " prokey" : "";
        return '<button class="btn kkey' + cls + '" type="button" data-k="' + esc(c) + '" aria-label="' + esc(c) + '">' + label(c) + "</button>";
      }).join("");
    }
    function clearKeys() { keys.querySelectorAll(".ok,.no").forEach(function (b) { b.classList.remove("ok", "no"); }); }
    function mark(c, cls) { var b = keys.querySelector('[data-k="' + CSS.escape(c) + '"]'); if (b) b.classList.add(cls); }
    function render() {
      lvl.textContent = st.level <= KOCH.length ? (T.levelChars || "{n} of 40 characters").replace("{n}", st.level)
        : (T.levelBonus || "40 characters + {n} procedural signs").replace("{n}", st.level - KOCH.length);
      var sum = $("[data-set-sum]", box);
      if (sum) sum.textContent = st.wpm + " " + (T.wpmShort || "WPM") + " · " + st.tone + " Hz" + (st.time ? " · " + st.time + " s" : "");
      learned.innerHTML = chars().map(function (c) {
        var a = acc(c), pct = a < 0 ? "–" : Math.round(a * 100) + " %";
        var cls = a < 0 ? "" : a >= 0.9 ? " good" : a < 0.7 ? " weak" : "";
        return '<span class="kchip' + cls + '" aria-label="' + esc(c) + ": " + pct + '"><b>' + label(c) + "</b>" + ML.shapes(code(c)) + "<small>" + pct + "</small></span>";
      }).join("");
      count.textContent = Math.min(session.total, ROUND) + " / " + ROUND;
      bar.style.width = Math.min(100, Math.round(session.total / ROUND * 100)) + "%";
      speedSel.value = String(st.wpm); toneSel.value = String(st.tone); modeSel.value = st.mode; timeSel.value = String(st.time || 0);
      modeSel.disabled = st.level < 5;
      $("[data-mode-note]", box).hidden = st.level >= 5;
    }
    function pickOne(avoid) {
      var cs = chars(), newest = cs[cs.length - 1];
      if (Math.random() < 0.3 && newest !== avoid) return newest;
      var weights = cs.map(function (c) { var a = acc(c); return c === avoid ? 0.2 : 1 + 3 * (1 - (a < 0 ? 0.5 : a)); });
      var sum = weights.reduce(function (x, y) { return x + y; }, 0), r = Math.random() * sum;
      for (var i = 0; i < cs.length; i++) { r -= weights[i]; if (r <= 0) return cs[i]; }
      return newest;
    }
    /* play one character or a group; with "longer pauses" the gaps between characters are stretched */
    function playSeq(list) {
      ML.stopAll(); clearOwn();
      var gapMs = (st.mode === "groupsSlow" ? 9 : 3) * 1200 / st.wpm, at = 0;
      list.forEach(function (c) {
        (function (when) { later(function () { ML.playSound(code(c), st.wpm, st.tone); }, when); })(at);
        at += ML.timeline(code(c), st.wpm).total + gapMs;
      });
      return at;
    }
    function next() {
      if (session.total >= ROUND) { finish(); return; }
      summary.hidden = true; introBox.hidden = true;
      var n = groupMode() ? 3 : 1, list = [], prev = q ? q.list[q.list.length - 1] : null;
      for (var i = 0; i < n; i++) { list.push(pickOne(i ? list[i - 1] : prev)); }
      q = { list: list, got: [], replays: 0, done: false };
      clearKeys();
      fb.className = "k-feedback"; fb.innerHTML = n > 1 ? (T.questionGroup || "Which three characters did you hear?") : (T.question || "What did you hear?");
      renderSlots();
      box.setAttribute("data-state", "asking");
      playBtn.textContent = "🔊 " + (T.replay || "Play again"); playBtn.hidden = false;
      appBox.hidden = true;
      q.t0 = Date.now() + playSeq(list);                         /* the thinking time starts when the sound has ended */
      gameIntoView();
    }
    /* phones: the play button, the question and the answer keys together on screen */
    function gameIntoView() {
      if (window.innerWidth > 640) return;
      var k = keys.getBoundingClientRect(), main = $(".k-main", box).getBoundingClientRect();
      if (k.bottom <= window.innerHeight && main.top >= 0) return;
      var head = document.querySelector("header"), h = head ? head.getBoundingClientRect().height : 0;
      window.scrollTo({ top: Math.max(0, main.top + window.scrollY - h - 8), behavior: "smooth" });
    }
    function renderSlots() {
      if (!q || q.list.length < 2) { slots.hidden = true; return; }
      slots.hidden = false;
      slots.innerHTML = q.list.map(function (c, i) { return "<span" + (q.got[i] ? "" : ' class="empty"') + ">" + (q.got[i] ? label(q.got[i]) : "") + "</span>"; }).join("") +
        (!q.done && q.got.length ? '<button type="button" class="btn k-back" data-act="k-back" aria-label="' + (T.back || "Undo") + '">⌫</button>' : "");
    }
    function answer(c) {
      if (!q || q.done || session.total >= ROUND) return;
      q.got.push(c); renderSlots();
      if (q.got.length < q.list.length) return;
      q.done = true;
      var slow = !!st.time && Date.now() - q.t0 > st.time * 1000;
      var half = q.replays > 0 || slow, allOk = true, html = [];
      q.list.forEach(function (want, i) {
        var got = q.got[i], ok = got === want, val = ok ? (half ? 0.5 : 1) : 0;
        record(want, val); session.total++; session.right += val;
        if (!ok) { allOk = false; session.wrongs[want] = (session.wrongs[want] || 0) + 1; }
        mark(got, ok ? "ok" : "no"); if (!ok) mark(want, "ok");
        html.push(ok ? '<span class="k-line ok">✓ <b>' + label(want) + "</b> " + ML.shapes(code(want)) + "</span>"
          : '<span class="k-line no">✗ ' + (T.itWas || "It was") + " <b>" + label(want) + "</b> " + ML.shapes(code(want)) + " · " + (T.youChose || "you chose") + " <b>" + label(got) + "</b> " + ML.shapes(code(got)) + "</span>");
      });
      save();
      if (allOk) {
        fb.className = "k-feedback ok";
        fb.innerHTML = html.join("<br>") + (half ? ' <span class="k-half">' + (slow && !q.replays ? (T.slow || "(answered after the time limit: half a point)") : (T.half || "(heard twice: half a point)")) + "</span>" : "");
        later(function () { next(); }, q.list.length > 1 ? 900 : 650);
      } else {
        fb.className = "k-feedback"; fb.innerHTML = html.join("<br>");
        /* hear the difference: first the right character, then the one you chose */
        var wrong = q.list.map(function (w, i) { return [w, q.got[i]]; }).filter(function (p) { return p[0] !== p[1]; })[0];
        playSeq(q.list.length > 1 ? q.list : []);
        if (q.list.length === 1) playSeq([wrong[0], wrong[1]]);
        playBtn.textContent = (session.total >= ROUND ? (T.toResult || "Result") : (T.next || "Next")) + " →";
        box.setAttribute("data-state", "wrong");
      }
      render();
    }
    function intro(list, title, autoplay, noStart) {
      introBox.hidden = false;
      $("[data-act=k-intro-start]", introBox).hidden = !!noStart;  /* after a round the main button already says "Next round" */
      playBtn.hidden = !noStart;                                  /* never two Start buttons at once */
      introBox.setAttribute("data-chars", list.join(""));
      $("[data-intro-title]", introBox).textContent = title;
      $("[data-intro-list]", introBox).innerHTML = list.map(function (c) {
        return '<span class="kintro"><b>' + label(c) + "</b>" + ML.shapes(code(c)) + "</span>";
      }).join("");
      if (autoplay) { var l3 = []; for (var i = 0; i < 3; i++) l3 = l3.concat(list); playSeq(l3); }
    }
    var BADGES = [5, 10, 15, 20, 25, 30, 35, 40];
    function renderBadges() {
      var names = T.badges || [];
      $("#k-badges", box).innerHTML = BADGES.map(function (n, i) {
        var got = st.level >= n;
        return '<span class="kbadge' + (got ? " got" : "") + '" title="' + n + " " + (T.chars || "characters") + '"><b>' + (got ? "🏅" : "🔒") + "</b>" + (names[i] || n) + "<small>" + n + " " + (T.chars || "characters") + "</small></span>";
      }).join("");
    }
    function finish() {
      clearOwn();
      var a = session.total ? session.right / session.total : 0, pct = Math.round(a * 100);
      summary.hidden = false; box.setAttribute("data-state", "done");
      var up = a >= 0.9 && st.level < KOCHL.length, msg;
      $("[data-sum-score]", summary).textContent = pct + " %";
      if (up) {
        st.level++; save(); msg = (T.unlocked || "New character unlocked:") + " <b>" + label(chars()[st.level - 1]) + "</b>";
        if (st.level === KOCH.length + 1) msg = (T.bonus || "All 40 characters done! Bonus: procedural signs.") + " " + msg;
        var bi = BADGES.indexOf(st.level);
        if (bi >= 0) msg += '<span class="k-newbadge">🏅 ' + (T.newBadge || "New badge:") + " <b>" + ((T.badges || [])[bi] || st.level) + "</b></span>";
      }
      else if (st.level >= KOCHL.length && a >= 0.9) msg = T.allDone || "You know all 40 characters!";
      else msg = (T.again || "Reach 90 % to unlock the next character. Practice:") + " " + Object.keys(session.wrongs).map(function (c) { return "<b>" + c + "</b>"; }).join(" ");
      $("[data-sum-msg]", summary).innerHTML = msg;
      session = { right: 0, total: 0, wrongs: {} }; q = null; save();
      playBtn.textContent = "▶ " + (T.startRound || "Next round");
      renderKeys(); render(); renderSlots(); renderBadges();
      appBox.hidden = false;
      if (up) intro([chars()[st.level - 1]], T.newChar || "New character", true, true);
      /* the result, the new character and "Next round" first; the App Store box comes below */
      var sr = summary.getBoundingClientRect(), head = document.querySelector("header"), h = head ? head.getBoundingClientRect().height : 0;
      if (sr.top < h || sr.top > window.innerHeight * 0.5) window.scrollTo({ top: Math.max(0, sr.top + window.scrollY - h - 8), behavior: "smooth" });
    }

    function onPlay() {
      if (q && !q.done) { q.replays++; playSeq(q.list); return; }
      next();
    }
    playBtn.addEventListener("click", onPlay);
    $("[data-act=k-intro-start]", introBox).addEventListener("click", function () { onPlay(); playBtn.focus({ preventScroll: true }); });
    slots.addEventListener("click", function (e) { if (e.target.closest("[data-act=k-back]")) undo(); });
    function undo() { if (q && !q.done && q.got.length) { q.got.pop(); renderSlots(); } }
    keys.addEventListener("click", function (e) {
      var b = e.target.closest("[data-k]"); if (!b) return;
      answer(b.getAttribute("data-k"));
      playBtn.focus({ preventScroll: true });                    /* so Space/Enter afterwards means "play", not "this answer again" */
    });
    document.addEventListener("keydown", function (e) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      var tag = e.target.tagName, interactive = /^(INPUT|TEXTAREA|SELECT)$/.test(tag);
      if (interactive || e.target.isContentEditable) return;
      var r = box.getBoundingClientRect(); if (r.bottom < 0 || r.top > innerHeight) return;
      if (e.key === " " || e.key === "Enter") {
        /* on a focused button or link, Enter/Space do what that element does */
        if (e.target !== document.body && e.target !== playBtn && /^(BUTTON|A|SUMMARY)$/.test(tag)) return;
        e.preventDefault(); onPlay(); return;
      }
      if (e.key === "Backspace" && q && !q.done && q.got.length) { e.preventDefault(); undo(); return; }
      var k = e.key.length === 1 ? e.key.toUpperCase() : "";
      if (k && q && !q.done && chars().indexOf(k) >= 0) { e.preventDefault(); answer(k); }
    });
    speedSel.addEventListener("change", function () { st.wpm = +speedSel.value || 20; save(); render(); });
    toneSel.addEventListener("change", function () { st.tone = +toneSel.value || 620; save(); render(); });
    modeSel.addEventListener("change", function () { st.mode = modeSel.value; save(); });
    timeSel.addEventListener("change", function () { st.time = +timeSel.value || 0; save(); render(); });
    $("[data-act=k-reset]", box).addEventListener("click", function () {
      if (!confirm(T.resetAsk || "Start again from the beginning?")) return;
      clearOwn(); ML.stopAll();
      session = { right: 0, total: 0, wrongs: {} }; st = { level: 2, wpm: st.wpm, tone: st.tone, mode: "single", time: st.time, stats: {} }; save(); q = null;
      summary.hidden = true; appBox.hidden = true; fb.className = "k-feedback"; fb.textContent = T.start || "Press Start and listen.";
      playBtn.textContent = "▶ " + (T.startBtn || "Start"); box.setAttribute("data-state", "idle");
      renderKeys(); render(); renderSlots(); renderBadges(); intro(["K", "M"], T.firstChars || "Your first characters", false);
    });
    $("[data-act=k-intro-play]", introBox).addEventListener("click", function () { playSeq((introBox.getAttribute("data-chars") || "").split("")); });
    renderKeys(); render(); renderSlots(); renderBadges();
    if (st.level === 2 && !Object.keys(st.stats).length) intro(["K", "M"], T.firstChars || "Your first characters", false);
    else { introBox.hidden = true; playBtn.hidden = false; }
  }

  document.addEventListener("DOMContentLoaded", function () {
    if (!root.MorseLux) return;
    var d = document.getElementById("decoder"); if (d) initDecoder(d);
    var t = document.getElementById("trainer"); if (t) initTrainer(t);
  });
})(typeof window !== "undefined" ? window : this);
