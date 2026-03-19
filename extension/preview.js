document.addEventListener('DOMContentLoaded', () => {
    const video = document.getElementById('video-player');
    const titleEl = document.getElementById('video-title');
    const statusEl = document.getElementById('video-status');
    const errorEl = document.getElementById('error-msg');

    // 从 URL 参数获取数据
    const params = new URLSearchParams(window.location.search);
    const mediaUrl = params.get('url');
    const title = params.get('title') || 'Untitled Stream';

    if (!mediaUrl) {
        statusEl.textContent = 'ERROR: No URL provided';
        return;
    }

    titleEl.textContent = title;

    // 根据后缀或内容特征判断格式
    if (mediaUrl.includes('.m3u8')) {
        loadHLS(mediaUrl);
    } else if (mediaUrl.includes('.mpd')) {
        loadDASH(mediaUrl);
    } else {
        loadDirect(mediaUrl);
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
});
