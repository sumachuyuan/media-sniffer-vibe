# 修复报告：Dailymotion 下载 & 消息通道错误

**版本**：v1.39.2
**修复日期**：2026-03-22
**涉及文件**：`extension/js/background/orchestrator.js`、`extension/js/background/main.js`

---

## 一、背景

本次修复针对两个独立但相互关联的问题：

1. **Dailymotion 视频下载失败**：点击合并后提示"扫描失败"或输出约 262 字节的损坏 MP4 文件。
2. **消息通道错误**：控制台持续出现 `Uncaught (in promise) Error: A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received`。

---

## 二、问题一：Dailymotion 下载失败

### 2.1 根因 A — DNR urlFilter 范围过窄

**文件**：`extension/js/background/orchestrator.js`
**函数**：`updateDnrRulesForFetch()`

**问题**：DNR 规则的 `urlFilter` 使用了精确子域名匹配：

```javascript
// 修复前（v1.39.1）
condition.urlFilter = `*://${u.host}/*`;
// 例：urlFilter = "*://nm3.dmcdn.net/*"
```

Dailymotion 的 HLS 清单文件（`.m3u8`）可能托管在 `nm3.dmcdn.net`，但实际视频分片（`.m4s`）和初始化映射（`init.mp4`）由其他 CDN 节点分发，例如 `nm2.dmcdn.net`、`nm4.dmcdn.net` 等。

由于 DNR 规则仅覆盖清单文件所在的精确子域名，后续所有分片请求发出时均未携带 `Referer` 头，CDN 因缺少防盗链校验通过的 `Referer` 返回 403。

**修复**：使用 DNR `||` 域名锚语法，一次覆盖目标域名的所有子域名：

```javascript
// 修复后（v1.39.2）
const parts = u.hostname.split('.');
const baseDomain = parts.length > 2 ? parts.slice(-2).join('.') : u.hostname;
condition.urlFilter = `||${baseDomain}/`;
// 例：urlFilter = "||dmcdn.net/" → 覆盖 nm2.dmcdn.net、nm3.dmcdn.net 等所有节点
```

**DNR `||` 语法说明**：

| 模式 | 匹配范围 |
|---|---|
| `*://nm3.dmcdn.net/*` | 仅 `nm3.dmcdn.net`（旧） |
| `\|\|dmcdn.net/` | `dmcdn.net` 及其所有子域名（新） |

---

### 2.2 根因 B — GET_SEGMENTS 清理定时器与下载阶段的竞态条件

**文件**：`extension/js/background/main.js`
**消息处理器**：`GET_SEGMENTS`

**问题**：`GET_SEGMENTS` 解析完清单后设置了一个 2 秒的 DNR 规则清理定时器：

```javascript
// 修复前（v1.39.1）
p.then(res => {
    sendResponse(res);
    setTimeout(clearDnrRules, 2000); // ⚠️ 2 秒后清除规则
});
```

但 `START_FFMPEG_MERGE` 会在 `GET_SEGMENTS` 返回后**立即**被 popup 发出，并重新设置新的 DNR 规则（规则 ID 1001）。2 秒定时器触发时，合并任务正在进行中，`clearDnrRules` 将删除活跃的分片下载所依赖的 DNR 规则，导致后续所有分片请求没有 `Referer` → 403。

**竞态条件时序图**：

```
T=0ms    : GET_SEGMENTS → updateDnrRulesForFetch → 规则 1001 设置
T=~200ms : parseHlsSegments 完成 → sendResponse → setTimeout(clearDnrRules, 2000) 启动
T=~250ms : Popup 收到分片列表 → 立刻发出 START_FFMPEG_MERGE
T=~300ms : START_FFMPEG_MERGE → updateDnrRulesForFetch → 规则 1001 重新设置
T=~350ms : 创建 Offscreen Document → 开始下载分片（耗时数分钟）
T=2200ms : ⚠️ clearDnrRules 定时器触发！规则 1001 被删除！
T=2200ms+: 后续所有分片请求无 Referer → 403 → 输出文件只有 262 字节
```

**修复**：将安全网超时从 2 秒延长至 30 秒：

```javascript
// 修复后（v1.39.2）
p.then(res => {
    sendResponse(res);
    // START_FFMPEG_MERGE 会在成功扫描后立即覆盖此规则，30 秒仅作为
    // "扫描失败 / 用户放弃下载"时的兜底清理
    setTimeout(clearDnrRules, 30000);
});
```

`START_FFMPEG_MERGE` 触发时会调用 `updateDnrRulesForFetch` 覆盖规则，而 `FFMPEG_COMPLETE` / `FFMPEG_ERROR` / `CANCEL_FFMPEG_MERGE` 处理器均会调用 `clearDnrRules`，因此正常合并流程中 30 秒定时器不会产生影响。

---

### 2.3 关于 Cookie 和 Origin 头的说明（不可修复的底层限制）

**`credentials: 'include'` 对 CDN 无效**：Dailymotion 的会话 Cookie（如 `dmvk`）设置在 `.dailymotion.com` 域名上，不会自动发送给 `*.dmcdn.net`（不同 eTLD+1）。CDN 的真实鉴权机制是 URL 中内嵌的 `sec2(...)` 签名 Token，Cookie 仅对 `dailymotion.com` 自身的 API 有效。`credentials: 'include'` 保留无害，但对 CDN 请求无实质效果。

**`Origin` 头无法修改**：从扩展上下文（Service Worker、Offscreen Document）发出的 `fetch()` 请求携带 `Origin: chrome-extension://<id>`。根据 Chrome 扩展规范，`Origin` 属于禁止修改的头部，DNR 的 `modifyHeaders` 操作无法处理它。如果 Dailymotion CDN 进行严格的 `Origin` 服务端校验，则需要通过内容脚本代理（Content Script Proxy）来绕过，这属于更复杂的架构改造，不在本次修复范围内。

---

## 三、问题二：消息通道 Promise 错误

**文件**：`extension/js/background/main.js`
**错误信息**：`Uncaught (in promise) Error: A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received`

### 3.1 原理

Chrome MV3 中，`chrome.runtime.sendMessage()` **无论是否传入回调都返回 Promise**。当 background listener 对某条消息返回 `return true`（声明"我将异步回复"）但最终从未调用 `sendResponse` 时，Chrome 最终 reject 该 Promise，若发送方没有 `.catch()`，则产生 Uncaught Promise rejection。

有两类触发场景：

**场景 A**：Fire-and-forget 消息的 handler 错误地返回了 `return true`。

**场景 B**：有 `sendResponse` 的异步 handler 缺少 `.catch()`，当 Promise 链中途抛出异常时，`sendResponse` 永远不被调用。

---

### 3.2 场景 A 修复：Fire-and-Forget Handler 移除 `return true`

下列消息的发送方均不等待响应（无回调、无 `.then()`），但 handler 错误地返回了 `return true`：

| 消息类型 | 发送方 | 问题 |
|---|---|---|
| `MEDIA_DETECTED` | Content Script | 无回调，handler 返回 `return true` |
| `START_FFMPEG_MERGE` | Popup | 无回调，handler 返回 `return true` |
| `CANCEL_FFMPEG_MERGE` | Popup | 无回调，handler 返回 `return true` |
| `CLEAR_DNR_RULES` | Popup | 无回调，handler 返回 `return true` |
| `FFMPEG_READY` | Offscreen | 发送方有 `.catch()`，handler 返回 `return true` |
| `FFMPEG_PROGRESS` | Offscreen | 发送方有 `.catch()`，handler 返回 `return true` |
| `FFMPEG_COMPLETE` / `FFMPEG_ERROR` | Offscreen | 发送方有 `.catch()`，handler 返回 `return true` |
| `DEBUG_LOG` | 各处 | 无回调，handler 返回 `return true` |

**修复**：将这些 handler 末尾的 `return true` 改为 `return`（或删除），Chrome 立即关闭通道，不再等待响应。

```javascript
// 修复前
if (type === 'START_FFMPEG_MERGE') {
    // ...
    updateDnrRulesForFetch(...).then(() => handleFfmpegMerge(request));
    return true; // ⚠️ 告诉 Chrome 等待 sendResponse，但永远不会调用
}

// 修复后
if (type === 'START_FFMPEG_MERGE') {
    // ...
    updateDnrRulesForFetch(...).then(() => handleFfmpegMerge(request));
    // fire-and-forget: popup 发送时无回调，无需 sendResponse
}
```

---

### 3.3 场景 B 修复：异步 Handler 缺少 `.catch()` 导致 sendResponse 未被调用

下列 handler 有 `sendResponse`（发送方等待响应），但 Promise 链没有错误处理。若 `updateDnrRulesForFetch` 内部抛出异常（如 DNR API 调用失败），`sendResponse` 永远不会被调用：

| 消息类型 | 发送方 | 风险 |
|---|---|---|
| `GET_SEGMENTS` | Popup（有回调，等待分片列表） | Promise 链无 catch，DNR 失败时 sendResponse 不被调用 |
| `START_DIRECT_DOWNLOAD` | Popup（有回调） | 同上 |
| `UPDATE_DNR_FOR_PREVIEW` | Popup（有回调） | 同上 |

**修复**：将嵌套 `.then().then()` 重构为链式调用，并添加 `.catch()` 兜底：

```javascript
// 修复前（GET_SEGMENTS）
updateDnrRulesForFetch(...).then(() => {
    const p = parseHlsSegments(url);
    p.then(res => {          // ⚠️ 内层 then，外层 then 的异常无法传播
        sendResponse(res);
    });
    // 没有 catch：updateDnrRulesForFetch 抛出时，sendResponse 永远不被调用
});

// 修复后（GET_SEGMENTS）
updateDnrRulesForFetch(...)
  .then(() => parseHlsSegments(url))  // 链式，异常可正常传播
  .then(res => {
    sendResponse(res);
    setTimeout(clearDnrRules, 30000);
  })
  .catch(err => {
    logger.error('GET_SEGMENTS failed', err);
    sendResponse({ segments: [], encryption: null, mapUrl: null }); // 始终回复
  });
```

---

## 四、变更汇总

### `extension/js/background/orchestrator.js`

| 位置 | 变更前 | 变更后 | 原因 |
|---|---|---|---|
| `updateDnrRulesForFetch` urlFilter | `*://${u.host}/*` | `\|\|${baseDomain}/` | 覆盖所有 CDN 子域名 |

### `extension/js/background/main.js`

| 位置 | 变更前 | 变更后 | 原因 |
|---|---|---|---|
| `GET_SEGMENTS` 清理超时 | `setTimeout(clearDnrRules, 2000)` | `setTimeout(clearDnrRules, 30000)` | 消除与 START_FFMPEG_MERGE 的竞态 |
| `GET_SEGMENTS` Promise 链 | 嵌套 `.then()` 无 catch | 链式 `.then().catch()` | 保证 sendResponse 总被调用 |
| `START_DIRECT_DOWNLOAD` Promise 链 | `.then()` 无 catch | 添加 `.catch()` | 同上 |
| `UPDATE_DNR_FOR_PREVIEW` Promise 链 | `.then()` 无 catch | 添加 `.catch()` | 同上 |
| `MEDIA_DETECTED` handler | `return true` | `return` | Fire-and-forget，无需 sendResponse |
| `START_FFMPEG_MERGE` handler | `return true` | 无 return | 同上 |
| `CANCEL_FFMPEG_MERGE` handler | `return true` | 无 return | 同上 |
| `CLEAR_DNR_RULES` handler | `return true` | 无 return | 同上 |
| `FFMPEG_READY` handler | `return true` | 无 return | 同上 |
| `FFMPEG_PROGRESS` handler | `return true` | 无 return | 同上 |
| `FFMPEG_COMPLETE/ERROR` handler | `return true` | 无 return | 同上 |
| `DEBUG_LOG` handler | `return true` | 无 return | 同上 |

---

## 五、遗留风险与后续排查方向

若更新至 v1.39.2 后 Dailymotion 仍然失败，按优先级排查：

1. **确认 DNR 规则是否真正注入 Referer**：在 Chrome DevTools → Network 中抓取 `*.dmcdn.net` 的请求头，验证 `Referer` 是否为 `https://geo.dailymotion.com/`。

2. **Origin 头服务端校验**：若 CDN 对 `Origin: chrome-extension://...` 进行严格白名单校验，需实现内容脚本代理方案——将分片下载委托给注入到 `geo.dailymotion.com` iframe 的内容脚本，使请求从页面真实 Origin 发出。

3. **sec2 Token 过期**：`sec2(...)` Token 随页面加载生成，有效期通常为几分钟。若用户在页面加载后延迟较长才点击下载，Token 可能已失效。目前无扩展侧解法，建议在用户界面添加提示，提醒用户在页面加载后尽快操作。

4. **多 CDN 域名**：若解析出的分片 URL 指向 `dmcdn.net` 之外的完全不同的 CDN 域名，`||dmcdn.net/` 规则将无效覆盖。需检查实际解析出的分片 URL 域名列表。
