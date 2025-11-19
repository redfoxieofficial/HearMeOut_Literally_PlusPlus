document.addEventListener('DOMContentLoaded', async () => {
  const toggle = document.getElementById('toggle');
  const statusText = document.getElementById('statusText');
  const testRead = document.getElementById('testRead');
  const STORAGE_KEY = 'wai:enabled';

  const { [STORAGE_KEY]: enabled } = await chrome.storage.local.get(STORAGE_KEY);
  updateUI(!!enabled);

  function updateUI(isEnabled) {
    toggle.classList.toggle('active', isEnabled);
    statusText.textContent = isEnabled ? 'Accessibility is active' : 'Accessibility is off';
  }

  async function setEnabled(next) {
    await chrome.storage.local.set({ [STORAGE_KEY]: next });
    updateUI(next);
    chrome.runtime.sendMessage({ type: 'STATE_SET', enabled: next });
  }

  toggle.addEventListener('click', async () => {
    const { [STORAGE_KEY]: current } = await chrome.storage.local.get(STORAGE_KEY);
    setEnabled(!current);
  });

  testRead.addEventListener('click', () => {
    chrome.runtime.sendMessage({
      type: 'ANNOUNCE',
      text: 'Hello! Your accessibility assistant is active.'
    });
  });

  document.getElementById('openHelp').addEventListener('click', () => {
    alert(
      'Keyboard shortcuts:\n\n' +
      'Alt + A → Toggle Assistant\n' +
      'Space → Pause/Resume speech\n' +
      'Escape → Stop narration\n' +
      'Arrow Down/Up → Navigate elements'
    );
  });
});
