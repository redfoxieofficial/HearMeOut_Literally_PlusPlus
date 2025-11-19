(() => {
  let selectionTimer = null;
  let enabled = false;

  async function loadDelaySettings() {
    const s = await chrome.storage.local.get(["delay"]);
    selectionDelay = s.delay ?? 150; 
    return selectionDelay
  }

  async function getBackendURL() {
    const s = await chrome.storage.local.get(["backendIp", "backendPort"]);
    const ip = s.backendIp || "127.0.0.1";
    const port = s.backendPort || "5555";
    return `http://${ip}:${port}/tts`;
  }

  function attach() {
    document.addEventListener("selectionchange", onSelectionChange);
    document.addEventListener("click", onImageClick);
    console.log("[WAI] Enabled.");
  }

  function detach() {
    document.removeEventListener("selectionchange", onSelectionChange);
    document.removeEventListener("click", onImageClick);
    console.log("[WAI] Disabled.");
  }

  async function sendToBackend(payload) {
    if (!enabled) return; // ⛔ PREVENT TTS WHEN DISABLED

    try {
      const myurl = await getBackendURL();
      const res = await fetch(myurl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) return;

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const settings = await chrome.storage.local.get(["volume", "speed"]);

      const audio = new Audio(url);
      audio.volume = (settings.volume ?? 100) / 100;
      audio.playbackRate = settings.speed ?? 1;
      audio.play();

    } catch (err) {
      console.warn("Backend error:", err);
    }
  }

  function isImageLike(el) {
    if (!el) return false;
    const tag = el.tagName?.toLowerCase();
    if (["img", "svg", "canvas"].includes(tag)) return true;

    const bg = window.getComputedStyle(el).backgroundImage;
    return bg && bg !== "none";
  }

  function getImageUrl(el) {
    if (!el) return null;

    const tag = el.tagName?.toLowerCase();
    if (tag === "img") return el.currentSrc || el.src;

    const bg = window.getComputedStyle(el).backgroundImage;
    if (bg && bg !== "none") {
      const match = bg.match(/url\((['"]?)(.*?)\1\)/);
      if (match) return match[2];
    }

    return null;
  }

  async function onSelectionChange() {
    if (!enabled) return;

    const settings = await chrome.storage.local.get(["readSelect"]);
    var SELECTION_DEBOUNCE_MS = await loadDelaySettings()
    if (!settings.readSelect) return; 

    if (selectionTimer) clearTimeout(selectionTimer);

    selectionTimer = setTimeout(() => {
      const text = window.getSelection().toString().trim();
      if (text.length > 0) {
        sendToBackend({ type: "text", text });
      }
    }, SELECTION_DEBOUNCE_MS);
  }

  async function onImageClick(e) {
    if (!enabled) return;

    const settings = await chrome.storage.local.get(["imageDesc"]);
    if (!settings.imageDesc) return; // ❌ image description disabled

    const element = e.target;
    if (isImageLike(element)) {
      const imgUrl = getImageUrl(element);
      if (imgUrl) {
        sendToBackend({ type: "image", imageUrl: imgUrl });
      }
    }
  }

  // ////////////////////////////
  // Handle toggle state from background
  // ////////////////////////////
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "STATE_SET") {
      enabled = msg.enabled;

      if (enabled) attach();
      else detach();
    }
  });

  // ////////////////////////////
  // INITIAL LOAD: check storage
  // ////////////////////////////

  chrome.storage.local.get("wai:enabled", (data) => {
    enabled = !!data["wai:enabled"];
    if (enabled) attach();
  });
})();
