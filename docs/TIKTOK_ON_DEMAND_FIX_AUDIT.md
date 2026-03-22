# TikTok 按需提取 (On-Demand Extraction) 修复验证文档

此文档专供 Claude 等 AI 助手进行代码审查和验证。本次更新修复了 TikTok 单页视频漏抓问题，并清除了 `1.36.0` 基线中的图片混淆漏洞。

## 根本问题 (Root Cause)
1. **漏抓原因**: TikTok 详情页的主视频通常由 Service Worker 劫持，或者作为 Blob 以碎片化加载，从而彻底绕过了 Chrome 的 `webRequest` 基础监听层。
2. **图片噪音泄漏原因**: `1.36.0` 原有的 `isValidMediaMime` 允许 `application/octet-stream` 通过，且后端逻辑中如果缺少 `Content-Length`，会导致 `< 1MB` 的过滤条件计算错误（被当作 0 而放行）。

## 核心修复逻辑 (Core Execution)
采用 **按需主动提取 (On-Demand Extraction)** 策略。为了不产生无关网络请求且避免污染现有稳定的侦听器，扫描器只在用户**点击扩展图标（打开 popup 面板）的那一瞬间**才工作，并从页面的 DOM 脚本 (`__UNIVERSAL_DATA_FOR_REHYDRATION__`) 中精确定位唯一的主视频地址。

---

## 修改的文件及改动详情

### 1. `extension/content.js`
**作用**: 增加页面内部的按需解析器。
**变动**:
- 新增 `chrome.runtime.onMessage` 监听器，接收 `EXTRACT_TIKTOK` 指令。
- 确认当前域名为 `tiktok.com`。
- 获取 ID 为 `__UNIVERSAL_DATA_FOR_REHYDRATION__`、`SIGI_STATE` 或 `RENDER_DATA` 的 `<script>` 标签内容。
- 使用递归函数 `findPlayAddr` 精确查找 JSON 中的 `playAddr` 或 `downloadAddr` 字段（而不是模糊正则全扫描）。
- 如果找到，则通过 `chrome.runtime.sendMessage({ type: 'MEDIA_DETECTED', url: foundUrl, isManualExtract: true })` 将其发回 Background。

### 2. `extension/js/popup/main.js`
**作用**: 触发按需提取动作。
**变动**:
- 在 `DOMContentLoaded` 初始化函数内，调用 `i18n.init()` 之后，`renderUrls()` 之前。
- 查询当前 active tab。如果 URL 包含 `tiktok.com`，则执行 `chrome.tabs.sendMessage(tabs[0].id, { type: 'EXTRACT_TIKTOK' })`。
- 随后 `await new Promise(r => setTimeout(r, 150))` 稍微延迟执行后续的渲染流程，以确保后台能接收到提取出的 URL。

### 3. `extension/js/background/main.js`
**作用**: 接收并豁免按需提取的 URL。
**变动**:
- 在消息中心 (`chrome.runtime.onMessage.addListener`) 中，新增 `MEDIA_DETECTED` 事件的处理逻辑。
- 获取 `request.isManualExtract`，如果是手动提取回传的数据，**直接跳过所有 `NOISE_KEYWORDS` 和体积检查规则**，将该 URL 插入当前 Tab 的媒体列表中供用户下载。

### 4. `extension/js/background/sniffer.js`
**作用**: 封堵原有的 `1MB` 文件体积检测的逻辑漏洞，根除图片噪音。
**变动**:
- 在 `isValidMediaMime` 函数开头，增加对 `url.toLowerCase()` 的黑名单校验。
- 包含后缀：`['.image', '.webp', '.jpg', '.jpeg', '.png', '.gif', '~tplv-']`。
- 如果检测到上述后缀，即便 `mimeType` 是 `application/octet-stream` 或者缺失，均强制返回 `false`。

## 代码评审要点 (Review Checklist for Claude)
- [ ] 确认 Popup 与 Content 之间的通信为显式的 `EXTRACT_TIKTOK` 且无滥发。
- [ ] 确认递归查找 `playAddr` 函数具有最大深度 (`depth > 20` 截断) 保护以防栈溢出。
- [ ] 确认 Background 中的 `isManualExtract` 存在防滥用机制或其调用上下文是安全的。
- [ ] 确认 MIME 检测强化规则覆盖到了常见的 TikTok 头像、缩略图等后缀 (`~tplv-` 等)。
