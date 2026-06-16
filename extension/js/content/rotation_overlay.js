/**
 * Media Sniffer - Rotation Overlay (Content Script)
 * Injected via chrome.scripting.executeScript into YouTube/Bilibili pages.
 * Self-toggles: second injection removes overlay and restores state.
 */
(function () {
  const OVERLAY_ID = 'ms-rotation-overlay';
  const FLAG_KEY = '__msRotationActive';

  // ── Toggle: remove if already active ──
  if (window[FLAG_KEY]) {
    const existing = document.getElementById(OVERLAY_ID);
    if (existing) existing.remove();
    if (window.__msRotationVideo) {
      window.__msRotationVideo.style.transform = '';
      window.__msRotationVideo = null;
    }
    window[FLAG_KEY] = false;
    return;
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
  if (!video) {
    window[FLAG_KEY] = true;
    createOverlay(null);
    return;
  }

  // ── Setup video transform ──
  video.style.transformOrigin = 'center center';
  video.style.transition = 'transform 0.3s ease';
  window.__msRotationVideo = video;

  let angle = 0;
  let updateDisplay = () => {}; // Set by createOverlay after DOM is built

  function apply(deg) {
    angle = deg;
    video.style.transform = angle === 0 ? '' : `rotate(${angle}deg)`;
    updateDisplay();
  }

  function rotateLeft()  { apply((angle - 90 + 360) % 360); }
  function rotateRight() { apply((angle + 90) % 360); }
  function reset()       { apply(0); }

  // ── Floating overlay UI ──
  function createOverlay(_video) {
    const container = document.createElement('div');
    container.id = OVERLAY_ID;
    container.innerHTML = `
      <style>
        #${OVERLAY_ID} {
          position: fixed;
          bottom: 24px;
          right: 24px;
          z-index: 99999;
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 8px 12px;
          background: rgba(0, 0, 0, 0.75);
          backdrop-filter: blur(8px);
          border: 1px solid rgba(255, 215, 0, 0.4);
          border-radius: 10px;
          font-family: -apple-system, sans-serif;
          user-select: none;
          cursor: grab;
          transition: box-shadow 0.2s;
        }
        #${OVERLAY_ID}:active { cursor: grabbing; }
        #${OVERLAY_ID}:hover {
          box-shadow: 0 0 20px rgba(255, 215, 0, 0.15);
        }
        #${OVERLAY_ID} .ms-rot-btn {
          background: transparent;
          color: #FFD700;
          border: 1px solid rgba(184, 134, 11, 0.5);
          border-radius: 6px;
          width: 36px;
          height: 32px;
          font-size: 16px;
          font-weight: 700;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: all 0.15s;
          line-height: 1;
          padding: 0;
        }
        #${OVERLAY_ID} .ms-rot-btn:hover {
          background: rgba(255, 215, 0, 0.2);
          border-color: #FFD700;
        }
        #${OVERLAY_ID} .ms-rot-reset {
          font-size: 12px;
          width: 32px;
        }
        #${OVERLAY_ID} .ms-rot-reset.disabled {
          opacity: 0.3;
          pointer-events: none;
          border-color: rgba(184, 134, 11, 0.2);
        }
        #${OVERLAY_ID} .ms-angle {
          color: rgba(255, 215, 0, 0.7);
          font-size: 11px;
          font-weight: 700;
          min-width: 28px;
          text-align: center;
        }
        #${OVERLAY_ID} .ms-hint {
          color: rgba(255, 255, 255, 0.5);
          font-size: 11px;
          padding: 0 4px;
        }
      </style>
      <button class="ms-rot-btn" id="ms-rot-left" title="左旋90°">↺</button>
      <span class="ms-angle" id="ms-angle">0°</span>
      <button class="ms-rot-btn" id="ms-rot-right" title="右旋90°">↻</button>
      <button class="ms-rot-btn ms-rot-reset disabled" id="ms-rot-reset" title="重置">⟲</button>
      ${!_video ? '<span class="ms-hint">未检测到视频</span>' : ''}
    `;
    document.body.appendChild(container);

    const angleEl = container.querySelector('#ms-angle');
    const resetBtn = container.querySelector('#ms-rot-reset');

    updateDisplay = function() {
      angleEl.textContent = angle + '°';
      if (angle === 0) {
        resetBtn.classList.add('disabled');
      } else {
        resetBtn.classList.remove('disabled');
      }
    };

    container.querySelector('#ms-rot-left').addEventListener('click', rotateLeft);
    container.querySelector('#ms-rot-right').addEventListener('click', rotateRight);
    resetBtn.addEventListener('click', reset);

    // ── Drag support ──
    let dragging = false, startX, startY, startLeft, startTop;
    container.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = container.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;
      container.style.right = 'auto';
      container.style.bottom = 'auto';
      container.style.left = startLeft + 'px';
      container.style.top = startTop + 'px';
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      container.style.left = (startLeft + e.clientX - startX) + 'px';
      container.style.top = (startTop + e.clientY - startY) + 'px';
    });
    document.addEventListener('mouseup', () => { dragging = false; });
  }

  createOverlay(video);
  window[FLAG_KEY] = true;
})();
