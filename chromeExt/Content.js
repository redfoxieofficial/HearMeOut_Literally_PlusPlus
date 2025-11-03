// content.js — Web Accessibility Extension (Task 3)
// Project: Web Accessibility Extension for Visually Impaired Users
// Teams: Aiden Ricksen, Imad-eddine El Bakiouli, Cagan Kilinc, Youri Krijgsman, Helin Ökmen, Buse Duygun
//
// Responsibilities in this file (per SRS):
// - UR-1/UR-2: Narrate text under cursor, describe images on hover (FR-1, FR-2, FR-3)
// - UR-3/FR-5: Sequential navigation & focus indicator; auto-narrate focus changes
// - UR-6/FR-4: Playback controls via keyboard (Space/Escape/Right Arrow)
// - FR-6: Toggle on/off via Alt+A, announce state changes
// - NFR-6/7: Fallback to native Web Speech API when VITS/Caption model unavailable/offline
//
// Notes:
// - Heavy ML (VITS TTS, BLIP/GIT captioning) should run in the background service worker or a native host.
// - This content script sends messages and implements a local SpeechSynthesis fallback if background replies fail/timeout.
// - Keep this file page-agnostic and fast: avoid layout trashing; use debounced hover + rAF coalescing.
//
// Minimal protocol with background:
//   {type: 'TTS_SPEAK', text, lang?, voice?, rate?, pitch?}
//   {type: 'TTS_CTRL', action: 'pause'|'resume'|'stop'|'skip'}
//   {type: 'CAPTION_REQUEST', imageUrl, alt?, ariaLabel?} -> {ok, text} response
//   {type: 'ANNOUNCE', text} quick one-shot
//   {type: 'STATE_GET'|'STATE_SET', enabled?: boolean}

(() => {
  // ---------- Config ----------
  const HOVER_DEBOUNCE_MS = 100;       // FR-2
  const SPEAK_THRESHOLD_CHARS = 6;     // Ignore super-short noise text
  const SPEAK_MAX_CHARS = 600;         // Keep narration snappy; long content will be trimmed
  const BACKGROUND_TIMEOUT_MS = 800;   // Quick fallback to ensure NFR-1 responsiveness
  const FOCUS_RING_ID = '__wai_focus_ring__';
  const STYLE_ID = '__wai_styles__';
  const STORAGE_KEY = 'wai:enabled';
  const NAV_ATTR = 'data-wai-nav-index';

  // Keyboard mapping (FR-4, FR-6, FR-5)
  const KEY = {
    SPACE: ' ',
    ESC: 'Escape',
    RIGHT: 'ArrowRight',
    LEFT: 'ArrowLeft',
    UP: 'ArrowUp',
    DOWN: 'ArrowDown',
    TOGGLE_MOD: 'Alt',       // Alt + A toggle
    TOGGLE_KEY: 'a'
  };

  // ---------- State ----------
  let enabled = true;                // FR-6 default ON; synced from storage
  let lastTarget = null;
  let lastHoverTs = 0;
  let hoverTimer = null;
  let pendingSpeakAbort = null;
  let navList = [];
  let navPos = -1;
  let usingFallback = false;

  // ---------- Utilities ----------
  function now() { return performance.now(); }

  function clampText(s, max = SPEAK_MAX_CHARS) {
    if (!s) return '';
    s = s.replace(/\s+/g, ' ').trim();
    if (s.length > max) s = s.slice(0, max) + '…';
    return s;
  }

  function isVisible(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function isTextual(el) {
    if (!el) return false;
    const tag = el.tagName?.toLowerCase();
    return ['p','span','a','li','button','label','td','th','h1','h2','h3','h4','h5','h6','div'].includes(tag);
  }

  function bestTextFor(el) {
    if (!el) return '';
    // Prefer ARIA labels/titles for controls
    const aria = el.getAttribute?.('aria-label');
    if (aria && aria.trim().length >= SPEAK_THRESHOLD_CHARS) return aria;

    const title = el.getAttribute?.('title');
    if (title && title.trim().length >= SPEAK_THRESHOLD_CHARS) return title;

    // For inputs/buttons
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.tagName === 'BUTTON') {
      const alt = el.getAttribute('alt');
      if (alt) return alt;
      const val = el.value;
      if (val && typeof val === 'string' && val.trim()) return val;
      const text = el.innerText || el.textContent || '';
      return text.trim();
    }

    // General textual content
    let text = (el.innerText || el.textContent || '').trim();
    if (!text && el.alt) text = el.alt;
    return text;
  }

  function isImageLike(el) {
    if (!el) return false;
    const tag = el.tagName?.toLowerCase();
    if (tag === 'img' || tag === 'svg' || tag === 'canvas' || tag === 'picture' || tag === 'video') return true;
    // background-image or role="img"
    const role = el.getAttribute?.('role');
    const hasBg = window.getComputedStyle(el).backgroundImage !== 'none';
    return role === 'img' || hasBg;
  }

  function getImageUrl(el) {
    if (!el) return null;
    const tag = el.tagName?.toLowerCase();
    if (tag === 'img' && el.src) return el.currentSrc || el.src;
    if (tag === 'video' && el.poster) return el.poster;
    const bg = window.getComputedStyle(el).backgroundImage;
    if (bg && bg !== 'none') {
      const m = bg.match(/url\((['"]?)(.*?)\1\)/);
      if (m && m[2]) return m[2];
    }
    // SVG/canvas fallback: serialize to data URL if possible (best-effort)
    if (tag === 'svg') {
      try {
        const s = new XMLSerializer().serializeToString(el);
        return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(s);
      } catch {}
    }
    if (tag === 'canvas') {
      try { return el.toDataURL('image/png'); } catch {}
    }
    return null;
  }

  function announceLocal(text) {
    // Very short one-shot confirmation with SpeechSynthesis if background is busy.
    try {
      if (!('speechSynthesis' in window)) return;
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1.0; u.pitch = 1.0;
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(u);
      usingFallback = true;
    } catch {}
  }

  function bgMessage(msg, timeout = BACKGROUND_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      let done = false;
      const tid = setTimeout(() => {
        if (!done) {
          done = true;
          reject(new Error('bg_timeout'));
        }
      }, timeout);
      try {
        chrome.runtime.sendMessage(msg, (resp) => {
          if (done) return;
          clearTimeout(tid);
          done = true;
          // If lastError, treat as failure to trigger fallback
          if (chrome.runtime.lastError) {
            reject(chrome.runtime.lastError);
          } else {
            resolve(resp);
          }
        });
      } catch (e) {
        clearTimeout(tid);
        reject(e);
      }
    });
  }

  async function speak(text, opts = {}) {
    // Try background (VITS) first; fallback to speechSynthesis (NFR-6)
    const clipped = clampText(text);
    if (!clipped || clipped.length < SPEAK_THRESHOLD_CHARS) return;

    // Abort any in-flight local fallback speech
    if (pendingSpeakAbort) { pendingSpeakAbort(); pendingSpeakAbort = null; }

    try {
      const resp = await bgMessage({ type: 'TTS_SPEAK', text: clipped, ...opts });
      if (!(resp && resp.ok)) throw new Error('bg_tts_failed');
      usingFallback = false;
    } catch {
      // Fallback
      if ('speechSynthesis' in window) {
        window.speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(clipped);
        u.rate = 1.0; u.pitch = 1.0;
        window.speechSynthesis.speak(u);
        usingFallback = true;
        // Provide abort handle for "skip" control
        pendingSpeakAbort = () => {
          window.speechSynthesis.cancel();
        };
      }
    }
  }

  async function captionAndSpeak(el) {
    const alt = el.getAttribute?.('alt') || '';
    const aria = el.getAttribute?.('aria-label') || '';
    const imgUrl = getImageUrl(el);

    // Prefer alt/aria immediately (NFR-2 fast path)
    const immediate = (aria || alt).trim();
    if (immediate) {
      await speak(immediate);
      return;
    }

    // Ask background captioner (BLIP/GIT); fallback chain
    try {
      const resp = await bgMessage({ type: 'CAPTION_REQUEST', imageUrl: imgUrl, alt, ariaLabel: aria });
      if (resp && resp.ok && resp.text) {
        await speak(resp.text);
        return;
      }
    } catch {}

    // Last resort
    const generic = alt || aria || 'Image';
    await speak(generic);
  }

  // ---------- Hover handling (FR-2) ----------
  function scheduleHoverNarration(target) {
    if (!enabled) return;
    if (!target) return;
    const t = now();

    // Ignore super-fast re-entries within 100ms
    if (lastTarget === target && (t - lastHoverTs) < HOVER_DEBOUNCE_MS) return;

    lastTarget = target;
    lastHoverTs = t;

    if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
    hoverTimer = setTimeout(async () => {
      if (!enabled || !isVisible(target)) return;

      if (isImageLike(target)) {
        await captionAndSpeak(target);
      } else if (isTextual(target)) {
        const text = bestTextFor(target);
        if (text && text.length >= SPEAK_THRESHOLD_CHARS) {
          await speak(text);
        }
      } else {
        // Try nearest textual ancestor
        const parent = target.closest?.('button, a, [role="button"], [role="link"], p, h1,h2,h3,h4,h5,h6, li, label, [aria-label]');
        if (parent) {
          if (isImageLike(parent)) return captionAndSpeak(parent);
          const text = bestTextFor(parent);
          if (text && text.length >= SPEAK_THRESHOLD_CHARS) return speak(text);
        }
      }
    }, HOVER_DEBOUNCE_MS);
  }

  // Use mousemove + rAF to coalesce pointer updates
  let rAFScheduled = false;
  function onMouseMove(e) {
    if (!enabled) return;
    if (rAFScheduled) return;
    rAFScheduled = true;
    requestAnimationFrame(() => {
      rAFScheduled = false;
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (el) scheduleHoverNarration(el);
    });
  }

  // ---------- Keyboard controls (FR-4, FR-6, FR-5) ----------
  function onKeyDown(e) {
    if (!enabled && !(e.altKey && e.key.toLowerCase() === KEY.TOGGLE_KEY)) return;

    // Toggle (Alt+A)
    if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.key.toLowerCase() === KEY.TOGGLE_KEY) {
      enabled = !enabled;
      chrome.storage?.local?.set({ [STORAGE_KEY]: enabled });
      if (enabled) {
        announce('Accessibility on');
      } else {
        announce('Accessibility off');
      }
      e.preventDefault();
      return;
    }

    // Playback controls when enabled
    if (e.key === KEY.SPACE) {
      e.preventDefault();
      bgMessage({ type: 'TTS_CTRL', action: 'pause' }).catch(() => {
        // Local fallback pause/resume
        if ('speechSynthesis' in window) {
          if (window.speechSynthesis.speaking && !window.speechSynthesis.paused) {
            window.speechSynthesis.pause();
            announceLocal('Paused');
          } else if (window.speechSynthesis.paused) {
            window.speechSynthesis.resume();
            announceLocal('Resumed');
          }
        }
      });
      return;
    }

    if (e.key === KEY.ESC) {
      e.preventDefault();
      bgMessage({ type: 'TTS_CTRL', action: 'stop' }).catch(() => {
        if ('speechSynthesis' in window) {
          window.speechSynthesis.cancel();
          announceLocal('Stopped');
        }
      });
      return;
    }

    if (e.key === KEY.RIGHT) {
      e.preventDefault();
      bgMessage({ type: 'TTS_CTRL', action: 'skip' }).catch(() => {
        if (pendingSpeakAbort) { pendingSpeakAbort(); pendingSpeakAbort = null; announceLocal('Skipped'); }
        else if ('speechSynthesis' in window) { window.speechSynthesis.cancel(); announceLocal('Skipped'); }
      });
      return;
    }

    // Sequential navigation (FR-5): Arrow keys navigate our ordered list.
    // We won’t hijack Tab behavior; instead ArrowUp/ArrowDown move through list.
    if ([KEY.UP, KEY.DOWN, KEY.LEFT, KEY.RIGHT].includes(e.key)) {
      // Left/Right also mapped to skip above; DOWN/UP for navigation primary
      if (e.key === KEY.DOWN || e.key === KEY.UP) {
        e.preventDefault();
        const dir = e.key === KEY.DOWN ? 1 : -1;
        moveSequential(dir);
      }
    }
  }

  function announce(text) {
    // Try background announce; fallback local
    bgMessage({ type: 'ANNOUNCE', text }).catch(() => announceLocal(text));
  }

  // ---------- Sequential Navigation (FR-5) ----------
  function buildNavList() {
    // Collect headings, paragraphs, links, buttons, inputs, images
    const sel = [
      'h1','h2','h3','h4','h5','h6',
      'p','li',
      'a','button','[role="button"]','[role="link"]',
      'input','textarea','select',
      'img','svg','canvas','picture','video',
      '[tabindex]:not([tabindex="-1"])',
      '[aria-label]'
    ].join(',');

    const nodes = Array.from(document.querySelectorAll(sel))
      .filter(isVisible);

    // Deduplicate & order by document position
    const unique = [];
    const seen = new Set();
    for (const n of nodes) {
      if (seen.has(n)) continue;
      seen.add(n); unique.push(n);
    }

    // Assign indices for debugging / focus ring sync
    unique.forEach((el, i) => el.setAttribute(NAV_ATTR, String(i)));
    navList = unique;
    navPos = -1;
  }

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #${FOCUS_RING_ID} {
        position: fixed;
        pointer-events: none;
        border: 3px solid #2b8a3e;
        border-radius: 10px;
        box-shadow: 0 0 0 4px rgba(43,138,62,0.25);
        z-index: 2147483647;
        transition: all 120ms ease-out;
      }
    `;
    document.documentElement.appendChild(style);
  }

  function getOrCreateFocusRing() {
    let ring = document.getElementById(FOCUS_RING_ID);
    if (!ring) {
      ensureStyles();
      ring = document.createElement('div');
      ring.id = FOCUS_RING_ID;
      document.body.appendChild(ring);
    }
    return ring;
  }

  function drawFocusRing(el) {
    const rect = el.getBoundingClientRect();
    const ring = getOrCreateFocusRing();
    ring.style.left = `${Math.max(0, rect.left + window.scrollX - 6)}px`;
    ring.style.top = `${Math.max(0, rect.top + window.scrollY - 6)}px`;
    ring.style.width = `${Math.max(0, rect.width + 12)}px`;
    ring.style.height = `${Math.max(0, rect.height + 12)}px`;
  }

  async function moveSequential(dir) {
    if (!navList.length) buildNavList();
    navPos += dir;
    if (navPos < 0) navPos = 0;
    if (navPos >= navList.length) navPos = navList.length - 1;

    const el = navList[navPos];
    if (!el) return;

    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    drawFocusRing(el);

    if (isImageLike(el)) {
      await captionAndSpeak(el);
    } else {
      const text = bestTextFor(el);
      if (text && text.length >= SPEAK_THRESHOLD_CHARS) await speak(text);
    }
  }

  // Narrate when native focus moves (supporting Tab navigation)
  function onFocusIn(e) {
    if (!enabled) return;
    const el = e.target;
    if (!el || !(el instanceof Element)) return;
    drawFocusRing(el);
    const text = isImageLike(el) ? null : bestTextFor(el);
    if (text && text.length >= SPEAK_THRESHOLD_CHARS) {
      speak(text);
    } else if (isImageLike(el)) {
      captionAndSpeak(el);
    }
  }

  // ---------- Init / State ----------
  async function loadEnabled() {
    try {
      const data = await chrome.storage?.local?.get(STORAGE_KEY);
      if (typeof data?.[STORAGE_KEY] === 'boolean') enabled = data[STORAGE_KEY];
    } catch {}
  }

  function attach() {
    window.addEventListener('mousemove', onMouseMove, { passive: true });
    window.addEventListener('keydown', onKeyDown, true); // capture to beat page handlers
    window.addEventListener('focusin', onFocusIn, true);
    ensureStyles();
    buildNavList();
  }

  function detach() {
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('focusin', onFocusIn, true);
    const ring = document.getElementById(FOCUS_RING_ID);
    if (ring) ring.remove();
  }

  // Listen for background state changes or toolbar toggles (FR-6)
  chrome.runtime?.onMessage?.addListener((msg, _sender, _sendResponse) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'STATE_SET') {
      enabled = !!msg.enabled;
      chrome.storage?.local?.set({ [STORAGE_KEY]: enabled });
      announce(enabled ? 'Accessibility on' : 'Accessibility off');
      if (enabled) attach(); else detach();
    }
  });

  // Boot
  (async () => {
    await loadEnabled();
    if (enabled) attach();

    // Let background know content is ready
    try { bgMessage({ type: 'CONTENT_READY' }).catch(() => {}); } catch {}
  })();

})();
