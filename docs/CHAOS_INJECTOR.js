/**
 * Media Sniffer Vibe - Chaos Injector (Console Paste Script)
 * ────────────────────────────────────────────────────────
 * 用途：在不修改源码的情况下模拟网络不稳定的极端环境。
 * 使用方法：
 * 1. 在扩展下载运行期间，右键点击 Offscreen 页面 -> 检查。
 * 2. 在控制台中粘贴并运行此脚本。
 */

(function() {
    console.log("%c[Chaos Engine] 注入成功！下载流程现已进入“地狱模式”...", "color: #ff4757; font-weight: bold; font-size: 1.2em;");

    const CONFIG = {
        requestFail: 0.1,    // 10% 概率模拟 HTTP 502 
        networkError: 0.05,  // 5% 概率模拟 Failed to fetch (TypeError)
        bodyTruncate: 0.1    // 10% 概率模拟传输中断 (ERR_CONTENT_LENGTH_MISMATCH)
    };

    const originalFetch = window.fetch;

    window.fetch = async function(...args) {
        // 模拟请求阶段故障
        if (Math.random() < CONFIG.requestFail) {
            console.warn("[Chaos] 模拟故障注入: Status 502");
            return new Response("Simulated 502", { status: 502, statusText: "Bad Gateway" });
        }
        if (Math.random() < CONFIG.networkError) {
            console.warn("[Chaos] 模拟故障注入: Failed to fetch");
            throw new TypeError("Failed to fetch");
        }

        const response = await originalFetch(...args);

        // 如果原本就不 ok，直接返回
        if (!response.ok) return response;

        // 劫持 arrayBuffer 模拟传输中断 (ERR_CONTENT_LENGTH_MISMATCH)
        const originalArrayBuffer = response.arrayBuffer.bind(response);
        response.arrayBuffer = async function() {
            if (Math.random() < CONFIG.bodyTruncate) {
                console.warn("[Chaos] 模拟故障注入: net::ERR_CONTENT_LENGTH_MISMATCH");
                throw new Error("Simulated Chaos: net::ERR_CONTENT_LENGTH_MISMATCH");
            }
            return await originalArrayBuffer();
        };

        return response;
    };
})();
