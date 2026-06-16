document.addEventListener('DOMContentLoaded', () => {
    const video = document.getElementById('video-player');
    const titleEl = document.getElementById('video-title');
    const statusEl = document.getElementById('video-status');
    const errorEl = document.getElementById('error-msg');

    // 从 URL 参数获取数据
    const params = new URLSearchParams(window.location.search);
    const mediaUrl = params.get('url');
    const title = params.get('title') || 'Untitled Stream';
    const autoSnapshot = params.get('autoSnapshot') === '1';
    const referer = params.get('referer') || '';

    if (!mediaUrl) {
        statusEl.textContent = 'ERROR: No URL provided';
        return;
    }

    titleEl.textContent = title;

    // 注入 DNR Referer 规则以穿越广告 CDN 鉴权
    function loadMedia() {
        if (mediaUrl.includes('.m3u8')) {
            loadHLS(mediaUrl);
        } else if (mediaUrl.includes('.mpd')) {
            loadDASH(mediaUrl);
        } else {
            loadDirect(mediaUrl);
        }
    }

    // 页面关闭时主动清除 DNR 规则
    window.addEventListener('beforeunload', () => {
        chrome.runtime.sendMessage({ type: 'CLEAR_DNR_RULES' }).catch(() => {});
    });

    if (referer && chrome?.runtime?.sendMessage) {
        chrome.runtime.sendMessage({
            type: 'UPDATE_DNR_FOR_PREVIEW',
            referer: referer,
            ua: navigator.userAgent,
            url: mediaUrl
        }, () => loadMedia());
    } else {
        loadMedia();
    }

    if (autoSnapshot) {
        video.addEventListener('loadeddata', () => {
            // 给一点点缓冲时间确保首帧渲染完成
            setTimeout(takeSnapshot, 1000);
        }, { once: true });
    }

    function loadHLS(url) {
        statusEl.textContent = 'PROTOCOL: HLS (M3U8)';
        if (Hls.isSupported()) {
            const hls = new Hls({
                enableWorker: true,
                lowLatencyMode: true,
                xhrSetup: function (xhr, url) {
                    // 这里可以注入某些 headers (但 fetch 请求的 headers 在这里不好注入)
                }
            });
            hls.loadSource(url);
            hls.attachMedia(video);
            hls.on(Hls.Events.MANIFEST_PARSED, () => video.play());
            hls.on(Hls.Events.ERROR, (event, data) => {
                if (data.fatal) {
                    showError('HLS Playback Error: ' + data.type);
                }
            });
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
            // 原生支持 (如 Safari)
            video.src = url;
            video.addEventListener('loadedmetadata', () => video.play());
        } else {
            showError('HLS not supported in this browser.');
        }
    }

    function loadDASH(url) {
        statusEl.textContent = 'PROTOCOL: DASH (MPD)';
        try {
            const player = dashjs.MediaPlayer().create();
            player.initialize(video, url, true);
            player.on('error', (e) => showError('DASH Error: ' + e.error));
        } catch (e) {
            showError('DASH initialization failed.');
        }
    }

    function loadDirect(url) {
        statusEl.textContent = 'PROTOCOL: DIRECT (MP4/WEBM)';
        video.src = url;
        video.play().catch(e => {
            showError('Direct Playback Failed: Please ensure CORS headers allow this.');
        });
    }

    function showError(msg) {
        console.error(msg);
        errorEl.textContent = msg;
        errorEl.style.display = 'block';
        statusEl.style.color = '#ff4444';
        statusEl.textContent = 'PLAYBACK FAILED';
    }

    // --- Rotation Functionality ---
    const container = document.getElementById('player-container');
    const rotateLeftBtn = document.getElementById('rotate-left');
    const rotateRightBtn = document.getElementById('rotate-right');
    const resetRotationBtn = document.getElementById('reset-rotation');
    const angleDisplay = document.getElementById('angle-display');
    const rotationGroup = document.getElementById('rotation-group');

    let currentRotation = 0;

    function applyRotation() {
        video.style.transform = `rotate(${currentRotation}deg)`;
        if (currentRotation === 90 || currentRotation === 270) {
            container.style.aspectRatio = '9 / 16';
        } else {
            container.style.aspectRatio = '16 / 9';
        }
        angleDisplay.textContent = currentRotation + '°';
        if (currentRotation === 0) {
            resetRotationBtn.classList.add('disabled');
        } else {
            resetRotationBtn.classList.remove('disabled');
        }
    }

    rotateLeftBtn.addEventListener('click', () => {
        currentRotation = (currentRotation - 90 + 360) % 360;
        applyRotation();
    });

    rotateRightBtn.addEventListener('click', () => {
        currentRotation = (currentRotation + 90) % 360;
        applyRotation();
    });

    resetRotationBtn.addEventListener('click', () => {
        if (currentRotation === 0) return;
        currentRotation = 0;
        applyRotation();
    });

    // --- Close button ---
    const closeBtn = document.getElementById('close-btn');
    if (closeBtn) {
        closeBtn.addEventListener('click', () => {
            window.close();
            // If close() is blocked (not opened by script), page will still be visible
            setTimeout(() => {
                document.body.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100vh;color:#FFD700;font-family:sans-serif;font-size:18px;">请手动关闭此标签页 (Ctrl+W / ⌘+W)</div>';
            }, 500);
        });
    }

    // --- Snapshot Functionality ---
    const snapshotBtn = document.getElementById('snapshot-btn');

    // Hide snapshot and rotation for audio
    const mediaType = params.get('mediaType');
    if (mediaType === 'audio') {
        snapshotBtn.style.display = 'none';
        rotationGroup.style.display = 'none';
    }

    snapshotBtn.addEventListener('click', takeSnapshot);

    function takeSnapshot() {
        if (!video.videoWidth || !video.videoHeight) {
            alert('视频尚未加载或无法截取');
            return;
        }

        try {
            const canvas = document.createElement('canvas');
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            const fileName = `${title.replace(/[/\\?%*:|"<>]/g, '-')}_Snapshot_${timestamp}.png`;

            canvas.toBlob((blob) => {
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = fileName;
                a.click();
                URL.revokeObjectURL(url);
                console.log(`Snapshot saved: ${fileName}`);
            }, 'image/png');
        } catch (e) {
            console.error('Snapshot failed', e);
            alert('快照失败：可能是由于跨域(CORS)限制，暂时无法直接截取该站点的视频帧。');
        }
    }
});
