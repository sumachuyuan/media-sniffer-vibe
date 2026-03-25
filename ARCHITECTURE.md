# Media Sniffer Vibe — 架构文档

> 版本：v1.47.1 · 最后更新：2026-03-25

---

## 目录

1. [项目概述](#1-项目概述)
2. [执行上下文总览](#2-执行上下文总览)
3. [目录结构](#3-目录结构)
4. [核心模块说明](#4-核心模块说明)
5. [消息流与数据流](#5-消息流与数据流)
6. [核心功能详解](#6-核心功能详解)
7. [关键设计决策](#7-关键设计决策)
8. [如何贡献新平台规则](#8-如何贡献新平台规则)
9. [版本更新记录](#9-版本更新记录)

---

## 1. 项目概述

**Media Sniffer Vibe** 是一个基于 Chrome Manifest V3 的浏览器扩展，用于从网页中捕获并下载媒体流（HLS/M3U8、DASH/MPD、MP4、音频）。使用 FFmpeg.wasm 在浏览器内完成分段合并，**零服务器依赖**。v1.40+ 新增**极致录制 (Ultimate Recording)** 功能，使用 WebCodecs + IndexedDB 实现全程无服务器的标签页录像。

| 属性 | 值 |
|------|-----|
| 平台 | Chrome (Manifest V3) |
| 核心依赖 | FFmpeg.wasm (offscreen)、HLS.js (preview)、Dash.js (preview)、WebCodecs API (recording) |
| 构建工具 | 无（直接加载 `extension/` 目录） |
| 主语言 | JavaScript (ES Modules) |
| 国际化 | 中文 (zh_CN) / 英文 (en) |

---

## 2. 执行上下文总览

Chrome MV3 扩展有**五个**完全隔离的执行上下文，通过 `chrome.runtime.sendMessage` 通信：

```
┌─────────────────────────────────┐    ┌──────────────────────────────┐
│   Background Service Worker     │    │        Popup (UI)            │
│                                 │    │                              │
│  main.js        ← 消息总线      │    │  main.js    ← 状态 & 事件   │
│  sniffer.js     ← 网络拦截      │◄──►│  renderer.js← DOM 渲染      │
│  platforms.js   ← 平台规则表    │    │  i18n.js    ← 本地化        │
│  parser.js      ← M3U8/MPD解析  │    │  ui.js      ← Toast/控件    │
│  orchestrator.js← Offscreen管理 │    │  utils.js   ← 工具函数      │
│  storage.js     ← Tab 媒体缓存  │    │                              │
└─────────────────────────────────┘    └──────────────────────────────┘
            ▲                                        ▲
            │         chrome.runtime.sendMessage     │
            ▼                                        ▼
┌─────────────────────────────────┐    ┌──────────────────────────────┐
│   Content Script (页面上下文)   │    │  Offscreen Document A        │
│                                 │    │  offscreen.html (FFmpeg)     │
│  content.js                     │    │  main.js   ← 分段下载池     │
│  ├─ 提取页面 <video>/<audio>    │    │  ffmpeg.js ← FFmpeg.wasm    │
│  ├─ 获取上下文标题              │    │  crypto.js ← AES-128解密    │
│  └─ TikTok script JSON 抽取    │    │                              │
└─────────────────────────────────┘    └──────────────────────────────┘
                                        ┌──────────────────────────────┐
                                        │  Offscreen Document B        │
                                        │  record.html (极致录制)      │
                                        │  record/offscreen.js         │
                                        │    ← TabCapture + 帧泵       │
                                        │  record/worker.js (Worker)   │
                                        │    ← WebCodecs 编码          │
                                        │  record/muxer.js (VibeMuxer) │
                                        │    ← EBML/WebM 写入 IDB     │
                                        └──────────────────────────────┘
```

> **注意**：Chrome 同一时刻只允许**一个** Offscreen Document。Offscreen A (FFmpeg) 和 Offscreen B (录制) 互斥，由 `orchestrator.js` 通过类型标识（`'ffmpeg'` / `'record'`）和原子锁统一管理。

---

## 3. 目录结构

```
media-sniffer-vibe/
├── extension/                      # 插件根目录（Chrome 直接加载此目录）
│   ├── manifest.json               # MV3 清单，权限声明
│   ├── popup.html                  # 弹出窗口 HTML
│   ├── offscreen.html              # Offscreen Document HTML（FFmpeg 宿主）
│   ├── record.html                 # Offscreen Document HTML（录制宿主）★ 新增
│   ├── preview.html / preview.js   # 内联播放器页面
│   ├── content.js                  # Content Script（注入到目标网页）
│   ├── hls.min.js                  # HLS.js（预览用）
│   ├── dash.all.min.js             # Dash.js（预览用）
│   ├── icons/                      # 扩展图标
│   ├── libs/                       # FFmpeg.wasm 核心文件
│   │   ├── ffmpeg.min.js
│   │   └── ffmpeg-core.js / .wasm
│   ├── _locales/                   # 国际化字符串
│   │   ├── zh_CN/messages.json     # 中文（主语言）
│   │   └── en/messages.json        # 英文
│   └── js/
│       ├── background/             # Service Worker 模块
│       │   ├── main.js             # 消息总线 & 网络监听器
│       │   ├── sniffer.js          # URL 过滤 & 分类引擎
│       │   ├── platforms.js        # 平台规则表（可扩展）
│       │   ├── parser.js           # HLS/DASH Manifest 解析
│       │   ├── orchestrator.js     # Offscreen 生命周期管理（FFmpeg + 录制）
│       │   └── storage.js          # Tab 级媒体缓存
│       ├── offscreen/              # FFmpeg Offscreen 模块
│       │   ├── main.js             # 下载池 & 合并任务调度（含 WebM remux）
│       │   ├── ffmpeg.js           # FFmpeg.wasm 初始化 & 执行
│       │   └── crypto.js           # AES-128-CBC 解密
│       ├── record/                 # 极致录制 (Ultimate Recording) 模块 ★ 新增
│       │   ├── offscreen.js        # TabCapture 采集 & 帧泵（Offscreen 主脚本）
│       │   ├── worker.js           # WebCodecs 编码器（独立 Worker 线程）
│       │   ├── muxer.js            # VibeMuxer — 自研 EBML/WebM 流式封装
│       │   └── storage.js          # RecordStorage — IndexedDB 统一数据访问层
│       ├── popup/                  # 弹出窗口模块
│       │   ├── main.js             # 状态管理 & 事件绑定（含录制导出逻辑）
│       │   ├── renderer.js         # DOM 列表渲染
│       │   ├── i18n.js             # 本地化系统
│       │   ├── ui.js               # Toast & UI 控件
│       │   └── utils.js            # 文件名净化 & 剪贴板
│       └── common/
│           └── logger.js           # 统一日志（DEBUG 开关）
├── docs/                           # 内部技术文档（不发布）
├── .github/workflows/              # CI/CD
│   └── auto-release.yml            # 推送 master 自动发布
├── ARCHITECTURE.md                 # 本文件
├── README.md                       # 用户安装 & 使用手册
├── PRIVACY_POLICY.md
└── CLAUDE.md                       # AI 协作指引
```

---

## 4. 核心模块说明

### 4.1 `background/main.js` — 消息总线

扩展的神经中枢，承担两项核心职责：

**① 双层网络监听**
- **Layer 1** — `chrome.webRequest.onBeforeRequest`：基于 URL 签名（`MEDIA_SIGNATURES`）拦截请求，命中后立即解析 Manifest 并入库
- **Layer 2** — `chrome.webRequest.onResponseStarted`：基于响应头 Content-Type 兜底，捕获签名未命中但 MIME 为媒体类型的 URL

**② 消息分发**
处理来自 Popup、Offscreen（FFmpeg）、Offscreen（录制）的所有消息类型：

| 消息类型 | 方向 | 说明 |
|---------|------|------|
| `GET_URLS` | Popup → BG | 获取当前 Tab 已检测媒体列表 |
| `GET_SEGMENTS` | Popup → BG | 解析 HLS/DASH 片段列表 |
| `START_FFMPEG_MERGE` | Popup → BG | 启动分段合并或伴音合并 |
| `START_DIRECT_DOWNLOAD` | Popup → BG | 直接下载或 Proxy 下载 |
| `CANCEL_FFMPEG_MERGE` | Popup → BG | 取消当前合并任务 |
| `FFMPEG_READY` | Offscreen → BG | Offscreen 初始化完成通知 |
| `FFMPEG_PROGRESS` | Offscreen → BG | 进度更新（广播给 Popup）|
| `FFMPEG_COMPLETE` | Offscreen → BG | 合并完成，触发 `chrome.downloads` |
| `FFMPEG_ERROR` | Offscreen → BG | 合并失败 |
| `PRE_WARM_RECORD_OFFSCREEN` | Popup → BG | 预热录制 Offscreen（用户点击前提前创建）|
| `START_RECORD_TEST` | Popup → BG | 启动录制（BG 代理获取 streamId 后转发）|
| `STOP_RECORD_TEST` | Popup → BG | 停止录制 |
| `RECORD_OFFSCREEN_READY` | RecordOffscreen → BG | 录制 Offscreen 初始化完成 |
| `RECORD_STOPPED` | RecordOffscreen → BG | 编码完毕，开始 IDB 写入 |
| `RECORD_BLOB_READY` | RecordOffscreen → BG | IDB 写入完成，导出按钮可用 |
| `START_WEBM_REMUX` | Popup → BG | 触发 WebM→MP4 remux（FFmpeg）|
| `START_AUDIO_EXTRACT` | Popup → BG | 触发音频提取（FFmpeg）|

---

### 4.2 `background/platforms.js` — 平台规则表

声明式规则引擎，每条规则描述一个平台的行为：

```javascript
{
  id: 'youtube',
  match:           (url) => url.includes('googlevideo.com'),  // 匹配谓词
  groupTag:        (url) => ...,   // 提取配对 key（用于伴音关联）
  mediaType:       (url) => ...,   // 检测 'audio' | 'video' | null
  normalizeParams: ['range', 'rn', 'rbuf'],  // URL 去重时清理的参数
  proxyRequired:   false,          // 直接下载是否需要 Offscreen Proxy
}
```

当前支持平台：`youtube` · `facebook` · `reddit` · `bilibili` · `tiktok`

**新增平台只需在 `platforms.js` 添加一条规则，其他模块无需修改。**

---

### 4.3 `background/sniffer.js` — 嗅探引擎

基于 `platforms.js` 规则表的通用处理函数：

| 函数 | 作用 |
|------|------|
| `isNoiseFragment(url)` | 过滤广告像素、分析 beacon、细碎分片等噪声 |
| `extractGroupTag(url)` | 提取伴音配对 key（cpn、trid、efg 等） |
| `detectMediaType(url)` | 判断音频/视频（关键词 → 平台规则 → 扩展名） |
| `isValidMediaMime(mime, url)` | 验证 MIME 类型（含 Feishu 特殊路径白名单） |
| `normalizeUrl(url)` | 清理去重参数（bytestart/byteend + 平台规则声明参数） |
| `isVerifiedMedia(url)` | 识别高置信度媒体流（绕过 1MB 过滤阈值） |

---

### 4.4 `background/parser.js` — Manifest 解析器

| 函数 | 协议 | 功能 |
|------|------|------|
| `parseM3U8(url)` | HLS | 解析 Master/Media Playlist，提取质量层级、加密信息、总时长 |
| `parseMPD(url)` | DASH | 解析 MPD，提取 Representation 质量列表 |
| `parseHlsSegments(url)` | HLS | 提取所有 TS/fMP4 片段 URL + 初始化段 + 加密密钥 |
| `parseDashSegments(url)` | DASH | 用 DOMParser 解析 SegmentTemplate / SegmentList，真实计算片段数 |

所有解析结果缓存 30 秒（`storage.parsingCache`），避免重复 fetch。

---

### 4.5 `background/orchestrator.js` — Offscreen 原子化生命周期管理

Chrome 同一时刻只允许一个 Offscreen Document。Orchestrator 以**类型标识**区分两种任务，并以**原子锁**防止并发竞争：

#### 类型标识（`_activeOffscreenType`）

| 值 | 对应文档 | 用途 |
|----|---------|------|
| `'ffmpeg'` | `offscreen.html` | HLS/DASH 分段下载合并、伴音合并、WebM Remux、音频提取 |
| `'record'` | `record.html` | 极致录制 (Ultimate Recording) TabCapture 采集 |
| `null` | 无 | 空闲或 SW 重启后尚未探测 |

#### 原子锁（`_isCreating`）

`createRecordOffscreen()` 是一个异步函数，在 `chrome.offscreen.createDocument()` 期间存在竞争窗口：PRE_WARM 调用和 START_RECORD 调用可能同时进入，导致 `createDocument()` 被调用两次（Chrome 会抛出异常）。`_isCreating` 标志在函数入口处同步置位、在 `finally` 块中复位，将创建路径收窄为单个飞行中的 Promise：

```javascript
export async function createRecordOffscreen() {
  if (_isCreating) return true;   // 已有创建请求在途，直接返回
  _isCreating = true;
  try {
    // ... 关闭残留文档、创建 record.html ...
  } finally {
    _isCreating = false;           // 无论成败都释放锁
  }
}
```

#### 硬件采集锁释放（`track.stop()`）

Chrome 的 TabCapture 会持有一把**操作系统级硬件采集锁**（可见于 Chrome 标签栏的红色录制指示器）。若直接调用 `chrome.offscreen.closeDocument()` 而不先停止媒体轨道，Chrome 需要等待 GC 回收 `MediaStream` 对象后才能释放这把锁，整个过程可能长达数百毫秒。在此窗口期内，任何新建的 Offscreen Document 都无法获取同一标签页的 TabCapture 权限。

**解决方案**：在关闭 Offscreen Document 之前，`orchestrator.js` 会先发送 `CLEAR_RECORD_STORAGE` 消息触发 `record/offscreen.js` 中的 `mediaStream.getTracks().forEach(t => t.stop())`，确保硬件锁**立即**释放：

```
closeRecordOffscreen()
  │
  ├─ sendMessage(CLEAR_RECORD_STORAGE)    ← record/offscreen.js 调用 track.stop()
  ├─ await 150ms（轨道停止 < 10ms，有余量）
  └─ chrome.offscreen.closeDocument()     ← 此时锁已释放，立即成功
```

#### 全局状态变量一览

| 变量 | 类型 | 作用 |
|------|------|------|
| `_activeOffscreenType` | `'ffmpeg'\|'record'\|null` | 当前 Offscreen 类型标识 |
| `_isCreating` | `boolean` | 录制 Offscreen 创建原子锁 |
| `_isFfmpegBusy` | `boolean` | FFmpeg 任务占用锁 |
| `isRecordOffscreenActive` | `boolean` | 录制 Offscreen 存活标志 |
| `pendingOffscreenCommand` | `object\|null` | FFmpeg Offscreen 就绪后待分发的命令 |
| `pendingRecordCommand` | `object\|null` | 录制 Offscreen 就绪后待分发的命令 |

---

### 4.6 `offscreen/main.js` — 下载池 & 合并调度

四种任务模式：

**① `handleMergeSegments`（分段流）**
- 共享索引池模式：N 个 Worker 协同消费片段队列，避免 Promise.all 内存峰值
- 失败段单独收集，一次性冷却重试（1s 间隔，单线程，最多 3 次）
- AES-128-CBC 解密支持
- fMP4 路径：二进制拼接 init + segments → FFmpeg remux
- TS 路径：concat list → FFmpeg `aac_adtstoasc` + genpts

**② `handleMerge`（伴音合并）**
- 并行下载视频流 + 音频流
- FFmpeg `-c copy` 尝试 MP4 容器；VP9/Opus 不兼容时自动 fallback 到 MKV

**③ `handleProxyDownload`（单文件代理）**
- 流式读取 + 进度上报（每 1MB 更新一次）
- 用于 TikTok/Bilibili 等需要 Referer/UA 的直链下载

**④ `handleWebmRemux` / `handleAudioExtract`（录制后处理）**
- 从 IndexedDB（`vibeRecordDB`）读取 `remuxInputBlob`（录制生成的 WebM）
- FFmpeg `-c copy` 容器转换为 MP4（`handleWebmRemux`）
- FFmpeg 提取 Opus 音轨输出 MP3（`handleAudioExtract`）
- 处理结果写回 IDB `remuxOutputBuffer`，Popup 从 IDB 读取后写入磁盘

---

### 4.7 `offscreen/ffmpeg.js` — FFmpeg.wasm 封装

| 函数 | 作用 |
|------|------|
| `initFFmpeg(forceNew)` | 懒加载 + 单例缓存；`forceNew=true` 跳过缓存（用于每次合并前确保干净状态）|
| `runFFmpeg(ffmpeg, args)` | 统一执行入口，捕获异常返回 `-1`，打印完整命令行 |
| `cleanupFS(ffmpeg)` | 清理 MEMFS 中所有工作文件（`part_*.ts`、`final.*`、`concat.txt` 等）|

---

### 4.8 `record/offscreen.js` — TabCapture 采集与帧泵 ★ 新增

录制 Offscreen Document 的主脚本，负责：

1. **Token-First 初始化协议**：`startTest()` 的第一个 `await` 必须是 `navigator.mediaDevices.getUserMedia()`，以确保在 Chrome TabCapture 令牌（~250ms TTL）过期之前消费它。IDB 清理、Worker 创建等所有其他异步操作均在 `getUserMedia` 成功返回后才执行。

2. **帧泵**：使用 `MediaStreamTrackProcessor` 将 `MediaStream` 拆分为 `ReadableStream<VideoFrame>` 和 `ReadableStream<AudioData>`，以 Transferable 零拷贝方式逐帧 `postMessage` 到 Record Worker。

3. **音频回桥**：TabCapture 会静音原始标签页。通过 `AudioContext.createMediaStreamSource()` 将捕获流路由回扬声器，确保用户录制期间仍能听到声音。

4. **心跳**：每 5 秒向 `chrome.storage.local` 写入 `recordLastHeartbeat`。Popup 检测到心跳超时（>15s）时可判断 Offscreen 崩溃。

5. **CLEAR_RECORD_STORAGE 消息**：收到后立即调用 `mediaStream.getTracks().forEach(t => t.stop())` 以释放硬件采集锁，然后终止 Worker 并清理 IDB。

---

### 4.9 `record/worker.js` — WebCodecs 编码器（独立 Worker）★ 新增

运行在独立 Worker 线程，承担所有 CPU/GPU 密集型编码工作：

**编码器优先级链（Hardware → Software fallback）**
1. `avc1.640028` H.264 High Profile L4.0（GPU 硬件加速，`prefer-hardware`）
2. `avc1.42E01E` H.264 Baseline L3.0（软件编码，`prefer-software`）
3. `vp09.00.10.08` VP9 Profile 0（最后兜底）

**关键机制**
- **时间戳单调性保护**：VideoEncoder 要求时间戳严格单调递增。UHD 高负载时捕获管线可能产生相等或倒退的时间戳，Worker 用 `lastFrameTimestampUs + 1µs` 修正。
- **帧缩放**：需要降分辨率时使用 `createImageBitmap({ resizeWidth, resizeHeight })`，而非 OffscreenCanvas。GPU 上的 VideoFrame 在 drawImage 返回时像素数据可能尚未完成 GPU→CPU 回读，createImageBitmap 内部处理了异步回读，避免"所有帧相同"的冻屏问题。
- **I/O 背压控制**：追踪 `pendingVideoBytes + pendingAudioBytes`。积压超过 50MB 时将编码码率减半；降至 25MB 以下时恢复，防止 IDB 写入速度跟不上编码速度时内存爆炸。
- **统一写入队列（muxerChain）**：所有视频和音频写入均串行化到同一 Promise 链，保证 WebM 头部先于任何 SimpleBlock 写入，且视频/音频交织顺序确定。

---

### 4.10 `record/muxer.js` — VibeMuxer（自研 EBML/WebM 封装）★ 新增

经典脚本（非 ES Module），通过 `importScripts()` 加载到 Worker 全局作用域。

**设计目标**：任意时刻崩溃仍可播放——Segment 和每个 Cluster 均使用 EBML "Unknown Size" 编码，VLC 等播放器可解析未正常关闭的文件。

**关键特性**
- **懒加载头部**：EBML 头、Segment、SegmentInfo、Tracks 在**首个关键帧**到达时才写入，以便嵌入 WebCodecs 提供的 CodecPrivate（H.264 AVCC box）。
- **Cluster 边界**：每个关键帧或超过 1s 时开启新 Cluster，保证 seek 点间隔合理。
- **持久 Writer**：在构造函数中一次性获取 `WritableStreamDefaultWriter`，整个录制会话复用，避免频繁 `getWriter()`/`releaseLock()` 的性能开销。
- **音频模式**：支持纯音频（`isAudioOnly=true`）和视频+音频两种轨道配置，音频编解码器固定为 Opus，包含标准 OpusHead CodecPrivate。

---

### 4.11 `record/storage.js` — RecordStorage（IDB 统一数据访问层）★ 新增

消除了 `record/offscreen.js`、`offscreen/main.js`、`popup/main.js` 三处重复的 IndexedDB 样板代码。

**数据库**：`vibeRecordDB` v2

| Object Store | 键 | 值 | 用途 |
|---|---|---|---|
| `chunks` | 顺序数字索引 | `ArrayBuffer`（WebM 分段） | 录制期间实时写入 |
| `handles` | `'remuxInputBlob'` | `ArrayBuffer` | 合并后的完整 WebM（FFmpeg 输入） |
| `handles` | `'remuxOutputBuffer'` | `ArrayBuffer` | FFmpeg 输出的 MP4/MP3（Popup 读取后写盘） |
| `handles` | `'currentFileHandle'` | `FileSystemFileHandle` | Popup 选择的目标文件句柄（IPC 无法传递） |

**核心 API**

```javascript
createChunkWritableStream() → WritableStream   // 转移至 Worker，零拷贝写入 IDB
consolidateChunks()                             // 合并所有 chunk → remuxInputBlob
loadRemuxInput() / deleteRemuxInput()           // FFmpeg 侧读取/清理输入
saveRemuxOutput(buffer) / loadRemuxOutput()     // FFmpeg 侧写入 / Popup 侧读取
saveFileHandle(handle) / loadFileHandle()       // FileSystemFileHandle 跨上下文传递
clearSession()                                  // 清理 chunks + remuxInputBlob（新录制前调用）
```

> **设计约束**：`FileSystemFileHandle.createWritable()` 需要用户手势激活（User Activation）。`handle` 只能在 Popup 上下文中调用，IDB 是唯一能跨上下文传递 Handle 原型链的机制（chrome.runtime IPC 会丢失原型）。

---

## 5. 消息流与数据流

### 5.1 媒体捕获流

```
网页请求
   │
   ├─[URL 签名命中]──► onBeforeRequest ──► normalizeUrl
   │                         │
   │              ┌──────────┴──────────┐
   │           .m3u8/.mpd           其他媒体签名
   │              │                     │
   │         parseM3U8/MPD         直接跳过解析
   │              │                     │
   └─[MIME 兜底]──► onResponseStarted ──► isValidMediaMime ──► size filter
                                              │
                                         addMedia(tabId)
                                              │
                                    tabStorage[tabId].push(item)
                                              │
                                    badge 数字 +1
```

### 5.2 下载合并流 & 录制流

```
                    ┌─────────────────────────────────────────────────────────┐
                    │                   Popup 用户操作                        │
                    └───────────────┬───────────────────┬─────────────────────┘
                                    │                   │
                          点击下载按钮              点击开始录制
                                    │                   │
                         START_FFMPEG_MERGE      PRE_WARM_RECORD_OFFSCREEN ①
                                    │                   │
                         Background main.js      createRecordOffscreen()
                                    │              (_isCreating 原子锁)
                         updateDnrRulesForFetch         │
                                    │             START_RECORD_TEST ②
                         orchestrator.handleFfmpegMerge  │
                                    │              getMediaStreamId() [SW Only]
                    ┌───────────────┴──┐                │
                Offscreen          创建Offscreen  dispatchToRecordOffscreen
                已存在(ffmpeg)      └──► FFMPEG_READY    │
                    │                    │         RECORD_OFFSCREEN_READY
                    └────────────────────┘               │
                               │                  START_RECORD_TEST + streamId
                    FFMPEG_MERGE_SEGMENTS                 │
                    or FFMPEG_MERGE              record/offscreen.js
                               │                    │
                    offscreen/main.js         ① getUserMedia(streamId)  ← Token-First
                               │                    │  [消费 ~250ms 令牌]
                    ┌──────────┴──────────┐    ② clearSession() [IDB]
                下载池              initFFmpeg   ③ new Worker(worker.js)
                (N workers)              │            │
                    │               FFmpeg.wasm  INIT → WebCodecs 编码器就绪
                    │               执行合并          │
                    └──────────────────┘         帧泵 (VideoFrame / AudioData)
                               │                  [Transferable 零拷贝]
                    FFMPEG_COMPLETE                     │
                    { filename, blobUrl }         record/worker.js
                               │               VideoEncoder + AudioEncoder
                    chrome.downloads.download    VibeMuxer.addChunk()
                               │                      │
                    closeOffscreen(ffmpeg)        写入 IDB chunks
                                                       │
                                            用户点击停止录制
                                                       │
                                          STOP → flush encoders
                                                       │
                                          RECORD_WRITE_COMPLETE
                                                       │
                                          consolidateChunks() → remuxInputBlob
                                                       │
                                          RECORD_BLOB_READY → closeOffscreen(record)
                                                       │
                                          Popup 导出按钮可用
                                          ├─ 保存 WebM → FileSystemFileHandle.write()
                                          └─ 导出 MP4/MP3 → START_WEBM_REMUX / START_AUDIO_EXTRACT
                                                               │
                                                    dispatchToOffscreen(ffmpeg)
                                                    loadRemuxInput() → FFmpeg → saveRemuxOutput()
                                                    Popup: loadRemuxOutput() → 写盘
```

---

## 6. 核心功能详解

### 6.1 双层嗅探机制

| 层级 | 触发时机 | 判断依据 | 适用场景 |
|------|---------|---------|---------|
| Layer 1 | 请求发出前 | URL 包含 `.m3u8 / .mpd / .mp4 / googlevideo.com` 等签名 | HLS、DASH、MP4 直链 |
| Layer 2 | 响应头返回后 | Content-Type 为 `video/*` / `audio/*` / manifest MIME | 无扩展名的 CDN 路径、Feishu |

### 6.2 伴音配对（Companion Merge）

视频流和音频流通过 `groupTag` 配对：

- **YouTube**：提取 `cpn` 参数（同一播放会话共享）
- **Bilibili**：提取 `trid`（同一视频任务共享）
- **Facebook**：解码 `efg` Base64 JSON，提取 `video_id`
- **Reddit**：提取路径中 10-15 字符的内容 ID

同一 Tab 下 `groupTag` 相同且一个为 `video`、另一个为 `audio` 的两条记录，Popup 渲染时自动合并为 **Companion Card**。

### 6.3 FFmpeg 容器自适应

合并时优先尝试 MP4 容器（`-c copy`）：
- **成功** → 输出 `.mp4`
- **失败**（VP9 + Opus 不兼容 MP4）→ fallback 到 MKV，输出 `.mkv`

### 6.4 AES-128 解密

HLS 加密流（`#EXT-X-KEY:METHOD=AES-128`）：
1. 解析器提取密钥 URL、IV、Media Sequence
2. Offscreen 在每段下载后调用 `crypto.decryptBuffer()`（Web Crypto API，AES-CBC）
3. 解密后的明文段写入 FFmpeg MEMFS，后续流程与未加密相同

### 6.5 DNR 请求头注入

需要 Referer / User-Agent 的平台（TikTok、Bilibili 等），通过 `chrome.declarativeNetRequest` 动态注入：
- 仅对 `chrome.runtime.id` 发起的请求生效（`initiatorDomains` 限制），不影响用户正常浏览
- 下载完成后 5 秒内清除规则

### 6.6 高性能模式

Popup 的 🚀 按钮控制 `concurrency` 参数（1 或 5），传入 Offscreen 的下载池：
- **普通模式**：1 线程，兼容性最佳
- **高性能模式**：5 线程，速度提升 3-5×

### 6.7 极致录制 (Ultimate Recording) ★ 新增

端到端无服务器标签页录制，完整管线：

```
chrome.tabCapture.getMediaStreamId() [Service Worker]
  → getUserMedia({ chromeMediaSource:'tab' }) [RecordOffscreen]
    → MediaStreamTrackProcessor → VideoFrame / AudioData
      → Worker.postMessage(frame) [Transferable 零拷贝]
        → VideoEncoder (H.264 HW/SW / VP9) + AudioEncoder (Opus)
          → VibeMuxer → WritableStream → IndexedDB chunks
              ↓ [录制结束]
          consolidateChunks() → remuxInputBlob [IDB]
              ↓ [用户选择导出格式]
        FFmpeg.wasm: WebM → MP4 or Opus → MP3
          → FileSystemFileHandle.write() [Popup, 需用户手势]
```

支持三种质量档位：

| 档位 | 分辨率上限 | 说明 |
|------|-----------|------|
| UHD | 显示器原生（≤4K） | 不设 minWidth/minHeight，适应非 4K 显示器 |
| 1080P | 1920×1080 | 强制 min+max 约束 |
| 720P | 1280×720 | 强制 min+max 约束 |

---

## 7. 关键设计决策

### 7.1 为什么使用 Offscreen Document 而非 Service Worker 直接运行 FFmpeg？

Service Worker 没有 DOM 环境，FFmpeg.wasm 依赖 Web Worker 和部分 DOM API。Offscreen Document 提供完整的 DOM 环境，同时保持与 Service Worker 的消息通信。

**限制**：Chrome 同一时刻只允许一个 Offscreen Document，`orchestrator.js` 通过 `pendingOffscreenCommand` 队列处理并发请求。

### 7.2 为什么使用共享索引池而非 Promise.all 下载分段？

`Promise.all` 会同时在内存中持有所有分段的 ArrayBuffer，对于 2000+ 分段的长视频会导致 OOM。共享索引池让 N 个 Worker 轮流消费队列，任意时刻内存中只有 N 个分段。

### 7.3 为什么 `platforms.js` 的 match 接收 lowercase URL？

`extractGroupTag`、`detectMediaType`、`normalizeUrl` 等函数都先将 URL 转为小写再做特征匹配，统一传入 lowercase URL 避免规则编写者忘记大小写处理。

### 7.4 为什么 `parseDashSegments` 使用 DOMParser 而非正则？

MPD 是 XML，正则无法正确处理属性顺序、命名空间、嵌套结构等情况。DOMParser 在 Chrome Service Worker 中可用（Chrome 99+），且 MV3 已要求 Chrome 88+，版本范围安全。

### 7.5 为什么录制必须采用 Token-First 初始化协议？★ 新增

Chrome 的 `tabCapture` streamId 有约 250ms 的 TTL。一旦 `getMediaStreamId()` 返回，令牌开始计时。如果在调用 `getUserMedia` 之前执行了 IDB 清理、Worker 创建等异步操作，令牌可能在到达 Offscreen Document 时已经过期，导致 `getUserMedia` 以 "Error starting tab capture" 失败。

**Token-First 规则**：`startTest()` 函数的**第一个** `await` 必须是 `getUserMedia`，令牌消费后所有其他初始化工作才安全执行。

### 7.6 为什么使用 PRE_WARM 预热机制？★ 新增

`chrome.offscreen.createDocument()` 本身有约 200-400ms 的冷启动延迟（文档解析、脚本加载）。如果在用户点击录制按钮时才创建 Offscreen，这段延迟会叠加到 TabCapture 令牌的 TTL 上，增加令牌失效的风险。

**PRE_WARM 协议**：Popup 在用户打开录制面板时立即发送 `PRE_WARM_RECORD_OFFSCREEN`，Background 提前调用 `createRecordOffscreen()` 创建 `record.html`。等用户真正点击录制时，Offscreen 已处于就绪状态，只需消费令牌即可。

### 7.7 为什么关闭 Offscreen 前必须先调用 track.stop()？★ 新增

Chrome 的 TabCapture 在 `getUserMedia` 成功后持有一把操作系统级硬件采集锁。`chrome.offscreen.closeDocument()` 仅销毁文档上下文，但底层 `MediaStream` 对象的 GC 是异步的，硬件锁随之延迟释放（可能 >250ms）。

在此窗口期内，如果新的录制请求尝试创建另一个 Offscreen 并再次调用 `getMediaStreamId()`，Chrome 会因采集冲突而失败。

**解决方案**：在销毁文档前，先通过 `CLEAR_RECORD_STORAGE` 消息触发 `offscreen.js` 内的 `t.stop()`，操作系统立即（<10ms）释放硬件锁，后续的 `closeDocument()` 才能以干净状态完成。

### 7.8 为什么 FileSystemFileHandle 通过 IDB 而非 IPC 传递？★ 新增

`chrome.runtime.sendMessage()` 底层使用结构化克隆算法序列化消息，而 `FileSystemFileHandle` 不支持结构化克隆，消息传递时原型链丢失，导致 `handle.createWritable()` 不可用。

IDB 的 `put()`/`get()` 保留了 Handle 的完整原型链。Popup 将 Handle 存入 IDB，FFmpeg Offscreen 处理完成后 Popup 再从 IDB 取回，调用 `handle.createWritable()` 写盘——这一操作在 Popup 上下文中执行，满足 User Activation 要求。

---

## 8. 如何贡献新平台规则

`platforms.js` 是 Vibe 的核心配置中心。如果你想支持一个新站点，只需遵循以下"接口协议"：

### 8.1 规则模板
在 `extension/js/background/platforms.js` 的 `PLATFORM_RULES` 数组中添加一个新对象：

```javascript
{
  id: 'mysite',
  // 1. 匹配逻辑：返回 true 则应用此条规则
  match: (url) => url.includes('mysite.com'),

  // 2. 配对逻辑：从视频/音频 URL 中提取共同的 ID（用于合并）
  groupTag: (url) => url.match(/vid=([^&]+)/)?.[1],

  // 3. 类型识别：返回 'audio' 或 'video'（可选，不填则根据后缀判断）
  mediaType: (url) => url.includes('/audio/') ? 'audio' : 'video',

  // 4. 去重清理：URL 中哪些参数在去重时应该被忽略（如随机数、时间戳）
  normalizeParams: ['token', 'ts'],

  // 5. 代理下载：是否需要通过 Offscreen 伪造 Referer 下载（防盗链）
  proxyRequired: true
}
```

### 8.2 提交建议
1. **先观察控制台**：运行插件并开启 `DEBUG=true`，观察目标站点的网络请求规律。
2. **测试去重**：确保 `normalizeParams` 能覆盖所有变化的参数，避免列表爆炸。
3. **验证配对**：检查配对后的 `groupTag` 是否一致，确保 Popup 能渲染出合并卡片。

---

## 9. 版本更新记录

| 版本 | 主要变更 |
|------|---------|
| **v1.47.1** | 录制质量偏好持久化；修复 UHD 时间戳抖动问题 |
| **v1.47.0** | 极致录制 (Ultimate Recording) 稳定版；IDB remux 管线完整实现 |
| **v1.46.x** | `_isCreating` 原子锁；PRE_WARM 预热协议；硬件采集锁 track.stop() 修复 |
| **v1.45.x** | RecordStorage 统一数据访问层（消除三处重复 IDB 样板）；VibeMuxer 持久 Writer |
| **v1.44.x** | WebM→MP4 remux（FFmpeg container-copy）；音频提取（Opus→MP3）|
| **v1.43.x** | Token-First 初始化协议；修复 RECORD_OFFSCREEN_READY 递归回环 |
| **v1.42.x** | `_activeOffscreenType` 类型标识；FFmpeg/录制 Offscreen 互斥管理 |
| **v1.40.x** | 极致录制 (Ultimate Recording) 初版；WebCodecs + VibeMuxer + IDB 分片 |
| **v1.38.x** | 基础架构（媒体嗅探、HLS/DASH 合并、伴音配对、平台规则表）|

---

*本文档由 Claude Code 与项目维护者协作生成 · Media Sniffer Vibe Dev Team*
