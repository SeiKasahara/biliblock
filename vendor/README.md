# vendor/

第三方运行时依赖，供 offscreen document 里的本地 CLIP 推理（第 2 层图片过滤）使用。
CSP 不允许扩展页加载远程脚本，故必须本地放置。**这些是二进制/构建产物，不手改。**

| 文件 | 来源 | 说明 |
| --- | --- | --- |
| `transformers.min.js` | `@huggingface/transformers@3.7.1` dist（ESM） | Transformers.js 主包 |
| `ort-wasm-simd-threaded.jsep.wasm` | 同上 | ONNX Runtime Web（JSEP，带 WebGPU），约 21MB |
| `ort-wasm-simd-threaded.jsep.mjs` | 同上 | 上面 wasm 的 JS 胶水 |

CLIP 模型权重（`Xenova/clip-vit-base-patch32`）**不在此**，首次启用时从 Hugging Face 下载并由浏览器 Cache API 缓存。

> 注：`.gitignore` 默认忽略了 `vendor/*.wasm`（21MB 太大）。克隆本仓库后需按下面命令重新拉取该 wasm，CLIP 才能用。

## 重新拉取

```bash
V=3.7.1
B="https://cdn.jsdelivr.net/npm/@huggingface/transformers@$V/dist"
for f in transformers.min.js ort-wasm-simd-threaded.jsep.wasm ort-wasm-simd-threaded.jsep.mjs; do
  curl -sL "$B/$f" -o "vendor/$f"
done
```
