# TikTok 按需提取安全加固修复报告

**日期**: 2026-03-22
**Commit**: `cec4128`
**关联文档**: `TIKTOK_ON_DEMAND_FIX_AUDIT.md`

---

## 背景

在对 `1.36.0` 基线中引入的"按需提取 (On-Demand Extraction)"功能进行代码审查时，发现两处安全/正确性缺陷，本次修复将其一并关闭。

---

## 修复一：MEDIA_DETECTED 消息缺少发送方域名校验

### 问题描述

`extension/js/background/main.js` 的 `MEDIA_DETECTED` 消息处理器原本仅校验：

```js
if (tabId !== -1 && url && isManualExtract) { ... }
```

`isManualExtract` 是消息体中的普通字段，任何页面的 content script 均可构造并发送该消息。若 `content.js` 被注入至非 TikTok 页面（取决于 manifest 的 `matches` 范围），攻击者可通过发送 `{ type: 'MEDIA_DETECTED', url: '...', isManualExtract: true }` 向 background 的媒体列表注入任意 URL，完全绕过 sniffer 的噪音过滤规则。

### 修复方案

在条件判断中增加对 `sender.tab.url` 的域名校验。`sender.tab.url` 由 Chrome 运行时注入，content script 无法伪造。

```js
// extension/js/background/main.js
const senderUrl = sender.tab ? sender.tab.url : '';
if (tabId !== -1 && url && isManualExtract && senderUrl.includes('tiktok.com')) {
  addMedia(tabId, url, title || (sender.tab ? sender.tab.title : null));
}
```

### 安全影响

修复后，来自非 TikTok 域名页面的 `MEDIA_DETECTED` 消息将被静默丢弃，URL 注入路径关闭。

---

## 修复二：sniffer 图片黑名单缺少 `.avif`

### 问题描述

`extension/js/background/sniffer.js` 的 `isValidMediaMime` 函数中，URL 图片特征黑名单原为：

```js
const imageSigns = ['.image', '.webp', '.jpg', '.jpeg', '.png', '.gif', '~tplv-'];
```

TikTok 的封面图、头像等静态资源大量使用 AVIF 格式，缺少 `.avif` 导致此类 URL 在 `mimeType` 为 `application/octet-stream` 时可能绕过体积检查而被误收录为有效媒体。

### 修复方案

在黑名单中补充 `.avif`：

```js
const imageSigns = ['.image', '.webp', '.jpg', '.jpeg', '.png', '.gif', '.avif', '~tplv-'];
```

### 影响范围

仅影响 `isValidMediaMime` 的 URL 辅助过滤逻辑，不影响正常视频/音频流的识别。

---

## 变更文件

| 文件 | 变更类型 |
|------|----------|
| `extension/js/background/main.js` | 安全加固：增加 sender 域名校验 |
| `extension/js/background/sniffer.js` | 正确性修复：补充 `.avif` 图片黑名单 |

## Review Checklist 最终状态

- [x] Popup 与 Content 通信显式且无滥发
- [x] `findPlayAddr` 具有 `depth > 20` 栈溢出保护
- [x] `isManualExtract` 调用上下文安全（已加 sender 域名校验）
- [x] MIME 图片黑名单覆盖 `~tplv-`、`.avif` 等主要 TikTok 图片后缀
