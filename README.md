# Media Sniffer Vibe

[简体中文](#chinese) | [English](#english)

<a name="chinese"></a>
## 简体中文

> **定位**: 一个具备“主权感”的、基于 FFmpeg.wasm 的浏览器原生媒体捕获中枢。
> **核心哲学**: 离线优先，隐私优先，工具集约。

---

### 🚀 1. 安装指南

1.  **获取代码**: 
    *   **方法 A**: 克隆此仓库：`git clone https://github.com/sumachuyuan/media-sniffer-vibe.git`
    *   **方法 B**: 从 [GitHub Releases](https://github.com/sumachuyuan/media-sniffer-vibe/releases) 下载并解压源代码。
2.  **打开扩展页面**: 在 Chrome 浏览器地址栏输入 `chrome://extensions/`。
3.  **开启开发者模式**: 勾选页面右上角的“开发者模式 (Developer mode)”。
4.  **加载插件**: 点击左上角的“加载已解压的扩展程序 (Load unpacked)”，选择项目中的 **extension 文件夹**。
5.  **固定插件**: 点击浏览器工具栏的拼图图标，将 **Media Sniffer Vibe** 固定到工具栏。

---

### 🛠️ 2. 核心功能概览

-   **原生合并 (Native Merge)**: 利用 `FFmpeg.wasm` 技术，在浏览器内部直接将 HLS/DASH/fMP4 分段流合并为 MP4，**零延迟、无需服务器**。
-   **高能模式 (High Performance)**: 🚀 按钮开启 3-5 线程并发抓取，下载提速 300%+。
-   **内存脱水 (Memory Sovereignty)**: 智能回收 `MEMFS` 临时文件，确保任务结束即刻释放系统资源。
-   **主权嗅探**: 自动识别包含 M3U8、MPD、MP4 及音频流在内的多种媒体格式。
-   **隐私合规**: 权限逻辑已进行“权限脱水”审计，不读取任何无关数据。
-   **多语言支持**: 支持中/英双语，一键切换。

---

### 📖 3. 使用手册

#### 第一步：发现媒体
打开包含视频或音频的网页，点击播放。当插件检测到流媒体时，工具栏图标会显示数字。

#### 第二步：选择捕获方式
点击图标打开弹出窗口，您将看到检测到的资源列表：

1.  **合并下载 (MERGE & DOWNLOAD)**:
    *   **适用场景**: M3U8 视频流等。
    *   **操作**: 点击按钮，观察进度条。完成后，浏览器会自动弹出 MP4 下载。
2.  **CMD 指令 (CMD)**:
    *   **适用场景**: YouTube、Bilibili 或需要外部处理（如 4K/8K）的场景。
    *   **操作**: 点击将 `yt-dlp` 指令复制到剪贴板。

---

### 🔧 4. 高级进阶：外部工具指南

为了使用 **CMD** 模式进行高质量下载，您需要在电脑上安装 `yt-dlp` 和 `ffmpeg`。

#### A: 安装 yt-dlp
`yt-dlp` 是目前最强大的命令行音视频下载工具。
*   **macOS**: `brew install yt-dlp` (需安装 [Homebrew](https://brew.sh/))
*   **Windows**: 从 [yt-dlp GitHub Releases](https://github.com/yt-dlp/yt-dlp/releases) 下载 `yt-dlp.exe`，并将其放置在系统的 PATH 环境变量目录下。
*   **Linux**: `sudo wget https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -O /usr/local/bin/yt-dlp && sudo chmod a+rx /usr/local/bin/yt-dlp`

#### B: 安装 FFmpeg
`ffmpeg` 是音视频合并的必备核心引擎。
*   **macOS**: `brew install ffmpeg`
*   **Windows**: 从 [ffmpeg.org](https://ffmpeg.org/download.html) 或 [gyan.dev](https://www.gyan.dev/ffmpeg/builds/) 下载构建包，解压并将 `bin` 目录添加到 PATH。
*   **Linux**: `sudo apt install ffmpeg`

#### C: 使用方法
1. 从插件中点击 **CMD** 按钮复制指令。
2. 打开终端（Terminal）或命令行（CMD/PowerShell）。
3. 粘贴并回车，工具将自动完成下载与合并。

---

<a name="english"></a>
## English

> **Positioning**: A "Sovereign" browser-native media capture engine based on FFmpeg.wasm.
> **Core Philosophy**: Offline-first, Privacy-first, Tool Integration.

---

### 🚀 1. Installation Guide

1.  **Get the Code**: 
    *   **Option A**: Clone this repository: `git clone https://github.com/sumachuyuan/media-sniffer-vibe.git`
    *   **Option B**: Download and extract the source code from [GitHub Releases](https://github.com/sumachuyuan/media-sniffer-vibe/releases).
2.  **Open Extensions Page**: Enter `chrome://extensions/` in the Chrome address bar.
3.  **Enable Developer Mode**: Check "Developer mode" in the top right corner.
4.  **Load Extension**: Click "Load unpacked" and select the **extension folder** within this project.
5.  **Pin Extension**: Click the puzzle icon and pin **Media Sniffer Vibe** to the toolbar.

---

### 🛠️ 2. Key Features

-   **Native Merge**: Leverage `FFmpeg.wasm` to merge HLS/DASH/fMP4 segments directly in the browser—**zero latency, no server required**.
-   **High Performance**: 🚀 button enables 3-5 concurrent threads for 300%+ faster downloads.
-   **Memory Sovereignty**: Proactive `MEMFS` cleanup ensures system resources are released immediately after tasks.
-   **Sovereign Sniffing**: Automatically identifies M3U8, MPD, MP4, and various audio streams.
-   **Privacy Dehydration**: Audited permission logic ensuring zero data collection.
-   **Multilingual**: Support for English and Chinese with one-click toggling.

---

### 📖 3. User Guide

#### Step 1: Discover Media
Open a webpage with video/audio and start playback. The toolbar icon will display the count of detected streams.

#### Step 2: Choose Capture Method
Click the icon to open the popup and see the resource list:

1.  **MERGE & DOWNLOAD**:
    *   **Best for**: M3U8/DASH streams.
    *   **Action**: Click the button and watch the progress bar. The MP4 will download automatically once finished.
2.  **CMD**:
    *   **Best for**: YouTube/Bilibili or scenarios requiring high-quality external processing (e.g., 4K/8K).
    *   **Action**: Copy the `yt-dlp` command to your clipboard.

---

### 🔧 4. Advanced: External Tooling Guide

To use the **CMD** mode for high-quality downloads, you need to install `yt-dlp` and `ffmpeg` on your computer.

#### A: Install yt-dlp
*   **macOS**: `brew install yt-dlp`
*   **Windows**: Download `yt-dlp.exe` from [GitHub Releases](https://github.com/yt-dlp/yt-dlp/releases).
*   **Linux**: `sudo wget https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -O /usr/local/bin/yt-dlp && sudo chmod a+rx /usr/local/bin/yt-dlp`

#### B: Install FFmpeg
*   **macOS**: `brew install ffmpeg`
*   **Windows**: Download from [ffmpeg.org](https://ffmpeg.org/download.html).
*   **Linux**: `sudo apt install ffmpeg`

#### C: Usage
1. Click the **CMD** button in the extension to copy the command.
2. Open your Terminal or CMD/PowerShell.
3. Paste and press Enter. The tool will automatically download and merge the media.

---

## 🔒 Privacy & Legal / 隐私与法律

This tool is for educational and research purposes only. Please respect content copyrights. 
本工具仅供学习与研究使用。请尊重内容版权。

*2026-03-20 | Media Sniffer Vibe Dev Team*
