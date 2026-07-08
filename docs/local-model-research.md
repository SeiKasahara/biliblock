# 本地小模型（WebGPU）评论筛选调研

> 目标：在浏览器扩展内用 WebGPU 跑一个轻量模型，免费、离线、私密地判定评论是否屏蔽，并复用用户手动标注的 🧠/✓ 样例。
> 体积/显存标注 `约` 或 `未核实` 的为二手来源或从基座模型推算，落地前需对着 HF `config.json` / Files 再确认。来源见文末。

## 结论（TL;DR）

1. **可行**。首选运行时 **Transformers.js v3**（底层 ONNX Runtime Web，`device:'webgpu'`，支持完全离线）。
2. **最契合的方案不是跑大模型，而是「小型中文 embedding + 你的样例」**：用 `bge-small-zh-v1.5`（原生中文，约 24MB/q8）把评论和样例都编码成向量，按"与 block/allow 样例的相似度"判定。免费、离线、毫秒级，天然复用现有样例机制。
3. **短板**：embedding 靠"像不像我屏蔽过的"，对没有样例覆盖的抽象类别（剧透、特定广告话术）偏弱 → **混合**：本地兜大头，边界样本可选走云端 LLM。
4. **图片（本项目最高优先，见 §0）**：核心不是"描述图里有什么"，而是"这张图像不像我标过的恶心图" → 用**图像相似度 + 样例**，比 VLM 轻得多。最便宜的一层（pHash）甚至不用模型、不用 WebGPU，可立刻做。
5. **最大工程坑**：WebGPU **不能可靠地在 MV3 service worker 里跑**，必须用 **offscreen document** 承载推理；模型与 ORT 的 wasm **打包进扩展**（离线、绕开 CSP）。

---

## 0. 重点场景：图片评论的主动学习

**需求**：有人只发一张图，图本身很恶心。要让工具从"你手动屏蔽过的图"里**主动学会**挡掉类似的。

关键洞察：这不是"让模型看懂图在说什么"（那要重量级 VLM），而是"这张图**像不像**我标过的坏图" → **图像相似度 + 样例库**即可，且最便宜的一层不用任何模型。分三层，按便宜→重，**建议按序落地**：

### 第 1 层：感知哈希 pHash（本地、无模型、无 WebGPU —— 先做这个）

- 点 🧠 屏蔽一条图片评论 → 后台取图算 **pHash**（缩 32×32 灰度 → DCT → 取低频符号，64bit）存进"黑图哈希库"。
- 新图算 pHash，与库里任一条**汉明距离 ≤ 阈值**（如 ≤10）→ 屏蔽。
- 抓的是**被反复转发/搬运的同一张图**——恶心图这类占大头，这一层就能挡掉很多。
- 全本地、零模型、每图几毫秒。后台 Service Worker 里：`fetch` 图 → `createImageBitmap` → `OffscreenCanvas` → `getImageData` → 算哈希（**不需要 WebGPU**）。
- 前提：加 `*://*.hdslb.com/*` host 权限取图；pHash 很小可存 sync 同步。

### 第 2 层：CLIP 图向量 + 样例 kNN（WebGPU、学"同类"）

- 同内容不同文件、同类型但非同一张，pHash 抓不到 → 用 **CLIP 图像编码器**把图编码成向量。
- 你屏蔽的图向量入黑库、放行的入白库；新图向量比最相似的样例（kNN/质心）→ 判定。
- **这才是"主动学习图片特征"**：样例库越大越准，正是你要的。
- 模型：`Xenova/clip-vit-base-patch32`，或 **Chinese-CLIP**（额外能对中文标签零样本打分，如"血腥/色情/恶心 vs 正常"，无样例也有初判）。约百 MB 级、比 2B VLM 轻一个数量级。
- 走 offscreen + transformers.js（见 §5）。图向量较大（几百浮点）→ 存 `storage.local`，不进 sync。

### 第 3 层：VLM 读懂新图（重、可选兜底）

- 全新、和任何样例都不像的图 → 让视觉模型描述/判断。
- **现已实现的云端多模态**（glm-4v-flash 等）就是这一层；或本地 `Qwen2-VL-2B`（多 GB、慢）。
- 定位：前两层都"不确定"时才动用，结果回写缓存、并可加进样例库供前两层以后直接命中。

### 三层协作

```
图片评论
  ├─ pHash 命中黑库?     ──是→ 屏蔽（毫秒，无模型）
  │        └白库? ─是→ 保留
  ├─ CLIP 向量像黑图?    ──是→ 屏蔽
  │        像白图? ─是→ 保留
  │        都不像 ↓
  └─（可选）VLM/云端判 → 屏蔽/保留，结果与向量回写样例库
```

### 🧠 / ✓ 如何喂养

- 🧠 屏蔽一条图片评论：存该图 **pHash**（第1层）+（若开）**CLIP 向量**（第2层）进黑库。
- ✓ 这条正常：存进白库，压制误杀。
- 与现有文本样例并存，图片样例**只存哈希/向量、不存原图**。

> **建议**：先落地第 1 层（pHash）——不碰 WebGPU/offscreen，改动小、当天可上，且直接解决"同一张恶心图被反复发"的主要痛点。第 2 层再上 CLIP 做泛化。第 3 层复用你已有的云端多模态。

---

## 1. 目标与约束

| 维度 | 要求 |
|---|---|
| 任务 | 中文短文本二分类（屏蔽 / 保留），可选图片 |
| 成本 | 零 token、零速率限制 |
| 隐私 | 评论不出本机 |
| 学习 | 直接吃现有 `block`/`allow` 样例 |
| 体积 | 越小越好（打包进扩展或首次下载缓存） |
| 延迟 | 冷启动数秒可接受；单条推理需毫秒级 |
| 上下文 | MV3：SW 无 WebGPU；需 offscreen document |

## 2. 运行时选型

| 运行时 | 用途 | WebGPU | 离线 | 备注 |
|---|---|---|---|---|
| **Transformers.js v3** ⭐ | embedding / 分类 / VLM / OCR(TrOCR) | ✅ `device:'webgpu'` | ✅ `allowRemoteModels=false` | 底层 ONNX Runtime Web；包名 `@huggingface/transformers`；dtype 支持 fp32/fp16/q8/q4/q4f16 |
| ONNX Runtime Web | 自己加载任意 ONNX | ✅ WebGPU EP | ✅ | 更底层，需自己写 tokenizer/后处理 |
| WebLLM (mlc-ai) | 本地小 LLM | ✅ | ✅（权重可缓存） | OpenAI 兼容 API，模型数百 MB~GB 级 |
| Paddle.js | 中文 OCR | 主要 WebGL | ✅ | `@paddlejs-models/ocr` 开箱即用 |
| TensorFlow.js | 通用 | WebGPU 后端 | ✅ | 生态上不如前者贴合 NLP |

**选 Transformers.js**：一个库覆盖 embedding / 零样本分类 / VLM / OCR，API 统一，WebGPU + 离线都直接支持。

## 3. 候选模型

### 3.1 文本判定 —— 句向量 embedding（推荐路线）

| 模型（transformers.js repo） | 参数 | 维度 | 约 q8 体积 | 中文 |
|---|---|---|---|---|
| **`Xenova/bge-small-zh-v1.5`** ⭐ | 约 24M | 512（未核实） | 约 24MB | 原生中文（BAAI zh） |
| `Xenova/multilingual-e5-small` | 约 118M | 384 | 约 115–120MB | 强，100 语言 |
| `Xenova/paraphrase-multilingual-MiniLM-L12-v2` | 118M | 384 | 约 115–120MB | 50+ 语言；**最大仅 128 token** |
| `onnx-community/gte-multilingual-base` | 约 305M | 768 | 约 300MB | 70+ 语言，8192 seq；需较新版 transformers.js（旧版报 `Unknown model class "new"`） |
| `Xenova/all-MiniLM-L6-v2` | 约 22.7M | 384 | 约 23MB | ❌ 英文为主，中文弱 |
| `Xenova/gte-small` | 约 33M | 384 | 约 33MB | ❌ 仅英文 |

> 选 **`bge-small-zh-v1.5`**：中文原生 + 体积最小。评论多为短句，512 token 上限足够。`multilingual-e5-small` 作为多语言备选（体积大 5 倍）。**别用** all-MiniLM / gte-small（英文向，B 站中文场景不合适）。

### 3.2 文本判定 —— 零样本分类（无样例也能用）

- `Xenova/mDeBERTa-v3-base-xnli-multilingual-nli-2mil7`：`pipeline('zero-shot-classification')`，可自定义中文假设标签（如"这是引战/广告/剧透"）。
- 参数约 278M（含大词表），int8 约 140MB（**未核实**）。多语言含中文。
- 定位：**冷启动**（样例还没攒够时）或补 embedding 覆盖不到的抽象类别。比 LLM 轻，比 embedding 更懂"类别"。

### 3.3 文本判定 —— 本地小 LLM（WebLLM）

| 模型 | 约显存(q4f16) | 中文 |
|---|---|---|
| Qwen2.5-0.5B-Instruct | 约 945MB | 强（原生双语） |
| Qwen2.5-1.5B-Instruct | 约 1630MB | 强 |
| Llama-3.2-1B / SmolLM2-1.7B / gemma-2-2b | ~0.9–1.9GB | 一般/弱 |

> 下载体积≈显存（**未单独核实**）。优点：真有推理，能懂"剧透/阴阳怪气"这类抽象策略，还能直接用你现有的提示词。缺点：下载数百 MB~GB、首推理慢、吃显存。定位：**追求判定质量、能接受大模型下载**的高级选项，或对 embedding 判"不确定"的样本做二次裁决（本地版的"边界样本升级"）。

### 3.4 图片 —— OCR（抠出图里的字）

| 方案 | 中文 | 说明 |
|---|---|---|
| `@paddlejs-models/ocr` | ✅ | 检测+识别两模型，WebGL；开箱即用；体积未文档化 |
| RapidOCR / PaddleOCR→ONNX | ✅ | 模型小（识别 1.5M~34M 参数，整套常 <20MB），但**无官方浏览器构建**，要自己用 onnxruntime-web 加载 |
| TrOCR（transformers.js） | ❌ | 公开权重仅英文印刷体、单行、无检测，不适合中文表情包 |

### 3.5 图片 —— 图生文 / 特征打分

- **图生文（中文）**：`onnx-community/Qwen2-VL-2B-Instruct`，transformers.js + WebGPU，支持中英、能读图内文字并用中文描述。缺点：约 2B、多 GB 下载、每图慢。
- **零样本图分类（更轻）**：`Xenova/clip-vit-base-patch32` 或 Chinese-CLIP，对**你自定义的中文标签**打分（如"色情/引流/引战图"），比逐图描述便宜得多。
- 建议：图片先靠 CLIP 零样本兜；需要"读懂梗图内容"再上 Qwen2-VL 作为可选重档。

## 4. 推荐架构：Embedding + 样例学习

### 4.1 流程

```
                      ┌─ 你的样例(block/allow) ──[bge-small-zh]──> 样例向量集(离线预算一次, 缓存)
评论文本 ──[bge-small-zh, WebGPU]──> 评论向量 ──┐
                                              ├─ 与样例集比对 ──> 分数 ──> block / keep / 不确定
                      ┌────────────────────────┘
                      └─ 不确定(可选) ──> 云端 LLM 裁决
```

### 4.2 判定算法（从简到好，任选）

1. **最近质心**：block/allow 各求 L2 归一化后的均值向量 `Cb`/`Ca`；`score = cos(v,Cb) − cos(v,Ca)`。
2. **加权 kNN**：取最相似的 k 条样例（k≈5），按相似度加权投票。对样例分布不均更稳。
3. **逻辑回归头**：在样例向量上训一个 `dim→1` 的 sigmoid（纯 JS 几十行梯度下降即可），输出**校准过的概率**，最适合配阈值。

### 4.3 阈值 —— 落实"宁可漏放"

- 双阈值：`p > τ_high` 才屏蔽；`p < τ_low` 保留；中间 = 不确定。
- 不确定的处理：默认**保留**（宁可漏放）；或可选升级到云端 LLM / 本地 LLM 裁决。
- `τ_high` 给高一点（如 0.8），把 embedding 只用在"高置信、明显像屏蔽过的"上。

### 4.4 冷启动与混合

- 样例太少（如每类 < 8~10 条）→ 关闭本地模型判定，退回**关键词 + 云端 LLM**。
- 与现有 UID / 关键词规则取并集；embedding 只负责"语义相似"这一层。
- 抽象类别（剧透等）embedding 覆盖不到 → 混合 3.2 零样本或 3.3 本地 LLM。

### 4.5 与现有代码对接

现在 `background.js → handleClassify → llm.classify(fetch)`。本地方案只是多一个 **provider = local**：

- 复用 `store.getExamples()`（样例）、LLM 判定缓存（按 rpid/文本哈希，避免重复推理）。
- `background` 不直接推理（SW 无 WebGPU）→ 转发给 **offscreen document** 里的 transformers.js，拿回向量/判定。
- 内容脚本、样例、缓存、🧠/✓ 全部不动；只是判定引擎从"云端 fetch"换成/并行"本地 offscreen"。

## 5. 扩展工程落地

### 5.1 WebGPU 上下文（关键）

- MV3 **service worker 里 `navigator.gpu` 不可靠**（WebGPU-in-Workers 到 Chrome 124 才进，且扩展 SW 仍常被报有问题）。
- **用 offscreen document**：SW ⇄ offscreen（跑 transformers.js/ONNX）消息通信。需 `offscreen` 权限。`chrome.offscreen` 的 `reasons` 没有 ML 专用项，社区普遍填 `["BLOBS"]`（公认的 workaround）。
- 内容脚本本身处在 Window 上下文、理论上有 `navigator.gpu`（**未见扩展专门文档，属推断**），但每个标签页各加载一份模型太浪费 → 单例 offscreen 更优。

### 5.2 模型与 wasm 托管

- **打包进扩展**（推荐）：把 ONNX 权重 + ORT 的 `.wasm/.mjs` 放进扩展，`web_accessible_resources` 暴露，`env.allowRemoteModels=false` / `env.localModelPath` / `env.backends.onnx.wasm.wasmPaths` 指向本地。→ 完全离线、绕开远程 CSP、无首次下载。代价：扩展包变大（约 +25MB）。
- 或**首次从 HF 下载 + Cache API 缓存**：包小，但需 `huggingface.co` 等 host 权限，且要处理 CSP。

### 5.3 CSP

MV3 默认不含 `wasm-unsafe-eval`，ONNX Runtime Web 的 WASM 必须声明：

```json
"content_security_policy": {
  "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"
}
```

（不能加 `'unsafe-eval'`。）

### 5.4 内存 / 冷启动

- 冷启动：首次加载模型 + 编译 WebGPU 管线，数秒；之后常驻 offscreen。
- 显存/内存：embedding 小模型几十~一两百 MB；本地 LLM 上 GB。
- 缓存判定结果（现有机制），同一条评论不重复推理。

## 6. 取舍总表

| 方案 | 体积 | 中文 | 懂抽象策略 | 用样例 | 速度 | 适用 |
|---|---|---|---|---|---|---|
| **A. bge-small-zh + 样例** ⭐ | 约 25MB | ✅ | 弱 | ✅✅ | 快 | 主力，免费离线 |
| B. mDeBERTa 零样本 | 约 140MB | 中 | 中 | ✗ | 中 | 冷启动 / 补类别 |
| C. Qwen2.5-0.5B~1.5B(WebLLM) | 0.5~1.6GB | ✅ | ✅ | 提示词 | 慢 | 高质量 / 边界裁决 |
| D. 云端 LLM（现状） | 0 | ✅ | ✅ | few-shot | 网络 | 边界升级 / 图片 |
| 图-CLIP 零样本 | ~百 MB | 标签 | — | ✗ | 中 | 图片轻筛 |
| 图-Qwen2-VL-2B | 多 GB | ✅ | ✅ | — | 很慢 | 读懂梗图（可选） |

## 7. 分阶段 POC

1. **P0 验证（不进扩展）**：单页 demo，transformers.js + `bge-small-zh-v1.5` + WebGPU，编码 20 条评论 + 若干样例，跑最近质心，看中文相似度是否合理、单条延迟。
2. **P1 接入**：加 offscreen document + `wasm-unsafe-eval` CSP + 本地模型；`background` 增加 `provider:'local'`，走 offscreen 推理，复用样例与缓存。设置页加"本地模型"开关与阈值。
3. **P2 混合**：双阈值 + 不确定升级到云端/本地 LLM；逻辑回归头替代质心。
4. **P3 图片（可选）**：CLIP 零样本对中文标签打分；需要时上 Qwen2-VL。

## 8. 风险 / 未决（落地前需确认）

- [ ] §3 各 embedding 的**真实 ONNX 文件体积**（HF Files 403 未取到）；`bge-small-zh` 维度 512 来自二手来源，需对 `config.json` 核实。
- [ ] WebLLM 各模型**下载体积**（仅显存有据，下载按显存估）。
- [ ] 扩展**内容脚本 / SW 的 WebGPU 可用性**（推断，非权威文档）；以 offscreen 为准。
- [ ] Paddle.js OCR 模型**体积**未文档化。
- [ ] offscreen `reasons:["BLOBS"]` 属 workaround，未来 Chrome 策略变化风险。
- [ ] embedding 对"剧透/特定广告话术"等**无样例覆盖类别**的召回，需实测；大概率要混合。

## 参考

- Transformers.js v3（WebGPU）: https://huggingface.co/blog/transformersjs-v3
- dtypes: https://huggingface.co/docs/transformers.js/guides/dtypes
- 离线用法: https://huggingface.co/docs/transformers.js/en/custom_usage
- bge-small-zh: https://huggingface.co/Xenova/bge-small-zh-v1.5 ・ multilingual-e5-small: https://huggingface.co/Xenova/multilingual-e5-small
- mDeBERTa XNLI: https://huggingface.co/Xenova/mDeBERTa-v3-base-xnli-multilingual-nli-2mil7
- WebLLM: https://github.com/mlc-ai/web-llm ・ 模型显存表: https://github.com/mlc-ai/web-llm/issues/683
- Offscreen + WebGPU 扩展实践: https://medium.com/@GenerationAI/transformers-js-onnx-runtime-webgpu-in-chrome-extension-13b563933ca9
- chrome.offscreen: https://developer.chrome.com/docs/extensions/reference/api/offscreen
- MV3 CSP: https://developer.chrome.com/docs/extensions/mv3/manifest/content_security_policy/
- ORT-Web MV3: https://github.com/microsoft/onnxruntime/discussions/23063
- Paddle.js OCR: https://www.npmjs.com/package/@paddlejs-models/ocr ・ RapidOCR: https://github.com/RapidAI/RapidOCR
- Qwen2-VL-2B ONNX: https://huggingface.co/onnx-community/Qwen2-VL-2B-Instruct ・ CLIP: https://huggingface.co/Xenova/clip-vit-base-patch32
