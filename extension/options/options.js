const S = globalThis.LessonListenSettings;
let settings;
let capturing = null;

async function render() {
  settings = await S.load();
  for (const input of document.querySelectorAll("input[type=checkbox][data-setting]")) input.checked = Boolean(settings[input.dataset.setting]);
  for (const radio of document.querySelectorAll("input[name=trackingStyle]")) radio.checked = radio.value === settings.trackingStyle;
  const model = document.getElementById("model");
  if (!model.options.length) {
    for (const [value, label] of Object.entries(S.MODELS)) model.append(new Option(label, value));
  }
  model.value = settings.model;
  renderShortcuts();
  renderSkipButtons();
}

function renderSkipButtons() {
  const container = document.getElementById("skip-buttons");
  container.replaceChildren();
  for (const [location, label] of Object.entries(S.SKIP_LOCATIONS)) {
    const field = document.createElement("div");
    field.className = "field";
    const name = document.createElement("span");
    name.className = "label";
    name.textContent = label;
    const chips = document.createElement("div");
    chips.className = "chips";
    for (const value of S.SKIP_VALUES) {
      const chip = document.createElement("label");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = settings.skipButtons[location].includes(value);
      input.addEventListener("change", async () => {
        const current = new Set(settings.skipButtons[location]);
        input.checked ? current.add(value) : current.delete(value);
        settings = await S.save({ skipButtons: { [location]: [...current] } });
      });
      const text = document.createElement("span");
      text.textContent = `${value < 0 ? "−" : "+"}${Math.abs(value)}`;
      chip.append(input, text);
      chips.append(chip);
    }
    field.append(name, chips);
    container.append(field);
  }
}

function renderShortcuts() {
  const list = document.getElementById("shortcuts");
  list.replaceChildren();
  const used = Object.values(settings.shortcuts).filter(Boolean);
  for (const [action, label] of Object.entries(S.ACTIONS)) {
    const combo = settings.shortcuts[action];
    const conflict = combo && used.filter((c) => c === combo).length > 1;
    const row = document.createElement("div");
    row.className = "shortcut";
    const name = document.createElement("span");
    name.textContent = label;
    const key = document.createElement("button");
    key.type = "button";
    key.className = "key" + (capturing === action ? " capturing" : "") + (conflict ? " conflict" : "");
    key.textContent = capturing === action ? "Press keys" : S.prettyCombo(combo);
    key.title = conflict ? "Used by another action" : "Click to change";
    key.addEventListener("click", () => {
      capturing = capturing === action ? null : action;
      renderShortcuts();
    });
    row.append(name, key);
    list.append(row);
  }
  document.getElementById("shortcuts").classList.toggle("disabled", !settings.shortcutsEnabled);
}

document.addEventListener("keydown", async (event) => {
  if (!capturing) return;
  event.preventDefault();
  if (event.key === "Escape") {
    capturing = null;
    return renderShortcuts();
  }
  const combo = event.key === "Backspace" || event.key === "Delete" ? "" : S.comboFromEvent(event);
  if (combo === null) return;
  const action = capturing;
  capturing = null;
  settings = await S.save({ shortcuts: { [action]: combo } });
  renderShortcuts();
});

document.addEventListener("change", async (event) => {
  const target = event.target;
  if (target.closest("#skip-buttons")) return;
  if (target.dataset.setting) {
    const value = target.type === "checkbox" ? target.checked : target.value;
    settings = await S.save({ [target.dataset.setting]: value });
    renderShortcuts();
    if (target.dataset.setting === "model") checkHost();
  } else if (target.name === "trackingStyle") {
    settings = await S.save({ trackingStyle: target.value });
  }
});

document.getElementById("reset-shortcuts").addEventListener("click", async () => {
  settings = await S.save({ shortcuts: { ...S.DEFAULTS.shortcuts } });
  renderShortcuts();
});

function checkHost() {
  const status = document.getElementById("host-status");
  const dot = document.getElementById("host-dot");
  status.textContent = "Checking";
  dot.className = "dot";
  const port = chrome.runtime.connect({ name: "stt" });
  let answered = false;
  port.onMessage.addListener((message) => {
    if (message.type === "pong") {
      answered = true;
      dot.className = "dot ok";
      status.textContent = `Installed · model ${message.modelCached ? "downloaded" : "not downloaded yet (downloads on first sync)"}`;
    } else if (message.type === "host-closed") {
      if (!answered) {
        dot.className = "dot bad";
        status.textContent = /not found/i.test(message.error || "")
          ? "Not installed. Run lesson-listen/host/install.sh"
          : `Unavailable: ${message.error || "closed without reply"}`;
      }
      port.disconnect();
    }
  });
  port.postMessage({ type: "ping", model: settings?.model });
}

async function renderStored() {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith("transcript:"));
  const bytes = await chrome.storage.local.getBytesInUse(keys);
  const slugs = [...new Set(keys.map((k) => k.split(":")[1]))];
  document.getElementById("stored").textContent = keys.length
    ? `${keys.length} (${slugs.join(", ")}) · ${(bytes / 1024).toFixed(0)} KB`
    : "None";
  return keys;
}

document.getElementById("clear-transcripts").addEventListener("click", async () => {
  const keys = await renderStored();
  if (keys.length) await chrome.storage.local.remove(keys);
  renderStored();
});
document.getElementById("host-check").addEventListener("click", checkHost);

render().then(() => {
  checkHost();
  renderStored();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes.settings && !capturing) render();
  if (area === "local") renderStored();
});
