;(function () {
  'use strict';
  const NS = (globalThis.__BCP = globalThis.__BCP || {});

  const SYNC = chrome.storage.sync;
  const LOCAL = chrome.storage.local;
  // 每个 sync 分片的字符数。sync 单项上限为 8192 字节（UTF-8），中文 3 字节/字、
  // emoji 等最多 4 字节/码元，取 2000 字符保证最坏情况也 < 8192 字节。
  const CHUNK = 2000;
  const CACHE_KEY = 'llmcache';
  const CACHE_CAP = 8000; // LLM 判定缓存最多保留条数

  // ---------- 设置 ----------
  async function getSettings() {
    const o = await SYNC.get('settings');
    return NS.mergeSettings(o.settings || {});
  }
  async function setSettings(s) {
    await SYNC.set({ settings: s });
    return s;
  }

  // ---------- 屏蔽名单（分片存 sync 以支持多设备同步）----------
  async function getBlocklist() {
    const meta = await SYNC.get('bl:count');
    const count = meta['bl:count'] || 0;
    if (!count) return [];
    const keys = [];
    for (let i = 0; i < count; i++) keys.push('bl:' + i);
    const parts = await SYNC.get(keys);
    let str = '';
    for (let i = 0; i < count; i++) str += parts['bl:' + i] || '';
    try {
      return JSON.parse(str) || [];
    } catch (e) {
      return [];
    }
  }

  async function setBlocklist(arr) {
    const str = JSON.stringify(arr || []);
    const chunks = [];
    for (let i = 0; i < str.length; i += CHUNK) chunks.push(str.slice(i, i + CHUNK));
    if (chunks.length === 0) chunks.push('');

    // 读旧分片数，清理多余分片
    const old = (await SYNC.get('bl:count'))['bl:count'] || 0;
    const set = { 'bl:count': chunks.length };
    for (let i = 0; i < chunks.length; i++) set['bl:' + i] = chunks[i];
    await SYNC.set(set);
    if (old > chunks.length) {
      const rm = [];
      for (let i = chunks.length; i < old; i++) rm.push('bl:' + i);
      await SYNC.remove(rm);
    }
    return arr;
  }

  async function addBlock(entry) {
    const uid = NS.filter.uid(entry.uid);
    if (!uid) throw new Error('UID 为空');
    const list = await getBlocklist();
    const idx = list.findIndex(function (e) { return NS.filter.uid(e.uid) === uid; });
    const rec = {
      uid: uid,
      name: entry.name || (idx >= 0 ? list[idx].name : '') || '',
      note: entry.note || (idx >= 0 ? list[idx].note : '') || '',
      addedAt: idx >= 0 ? list[idx].addedAt : Date.now(),
    };
    if (idx >= 0) list[idx] = rec;
    else list.unshift(rec);
    await setBlocklist(list);
    return { list: list, added: idx < 0 };
  }

  async function removeBlock(uid) {
    uid = NS.filter.uid(uid);
    const list = await getBlocklist();
    const next = list.filter(function (e) { return NS.filter.uid(e.uid) !== uid; });
    await setBlocklist(next);
    return next;
  }

  // ---------- LLM 判定缓存（存 local，不同步）----------
  async function getCache() {
    const o = await LOCAL.get(CACHE_KEY);
    return o[CACHE_KEY] || {};
  }
  async function putCache(map) {
    // map: { key: boolean }
    const cache = await getCache();
    const now = Date.now();
    for (const k in map) cache[k] = { b: !!map[k], t: now };
    // 超出容量则按时间淘汰最旧
    const keys = Object.keys(cache);
    if (keys.length > CACHE_CAP) {
      keys.sort(function (a, b) { return cache[a].t - cache[b].t; });
      const drop = keys.length - CACHE_CAP;
      for (let i = 0; i < drop; i++) delete cache[keys[i]];
    }
    await LOCAL.set({ [CACHE_KEY]: cache });
  }
  async function clearCache() {
    await LOCAL.remove(CACHE_KEY);
  }
  async function cacheStats() {
    const c = await getCache();
    const keys = Object.keys(c);
    let blocked = 0;
    for (const k of keys) if (c[k].b) blocked++;
    return { total: keys.length, blocked: blocked };
  }

  // 读取一组键的判定（考虑 TTL）
  async function lookupCache(keys, ttlDays) {
    const cache = await getCache();
    const ttl = (ttlDays || 30) * 86400000;
    const now = Date.now();
    const hit = {}, miss = [];
    for (const k of keys) {
      const e = cache[k];
      if (e && now - e.t < ttl) hit[k] = e.b;
      else miss.push(k);
    }
    return { hit: hit, miss: miss };
  }

  // ---------- 样例学习（few-shot，供大模型参考）----------
  const EX_KEY = 'bcp_examples';
  const EX_MAX = 40;       // 最多保留样例数
  const EX_TEXTLEN = 80;   // 单条样例文本截断长度
  const EX_BYTES = 6500;   // 该项估算字节上限（sync 单项 8192 字节）

  async function getExamples() {
    const o = await SYNC.get(EX_KEY);
    return o[EX_KEY] || [];
  }
  async function setExamples(arr) {
    const seen = {};
    let list = [];
    for (const e of arr || []) {
      const text = ((e && e.text) || '').trim().slice(0, EX_TEXTLEN);
      if (!text || seen[text]) continue;
      seen[text] = true;
      list.push({ text: text, label: e.label === 'allow' ? 'allow' : 'block', ts: e.ts || Date.now() });
    }
    list = list.slice(0, EX_MAX);
    // 字节保护：按最坏 3 字节/字估算，超限则丢最旧
    while (list.length && JSON.stringify(list).length * 3 > EX_BYTES) list.pop();
    await SYNC.set({ [EX_KEY]: list });
    return list;
  }
  async function addExample(entry) {
    const text = ((entry && entry.text) || '').trim().slice(0, EX_TEXTLEN);
    if (!text) throw new Error('样例文本为空');
    const list = await getExamples();
    const next = list.filter(function (e) { return e.text !== text; }); // 去掉同文本旧项
    next.unshift({ text: text, label: entry.label === 'allow' ? 'allow' : 'block', ts: Date.now() });
    return setExamples(next);
  }
  async function removeExample(text) {
    const list = await getExamples();
    return setExamples(list.filter(function (e) { return e.text !== text; }));
  }
  async function clearExamples() {
    await SYNC.remove(EX_KEY);
  }

  // ---------- 图片感知哈希库（pHash，屏蔽同图/极相似图）----------
  const IMG_BLACK = 'bcp_imgblack', IMG_WHITE = 'bcp_imgwhite';
  const IMG_MAX = 300; // 每库最多哈希数（16 字符/条，300 条约 5KB，可 sync）

  async function getImgHashes() {
    const o = await SYNC.get([IMG_BLACK, IMG_WHITE]);
    return { black: o[IMG_BLACK] || [], white: o[IMG_WHITE] || [] };
  }
  async function addImgHashes(hashes, label) {
    const key = label === 'allow' ? IMG_WHITE : IMG_BLACK;
    const cur = (await SYNC.get(key))[key] || [];
    const seen = {};
    cur.forEach(function (h) { seen[h] = 1; });
    (hashes || []).forEach(function (h) { if (h) seen[h] = 1; });
    let list = Object.keys(seen);
    if (list.length > IMG_MAX) list = list.slice(list.length - IMG_MAX);
    await SYNC.set({ [key]: list });
    return list;
  }
  async function clearImgHashes() {
    await SYNC.remove([IMG_BLACK, IMG_WHITE]);
  }
  async function imgHashStats() {
    const h = await getImgHashes();
    return { black: h.black.length, white: h.white.length };
  }

  // ---------- CLIP 图向量库（存 local，量化为 int8；较大不进 sync）----------
  const IMGVEC = 'bcp_imgvec';
  const VEC_MAX = 250;

  // int8 量化：先按最大绝对值缩放到填满 [-127,127]，再取整。
  // 归一化向量分量很小（~0.04），直接 *127 只用到 ~5 的量程、精度损失大；
  // 缩放后余弦保真度 >0.999。余弦对尺度不变，故无需保存缩放系数。
  function quantize(v) {
    let max = 0;
    for (let i = 0; i < v.length; i++) { const a = v[i] < 0 ? -v[i] : v[i]; if (a > max) max = a; }
    const s = max > 0 ? 127 / max : 1;
    const out = new Array(v.length);
    for (let i = 0; i < v.length; i++) {
      let q = Math.round(v[i] * s);
      out[i] = q > 127 ? 127 : q < -127 ? -127 : q;
    }
    return out;
  }
  async function getImgVecs() {
    const o = await LOCAL.get(IMGVEC);
    return o[IMGVEC] || { black: [], white: [] };
  }
  async function addImgVec(vec, label) {
    if (!vec || !vec.length) return;
    const cur = await getImgVecs();
    const arr = label === 'allow' ? cur.white : cur.black;
    arr.push(quantize(vec));
    if (arr.length > VEC_MAX) arr.splice(0, arr.length - VEC_MAX);
    await LOCAL.set({ [IMGVEC]: cur });
  }
  async function setImgVecs(obj) {
    await LOCAL.set({ [IMGVEC]: { black: (obj && obj.black) || [], white: (obj && obj.white) || [] } });
  }
  async function clearImgVecs() {
    await LOCAL.remove(IMGVEC);
  }
  async function imgVecStats() {
    const c = await getImgVecs();
    return { black: c.black.length, white: c.white.length };
  }

  // 触发所有页面「清空AI缓存并重新评估」的信号
  async function requestReeval() {
    await clearCache();
    await SYNC.set({ bcp_reeval: Date.now() });
  }

  // ---------- 导入 / 导出 ----------
  async function exportAll() {
    return {
      _app: 'BiliBlock',
      _version: 1,
      exportedAt: new Date().toISOString(),
      settings: await getSettings(),
      blocklist: await getBlocklist(),
      examples: await getExamples(),
      imgHashes: await getImgHashes(),
      imgVecs: await getImgVecs(),
    };
  }

  // mode: 'merge' 合并名单 | 'replace' 覆盖
  async function importAll(obj, mode) {
    if (!obj || typeof obj !== 'object') throw new Error('文件格式不正确');
    if (obj.settings) await setSettings(NS.mergeSettings(obj.settings));
    if (Array.isArray(obj.blocklist)) {
      if (mode === 'replace') {
        await setBlocklist(obj.blocklist);
      } else {
        const cur = await getBlocklist();
        const byUid = {};
        cur.forEach(function (e) { byUid[NS.filter.uid(e.uid)] = e; });
        obj.blocklist.forEach(function (e) {
          const u = NS.filter.uid(e.uid);
          if (u) byUid[u] = Object.assign({}, byUid[u], e, { uid: u });
        });
        await setBlocklist(Object.keys(byUid).map(function (u) { return byUid[u]; }));
      }
    }
    if (Array.isArray(obj.examples)) {
      if (mode === 'replace') await setExamples(obj.examples);
      else await setExamples((await getExamples()).concat(obj.examples));
    }
    if (obj.imgHashes) {
      if (mode === 'replace') await clearImgHashes();
      await addImgHashes(obj.imgHashes.black || [], 'block');
      await addImgHashes(obj.imgHashes.white || [], 'allow');
    }
    if (obj.imgVecs) {
      if (mode === 'replace') {
        await setImgVecs(obj.imgVecs);
      } else {
        const cur = await getImgVecs();
        await setImgVecs({
          black: cur.black.concat(obj.imgVecs.black || []).slice(-VEC_MAX),
          white: cur.white.concat(obj.imgVecs.white || []).slice(-VEC_MAX),
        });
      }
    }
  }

  NS.store = {
    getSettings, setSettings,
    getBlocklist, setBlocklist, addBlock, removeBlock,
    getCache, putCache, clearCache, cacheStats, lookupCache,
    getExamples, setExamples, addExample, removeExample, clearExamples, requestReeval,
    getImgHashes, addImgHashes, clearImgHashes, imgHashStats,
    getImgVecs, addImgVec, setImgVecs, clearImgVecs, imgVecStats,
    exportAll, importAll,
  };
})();
