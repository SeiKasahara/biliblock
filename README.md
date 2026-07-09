<h1 align="center">BiliUserBlock</h1>

<p align="center">
  <img src="assets/rana.jpg" alt="rana">
</p>

<p align="center">B 站深度学习个人屏蔽助手</p>

<p align="center">
  <img src="https://img.shields.io/badge/Manifest-V3-4285F4" alt="Manifest V3">
  <img src="https://img.shields.io/badge/Chrome%20%7C%20Edge-Chromium-46a2f1" alt="Platform">
  <img src="https://img.shields.io/badge/WebGPU-local%20ML-ff6f61" alt="WebGPU">
  <img src="https://img.shields.io/badge/build-none-success" alt="No build">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="License">
</p>

把一个 UID 加进名单，他的**投稿、评论、动态、弹幕**在整个 bilibili.com 对你消失，纯本地过滤，**不占官方拉黑名额，对方无感知**。

包含传统算法 → 本地深度学习(WebGPU) → 大模型」三层递进筛选，**全程从一键标注的样例里学习**。

---

### 从你的操作里主动学习

- 评论旁点 **🚫** = 拉黑此人 + 把这条记为「应屏蔽」样例（文本喂上面三层、图片进图库）。
- 浅屏蔽下对误杀点 **✓ 这条正常** = 记为「正常」样例。**所有层都尊重它**——近重复白名单、语义把相似评论拉离、大模型 few-shot、图片白库，越用越准，误杀越来越少。

### 本地优先 · 免费 · 隐私

**WebGPU，wasm支持**，不消耗任何 token、不上传评论
- **不占官方拉黑名额**，对方完全无感知。
- **全站生效**：评论（含楼中楼）、动态、投稿、搜索、首页/热门/相关推荐、**联合投稿（合作 UP 也挡）**、弹幕。
- **每人深/浅可调**：某些人彻底不可见，某些人折叠成可展开的占位条。
- **多端同步 + 导入导出**：名单与设置随浏览器账号同步。

---

## 特性一览

- **按 UID 全站屏蔽** —— 不占官方名额，对方无感知。
- **文本刷屏三层筛选** —— 近重复(传统) → 语义(WebGPU) → 大模型。
- **图片评论三层筛选** —— pHash(传统) → CLIP(WebGPU) → 视觉大模型。
- **样例主动学习** —— 🚫 / ✓ 一键标注，各层共用、越用越准。
- **两级强度，逐人可调** —— 深屏蔽无闪现，浅屏蔽可展开。
- **关键词 / 正则** —— 零成本本地兜底，不接任何模型也能用。
- **弹幕屏蔽** —— CRC32 匹配 midHash。
- **多端同步 / JSON 导入导出**。
- **纯本地、免构建** —— 除你自配的大模型请求外，无任何数据外发。

## 安装

1. 下载或 `git clone` 本仓库（CLIP/文本模型需要的 wasm 见 [`vendor/README.md`](vendor/README.md)）。
2. Chrome / Edge 打开 `chrome://extensions`，开启右上角**开发者模式**。
3. 点**加载已解压的扩展程序**，选择仓库根目录。
4. 刷新任意 B 站页面。

免构建。改完代码在扩展页点刷新，再刷新页面即可。也可用 `pack.ps1` 打成 zip 分发（见[打包](#打包发布)）。

## 快速上手

| 操作 | 方式 |
| --- | --- |
| 屏蔽 + 学习 | 评论昵称旁点 `🚫`：拉黑该用户 + 记住这条 ／ 右键用户空间链接 ／ 扩展弹窗输入 UID |
| 纠正误屏蔽 | 浅屏蔽下，对被自动折叠的评论点「✓ 这条正常」 |
| 开自动屏蔽 | 点扩展图标：图片查重、图片相似、大模型、**语义刷屏阈值滑块**（默认全关，按需开） |
| 细调 | 进设置页：阈值、置信度、提示词、样例库、每人强度… |

## 大模型筛选

设置页 → **大模型筛选** → 开开关 → 选服务商 → 填 API Key → **测试连接**。判定结果本地缓存（默认 30 天），同一条评论不重复请求。筛选标准由**自定义提示词** + 你标注的**样例**决定。

| 服务商 | 推荐模型 | 说明 |
| --- | --- | --- |
| 智谱 GLM | `glm-4-flash` / 视觉 `glm-4v-flash` | 免费，国内直连 |
| OpenRouter | `…:free` | 免费额度，需注册 Key |
| 本地 Ollama | `qwen2.5:7b` | 离线免费、隐私最佳 |
| 硅基流动 / Groq / DeepSeek / OpenAI / 自定义 | — | 兼容 OpenAI `/chat/completions` |

**带图评论**可勾选「识别配图（多模态）」，连图片交给视觉模型判断。

## 本地模型（WebGPU）

第②层（语义文本、图片 CLIP）在浏览器本地用 WebGPU 跑 [Transformers.js](https://github.com/huggingface/transformers.js)：

- 运行时依赖（Transformers.js + ONNX Runtime wasm）放在 `vendor/`（wasm 较大，`.gitignore` 默认忽略，按 `vendor/README.md` 拉取）。
- 模型权重首次从 Hugging Face 下载并由浏览器缓存（文本 `bge-small-zh` ~24MB、图片 `clip-vit-base-patch32`）；启用时需授权 `huggingface.co`。
- 推理放在 **offscreen document**（MV3 的 Service Worker 无 WebGPU），失败自动回退 wasm、再不行则该层静默降级，不影响其它屏蔽。
- **算法要点**：文本 embedding 有强各向异性（不相关句子余弦也 0.5+），故先**按批次去均值**消除公共方向，再 **kNN + 置信度门槛（比正常基线高多少才屏蔽）** 抗小样本误伤——这是能把「正常评论」和「刷屏」在真实数据上拉开的关键。设计与实测见 [`docs/local-model-research.md`](docs/local-model-research.md)。

## 降低误杀

```
浅屏蔽浏览  →  误杀点「✓ 这条正常」/ 漏网点「🚫」  →  攒够样例  →  满意后切深屏蔽
```

- 三层文本 + 三层图片都从这两个按钮学习，`✓` 的修正**所有层都生效**（近重复白名单、语义拉离、大模型 few-shot、图片白库），并持久化——刷新后不复发。
- 想让整页按新样例回溯重判，点设置页「清空 AI 缓存并重新评估」。
- 大模型默认提示词按「宁可漏放，不可错杀」编写，并列出不该屏蔽的类型（正常批评、玩梗、无害闲聊…）。

## 生效范围

| 板块 | 屏蔽依据 |
| --- | --- |
| 评论（含楼中楼） | UID / 关键词 / 文本三层 / 图片三层 |
| 动态 feed | UID / 关键词 |
| 用户空间投稿 | UID（含联合投稿人） |
| 搜索结果 | UID（含联合投稿人）/ 关键词 |
| 首页 / 热门 / 相关推荐 | UID（含联合投稿人）/ 关键词 |
| 弹幕 | UID（CRC32 匹配 midHash）/ 关键词 |

每一项都可在设置页单独开关。

## 工作原理

三处协作，共用同一份名单与样例：

1. **接口拦截（主世界）**：`document_start` 劫持 `window.fetch`，在 B 站接口返回时就剔除被屏蔽 UID 的数据（深屏蔽无闪现）；弹幕解析 `seg.so` protobuf，用 `CRC32(uid)` 匹配 `midHash` 丢弃。
2. **DOM 兜底（隔离世界）**：穿透 Shadow DOM 扫描评论与卡片，按 UID / 关键词判隐藏或折叠、注入 🚫 按钮，并把文本/图片评论送去后台分类。
3. **后台分类（Service Worker + offscreen）**：三层文本、三层图片、缓存判定；WebGPU 推理在 offscreen document 完成。名单/设置存 `chrome.storage.sync`（分片）多端同步。

## 目录结构

```
manifest.json  ·  icons/  ·  vendor/（Transformers.js + wasm）
src/
  common/      crc32 · filter-core · defaults · endpoints · store · textdup（文本近重复）
  inject/      dmproto（弹幕）· inject（fetch 拦截，主世界）
  content/     scanner（Shadow DOM 扫描）· content（编排，隔离世界）
  background/  llm · phash · background（三层流水线，Service Worker）
offscreen/     offscreen（WebGPU 本地 embedding：CLIP + bge-small-zh）
ui/            popup（弹窗）· options（设置与名单）
docs/          local-model-research（本地模型选型与算法调研）
pack.ps1       打包为可安装 zip
```

## 打包发布

```powershell
powershell -ExecutionPolicy Bypass -File pack.ps1
```

在 `release/` 生成安装 zip（manifest 在压缩包根部、含 vendor wasm、正斜杠路径可跨平台）。解压后「加载已解压的扩展程序」，或上传 Chrome 应用商店。

## 隐私

- 屏蔽逻辑全在本地浏览器内完成；名单与设置默认只在浏览器同步存储。
- **本地模型层不外发任何数据**。唯一外发是你主动开启大模型层后，把评论文本/图片发给**你自己配置**的 API；想完全离线用本地 Ollama。
- API Key 随账号同步，介意可留空、改用本地模型。

## License

MIT。个人使用的非官方工具，与 bilibili 无关，请遵守 B 站用户协议，风险自负。
