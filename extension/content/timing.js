/**
 * Timing math with no DOM access: tokenizing, chapter-anchored estimates and
 * aligning page tokens to speech-to-text words.
 */
(() => {
  const TOKEN_PATTERN = /[\p{L}\p{N}]+(?:['’][\p{L}]+)*/gu;
  const LCS_CELL_LIMIT = 6_000_000;

  function normalize(token) {
    return token.toLowerCase().replace(/’/g, "'");
  }

  function tokenize(text) {
    const tokens = [];
    for (const match of text.matchAll(TOKEN_PATTERN)) {
      tokens.push({ norm: normalize(match[0]), index: match.index, length: match[0].length });
    }
    return tokens;
  }

  const MIN_SPLIT_PART = 2;

  /** Splits a token the recognizer glued together ("becomesespecially") into two words the page uses. */
  function splitGlued(norm, vocabulary) {
    if (!vocabulary || vocabulary.has(norm)) return [norm];
    for (let cut = MIN_SPLIT_PART; cut <= norm.length - MIN_SPLIT_PART; cut++) {
      const left = norm.slice(0, cut), right = norm.slice(cut);
      if (vocabulary.has(left) && vocabulary.has(right)) return [left, right];
    }
    return [norm];
  }

  /**
   * Splits STT words into tokens with the same rules as the page, spreading each word's time across its parts
   * by length. With a page vocabulary, glued words are split back into the page's words.
   */
  function sttTokens(words, vocabulary = null) {
    const out = [];
    for (const [text, start, end] of words) {
      const parts = tokenize(text).flatMap((part) => splitGlued(part.norm, vocabulary));
      const total = parts.reduce((sum, part) => sum + part.length, 0) || 1;
      let cursor = start;
      for (const part of parts) {
        const span = ((end - start) * part.length) / total;
        out.push({ norm: part, start: cursor, end: cursor + span });
        cursor += span;
      }
    }
    return out;
  }

  /**
   * Least-squares fit of chapter durations as textWords * a + altWords * b,
   * returning how many seconds an alt-text word costs relative to a text word.
   */
  function fitAltRatio(segments) {
    let tt = 0, ta = 0, aa = 0, td = 0, ad = 0;
    for (const { text, alt, duration } of segments) {
      tt += text * text; ta += text * alt; aa += alt * alt;
      td += text * duration; ad += alt * duration;
    }
    const det = tt * aa - ta * ta;
    if (segments.length < 3 || Math.abs(det) < 1e-9) return 0.5;
    const a = (td * aa - ad * ta) / det;
    const b = (tt * ad - ta * td) / det;
    if (!(a > 0)) return 0.5;
    return Math.min(Math.max(b / a, 0), 1.2);
  }

  const HEADING_WEIGHT = 4;

  function blockWeight(block, altRatio) {
    if (block.kind === "heading") return block.textWords + HEADING_WEIGHT;
    return block.textWords + block.altWords * altRatio;
  }

  /**
   * Estimates a start/end time for every block from chapter anchors.
   * @param {{kind:string,textWords:number,altWords:number}[]} blocks
   * @param {{blockIndex:number,time:number}[]} anchors sorted, first one at block 0
   * @param {number} duration total audio seconds
   */
  function estimate(blocks, anchors, duration) {
    const points = anchors.length && anchors[0].blockIndex === 0 ? anchors.slice() : [{ blockIndex: 0, time: 0 }, ...anchors];
    points.push({ blockIndex: blocks.length, time: duration });

    const segments = [];
    for (let i = 0; i < points.length - 1; i++) {
      const from = points[i], to = points[i + 1];
      if (to.blockIndex <= from.blockIndex || to.time <= from.time) continue;
      let text = 0, alt = 0;
      for (let b = from.blockIndex; b < to.blockIndex; b++) {
        text += blocks[b].textWords + (blocks[b].kind === "heading" ? HEADING_WEIGHT : 0);
        alt += blocks[b].altWords;
      }
      segments.push({ from, to, text, alt, duration: to.time - from.time });
    }

    const altRatio = fitAltRatio(segments);
    const times = blocks.map(() => ({ start: 0, end: 0 }));
    for (const { from, to, duration: span } of segments) {
      let total = 0;
      for (let b = from.blockIndex; b < to.blockIndex; b++) total += blockWeight(blocks[b], altRatio);
      let cursor = from.time;
      for (let b = from.blockIndex; b < to.blockIndex; b++) {
        const share = total > 0 ? (blockWeight(blocks[b], altRatio) / total) * span : 0;
        times[b] = { start: cursor, end: cursor + share };
        cursor += share;
      }
    }
    return { times, altRatio };
  }

  /**
   * Picks the set of non-crossing runs with the most matched words in total.
   * Runs are {a, b, len}: page start, STT start, length. Order: by page start.
   */
  function heaviestRunChain(runs) {
    const best = new Float64Array(runs.length), prev = new Int32Array(runs.length).fill(-1);
    let top = -1;
    for (let i = 0; i < runs.length; i++) {
      best[i] = runs[i].len;
      for (let k = 0; k < i; k++) {
        const before = runs[k];
        if (before.a + before.len <= runs[i].a && before.b + before.len <= runs[i].b && best[k] + runs[i].len > best[i]) {
          best[i] = best[k] + runs[i].len;
          prev[i] = k;
        }
      }
      if (top < 0 || best[i] > best[top]) top = i;
    }
    const chain = [];
    for (let i = top; i >= 0; i = prev[i]) chain.push(runs[i]);
    return chain.reverse();
  }

  const MAX_ANCHOR_GRAM = 3;

  /** Runs seeded by n-grams that occur exactly once in both ranges. */
  function uniqueRuns(a, aLo, aHi, b, bLo, bHi, n) {
    const key = (arr, i) => (n === 1 ? arr[i] : arr.slice(i, i + n).join(" "));
    const counts = new Map();
    for (let i = aLo; i + n <= aHi; i++) {
      const k = key(a, i);
      const entry = counts.get(k) || { a: 0, b: 0, ai: -1, bi: -1 };
      entry.a++; entry.ai = i; counts.set(k, entry);
    }
    for (let j = bLo; j + n <= bHi; j++) {
      const entry = counts.get(key(b, j));
      if (entry) { entry.b++; entry.bi = j; }
    }
    const seen = new Set();
    const runs = [];
    for (const entry of counts.values()) {
      if (entry.a !== 1 || entry.b !== 1) continue;
      const run = growRun(a, aLo, aHi, b, bLo, bHi, entry.ai, entry.bi);
      const id = run.a + ":" + run.b;
      if (!seen.has(id)) { seen.add(id); runs.push(run); }
    }
    return runs;
  }

  /** Grows a matching pair into the longest run of equal tokens around it, inside the given ranges. */
  function growRun(a, aLo, aHi, b, bLo, bHi, ai, bi) {
    let start = 0, end = 1;
    while (ai - start - 1 >= aLo && bi - start - 1 >= bLo && a[ai - start - 1] === b[bi - start - 1]) start++;
    while (ai + end < aHi && bi + end < bHi && a[ai + end] === b[bi + end]) end++;
    return { a: ai - start, b: bi - start, len: start + end };
  }

  function lcsFill(a, aLo, aHi, b, bLo, bHi, map) {
    const n = aHi - aLo, m = bHi - bLo;
    if (!n || !m || n * m > LCS_CELL_LIMIT) return;
    const width = m + 1;
    const table = new Uint16Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        table[i * width + j] = a[aLo + i] === b[bLo + j]
          ? table[(i + 1) * width + j + 1] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
      }
    }
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (a[aLo + i] === b[bLo + j]) { map[aLo + i] = bLo + j; i++; j++; }
      else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) i++;
      else j++;
    }
  }

  function patience(a, aLo, aHi, b, bLo, bHi, map, depth) {
    while (aLo < aHi && bLo < bHi && a[aLo] === b[bLo]) map[aLo++] = bLo++;
    while (aLo < aHi && bLo < bHi && a[aHi - 1] === b[bHi - 1]) map[--aHi] = --bHi;
    if (aLo >= aHi || bLo >= bHi) return;

    let runs = [];
    for (let n = 1; n <= MAX_ANCHOR_GRAM && !runs.length; n++) runs = uniqueRuns(a, aLo, aHi, b, bLo, bHi, n);
    runs.sort((x, y) => x.a - y.a);
    const chain = depth < 64 ? heaviestRunChain(runs) : [];

    if (!chain.length) {
      lcsFill(a, aLo, aHi, b, bLo, bHi, map);
      return;
    }
    let pa = aLo, pb = bLo;
    for (const run of chain) {
      patience(a, pa, run.a, b, pb, run.b, map, depth + 1);
      for (let k = 0; k < run.len; k++) map[run.a + k] = run.b + k;
      pa = run.a + run.len; pb = run.b + run.len;
    }
    patience(a, pa, aHi, b, pb, bHi, map, depth + 1);
  }

  const TRUSTED_RUN = 3;
  const STRAY_MIN_SECONDS = 2.5;
  const STRAY_SPAN_FRACTION = 0.2;

  /**
   * Removes short matches (runs under three consecutive words) whose time disagrees with the trusted runs around them,
   * like a common word matched to the same word said elsewhere while a figure is narrated.
   */
  function dropStrayMatches(map, stt) {
    const n = map.length;
    const trusted = new Uint8Array(n);
    for (let i = 0; i < n;) {
      if (map[i] < 0) { i++; continue; }
      let j = i;
      while (j + 1 < n && map[j + 1] === map[j] + 1) j++;
      if (j - i + 1 >= TRUSTED_RUN) trusted.fill(1, i, j + 1);
      i = j + 1;
    }
    const prevTrusted = new Int32Array(n), nextTrusted = new Int32Array(n);
    for (let i = 0, last = -1; i < n; i++) { if (trusted[i]) last = i; prevTrusted[i] = last; }
    for (let i = n - 1, last = -1; i >= 0; i--) { if (trusted[i]) last = i; nextTrusted[i] = last; }
    for (let i = 0; i < n; i++) {
      if (map[i] < 0 || trusted[i]) continue;
      const p = prevTrusted[i], q = nextTrusted[i];
      const tp = p >= 0 ? stt[map[p]].start : 0;
      const tq = q >= 0 ? stt[map[q]].start : stt[stt.length - 1].end;
      const ip = p >= 0 ? p : -1, iq = q >= 0 ? q : n;
      const expected = tp + ((tq - tp) * (i - ip)) / (iq - ip);
      const tolerance = Math.max(STRAY_MIN_SECONDS, STRAY_SPAN_FRACTION * (tq - tp));
      if (Math.abs(stt[map[i]].start - expected) > tolerance) map[i] = -1;
    }
  }

  /**
   * Gives every page token a start/end time from the STT tokens it aligns with.
   * Unmatched tokens are interpolated between their matched neighbours.
   * @returns {{starts: Float64Array, ends: Float64Array, matched: Uint8Array, matchRatio: number}}
   */
  function align(pageNorms, stt, duration) {
    const sttNorms = stt.map((t) => t.norm);
    const map = new Int32Array(pageNorms.length).fill(-1);
    patience(pageNorms, 0, pageNorms.length, sttNorms, 0, sttNorms.length, map, 0);
    dropStrayMatches(map, stt);

    const n = pageNorms.length;
    const starts = new Float64Array(n), ends = new Float64Array(n), matched = new Uint8Array(n);
    let matchCount = 0;
    for (let i = 0; i < n; i++) {
      if (map[i] >= 0) {
        starts[i] = stt[map[i]].start; ends[i] = stt[map[i]].end;
        matched[i] = 1; matchCount++;
      }
    }

    let prev = -1;
    for (let i = 0; i <= n; i++) {
      if (i < n && !matched[i]) continue;
      const gapStart = prev + 1, gapEnd = i;
      if (gapEnd > gapStart) {
        const t0 = prev >= 0 ? ends[prev] : 0;
        const t1 = i < n ? starts[i] : (stt.length ? stt[stt.length - 1].end : duration);
        const step = (t1 - t0) / (gapEnd - gapStart);
        for (let k = gapStart; k < gapEnd; k++) {
          starts[k] = t0 + (k - gapStart) * step;
          ends[k] = starts[k] + step;
        }
      }
      prev = i;
    }
    return { starts, ends, matched, map, matchRatio: n ? matchCount / n : 0 };
  }

  function formatTime(seconds) {
    const s = Math.max(0, Math.floor(seconds));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    const mm = h ? String(m).padStart(2, "0") : String(m);
    return (h ? h + ":" : "") + mm + ":" + String(r).padStart(2, "0");
  }

  /** Index of the last element whose start is <= t, or -1. */
  function findAt(starts, t) {
    let lo = 0, hi = starts.length - 1, found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid] <= t) { found = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return found;
  }

  globalThis.LessonListenTiming = { tokenize, sttTokens, estimate, align, formatTime, findAt, fitAltRatio };
})();
