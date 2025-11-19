document.addEventListener("DOMContentLoaded", async () => {
  const settings = await chrome.storage.local.get([
    "volume",
    "readSelect",
    "imageDesc",
    "speed",
    "delay",
    "backendIp",
    "backendPort"
  ]);

  function setValue(id, value) {
    const el = document.getElementById(id);
    if (el) el.value = value;
  }
  function setChecked(id, value) {
    const el = document.getElementById(id);
    if (el) el.checked = value;
  }

  // Fill UI with saved values or defaults
  setValue("volume", settings.volume ?? 100);
  setChecked("readSelect", settings.readSelect ?? true);
  setChecked("imageDesc", settings.imageDesc ?? true);
  setValue("speed", settings.speed ?? 1);
  setValue("delay", settings.delay ?? 150);
  setValue("backendIp", settings.backendIp ?? "127.0.0.1");
  setValue("backendPort", settings.backendPort ?? "5555");

  function save(key, value) {
    chrome.storage.local.set({ [key]: value });
  }

  document.getElementById("volume").addEventListener("input", e => save("volume", Number(e.target.value)));
  document.getElementById("readSelect").addEventListener("change", e => save("readSelect", e.target.checked));
  document.getElementById("imageDesc").addEventListener("change", e => save("imageDesc", e.target.checked));
  document.getElementById("speed").addEventListener("change", e => save("speed", Number(e.target.value)));
  document.getElementById("delay").addEventListener("change", e => save("delay", Number(e.target.value)));
  document.getElementById("backendIp").addEventListener("input", e => save("backendIp", e.target.value.trim()));
  document.getElementById("backendPort").addEventListener("input", e => save("backendPort", e.target.value.trim()));

  document.getElementById("reset").addEventListener("click", () => {
    chrome.storage.local.set({
      volume: 100,
      readSelect: true,
      imageDesc: true,
      speed: 1,
      delay: 150,
      backendIp: "127.0.0.1",
      backendPort: "5555"
    }, () => {
      location.reload();
    });
  });
});
