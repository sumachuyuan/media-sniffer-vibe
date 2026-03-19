/**
 * Sovereign Popup UI Component
 */
export const ui = {
    updateMergeBanner: (pct, stage, title) => {
        const banner = document.getElementById('global-merge-banner');
        const bar = document.getElementById('global-bar');
        const pctMsg = document.getElementById('global-pct');
        const stageMsg = document.getElementById('global-stage');
        const titleMsg = document.getElementById('global-msg');
        if (banner && bar && pctMsg) {
            banner.style.display = 'block';
            bar.style.width = `${pct}%`;
            pctMsg.textContent = `${Math.round(pct)}%`;
            if (stage) stageMsg.textContent = stage;
            if (title && titleMsg) titleMsg.textContent = title;
        }
    },
    hideMergeBanner: () => {
        const banner = document.getElementById('global-merge-banner');
        if (banner) banner.style.display = 'none';
    },
    showToast: (message, tag = 'default') => {
        const container = document.getElementById('toastContainer');
        const existing = container.querySelector(`.toast[data-tag="${tag}"]`);
        if (existing) { existing.innerText = message; return; }
        
        const toast = document.createElement('div');
        toast.className = 'toast';
        toast.dataset.tag = tag;
        toast.innerText = message;
        container.appendChild(toast);
        setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transform = 'translateX(-50%) translateY(-20px) scale(0.9)';
            toast.style.transition = 'all 0.4s cubic-bezier(0.16, 1, 0.3, 1)';
            setTimeout(() => toast.remove(), 400);
        }, 2800);
    }
};
