# Media Sniffer Vibe — 架构文档

> 版本：v1.38.9 · 最后更新：2026-03-23

---

## 目录

1. [项目概述](#1-项目概述)
2. [执行上下文总览](#2-执行上下文总览)
3. [目录结构](#3-目录结构)
4. [核心模块说明](#4-核心模块说明)
5. [消息流与数据流](#5-消息流与数据流)
6. [核心功能详解](#6-核心功能详解)
7. [关键设计决策](#7-关键设计决策)

---

## 1. 项目概述

**Media Sniffer Vibe** 是一个基于 Chrome Manifest V3 的浏览器扩展，用于从网页中捕获并下载媒体流（HLS/M3U8、DASH/MPD、MP4、音频）。使用 FFmpeg.wasm 在浏览器内完成分段合并，**零服务器依赖**。

| 属性 | 值 |
|------|-----|
| 平台 | Chrome (Manifest V3) |
| 核心依赖 | FFmpeg.wasm (offscreen)、HLS.js (preview)、Dash.js (preview) |
| 构建工具 | 无（直接加载 `extension/` 目录） |
| 主语言 | JavaScript (ES Modules) |
| 国际化 | 中文 (zh_CN) / 英文 (en) |

---

## 2. 执行上下文总览

Chrome MV3 扩展有四个**完全隔离**的执行上下文，通过 `chrome.runtime.sendMessage` 通信：

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
│   Content Script (页面上下文)   │    │  Offscreen Document (隐藏)   │
│                                 │    │                              │
│  content.js                     │    │  main.js   ← 分段下载池     │
│  ├─ 提取页面 <video>/<audio>    │    │  ffmpeg.js ← FFmpeg.wasm    │
│  ├─ 获取上下文标题              │    │  crypto.js ← AES-128解密    │
│  └─ TikTok script JSON 抽取    │    │                              │
└─────────────────────────────────┘    └──────────────────────────────┘
```

---

## 3. 目录结构

```
media-sniffer-vibe/
├── extension/                      # 插件根目录（Chrome 直接加载此目录）
│   ├── manifest.json               # MV3 清单，权限声明
│   ├── popup.html                  # 弹出窗口 HTML
│   ├── offscreen.html              # Offscreen Document HTML（FFmpeg 宿主）
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
│       │   ├── orchestrator.js     # Offscreen 生命周期管理
│       │   └── storage.js          # Tab 级媒体缓存
│       ├── offscreen/              # Offscreen Worker 模块
│       │   ├── main.js             # 下载池 & 合并任务调度
│       │   ├── ffmpeg.js           # FFmpeg.wasm 初始化 & 执行
│       │   └── crypto.js           # AES-128-CBC 解密
│       ├── popup/                  # 弹出窗口模块
│       │   ├── main.js             # 状态管理 & 事件绑定
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
处理来自 Popup 和 Offscreen 的所有消息类型：

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

### 4.5 `background/orchestrator.js` — Offscreen 生命周期管理

Chrome 同一时刻只允许一个 Offscreen Document。Orchestrator 管理其创建/复用/销毁：

```
handleFfmpegMerge(data)     ─┐
                              ├─► buildMergeCommand() ─► dispatchToOffscreen()
handleProxyDownload(data)   ─┘                               │
                                                              ├─ 文档已存在 → sendMessage
                                                              └─ 文档不存在 → 存入 pendingOffscreenCommand
                                                                            → createOffscreen()
                                                                            → FFMPEG_READY 触发 handleOffscreenReady()
```

---

### 4.6 `offscreen/main.js` — 下载池 & 合并调度

三种任务模式：

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

---

### 4.7 `offscreen/ffmpeg.js` — FFmpeg.wasm 封装

| 函数 | 作用 |
|------|------|
| `initFFmpeg(forceNew)` | 懒加载 + 单例缓存；`forceNew=true` 跳过缓存（用于每次合并前确保干净状态）|
| `runFFmpeg(ffmpeg, args)` | 统一执行入口，捕获异常返回 `-1`，打印完整命令行 |
| `cleanupFS(ffmpeg)` | 清理 MEMFS 中所有工作文件（`part_*.ts`、`final.*`、`concat.txt` 等）|

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

### 5.2 下载合并流

```
Popup 点击下载按钮
        │
  START_FFMPEG_MERGE
        │
  Background main.js
        │
  updateDnrRulesForFetch (注入 Referer/UA)
        │
  orchestrator.handleFfmpegMerge
        │
  ┌─────┴──────┐
Offscreen   创建Offscreen
已存在         └──► FFMPEG_READY
  │                    │
  └────────────────────┘
           │
    FFMPEG_MERGE_SEGMENTS / FFMPEG_MERGE
           │
    offscreen/main.js
           │
    ┌──────┴───────┐
  下载池          initFFmpeg
  (N workers)        │
    │           FFmpeg.wasm
    │             执行合并
    └──────────────┘
           │
    FFMPEG_COMPLETE { filename, blobUrl }
           │
    Background main.js
           │
    chrome.downloads.download(blobUrl, filename)
           │
    closeOffscreen
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

---

*本文档由 Claude Code 与项目维护者协作生成 · Media Sniffer Vibe Dev Team*
