// Offscreen document：用 WebGPU + transformers.js 跑 CLIP 图像编码，产出 512 维向量。
// Service Worker 没有 WebGPU，故推理放这里；SW 通过 runtime 消息驱动。
import { env, AutoProcessor, CLIPVisionModelWithProjection, RawImage } from '../vendor/transformers.min.js';

// 运行时全部走本地 vendor/，模型权重从 HF 远程拉并由 Cache API 缓存
env.allowLocalModels = false;
env.allowRemoteModels = true;
env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('vendor/');
env.backends.onnx.wasm.numThreads = 1; // 避免依赖跨源隔离(SharedArrayBuffer)

const MODEL = 'Xenova/clip-vit-base-patch32';
let processor = null, model = null, loading = null, backend = '';

async function load() {
  if (model) return;
  if (!loading) {
    loading = (async () => {
      processor = await AutoProcessor.from_pretrained(MODEL);
      try {
        model = await CLIPVisionModelWithProjection.from_pretrained(MODEL, { device: 'webgpu', dtype: 'q8' });
        backend = 'webgpu';
      } catch (e) {
        // WebGPU 不可用则退回 wasm（慢但能用）
        model = await CLIPVisionModelWithProjection.from_pretrained(MODEL, { device: 'wasm', dtype: 'q8' });
        backend = 'wasm';
      }
    })().catch(function (e) { loading = null; throw e; });
  }
  await loading;
}

// 串行化推理：ORT 会话不可并发 run()，把重叠的 embed 请求排队执行
let chain = Promise.resolve();
function serialize(fn) {
  const p = chain.then(fn, fn);
  chain = p.then(function () {}, function () {});
  return p;
}

async function embedOne(url) {
  // RawImage.read 内部会 fetch，无超时；加 12s 竞速，避免慢图/挂起的 CDN 卡死推理队列
  const image = await Promise.race([
    RawImage.read(url),
    new Promise(function (_, rej) { setTimeout(function () { rej(new Error('image read timeout')); }, 12000); }),
  ]);
  const inputs = await processor(image);
  const out = await model(inputs);
  const v = out.image_embeds.tolist()[0]; // 512 floats
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i++) v[i] = v[i] / n; // L2 归一化
  return v;
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || msg.target !== 'offscreen') return;

  if (msg.type === 'warm') {
    load().then(function () { sendResponse({ ok: true, backend: backend }); })
      .catch(function (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); });
    return true;
  }

  if (msg.type === 'embed') {
    serialize(async function () {
      try {
        await load();
        const vectors = [];
        for (const url of (msg.urls || [])) {
          try { vectors.push(await embedOne(url)); }
          catch (e) { vectors.push(null); }
        }
        sendResponse({ ok: true, backend: backend, vectors: vectors });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e), vectors: (msg.urls || []).map(function () { return null; }) });
      }
    });
    return true;
  }
});
