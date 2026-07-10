<div align="center">

<a href="https://gythiro.github.io/yt-dual-subs/"><img src="https://gythiro.github.io/yt-dual-subs/img/icon128.png" width="110" alt="Dual Subtitles for YouTube 图标"></a>

# Dual Subtitles for YouTube™

**一次看两种语言 —— 原文与译文同处一层、永不重叠，按整句干净切换。**

[![Chrome Web Store 版本](https://img.shields.io/chrome-web-store/v/ndifcigakimmibkgeabchfaolhjpcmge?style=flat-square&logo=googlechrome&logoColor=white&label=chrome%20web%20store)](https://chromewebstore.google.com/detail/dual-subtitles-for-youtub/ndifcigakimmibkgeabchfaolhjpcmge)
[![许可: MIT](https://img.shields.io/badge/license-MIT-green?style=flat-square)](LICENSE)

<a href="https://chromewebstore.google.com/detail/dual-subtitles-for-youtub/ndifcigakimmibkgeabchfaolhjpcmge"><img src="https://img.shields.io/badge/%E5%AE%89%E8%A3%85-Chrome%20%E7%BD%91%E4%B8%8A%E5%BA%94%E7%94%A8%E5%BA%97-4285F4?style=for-the-badge&logo=googlechrome&logoColor=white" alt="从 Chrome 网上应用店安装"></a>&nbsp;&nbsp;<a href="https://gythiro.github.io/yt-dual-subs/"><img src="https://img.shields.io/badge/%E5%AE%98%E6%96%B9%E7%BD%91%E7%AB%99-gythiro.github.io-2ea44f?style=for-the-badge" alt="官方网站"></a>&nbsp;&nbsp;<a href="README.md"><img src="https://img.shields.io/badge/English-README.md-orange?style=for-the-badge" alt="English README"></a>

[English](README.md) | 简体中文

<br>

<img src="https://gythiro.github.io/yt-dual-subs/img/screenshot-overlay.png" width="800" alt="YouTube 视频上的双语字幕 —— 英文原文在上、中文译文在下，同处一个覆盖层">

<sub>一个完全独立（clean-room）、开源的 <b>Manifest V3</b> 扩展。它读取视频真正的字幕轨、即时翻译，再把两种语言渲染在一个可自定义、可拖动的图层里。</sub>

</div>

---

> [!IMPORTANT]
> **无统计、无追踪、无账号。** 字幕文本只会发送到当前使用的翻译服务（YouTube 自身或 Google 翻译 —— 由默认的「自动」模式按视频选择，也可手动指定）用于翻译。设置保存在 `chrome.storage.sync` —— 除此之外没有任何数据离开你的浏览器。

## ✨ 功能一览

<table>
<tr>
<td width="50%" valign="top" align="center">

<h3>一层字幕，零重叠，零抖动。</h3>

<img src="https://gythiro.github.io/yt-dual-subs/img/compare-zh.png" width="400" alt="前后对比：其他工具的原文与译文撞在一起；本扩展上下分明不重叠">

</td>
<td width="50%" valign="top" align="center">

<h3>每一行，随你调。</h3>

<img src="https://gythiro.github.io/yt-dual-subs/img/screenshot-popup.zh.png" width="320" alt="带实时预览的设置弹窗：目标语言、翻译引擎与布局控制">

</td>
</tr>
<tr>
<td valign="top">

- **双语单层** —— 一行原文、一行译文；YouTube 自带字幕层被隐藏，两者永不重叠。
- **整句切换，不抖动** —— 直接用带时间轴的字幕 *cue*（而非屏幕上滚动刷新的文本）渲染，按整句切换，不再逐词闪烁。
- **双引擎，聪明的默认值** —— 视频支持时用 YouTube 自带的整轨翻译；不支持时自动换用聪明得多的备选：先把碎片字幕**拼回完整句子**再交给 Google 翻译，碎片式「翻译腔渣渣」从根上消失。译文提前预取。
- **16 种目标语言**可选。

</td>
<td valign="top">

- **高度可定制** —— 每一行的字体、字号、文字色、背景色 + 透明度、描边、行间距、上下顺序都能单独设置，弹窗里有实时预览。
- **可拖动** —— 把字幕框拖到画面任意位置，会记住；双击手柄复位；全屏下同样可用。
- **一键开关** —— 播放器控制栏按钮一键开/关整个扩展（连带 YouTube 的 CC）。
- **导出 SRT** —— 把当前视频的字幕导出成 `.srt`：原文、译文或双语。
- **稳健** —— 支持 YouTube 单页跳转；取 cue 失败自动回退为读取屏幕字幕；并会自动帮你打开 YouTube 字幕。

</td>
</tr>
</table>

## 🚀 安装

**[➜ 从 Chrome 网上应用店安装](https://chromewebstore.google.com/detail/dual-subtitles-for-youtub/ndifcigakimmibkgeabchfaolhjpcmge)** —— 一键安装，自动更新。

然后打开任意有字幕的 YouTube 视频：双语字幕自动出现（扩展会替你打开 CC）。

支持 **Chrome、Edge 等 Chromium 浏览器**，需 111+（主世界 content script 的要求）。

<details>
<summary><b>🧑‍💻 加载已解压的扩展（开发者）</b></summary>

1. 到 [Releases 页面](https://github.com/Gythiro/yt-dual-subs/releases/latest)**下载最新版 ZIP** 并解压。*（喜欢命令行也可以直接 `git clone`。）*
1. 打开 `chrome://extensions`。
1. 打开右上角的**开发者模式**。
1. 点击**加载已解压的扩展程序**，选择解压后的文件夹。
1. 打开任意有字幕的 YouTube 视频 —— 字幕会自动出现。

> ⚠️ **若提示「清单文件丢失或不可读取 / Manifest file is missing or unreadable」**：几乎都是解压成了**文件夹套文件夹**（`yt-dual-subs\yt-dual-subs\`）。请一直点进去，选**直接能看到 `manifest.json` 的那一层**再加载。请优先用 **Releases 页面**里的 ZIP（解压只有一层），不要用绿色 **Code** 按钮下的源码包；也要确认是**真的解压**出来、而不是在压缩包里直接加载。

</details>

## 🌐 官方网站

**[gythiro.github.io/yt-dual-subs](https://gythiro.github.io/yt-dual-subs/)** —— 扩展的官方主页，**中英双语**：功能可视化演示、安装入口、最新动态，一页看完。想把这个扩展推荐给朋友，发这个链接就够了。

## ⚙️ 使用

- **工具栏图标** → 设置弹窗：目标语言、翻译引擎、上下顺序、位置、行间距，以及每一行的样式，均带实时预览。
- **控制栏按钮**（齿轮旁边那个字幕框图标）：一键开/关。**蓝色 = 开，灰色 = 关。**
- **拖动**：鼠标移到播放器上，字幕框左上角出现拖动手柄；**双击手柄**复位。
- **导出**（弹窗 → 导出字幕）：把字幕下载成 `.srt` 文件 —— 可选原文、译文或双语。

## 📖 细节

<details>
<summary><b>🔬 工作原理</b></summary>

YouTube 的字幕来自 `/api/timedtext` 接口，如今每次请求都需要一个 **proof‑of‑origin token（`pot`）**。扩展自己直接去拉字幕 URL 会拿到**空响应**。所以做法是：

1. 一个运行在页面主世界（MAIN world）的脚本 `inject.js` **被动**监听页面网络（XHR、`fetch`、Resource Timing），抓取**播放器自己**发出的、已经带着有效 `pot` 的那条 timedtext 请求。
1. 用这条 URL 以 `json3` 取原文 cue，再加 `&tlang=` 取 YouTube 的译文 —— 两者逐句对齐。
1. `content.js` 按 `video.currentTime` 驱动覆盖层，在正确的时间显示对应整句及其译文，同时隐藏 YouTube 原生字幕层，做到单层不重叠。
1. 万一取 cue 失败，自动回退为直接读取屏幕上的字幕文本。

</details>

<details>
<summary><b>🔁 两套翻译引擎对比</b></summary>

默认的**自动**模式：视频的字幕轨可翻译时用整轨翻译，不可翻译时自动切到智能整句。也可以在弹窗里手动指定任一引擎 —— 觉得整轨翻译读不通时，值得切到智能整句试试。

| | 整轨翻译（YouTube） | 智能整句（Google） |
|---|---|---|
| 来源 | YouTube 服务端整轨翻译 | Google 免费翻译接口 |
| 方式 | 服务端整轨翻译，逐条完美对齐 | 先把碎片字幕**拼回完整句子**，再整句送翻 |
| 适合 | 大多数视频 —— 默认 | YouTube 翻不了的轨道，或整轨翻译在碎片字幕上读不通的视频 |
| 备注 | 质量取决于 YouTube 对该轨的切分 | 非官方接口，重度使用可能被短暂限流；扩展会自动放慢并重试 |

</details>

<details>
<summary><b>⏳ 翻译偶尔不出来？</b></summary>

智能整句引擎走的是 Google 免费公共接口，重度使用（超长视频、频繁拖进度条）时可能被短暂限流。扩展会自己发现并放慢重试：等待期间译文行显示「…」，翻译通常在几秒到一两分钟内自动恢复。已翻译过的句子有缓存，不受影响。若视频支持，在弹窗里手动指定「整轨翻译（YouTube）」可完全绕开免费接口。导出 SRT 不受影响 —— 它走的是另一条通道。

</details>

<details>
<summary><b>⚠️ 已知限制</b></summary>

- 需要真正的字幕轨。**烧录进画面**的硬字幕（画进视频像素里的）无法隐藏 —— 这类视频用控制栏按钮把覆盖层关掉即可。
- 智能整句用的是非官方 Google 接口，无 SLA，重度使用可能被短暂限流（扩展会自动退避并恢复）。
- 依赖 YouTube 当前行为；YouTube 大改版时可能需要更新选择器。

</details>

<details>
<summary><b>🛠 开发</b></summary>

纯原生 JS/CSS，无需构建、无依赖。

| 文件 | 作用 |
|---|---|
| `inject.js` | 主世界嗅探：抓取播放器带 `pot` 的 timedtext URL，取 cue + 译文 |
| `content.js` | 覆盖层、cue 引擎、拖动、控制栏开关、读屏回退 |
| `background.js` | 翻译 service worker（Google 接口） |
| `popup.html/.css/.js` | 带实时预览的设置界面 |
| `content.css` | 覆盖层样式 + 隐藏原生字幕 |

欢迎提 Issue 和 Pull Request —— [入口在这里](https://github.com/Gythiro/yt-dual-subs/issues)。

</details>

## 🔒 隐私

无统计、无追踪、无账号。字幕文本**仅**发送到你选择的翻译服务用于翻译；设置保存在 `chrome.storage.sync`。完整政策见 [PRIVACY.md](PRIVACY.md)。

## 🙏 致谢

本项目是受（已停更、闭源的）*YouTube™ Dual Subtitles* 启发的**全新独立实现** —— 未使用其任何代码，并从根本上解决了重叠与逐词跳动的问题。

## 📜 许可

[MIT](LICENSE)。

---

<sub>*本扩展非 YouTube / Google LLC 官方出品，与其无任何关联，亦未获其背书或赞助。「YouTube」是 Google LLC 的商标，此处仅用于说明兼容性。*</sub>

<p align="right"><a href="#readme">↑ 回到顶部</a></p>
