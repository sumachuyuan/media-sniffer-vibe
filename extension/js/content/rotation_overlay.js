/**
 * Media Sniffer - Rotation Overlay (Content Script)
 * Injected via chrome.scripting.executeScript into YouTube/Bilibili pages.
 * Self-toggles: second injection removes overlay and restores state.
 * Uses DOM API only (no innerHTML) for YouTube Trusted Types CSP compatibility.
 */
(function () {
  const OVERLAY_ID = 'ms-rotation-overlay';
  const STYLE_ID = 'ms-rotation-styles';
  const FLAG_KEY = '__msRotationActive';

  // ── Shared teardown: clean up everything and restore page state ──
  function teardown() {
    // 1. Restore video original CSS properties
    if (window.__msRotationVideo) {
      window.__msRotationVideo.style.transform = window.__msRotationSavedTransform || '';
      window.__msRotationVideo.style.transformOrigin = window.__msRotationSavedTransformOrigin || '';
      window.__msRotationVideo.style.transition = window.__msRotationSavedTransition || '';
      window.__msRotationVideo = null;
      window.__msRotationSavedTransform = undefined;
      window.__msRotationSavedTransformOrigin = undefined;
      window.__msRotationSavedTransition = undefined;
    }

    // 2. Remove any active drag listeners on document
    if (_dragOnMove) {
      document.removeEventListener('mousemove', _dragOnMove);
      _dragOnMove = null;
    }
    if (_dragOnUp) {
      document.removeEventListener('mouseup', _dragOnUp);
      _dragOnUp = null;
    }

    // 3. Remove overlay DOM element
    const existing = document.getElementById(OVERLAY_ID);
    if (existing) existing.remove();

    // 4. Remove style element
    const styleEl = document.getElementById(STYLE_ID);
    if (styleEl) styleEl.remove();

    // 5. Reset flag
    window[FLAG_KEY] = false;
  }

  // ── Toggle: remove if already active ──
  if (window[FLAG_KEY]) {
    teardown();
    return;
  }

  // ── Inject stylesheet once ──
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #${OVERLAY_ID} {
        position: fixed; bottom: 24px; right: 24px; z-index: 99999;
        display: flex; align-items: center; gap: 6px;
        padding: 8px 12px;
        background: rgba(0,0,0,0.75); backdrop-filter: blur(8px);
        border: 1px solid rgba(255,215,0,0.4); border-radius: 10px;
        font-family: -apple-system, sans-serif;
        user-select: none; cursor: grab;
      }
      #${OVERLAY_ID}:active { cursor: grabbing; }
      #${OVERLAY_ID}:hover { box-shadow: 0 0 20px rgba(255,215,0,0.15); }
      #${OVERLAY_ID} .ms-rot-btn {
        background: transparent; color: #FFD700;
        border: 1px solid rgba(184,134,11,0.5); border-radius: 6px;
        width: 36px; height: 32px;
        font-size: 16px; font-weight: 700;
        cursor: pointer; display: flex;
        align-items: center; justify-content: center;
        line-height: 1; padding: 0;
      }
      #${OVERLAY_ID} .ms-rot-btn:hover {
        background: rgba(255,215,0,0.2); border-color: #FFD700;
      }
      #${OVERLAY_ID} .ms-rot-btn:disabled {
        opacity: 0.3; pointer-events: none;
        border-color: rgba(184,134,11,0.2);
      }
      #${OVERLAY_ID} .ms-rot-reset { font-size: 12px; width: 32px; }
      #${OVERLAY_ID} .ms-rot-reset.disabled {
        opacity: 0.3; pointer-events: none;
        border-color: rgba(184,134,11,0.2);
      }
      #${OVERLAY_ID} .ms-rot-close {
        background: transparent; color: rgba(255,255,255,0.5);
        border: 1px solid rgba(255,255,255,0.15); border-radius: 6px;
        width: 28px; height: 28px;
        font-size: 14px; cursor: pointer; display: flex;
        align-items: center; justify-content: center;
        line-height: 1; padding: 0; margin-left: 4px;
      }
      #${OVERLAY_ID} .ms-rot-close:hover {
        color: #fff; border-color: rgba(255,255,255,0.4);
        background: rgba(255,255,255,0.1);
      }
      #${OVERLAY_ID} .ms-angle {
        color: rgba(255,215,0,0.7); font-size: 11px; font-weight: 700;
        min-width: 28px; text-align: center;
      }
      #${OVERLAY_ID} .ms-hint {
        color: rgba(255,255,255,0.5); font-size: 11px; padding: 0 4px;
      }
    `;
    document.head.appendChild(style);
  }

  // ── Helper: create element with class and attributes ──
  function el(tag, cls, attrs, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (attrs) Object.entries(attrs).forEach(([k, v]) => e.setAttribute(k, v));
    if (text) e.textContent = text;
    return e;
  }

  // ── Find the largest visible video element ──
  function findLargestVideo() {
    const videos = [...document.querySelectorAll('video')];
    const scored = videos.map(v => ({
      el: v,
      area: (v.videoWidth && v.videoHeight)
        ? v.videoWidth * v.videoHeight
        : v.offsetWidth * v.offsetHeight
    }));
    const candidates = scored.filter(s => s.area > 0).sort((a, b) => b.area - a.area);
    return candidates[0]?.el || null;
  }

  const video = findLargestVideo();

  // ── Save original video CSS properties BEFORE modifying ──
  if (video) {
    window.__msRotationSavedTransform = video.style.transform;
    window.__msRotationSavedTransformOrigin = video.style.transformOrigin;
    window.__msRotationSavedTransition = video.style.transition;

    video.style.transformOrigin = 'center center';
    video.style.transition = 'transform 0.3s ease';
    window.__msRotationVideo = video;
  }

  let angle = 0;
  let _dragOnMove = null;
  let _dragOnUp = null;
  let updateDisplay = () => { };

  function apply(deg) {
    if (!video) return;
    angle = deg;
    video.style.transform = angle === 0 ? '' : `rotate(${angle}deg)`;
    updateDisplay();
  }

  function rotateLeft()  { apply((angle - 90 + 360) % 360); }
  function rotateRight() { apply((angle + 90) % 360); }
  function reset()       { apply(0); }

  // ── Floating overlay UI (DOM API only, no innerHTML) ──
  function createOverlay(hasVideo) {
    const container = el('div', null, { id: OVERLAY_ID });

    const leftBtn = el('button', 'ms-rot-btn', { id: 'ms-rot-left', title: '左旋90°' }, '↺');
    const angleEl = el('span', 'ms-angle', { id: 'ms-angle' }, '0°');
    const rightBtn = el('button', 'ms-rot-btn', { id: 'ms-rot-right', title: '右旋90°' }, '↻');
    const resetBtn = el('button', 'ms-rot-btn ms-rot-reset disabled', { id: 'ms-rot-reset', title: '重置' }, '⟲');
    const closeBtn = el('button', 'ms-rot-close', { id: 'ms-rot-close', title: '关闭翻转' }, '✕');

    container.appendChild(leftBtn);
    container.appendChild(angleEl);
    container.appendChild(rightBtn);
    container.appendChild(resetBtn);
    container.appendChild(closeBtn);

    if (!hasVideo) {
      container.appendChild(el('span', 'ms-hint', null, '未检测到视频'));
      // Disable all rotation buttons when no video
      leftBtn.disabled = true;
      rightBtn.disabled = true;
      resetBtn.disabled = true;
    }

    document.body.appendChild(container);

    updateDisplay = function () {
      angleEl.textContent = angle + '°';
      if (angle === 0) {
        resetBtn.classList.add('disabled');
      } else {
        resetBtn.classList.remove('disabled');
      }
    };

    leftBtn.addEventListener('click', rotateLeft);
    rightBtn.addEventListener('click', rotateRight);
    resetBtn.addEventListener('click', reset);
    closeBtn.addEventListener('click', teardown);

    // ── Drag support (listeners added on mousedown, removed on mouseup) ──

    container.addEventListener('mousedown', function (e) {
      if (e.target.tagName === 'BUTTON') return;

      const rect = container.getBoundingClientRect();
      const startLeft = rect.left;
      const startTop = rect.top;
      const startX = e.clientX;
      const startY = e.clientY;

      // Switch from right/bottom to left/top positioning for drag
      container.style.right = 'auto';
      container.style.bottom = 'auto';
      container.style.left = startLeft + 'px';
      container.style.top = startTop + 'px';
      e.preventDefault();

      _dragOnMove = function (e) {
        container.style.left = (startLeft + e.clientX - startX) + 'px';
        container.style.top = (startTop + e.clientY - startY) + 'px';
      };

      _dragOnUp = function () {
        document.removeEventListener('mousemove', _dragOnMove);
        document.removeEventListener('mouseup', _dragOnUp);
        _dragOnMove = null;
        _dragOnUp = null;
      };

      document.addEventListener('mousemove', _dragOnMove);
      document.addEventListener('mouseup', _dragOnUp, { once: true });
    });
  }

  createOverlay(!!video);
  window[FLAG_KEY] = true;

  // Default rotation: immediately rotate 90° right on first inject
  if (video) {
    rotateRight();
  }
})();
