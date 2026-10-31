const HOST_NAME = "dev.lesson_listen.stt";

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "stt") return;
  let native = null;

  const openNative = () => {
    native = chrome.runtime.connectNative(HOST_NAME);
    native.onMessage.addListener((message) => port.postMessage(message));
    native.onDisconnect.addListener(() => {
      const error = chrome.runtime.lastError?.message;
      native = null;
      try {
        port.postMessage({ type: "host-closed", error });
      } catch {}
    });
  };

  port.onMessage.addListener((message) => {
    if (message.type === "ping" || message.type === "begin") {
      native?.disconnect();
      openNative();
    }
    native?.postMessage(message);
  });

  port.onDisconnect.addListener(() => native?.disconnect());
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "open-options") chrome.runtime.openOptionsPage();
});

const IS_UNPACKED = !("update_url" in chrome.runtime.getManifest());
const WATCHED_FILES = [
  "manifest.json",
  "background.js",
  "shared/settings.js",
  "content/timing.js",
  "content/content.js",
  "content/content.css",
  "options/options.html",
  "options/options.js",
  "options/options.css",
];

async function fingerprint() {
  const texts = await Promise.all(WATCHED_FILES.map((file) => fetch(chrome.runtime.getURL(file), { cache: "no-store" }).then((r) => r.text())));
  let hash = 0;
  for (const char of texts.join("\u0000")) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) | 0;
  return hash;
}

if (IS_UNPACKED) {
  chrome.runtime.onInstalled.addListener(async ({ reason }) => {
    await chrome.storage.session.set({ devFingerprint: await fingerprint() });
    if (reason === "update") {
      const tabs = await chrome.tabs.query({ url: "https://hq.mega.dev/lessons/*" });
      tabs.forEach((tab) => chrome.tabs.reload(tab.id));
    }
  });

  chrome.runtime.onMessage.addListener((message, _sender, reply) => {
    if (message?.type !== "dev-check") return;
    (async () => {
      const { devFingerprint } = await chrome.storage.session.get("devFingerprint");
      const current = await fingerprint();
      if (devFingerprint === undefined) await chrome.storage.session.set({ devFingerprint: current });
      else if (current !== devFingerprint) chrome.runtime.reload();
      reply({ ok: true });
    })();
    return true;
  });
}
