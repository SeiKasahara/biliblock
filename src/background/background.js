'use strict';
// 经典 Service Worker：用 importScripts 载入共享模块（免构建，无需 ES module）
importScripts(
  '../common/crc32.js',
  '../common/filter-core.js',
  '../common/defaults.js',
  '../common/store.js',
  './llm.js',
  './phash.js'
);

const NS = globalThis.__BCP;

// ---------------- 右键菜单：屏蔽用户空间链接 ----------------
function setupMenus() {
  try {
    chrome.contextMenus.removeAll(function () {
      chrome.contextMenus.create({
        id: 'bcp-block-uid',
        title: '🚫 屏蔽此UID的所有内容（BiliBlock）',
        contexts: ['link'],
        targetUrlPatterns: ['*://space.bilibili.com/*'],
      });
    });
  } catch (e) { /* contextMenus 可能不可用 */ }
}

chrome.runtime.onInstalled.addListener(setupMenus);
chrome.runtime.onStartup.addListener(setupMenus);
setupMenus();

chrome.contextMenus.onClicked.addListener(function (info, tab) {
  if (info.menuItemId !== 'bcp-block-uid') return;
  const m = (info.linkUrl || '').match(/space\.bilibili\.com\/(\d+)/);
  if (!m) return;
  const uid = m[1];
  NS.store.addBlock({ uid: uid }).then(function () {
    if (tab && tab.id != null) {
      chrome.tabs.sendMessage(tab.id, { type: 'toast', msg: '已屏蔽 UID ' + uid }).catch(function () {});
    }
  });
});

// ---------------- 角标计数 ----------------
function setBadge(tabId, n) {
  if (tabId == null) return;
  const text = n > 0 ? (n > 999 ? '999+' : String(n)) : '';
  try {
    chrome.action.setBadgeText({ tabId: tabId, text: text });
    chrome.action.setBadgeBackgroundColor({ tabId: tabId, color: '#fb7299' });
  } catch (e) {}
}

// ---------------- 消息处理 ----------------
// ---------------- Offscreen（CLIP 本地推理，WebGPU）----------------
let creatingOffscreen = null;
async function ensureOffscreen() {
  if (!chrome.offscreen) throw new Error('浏览器不支持 offscreen（需 Chrome 109+）');
  if (chrome.offscreen.hasDocument && (await chrome.offscreen.hasDocument())) return;
  if (creatingOffscreen) { await creatingOffscreen; return; }
  creatingOffscreen = chrome.offscreen.createDocument({
    url: 'offscreen/offscreen.html',
    reasons: ['BLOBS'],
    justification: '本地 CLIP 图片向量推理（WebGPU）',
  }).catch(function () {});
  await creatingOffscreen;
  creatingOffscreen = null;
}
// 向 offscreen 发消息，带重试（覆盖其模块监听器尚未就绪的窗口）
async function sendToOffscreen(msg) {
  for (let i = 0; i < 5; i++) {
    try {
      const r = await chrome.runtime.sendMessage(msg);
      if (r !== undefined) return r;
    } catch (e) { /* 监听器还没起来 */ }
    await new Promise(function (res) { setTimeout(res, 300); });
  }
  return null;
}
async function embedImages(urls) {
  if (!urls || !urls.length) return [];
  try {
    await ensureOffscreen();
    const res = await sendToOffscreen({ target: 'offscreen', type: 'embed', urls: urls });
    return (res && res.vectors) || urls.map(function () { return null; });
  } catch (e) {
    return urls.map(function () { return null; });
  }
}
function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9);
}
function maxCos(q, list) {
  let m = -1;
  for (let i = 0; i < list.length; i++) { const c = cosine(q, list[i]); if (c > m) m = c; }
  return m;
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg) return false;
  if (msg.target === 'offscreen') return false; // 交给 offscreen 处理

  if (msg.type === 'warmClip') {
    ensureOffscreen()
      .then(function () { return sendToOffscreen({ target: 'offscreen', type: 'warm' }); })
      .then(function (r) { sendResponse(r || { ok: false, error: '本地模型无响应' }); })
      .catch(function (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); });
    return true;
  }

  if (msg.type === 'count') {
    setBadge(sender.tab && sender.tab.id, msg.n || 0);
    return false;
  }

  if (msg.type === 'classify') {
    handleClassify(msg.items || []).then(sendResponse).catch(function (e) {
      sendResponse({ decisions: {}, error: String(e && e.message || e) });
    });
    return true; // 异步
  }

  if (msg.type === 'imghash') {
    handleImgHash(msg).then(sendResponse).catch(function (e) {
      sendResponse({ ok: false, error: String(e && e.message || e) });
    });
    return true;
  }

  if (msg.type === 'testLLM') {
    Promise.all([NS.store.getSettings(), NS.store.getExamples()]).then(function (r) {
      const cfg = Object.assign({}, r[0].llm, msg.override || {});
      return NS.llm.test(cfg, r[1]);
    }).then(sendResponse).catch(function (e) {
      sendResponse({ ok: false, error: String(e && e.message || e) });
    });
    return true;
  }

  return false;
});

// 计算一条图片评论的 pHash 判定：命中黑库=true，命中白库=false，都不命中=null
async function phashDecide(item, black, white, thr) {
  let decided = null;
  const urls = (item.images || []).slice(0, 4);
  for (const url of urls) {
    let h = null;
    try { h = await NS.phash.hashFromUrl(url); } catch (e) { h = null; }
    if (!h) continue;
    if (black.some(function (b) { return NS.phash.hamming(h, b) <= thr; })) return true; // 黑库优先
    if (white.some(function (w) { return NS.phash.hamming(h, w) <= thr; })) decided = false;
  }
  return decided;
}

async function handleClassify(items) {
  if (!items.length) return { decisions: {} };
  const settings = await NS.store.getSettings();
  const llmOn = !!(settings.llm && settings.llm.enabled);
  const phashOn = !!(settings.imageFilter && settings.imageFilter.phash);
  const clipOn = !!(settings.imageFilter && settings.imageFilter.clip);
  if (!llmOn && !phashOn && !clipOn) return { decisions: {} };

  const ids = items.map(function (i) { return i.id; });
  const look = await NS.store.lookupCache(ids, settings.llm.cacheTtlDays);
  const missSet = {};
  look.miss.forEach(function (k) { missSet[k] = true; });
  let missItems = items.filter(function (i) { return missSet[i.id]; });

  let fresh = {};

  // 第 1 层：pHash 图片查重（独立于大模型，先跑）
  if (phashOn) {
    const imgItems = missItems.filter(function (i) { return i.images && i.images.length; });
    if (imgItems.length) {
      const store = await NS.store.getImgHashes();
      const thr = settings.imageFilter.threshold || 10;
      for (const it of imgItems) {
        const d = await phashDecide(it, store.black, store.white, thr);
        if (d !== null) fresh[it.id] = d;
      }
    }
    missItems = missItems.filter(function (i) { return !(i.id in fresh); }); // pHash 已定的不再往下走
  }

  // 第 2 层：CLIP 图向量语义相似（本地 WebGPU）
  if (clipOn) {
    const imgItems = missItems.filter(function (i) { return i.images && i.images.length; });
    if (imgItems.length) {
      const vecs = await NS.store.getImgVecs();
      if (vecs.black.length || vecs.white.length) {
        const thr = settings.imageFilter.clipThreshold || 0.85;
        for (const it of imgItems) {
          const embs = await embedImages((it.images || []).slice(0, 2));
          let decided = null;
          for (const e of embs) {
            if (!e) continue;
            const cb = maxCos(e, vecs.black);
            const cw = maxCos(e, vecs.white);
            if (cb >= thr && cb >= cw) { decided = true; break; } // 黑图优先
            if (cw >= thr && cw > cb) decided = false;
          }
          if (decided !== null) fresh[it.id] = decided;
        }
        missItems = missItems.filter(function (i) { return !(i.id in fresh); });
      }
    }
  }

  // 第 3 层：大模型（含云端视觉，兜底全新图）
  if (llmOn && missItems.length) {
    const examples = await NS.store.getExamples();
    const useVision = !!settings.llm.multimodal;
    const hasImg = function (i) { return i.images && i.images.length; };
    const imgItems = useVision ? missItems.filter(hasImg) : [];
    const txtItems = useVision ? missItems.filter(function (i) { return !hasImg(i); }) : missItems;
    const parts = await Promise.all([
      txtItems.length ? NS.llm.classify(txtItems, settings.llm, examples) : {},
      imgItems.length ? NS.llm.classifyVision(imgItems, settings.llm, examples) : {},
    ]);
    Object.assign(fresh, parts[0], parts[1]);
  }

  // 图片经 pHash/CLIP 判为"不像黑图"、又没有大模型接管的，缓存为放行；
  // 否则内容脚本每次扫描都会重新入队 → 后台反复抓图 + 算哈希/向量，形成持续负载。
  // （代价：之后新增黑图不会回溯命中这些已缓存项，可用「重新评估」清缓存刷新。）
  if (!llmOn) {
    missItems.forEach(function (i) { if (!(i.id in fresh)) fresh[i.id] = false; });
  }

  if (Object.keys(fresh).length) await NS.store.putCache(fresh);
  return { decisions: Object.assign({}, look.hit, fresh) };
}

// 把图片评论的图加入黑/白库：pHash（第1层）+ 若开启则 CLIP 向量（第2层）
async function handleImgHash(msg) {
  const settings = await NS.store.getSettings();
  const urls = (msg.images || []).slice(0, 4);

  const hashes = [];
  for (const url of urls) {
    let h = null;
    try { h = await NS.phash.hashFromUrl(url); } catch (e) { h = null; }
    if (h) hashes.push(h);
  }
  if (hashes.length) await NS.store.addImgHashes(hashes, msg.label);

  let vecAdded = 0;
  if (settings.imageFilter && settings.imageFilter.clip) {
    const embs = await embedImages(urls);
    for (const e of embs) { if (e) { await NS.store.addImgVec(e, msg.label); vecAdded++; } }
  }
  return { ok: true, added: hashes.length, vecAdded: vecAdded };
}
