/**
 * Sovereign i18n Helper with Manual Override Support
 */
export const i18n = {
    locale: null,
    messages: null,

    /**
     * Set a custom locale manually
     */
    async setLocale(lang) {
        if (!lang) {
            this.locale = null;
            this.messages = null;
            return;
        }
        try {
            const path = chrome.runtime.getURL(`_locales/${lang}/messages.json`);
            const response = await fetch(path);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            this.messages = await response.json();
            this.locale = lang;
        } catch (e) {
            console.error('Failed to load locale:', lang, e);
        }
    },

    /**
     * Get a localized message by key
     */
    t(key, subs = []) {
        // 1. Check manual override
        if (this.messages && this.messages[key]) {
            let msg = this.messages[key].message;
            if (subs && subs.length > 0) {
                subs.forEach((sub, i) => {
                    msg = msg.replace(new RegExp(`\\$${i + 1}`, 'g'), sub);
                    const placeholderKey = Object.keys(this.messages[key].placeholders || {})[i];
                    if (placeholderKey) {
                        msg = msg.replace(new RegExp(`\\$${placeholderKey.toUpperCase()}\\$`, 'g'), sub);
                    }
                });
            }
            return msg;
        }
        // 2. Fallback to system chrome.i18n
        return chrome.i18n.getMessage(key, subs) || key;
    },

    /**
     * Automatically translate all elements with data-i18n attribute
     */
    init: async () => {
        // Check for stored preference
        const result = await chrome.storage.local.get('preferredLanguage');
        if (result.preferredLanguage) {
            await i18n.setLocale(result.preferredLanguage);
        }

        document.querySelectorAll('[data-i18n]').forEach(el => {
            const key = el.getAttribute('data-i18n');
            const translation = i18n.t(key);
            if (translation) {
                if (el.tagName === 'INPUT' && (el.type === 'text' || el.type === 'search')) {
                    el.placeholder = translation;
                } else {
                    el.innerHTML = translation;
                }
            }
        });
        
        // Update document lang for accessibility
        document.documentElement.lang = result.preferredLanguage || chrome.i18n.getUILanguage();
    }
};
