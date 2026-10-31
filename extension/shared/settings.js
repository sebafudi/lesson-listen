(() => {
  const ACTIONS = {
    back5: "Back 5 seconds",
    forward5: "Forward 5 seconds",
    back10: "Back 10 seconds",
    forward10: "Forward 10 seconds",
    playPause: "Play / pause",
    toggleTracking: "Toggle tracking",
    jumpToCurrent: "Scroll to what is playing",
    slower: "Slower",
    faster: "Faster",
  };

  const DEFAULTS = {
    shortcutsEnabled: true,
    shortcuts: {
      back5: "arrowleft",
      forward5: "arrowright",
      back10: "j",
      forward10: "l",
      playPause: "k",
      toggleTracking: "t",
      jumpToCurrent: "c",
      slower: "shift+,",
      faster: "shift+.",
    },
    skipButtons: {
      bar: [-10, 10],
      panel: [-30, -10, 10, 30],
    },
    showTimestamps: true,
    trackingEnabled: false,
    trackingStyle: "pauses",
    highlightWords: true,
    model: "mlx-community/parakeet-tdt-0.6b-v2",
  };

  const MODELS = {
    "mlx-community/parakeet-tdt-0.6b-v2": "Parakeet TDT 0.6B v2 (English, most accurate)",
    "mlx-community/parakeet-tdt-0.6b-v3": "Parakeet TDT 0.6B v3 (multilingual)",
  };

  const SHORTCUTS_VERSION = 3;
  const SKIP_VALUES = [-30, -10, -5, 5, 10, 30];
  const SKIP_LOCATIONS = { bar: "Sticky bar", panel: "Expanded player" };

  function knownSkipButtons(skipButtons = {}) {
    return Object.fromEntries(Object.keys(SKIP_LOCATIONS).map((location) => {
      const values = Array.isArray(skipButtons[location]) ? skipButtons[location] : DEFAULTS.skipButtons[location];
      return [location, SKIP_VALUES.filter((value) => values.includes(value))];
    }));
  }

  function knownShortcuts(shortcuts) {
    return Object.fromEntries(Object.keys(ACTIONS).map((action) => [action, shortcuts[action] ?? DEFAULTS.shortcuts[action]]));
  }

  /** Shortcuts saved under an older action set are replaced by the current defaults. */
  async function load() {
    const stored = await chrome.storage.sync.get("settings");
    const settings = stored.settings || {};
    const savedShortcuts = settings.shortcutsVersion === SHORTCUTS_VERSION ? settings.shortcuts || {} : {};
    return { ...DEFAULTS, ...settings, shortcutsVersion: SHORTCUTS_VERSION, shortcuts: knownShortcuts(savedShortcuts), skipButtons: knownSkipButtons(settings.skipButtons) };
  }

  async function save(patch) {
    const current = await load();
    const next = {
      ...current,
      ...patch,
      shortcutsVersion: SHORTCUTS_VERSION,
      shortcuts: knownShortcuts({ ...current.shortcuts, ...(patch.shortcuts || {}) }),
      skipButtons: knownSkipButtons({ ...current.skipButtons, ...(patch.skipButtons || {}) }),
    };
    await chrome.storage.sync.set({ settings: next });
    return next;
  }

  const CODE_NAMES = { Comma: ",", Period: ".", Slash: "/", Semicolon: ";", Quote: "'", BracketLeft: "[", BracketRight: "]", Minus: "-", Equal: "=", Backquote: "`", Backslash: "\\", Space: "space" };

  /** Builds a layout-independent combo like "shift+j" from a keyboard event. */
  function comboFromEvent(event) {
    const code = event.code || "";
    let key;
    if (code.startsWith("Key")) key = code.slice(3).toLowerCase();
    else if (code.startsWith("Digit")) key = code.slice(5);
    else if (CODE_NAMES[code]) key = CODE_NAMES[code];
    else key = code.toLowerCase();
    if (!key || ["shiftleft", "shiftright", "controlleft", "controlright", "altleft", "altright", "metaleft", "metaright"].includes(key)) return null;
    const mods = [];
    if (event.ctrlKey) mods.push("ctrl");
    if (event.altKey) mods.push("alt");
    if (event.metaKey) mods.push("meta");
    if (event.shiftKey) mods.push("shift");
    return [...mods, key].join("+");
  }

  function prettyCombo(combo) {
    if (!combo) return "-";
    const names = { shift: "⇧", meta: "⌘", alt: "⌥", ctrl: "⌃", arrowleft: "←", arrowright: "→", arrowup: "↑", arrowdown: "↓", space: "Space" };
    return combo.split("+").map((part) => names[part] || part.toUpperCase()).join(" ");
  }

  globalThis.LessonListenSettings = { ACTIONS, DEFAULTS, MODELS, SKIP_VALUES, SKIP_LOCATIONS, load, save, comboFromEvent, prettyCombo };
})();
