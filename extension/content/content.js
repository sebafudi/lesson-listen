(() => {
  if (globalThis.__lessonListenLoaded) return;
  globalThis.__lessonListenLoaded = true;

  const Timing = globalThis.LessonListenTiming;
  const Settings = globalThis.LessonListenSettings;

  const STORAGE_VERSION = 1;
  const MIN_TIMESTAMP_WORDS = 4;
  const FOLLOW_ANCHOR = 0.38;
  const PARAGRAPH_TARGET = 0.05;
  const PARAGRAPH_SETTLED = [-0.01, 0.1];
  const LINE_LIMIT = 0.88;
  const RESUME_UP_ALLOWANCE = 0.5;
  const RESUME_DOWN_ALLOWANCE = 1;
  const PARAGRAPH_LEAD_SECONDS = 0.35;
  const SILENCE_GAP = 0.28;
  const OVERFLOW_FALLBACK_MS = 3000;
  const SCROLL_STOP_MIN_WORDS = 8;
  const SMOOTH_TIME_CONSTANT_MS = 650;
  const STAGE_LABELS = {
    "downloading-model": "Downloading model (first run, about 1.2 GB)",
    "loading-model": "Loading model",
    transcribing: "Transcribing",
    receiving: "Sending audio to local model",
  };
  const ICONS = {
    settings: '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.2" shape-rendering="crispEdges"><path d="M2 4.5h12M2 8h12M2 11.5h12"/><rect x="4.5" y="3" width="3" height="3" fill="var(--ll-bg)"/><rect x="9" y="6.5" width="3" height="3" fill="var(--ll-bg)"/><rect x="5.5" y="10" width="3" height="3" fill="var(--ll-bg)"/></svg>',
  };

  const SKIP_ACTIONS = { "-5": "back5", 5: "forward5", "-10": "back10", 10: "forward10" };

  let settings = { ...Settings.DEFAULTS };
  let lesson = null;

  const highlightSupported = typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined";

  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (key === "text") node.textContent = value;
      else if (key === "html") node.innerHTML = value;
      else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value);
    }
    for (const child of children) node.append(child);
    return node;
  }

  function audioPath(audio) {
    const src = audio.getAttribute("src") || audio.querySelector("source")?.getAttribute("src") || "";
    return src ? new URL(src, location.href).pathname : "";
  }

  function audioUrl(audio) {
    const src = audio.getAttribute("src") || audio.querySelector("source")?.getAttribute("src") || audio.currentSrc;
    return new URL(src, location.href).href;
  }

  function storageKey(slug, path) {
    return `transcript:${slug}:${path}`;
  }

  function collectBlocks(prose) {
    const blocks = [];
    const tokens = [];
    for (const element of prose.children) {
      if (element.classList.contains("ll-ignore")) continue;
      const block = { el: element, kind: "text", textWords: 0, altWords: 0, tokenStart: tokens.length, tokenEnd: tokens.length, timestamp: null };
      if (/^H[1-6]$/.test(element.tagName)) block.kind = "heading";

      const textTokens = [];
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) => (node.parentElement?.closest(".ll-ts, [hidden], [aria-hidden='true']") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
      });
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        for (const token of Timing.tokenize(node.data)) {
          textTokens.push({ norm: token.norm, node, offset: token.index, length: token.length, block: blocks.length });
        }
      }

      const image = element.querySelector("img[alt]");
      if (block.kind !== "heading" && image && textTokens.length < 3) {
        block.kind = "figure";
        const altTokens = Timing.tokenize(image.alt).map((token) => ({ norm: token.norm, node: null, block: blocks.length }));
        block.altWords = altTokens.length;
        tokens.push(...altTokens);
      }
      block.textWords = textTokens.length;
      tokens.push(...textTokens);
      block.tokenEnd = tokens.length;
      blocks.push(block);
    }
    return { blocks, tokens };
  }

  function chapterAnchors(section, blocks) {
    const anchors = [];
    for (const button of section.querySelectorAll("button[data-start]")) {
      const time = Number(button.dataset.start);
      if (!Number.isFinite(time)) continue;
      const heading = button.dataset.heading;
      let blockIndex = heading ? blocks.findIndex((b) => b.el.id === heading || b.el.querySelector(`#${CSS.escape(heading)}`)) : time === 0 ? 0 : -1;
      if (blockIndex >= 0) anchors.push({ blockIndex, time });
    }
    anchors.sort((a, b) => a.time - b.time);
    return anchors.filter((a, i) => i === 0 || a.blockIndex > anchors[i - 1].blockIndex);
  }

  class Lesson {
    constructor(section, prose) {
      this.section = section;
      this.prose = prose;
      this.audio = section.querySelector("audio.lesson-audio-media, audio");
      this.slug = section.dataset.slug || location.pathname;
      this.key = storageKey(this.slug, audioPath(this.audio));
      this.mode = "estimated";
      this.syncInfo = null;
      this.syncing = false;
      this.activeBlock = -1;
      this.activeToken = -1;
      this.lastBlockChange = 0;
      this.followPausedByUser = false;
      this.userScrollAt = 0;
      this.pausedAtBlock = -1;
      this.pendingSince = 0;
      this.alignedBlock = -1;
      this.frame = null;
      this.lastFrameAt = 0;
      this.programmaticScrollUntil = 0;
      this.cleanups = [];
      section.dataset.llReady = "";

      ({ blocks: this.blocks, tokens: this.tokens } = collectBlocks(prose));
      this.anchors = chapterAnchors(section, this.blocks);
      this.injectControls();
      this.applyEstimate();
      this.renderTimestamps();
      this.bindAudio();
      this.bindScrollIntent();
      this.bindWordSeek();
      this.applySettings();
      this.loadStoredTranscript();
    }

    get seekInput() {
      return this.section.querySelector("[data-seek]") || document.querySelector(".lesson-audio-seek");
    }

    duration() {
      if (Number.isFinite(this.audio.duration) && this.audio.duration > 0) return this.audio.duration;
      const max = Number(this.seekInput?.max);
      if (max > 0) return max;
      const end = this.section.querySelector(".lesson-audio-end")?.textContent || "0:00";
      return end.split(":").reduce((acc, part) => acc * 60 + Number(part), 0);
    }

    currentTime() {
      if (this.audio.readyState >= HTMLMediaElement.HAVE_METADATA) return this.audio.currentTime;
      return Number(this.seekInput?.value) || 0;
    }

    seek(seconds, { play = false } = {}) {
      const target = Math.min(Math.max(0, seconds), Math.max(0, this.duration() - 0.25));
      const input = this.seekInput;
      if (input) {
        const step = input.step;
        input.step = "any";
        input.value = String(target);
        input.dispatchEvent(new Event("change", { bubbles: true }));
        input.step = step;
      } else {
        this.audio.currentTime = target;
      }
      if (this.audio.readyState >= HTMLMediaElement.HAVE_METADATA && Math.abs(this.audio.currentTime - target) > 0.5) {
        this.audio.currentTime = target;
      }
      if (play && this.audio.paused) this.togglePlay();
      this.followPausedByUser = false;
      this.alignedBlock = -1;
      this.update(true);
    }

    skip(delta) {
      this.seek(this.currentTime() + delta);
    }

    togglePlay() {
      const button = this.section.querySelector("[data-play]");
      if (button) button.click();
      else if (this.audio.paused) this.audio.play();
      else this.audio.pause();
    }

    changeSpeed(direction) {
      const select = this.section.querySelector("[data-speed]");
      if (!select) return;
      const next = Math.min(Math.max(select.selectedIndex + direction, 0), select.options.length - 1);
      if (next === select.selectedIndex) return;
      select.selectedIndex = next;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }

    /** Hover hints for the page's own controls that have shortcuts. */
    labelPageControls() {
      for (const button of this.section.querySelectorAll("[data-play], [data-bar-play]")) {
        button.dataset.llLabel = "Play / pause";
        button.dataset.llAction = "playPause";
      }
      const speed = this.section.querySelector(".lesson-audio-speed");
      if (speed) {
        speed.dataset.llLabel = "Speed";
        speed.dataset.llAction = "slower faster";
      }
    }

    renderSkipButtons() {
      this.section.querySelectorAll(".ll-skip").forEach((node) => node.remove());
      const { bar, panel } = settings.skipButtons;
      const play = this.section.querySelector("[data-play]");
      if (play && panel.length) play.after(this.skipGroup(panel, "ll-skip-panel"));
      const barPlay = this.section.querySelector("[data-bar-play]");
      if (barPlay && bar.length) barPlay.after(this.skipGroup(bar, "ll-skip-bar"));
    }

    skipGroup(values, extraClass) {
      return el("div", { class: `ll-skip ${extraClass}`, role: "group", "aria-label": "Skip" },
        values.map((value) => el("button", {
          type: "button",
          class: "ll-skip-btn",
          "data-ll-skip": String(value),
          "aria-label": `${value < 0 ? "Back" : "Forward"} ${Math.abs(value)} seconds`,
          "data-ll-label": `${value < 0 ? "Back" : "Forward"} ${Math.abs(value)}s`,
          ...(SKIP_ACTIONS[value] ? { "data-ll-action": SKIP_ACTIONS[value] } : {}),
          text: `${value < 0 ? "−" : "+"}${Math.abs(value)}`,
          onclick: (event) => { event.stopPropagation(); this.skip(value); },
        })));
    }

    injectControls() {
      this.renderSkipButtons();

      this.statusText = el("span", { class: "ll-status-text" });
      this.progress = el("span", { class: "ll-progress", hidden: "" });
      const trackButton = (extraClass) => el("button", { type: "button", class: `ll-btn ll-track ${extraClass}`, "aria-pressed": "false", onclick: (event) => { event.stopPropagation(); this.toggleTracking(); } }, [
        el("span", { class: "ll-check", "aria-hidden": "true" }), el("span", { class: "ll-track-label", text: "Track" }),
      ]);
      this.trackButtons = [trackButton("ll-track-panel"), trackButton("ll-track-bar")];
      const barToggle = this.section.querySelector(".lesson-audio-bar > .lesson-audio-toggle");
      if (barToggle) barToggle.before(this.trackButtons[1]);
      for (const button of this.trackButtons) button.dataset.llAction = "toggleTracking";
      this.syncButton = el("button", { type: "button", class: "ll-btn ll-btn-sync", "data-ll-label": "Transcribe locally for exact timestamps", onclick: () => this.sync() }, [el("span", { text: "Sync with Parakeet" })]);
      this.labelPageControls();
      this.row = el("div", { class: "ll-row" }, [
        el("p", { class: "ll-status" }, [el("span", { class: "ll-dot", "aria-hidden": "true" }), this.statusText, this.progress]),
        el("div", { class: "ll-actions" }, [
          this.trackButtons[0],
          this.syncButton,
          el("button", { type: "button", class: "ll-box", "data-ll-label": "Lesson Listen settings", "aria-label": "Lesson Listen settings", html: ICONS.settings, onclick: () => chrome.runtime.sendMessage({ type: "open-options" }) }),
        ]),
      ]);
      const controls = this.section.querySelector(".lesson-audio-controls");
      if (controls) controls.after(this.row);
      else this.section.append(this.row);
    }

    setStatus(text, { state = this.mode, progress = null } = {}) {
      this.statusText.textContent = text;
      this.row.dataset.state = state;
      if (progress === null) this.progress.hidden = true;
      else {
        this.progress.hidden = false;
        this.progress.style.setProperty("--ll-progress", `${Math.round(progress * 100)}%`);
      }
    }

    showModeStatus() {
      if (this.mode === "synced") {
        const model = (this.syncInfo?.model || "").includes("v3") ? "v3" : "v2";
        const ratio = this.syncInfo?.matchRatio;
        this.setStatus(`Timestamps · synced (Parakeet ${model}${ratio ? `, ${Math.round(ratio * 100)}% matched` : ""})`, { state: "synced" });
        this.syncButton.firstChild.textContent = "Re-sync";
      } else {
        this.setStatus("Timestamps · estimated", { state: "estimated" });
        this.syncButton.firstChild.textContent = "Sync with Parakeet";
      }
    }

    applyEstimate() {
      const { times } = Timing.estimate(this.blocks, this.anchors, this.duration());
      this.blockTimes = times;
      this.tokenStarts = new Float64Array(this.tokens.length);
      this.tokenEnds = new Float64Array(this.tokens.length);
      this.blocks.forEach((block, b) => {
        const count = block.tokenEnd - block.tokenStart;
        const { start, end } = times[b];
        const step = count ? (end - start) / count : 0;
        for (let i = 0; i < count; i++) {
          this.tokenStarts[block.tokenStart + i] = start + i * step;
          this.tokenEnds[block.tokenStart + i] = start + (i + 1) * step;
        }
      });
      this.blockStarts = Float64Array.from(times, (t) => t.start);
      this.mode = "estimated";
      this.showModeStatus();
    }

    applyTranscript(record) {
      const stt = Timing.sttTokens(record.words, new Set(this.tokens.map((t) => t.norm)));
      const aligned = Timing.align(this.tokens.map((t) => t.norm), stt, this.duration());
      this.alignment = { aligned, stt };
      this.tokenStarts = aligned.starts;
      this.tokenEnds = aligned.ends;
      this.blockTimes = this.blocks.map((block, b) => {
        const start = block.tokenEnd > block.tokenStart ? aligned.starts[block.tokenStart] : (b > 0 ? this.blockTimes[b - 1].end : 0);
        return { start, end: start };
      });
      for (let b = 0; b < this.blockTimes.length; b++) {
        this.blockTimes[b].end = b + 1 < this.blockTimes.length ? this.blockTimes[b + 1].start : this.duration();
      }
      this.blockStarts = Float64Array.from(this.blockTimes, (t) => t.start);
      this.mode = "synced";
      this.syncInfo = { model: record.model, matchRatio: aligned.matchRatio, createdAt: record.createdAt };
      this.showModeStatus();
      this.renderTimestamps();
      this.update(true);
    }

    async loadStoredTranscript() {
      const stored = await chrome.storage.local.get(this.key);
      const record = stored[this.key];
      if (record?.v === STORAGE_VERSION && Array.isArray(record.words) && record.words.length) this.applyTranscript(record);
    }

    renderTimestamps() {
      this.blocks.forEach((block, b) => {
        const worthy = block.kind === "heading" || block.kind === "figure" || block.textWords >= MIN_TIMESTAMP_WORDS;
        if (!worthy) return;
        if (!block.timestamp) {
          block.el.classList.add("ll-block");
          block.timestamp = el("button", { type: "button", class: "ll-ts", onclick: (event) => { event.preventDefault(); event.stopPropagation(); this.seek(this.blockTimes[b].start, { play: true }); } });
          block.el.prepend(block.timestamp);
        }
        const label = Timing.formatTime(this.blockTimes[b].start);
        const estimated = this.mode !== "synced";
        block.timestamp.textContent = estimated ? `~${label}` : label;
        block.timestamp.classList.toggle("ll-ts-estimated", estimated);
        block.timestamp.dataset.llLabel = `Play from ${label}${estimated ? " (estimated)" : ""}`;
      });
    }

    bindAudio() {
      const onState = () => {
        this.update(true);
        if (!this.audio.paused) this.startLoop();
      };
      for (const type of ["play", "pause", "seeked", "timeupdate", "loadedmetadata"]) {
        this.audio.addEventListener(type, onState);
        this.cleanups.push(() => this.audio.removeEventListener(type, onState));
      }
      this.audio.addEventListener("loadedmetadata", () => {
        if (this.mode === "estimated") {
          this.applyEstimate();
          this.renderTimestamps();
        }
      }, { once: true });
      const onResize = () => this.prose.classList.toggle("ll-narrow", this.prose.getBoundingClientRect().left < 84);
      onResize();
      window.addEventListener("resize", onResize);
      this.cleanups.push(() => window.removeEventListener("resize", onResize));
    }

    bindScrollIntent() {
      const scrollKeys = new Set(["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown", " "]);
      const markUser = (event) => {
        if (event?.target instanceof Element && event.target.closest("section.lesson-audio")) return;
        this.userScrollAt = performance.now();
        if (settings.trackingEnabled && !this.audio.paused && !this.followPausedByUser) {
          this.followPausedByUser = true;
          this.pausedAtBlock = this.upcomingBlock();
          this.renderFollowState();
        }
      };
      const onKey = (event) => {
        if (scrollKeys.has(event.key) && !isTyping(event.target)) markUser(event);
      };
      window.addEventListener("wheel", markUser, { passive: true });
      window.addEventListener("touchmove", markUser, { passive: true });
      window.addEventListener("keydown", onKey, true);
      this.cleanups.push(() => {
        window.removeEventListener("wheel", markUser);
        window.removeEventListener("touchmove", markUser);
        window.removeEventListener("keydown", onKey, true);
      });
    }

    bindWordSeek() {
      const onClick = (event) => {
        if (!event.altKey) return;
        const caret = document.caretPositionFromPoint?.(event.clientX, event.clientY);
        if (!caret) return;
        const index = this.tokens.findIndex((t) => t.node === caret.offsetNode && caret.offset >= t.offset && caret.offset <= t.offset + t.length);
        if (index < 0) return;
        event.preventDefault();
        event.stopPropagation();
        this.seek(this.tokenStarts[index], { play: true });
      };
      this.prose.addEventListener("click", onClick, true);
      this.cleanups.push(() => this.prose.removeEventListener("click", onClick, true));
    }

    applySettings() {
      this.prose.classList.toggle("ll-hide-ts", !settings.showTimestamps);
      this.renderSkipButtons();
      for (const button of this.trackButtons) button.setAttribute("aria-pressed", String(settings.trackingEnabled));
      if (!settings.highlightWords) this.clearWordHighlight();
      this.renderFollowState();
      this.update(true);
    }

    async toggleTracking() {
      if (settings.trackingEnabled && this.followPausedByUser) {
        this.jumpToCurrent();
        return;
      }
      settings = await Settings.save({ trackingEnabled: !settings.trackingEnabled });
      this.followPausedByUser = false;
      this.applySettings();
      if (settings.trackingEnabled) this.scrollToActive("smooth");
    }

    jumpToCurrent() {
      this.followPausedByUser = false;
      this.renderFollowState();
      this.scrollToActive("smooth");
    }

    renderFollowState() {
      const paused = Boolean(settings.trackingEnabled && this.followPausedByUser);
      const title = !settings.trackingEnabled ? "Tracking off" : paused ? "Tracking paused, click to follow" : "Tracking on";
      for (const button of this.trackButtons) {
        button.classList.toggle("ll-paused", paused);
        button.dataset.llLabel = title;
      }
    }

    async disableTracking() {
      this.followPausedByUser = false;
      settings = { ...settings, trackingEnabled: false };
      settings = await Settings.save({ trackingEnabled: false });
      this.applySettings();
    }

    startLoop() {
      if (this.frame) return;
      this.lastFrameAt = performance.now();
      const tick = (now) => {
        const dt = Math.min(now - this.lastFrameAt, 100);
        this.lastFrameAt = now;
        this.update(false);
        if (settings.trackingEnabled) this.follow(now, dt);
        this.frame = this.audio.paused ? null : requestAnimationFrame(tick);
      };
      this.frame = requestAnimationFrame(tick);
    }

    update(force) {
      const t = this.currentTime();
      const block = Timing.findAt(this.blockStarts, t);
      if (block !== this.activeBlock || force) {
        if (block !== this.activeBlock) this.lastBlockChange = performance.now();
        this.blocks[this.activeBlock]?.el.classList.remove("ll-active");
        this.activeBlock = block;
        const started = !this.audio.paused || t > 0.5;
        if (started) this.blocks[block]?.el.classList.add("ll-active");
      }
      const token = Timing.findAt(this.tokenStarts, t);
      if (token !== this.activeToken || force) {
        this.activeToken = token;
        this.renderWordHighlight();
      }
    }

    tokenRange(index) {
      const token = this.tokens[index];
      if (!token?.node?.isConnected) return null;
      const range = document.createRange();
      range.setStart(token.node, token.offset);
      range.setEnd(token.node, token.offset + token.length);
      return range;
    }

    renderWordHighlight() {
      if (!highlightSupported) return;
      if (this.mode !== "synced" || !settings.highlightWords || (this.audio.paused && this.currentTime() < 0.5)) {
        this.clearWordHighlight();
        return;
      }
      const range = this.tokenRange(this.activeToken);
      if (range) CSS.highlights.set("ll-word", new Highlight(range));
      else this.clearWordHighlight();
    }

    clearWordHighlight() {
      if (highlightSupported) CSS.highlights.delete("ll-word");
    }

    activeY() {
      const t = this.currentTime();
      const range = this.tokenRange(this.activeToken);
      if (range) {
        const rect = range.getClientRects()[0] || range.getBoundingClientRect();
        if (rect.height) return rect.top + rect.height / 2;
      }
      const block = this.blocks[this.activeBlock];
      if (!block) return null;
      const rect = block.el.getBoundingClientRect();
      const { start, end } = this.blockTimes[this.activeBlock];
      const fraction = end > start ? Math.min(Math.max((t - start) / (end - start), 0), 1) : 0;
      return rect.top + fraction * rect.height;
    }

    inSilence() {
      if (this.mode !== "synced" || this.activeToken < 0) return false;
      const t = this.currentTime();
      const next = this.tokenStarts[this.activeToken + 1];
      return t > this.tokenEnds[this.activeToken] && next !== undefined && next - this.tokenEnds[this.activeToken] >= SILENCE_GAP;
    }

    /** The visible reading area, excluding the docked player and any fixed header at the top. */
    readingBand() {
      let top = 0;
      for (const node of [this.section, document.querySelector(".site-header")]) {
        if (!node) continue;
        const position = getComputedStyle(node).position;
        const docked = node === this.section ? "stuck" in node.dataset : position === "fixed" || position === "sticky";
        if (!docked) continue;
        const rect = node.getBoundingClientRect();
        if (rect.top <= 1 && rect.bottom > top) top = rect.bottom;
      }
      const bottom = window.innerHeight;
      top = Math.min(top, bottom * 0.6);
      return { top, height: bottom - top, at: (fraction) => top + (bottom - top) * fraction };
    }

    /**
     * Where the page should scroll so a block starts at the paragraph target height,
     * unless that would push the spoken line below the bottom limit, in which case the line itself goes to the target.
     */
    blockScrollTop(blockIndex, y, band) {
      const rect = this.blocks[this.leadBlock(blockIndex)]?.el.getBoundingClientRect();
      const target = band.at(PARAGRAPH_TARGET);
      if (!rect || y === null) return window.scrollY + (y ?? target) - target;
      const lineBelowTop = Math.max(0, y - rect.top);
      const anchorTop = target + lineBelowTop > band.at(LINE_LIMIT) ? y : rect.top;
      return window.scrollY + anchorTop - target;
    }

    /** A heading (and a short line right before a paragraph) scrolls together with the block it introduces. */
    leadBlock(blockIndex) {
      let lead = blockIndex;
      for (let steps = 0; steps < 2 && lead > 0; steps++) {
        const previous = this.blocks[lead - 1];
        const shortLine = previous.kind === "text" && previous.textWords < SCROLL_STOP_MIN_WORDS && this.blocks[lead].kind !== "heading";
        if (previous.kind === "heading" || shortLine) lead--;
        else break;
      }
      return lead;
    }

    upcomingBlock() {
      return Math.max(0, Timing.findAt(this.blockStarts, this.currentTime() + PARAGRAPH_LEAD_SECONDS));
    }

    /**
     * While paused by a user scroll: turn tracking off when the reader went far from the spoken paragraph
     * (well above it, or a full screen past it). Otherwise wait for the next paragraph and resume only
     * if that paragraph is clearly off screen.
     */
    handleUserPause(band) {
      const height = window.innerHeight;
      const active = this.blocks[this.activeBlock]?.el.getBoundingClientRect();
      if (active) {
        const farAbove = active.top > height * (1 + RESUME_UP_ALLOWANCE);
        const farBelow = active.bottom < band.top - height * RESUME_DOWN_ALLOWANCE;
        if (farAbove || farBelow) {
          this.disableTracking();
          return false;
        }
      }
      const upcoming = this.upcomingBlock();
      if (upcoming === this.pausedAtBlock || !this.isScrollStop(upcoming)) return false;
      this.pausedAtBlock = upcoming;
      const rect = this.blocks[upcoming].el.getBoundingClientRect();
      const clearlyOffscreen = rect.top > height - 10 || rect.bottom < band.top + 10;
      if (!clearlyOffscreen) return false;
      this.followPausedByUser = false;
      this.alignedBlock = -1;
      this.renderFollowState();
      return true;
    }

    /** Short lines like "Let's begin!" ride along with the next block instead of triggering a scroll of their own. */
    isScrollStop(blockIndex) {
      const block = this.blocks[blockIndex];
      return Boolean(block) && (block.kind !== "text" || block.textWords >= SCROLL_STOP_MIN_WORDS);
    }

    follow(now, dt) {
      if (this.audio.paused) return;
      const y = this.activeY();
      if (y === null) return;
      const band = this.readingBand();

      if (this.followPausedByUser && !this.handleUserPause(band)) return;

      if (settings.trackingStyle === "smooth") {
        const delta = y - band.at(FOLLOW_ANCHOR);
        if (Math.abs(delta) < 1) return;
        const step = Math.abs(delta) > band.height ? delta : delta * (1 - Math.exp(-dt / SMOOTH_TIME_CONSTANT_MS));
        window.scrollBy({ top: step, behavior: "instant" });
        return;
      }

      if (now < this.programmaticScrollUntil) return;

      const upcoming = this.upcomingBlock();
      if (upcoming !== this.alignedBlock && this.isScrollStop(upcoming)) {
        this.alignedBlock = upcoming;
        this.pendingSince = 0;
        const top = this.blocks[this.leadBlock(upcoming)]?.el.getBoundingClientRect().top ?? y;
        const settled = top >= band.at(PARAGRAPH_SETTLED[0]) && top <= band.at(PARAGRAPH_SETTLED[1]);
        const lineY = upcoming === this.activeBlock ? y : top;
        if (!settled) this.scrollTo(this.blockScrollTop(upcoming, lineY, band), now);
        return;
      }

      const overflowing = y > band.at(LINE_LIMIT) || y < band.top;
      if (!overflowing) {
        this.pendingSince = 0;
        return;
      }
      if (!this.pendingSince) this.pendingSince = now;
      const offscreen = y < band.top || y > window.innerHeight;
      if (offscreen || this.inSilence() || now - this.pendingSince > OVERFLOW_FALLBACK_MS) {
        this.pendingSince = 0;
        this.scrollTo(window.scrollY + y - band.at(PARAGRAPH_TARGET), now);
      }
    }

    scrollTo(top, now = performance.now(), behavior = "smooth") {
      this.programmaticScrollUntil = now + 900;
      window.scrollTo({ top, behavior });
    }

    scrollToActive(behavior) {
      const y = this.activeY();
      if (y === null) return;
      this.alignedBlock = this.activeBlock;
      this.scrollTo(this.blockScrollTop(this.activeBlock, y, this.readingBand()), performance.now(), behavior);
    }

    async sync() {
      if (this.syncing) return;
      this.syncing = true;
      this.syncButton.disabled = true;
      try {
        const words = await this.transcribe();
        const record = { v: STORAGE_VERSION, model: settings.model, createdAt: Date.now(), words };
        await chrome.storage.local.set({ [this.key]: record });
        this.applyTranscript(record);
      } catch (error) {
        this.setStatus(error.message || String(error), { state: "error" });
      } finally {
        this.syncing = false;
        this.syncButton.disabled = false;
      }
    }

    async transcribe() {
      this.setStatus("Checking local speech-to-text host", { state: "busy" });
      await hostRequest({ type: "ping", model: settings.model });

      this.setStatus("Fetching lesson audio", { state: "busy", progress: 0 });
      const response = await fetch(audioUrl(this.audio), { credentials: "include" });
      if (!response.ok) throw new Error(`Could not fetch audio (HTTP ${response.status})`);
      const total = Number(response.headers.get("content-length")) || 0;
      const reader = response.body.getReader();
      const parts = [];
      let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
        received += value.length;
        if (total) this.setStatus("Fetching lesson audio", { state: "busy", progress: received / total });
      }
      const bytes = new Uint8Array(received);
      let offset = 0;
      for (const part of parts) { bytes.set(part, offset); offset += part.length; }

      return new Promise((resolve, reject) => {
        const port = chrome.runtime.connect({ name: "stt" });
        const words = [];
        let finished = false;
        port.onMessage.addListener((message) => {
          if (message.type === "status") {
            const label = STAGE_LABELS[message.stage] || message.stage;
            this.setStatus(label, { state: "busy", progress: typeof message.progress === "number" ? message.progress : null });
          } else if (message.type === "words") {
            words.push(...message.words);
          } else if (message.type === "done") {
            finished = true;
            port.disconnect();
            resolve(words);
          } else if (message.type === "error") {
            finished = true;
            port.disconnect();
            reject(new Error(`Speech-to-text failed: ${message.message}`));
          } else if (message.type === "host-closed" && !finished) {
            reject(new Error(hostErrorMessage(message.error)));
          }
        });
        port.postMessage({ type: "begin", model: settings.model, size: bytes.length, ext: "mp3" });
        const CHUNK = 1_500_000;
        for (let i = 0; i < bytes.length; i += CHUNK) {
          port.postMessage({ type: "chunk", data: toBase64(bytes.subarray(i, i + CHUNK)) });
        }
        port.postMessage({ type: "end" });
      });
    }

    destroy() {
      this.cleanups.forEach((fn) => fn());
      if (this.frame) cancelAnimationFrame(this.frame);
      this.clearWordHighlight();
      this.section.querySelectorAll(".ll-skip, .ll-row, .ll-track-bar").forEach((node) => node.remove());
      this.blocks.forEach((block) => {
        block.timestamp?.remove();
        block.el.classList.remove("ll-block", "ll-active");
      });
      delete this.section.dataset.llReady;
    }
  }

  const hint = {
    node: null,
    target: null,
    timer: null,
    show(target) {
      const label = target.dataset.llLabel;
      if (!label) return;
      const keys = settings.shortcutsEnabled
        ? (target.dataset.llAction || "").split(" ").map((action) => settings.shortcuts[action]).filter(Boolean)
        : [];
      if (!this.node) {
        this.node = el("div", { class: "ll-tip", role: "tooltip" });
        document.body.append(this.node);
      }
      this.node.replaceChildren(el("span", { text: label }), ...keys.map((combo) => el("kbd", { text: Settings.prettyCombo(combo) })));
      this.node.dataset.visible = "";
      const rect = target.getBoundingClientRect();
      const tip = this.node.getBoundingClientRect();
      const below = rect.bottom + tip.height + 10 < window.innerHeight;
      const top = below ? rect.bottom + 8 : rect.top - tip.height - 8;
      const left = Math.min(Math.max(8, rect.left + rect.width / 2 - tip.width / 2), window.innerWidth - tip.width - 8);
      this.node.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
    },
    hide() {
      clearTimeout(this.timer);
      this.target = null;
      if (this.node) delete this.node.dataset.visible;
    },
    schedule(target, delay) {
      if (target === this.target) return;
      this.hide();
      this.target = target;
      this.timer = setTimeout(() => this.target === target && target.isConnected && this.show(target), delay);
    },
  };

  function bindHints() {
    document.addEventListener("pointerover", (event) => {
      const target = event.target instanceof Element ? event.target.closest("[data-ll-label]") : null;
      if (target) hint.schedule(target, 350);
      else if (hint.target) hint.hide();
    });
    document.addEventListener("focusin", (event) => {
      const target = event.target instanceof Element ? event.target.closest("[data-ll-label]") : null;
      if (target?.matches(":focus-visible")) hint.schedule(target, 0);
    });
    for (const type of ["pointerdown", "scroll", "keydown", "focusout"]) {
      window.addEventListener(type, () => hint.hide(), { capture: true, passive: true });
    }
  }

  function toBase64(bytes) {
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  }

  function hostErrorMessage(error) {
    if (!error) return "Local host closed unexpectedly. See $TMPDIR/lesson-listen-host.log";
    if (/not found/i.test(error)) return "Local host not installed. Run lesson-listen/host/install.sh, then reload.";
    if (/forbidden/i.test(error)) return "Host does not allow this extension ID. Re-run install.sh.";
    return `Local host error: ${error}`;
  }

  function hostRequest(message) {
    return new Promise((resolve, reject) => {
      const port = chrome.runtime.connect({ name: "stt" });
      let answered = false;
      port.onMessage.addListener((reply) => {
        if (reply.type === "host-closed") {
          if (!answered) reject(new Error(hostErrorMessage(reply.error)));
          port.disconnect();
          return;
        }
        answered = true;
        if (reply.type === "error") reject(new Error(reply.message));
        else resolve(reply);
      });
      port.postMessage(message);
    });
  }

  function isTyping(target) {
    if (!(target instanceof Element) || target.matches("input[type='range']")) return false;
    return target.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']") !== null;
  }

  function onShortcut(event) {
    if (!lesson || !settings.shortcutsEnabled || event.defaultPrevented || event.repeat && event.code === "KeyK") return;
    if (isTyping(event.target)) return;
    const combo = Settings.comboFromEvent(event);
    if (!combo) return;
    const action = Object.entries(settings.shortcuts).find(([, value]) => value === combo)?.[0];
    if (!action) return;
    const handlers = {
      back5: () => lesson.skip(-5),
      forward5: () => lesson.skip(5),
      back10: () => lesson.skip(-10),
      forward10: () => lesson.skip(10),
      playPause: () => lesson.togglePlay(),
      toggleTracking: () => lesson.toggleTracking(),
      jumpToCurrent: () => lesson.jumpToCurrent(),
      slower: () => lesson.changeSpeed(-1),
      faster: () => lesson.changeSpeed(1),
    };
    if (!handlers[action]) return;
    event.preventDefault();
    event.stopPropagation();
    if (document.activeElement instanceof HTMLElement && document.activeElement.closest("section.lesson-audio")) document.activeElement.blur();
    handlers[action]();
  }

  function scan() {
    const section = document.querySelector("section.lesson-audio[data-lesson-audio]");
    const prose = section?.closest("article")?.querySelector(".prose") || document.querySelector(".lesson-article .prose");
    if (lesson && (lesson.section !== section || !lesson.section.isConnected)) {
      lesson.destroy();
      lesson = null;
    }
    if (!lesson && section && prose && section.querySelector("audio")) lesson = new Lesson(section, prose);
  }

  /** Unpacked builds only: lets the background reload the extension when its files change on disk. */
  /** Unpacked builds only: answers window.postMessage({type: "ll-debug-align", phrase}) with the alignment around a phrase. */
  function bindDevAlignmentProbe() {
    window.addEventListener("message", (event) => {
      if (event.source !== window || event.data?.type !== "ll-debug-align" || !lesson?.alignment) return;
      const { aligned, stt } = lesson.alignment;
      const wanted = Timing.tokenize(event.data.phrase || "").map((t) => t.norm);
      const norms = lesson.tokens.map((t) => t.norm);
      let at = norms.findIndex((_, i) => wanted.every((w, k) => norms[i + k] === w));
      const radius = event.data.radius || 25;
      const rows = [];
      for (let i = Math.max(0, at - radius); at >= 0 && i < Math.min(norms.length, at + radius); i++) {
        const j = aligned.map[i];
        rows.push([i, lesson.tokens[i].block, lesson.blocks[lesson.tokens[i].block].kind[0], norms[i], aligned.starts[i].toFixed(2), j >= 0 ? `${stt[j].norm}@${stt[j].start.toFixed(2)}` : "-"]);
      }
      const t0 = rows.length ? Number(rows[0][4]) - 3 : 0, t1 = rows.length ? Number(rows[rows.length - 1][4]) + 3 : 0;
      const spoken = stt.filter((s) => s.start >= t0 && s.start <= t1).map((s) => `${s.norm}@${s.start.toFixed(1)}`);
      window.postMessage({ type: "ll-debug-align-result", at, matchRatio: aligned.matchRatio, rows, spoken }, "*");
    });
    window.addEventListener("message", (event) => {
      if (event.source !== window || event.data?.type !== "ll-debug-scan" || !lesson?.alignment) return;
      const { starts } = lesson.alignment.aligned;
      const issues = [];
      lesson.blocks.forEach((block, b) => {
        if (block.kind === "figure") return;
        for (let i = block.tokenStart + 1; i < block.tokenEnd; i++) {
          const gap = starts[i] - starts[i - 1];
          if (gap > 2.5) issues.push(["stall", b, lesson.tokens[i - 1].norm + " " + lesson.tokens[i].norm, starts[i - 1].toFixed(1), gap.toFixed(1)]);
        }
        for (let i = block.tokenStart; i + 6 <= block.tokenEnd; i++) {
          const span = starts[i + 5] - starts[i];
          if (span < 0.5) { issues.push(["squeezed", b, lesson.tokens.slice(i, i + 6).map((t) => t.norm).join(" "), starts[i].toFixed(1), span.toFixed(2)]); i += 5; }
        }
      });
      window.postMessage({ type: "ll-debug-scan-result", issues }, "*");
    });
  }

  function watchForDevChanges() {
    const timer = setInterval(() => {
      if (!chrome.runtime?.id) return clearInterval(timer);
      chrome.runtime.sendMessage({ type: "dev-check" }).catch(() => clearInterval(timer));
    }, 2000);
  }

  async function start() {
    settings = await Settings.load();
    chrome.storage.onChanged.addListener(async (changes, area) => {
      if (area === "sync" && changes.settings) {
        settings = await Settings.load();
        lesson?.applySettings();
      }
      if (area === "local" && lesson && lesson.key in changes && !changes[lesson.key].newValue) {
        lesson.applyEstimate();
        lesson.renderTimestamps();
      }
    });
    window.addEventListener("keydown", onShortcut, true);
    bindHints();
    if (!("update_url" in chrome.runtime.getManifest())) {
      watchForDevChanges();
      bindDevAlignmentProbe();
    }
    scan();
    let scheduled = false;
    new MutationObserver(() => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => { scheduled = false; scan(); });
    }).observe(document.body, { childList: true, subtree: true });
  }

  start();
})();
