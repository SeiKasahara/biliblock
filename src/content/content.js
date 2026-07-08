;(function () {
  'use strict';
  const NS = globalThis.__BCP;
  const F = NS.filter;

  const S = {
    settings: null,
    enabled: true,
    level: 'deep',
    rules: { keywords: [], regexps: [], caseSensitive: false },
    scopes: {},
    llm: { enabled: false, batchSize: 15, minLen: 1 },
    imageFilter: { phash: false, threshold: 10 },
    semantic: { threshold: 0, minSamples: 5 },
    blocked: new Set(),
    uidLevel: new Map(), // uid -> 'deep'|'shallow'（每人强度覆盖，缺省跟随全局 S.level）
    cacheMem: new Map(), // key -> bool（LLM 判定）
    inflight: new Set(),
    queue: [],
    queueMap: new Map(),
    hidden: new Map(), // el -> { reason, level, ph }
    apiRemoved: 0, // 主世界在 API 层剔除的条数
  };

  // ---------------- 设置加载 ----------------
  function applySettings() {
    const s = S.settings;
    S.enabled = s.enabled;
    S.level = s.blockLevel;
    S.rules = s.rules;
    S.scopes = s.scopes;
    S.llm = s.llm;
    S.imageFilter = s.imageFilter || { phash: false, threshold: 10 };
    S.semantic = s.semantic || { threshold: 0, minSamples: 5 };
  }

  // 某 uid 的有效屏蔽强度：有个人覆盖用覆盖，否则跟随全局默认
  function effLevel(uid) { return S.uidLevel.get(F.uid(uid)) || S.level; }

  function loadBlockedFrom(bl) {
    S.blocked = new Set(bl.map(function (e) { return F.uid(e.uid); }));
    S.uidLevel = new Map();
    bl.forEach(function (e) {
      if (e.level === 'deep' || e.level === 'shallow') S.uidLevel.set(F.uid(e.uid), e.level);
    });
  }

  async function load() {
    S.settings = await NS.store.getSettings();
    applySettings();
    const bl = await NS.store.getBlocklist();
    loadBlockedFrom(bl);
    const cache = await NS.store.getCache();
    S.cacheMem = new Map(Object.keys(cache).map(function (k) { return [k, !!cache[k].b]; }));
    pushConfig();
    scan();
  }

  function pushConfig() {
    const uids = Array.from(S.blocked);
    window.postMessage({
      __bcp: 'cfg',
      enabled: S.enabled,
      globalDeep: S.level === 'deep',
      uids: uids, // 全部被屏蔽 uid（弹幕按 uid 剔除，无深浅之分）
      deepUids: uids.filter(function (u) { return effLevel(u) === 'deep'; }), // 仅"深"的在 API 层剔除
      rules: S.rules,
      scopes: S.scopes,
      llmEnabled: !!S.llm.enabled,
      // 缓存判定是否生效于 API 层：大模型 / 图片过滤 / 语义聚类 任一开启即可
      cacheActive: !!(S.llm.enabled || (S.imageFilter && (S.imageFilter.phash || S.imageFilter.clip)) || (S.semantic && S.semantic.threshold > 0)),
      cache: Array.from(S.cacheMem.entries()).slice(0, 8000),
    }, '*');
  }

  // ---------------- 屏蔽 / 恢复 表现 ----------------
  // level 省略时用全局 S.level；UID 屏蔽会传入该用户的个人强度
  function applyBlock(el, info, reason, level) {
    level = level || S.level;
    const prev = S.hidden.get(el);
    if (prev && prev.reason === reason && prev.level === level) return;
    if (prev) unhide(el);
    if (level === 'deep') {
      el.style.setProperty('display', 'none', 'important');
      el.setAttribute('data-bcp-hidden', reason);
      S.hidden.set(el, { reason: reason, level: 'deep', ph: null });
    } else {
      el.style.setProperty('display', 'none', 'important');
      const ph = buildPlaceholder(info, reason, el);
      if (el.parentNode) el.parentNode.insertBefore(ph, el);
      S.hidden.set(el, { reason: reason, level: 'shallow', ph: ph });
    }
    reportCount();
  }

  function buildPlaceholder(info, reason, el) {
    const ph = document.createElement('div');
    ph.className = 'bcp-ph';
    ph.style.cssText =
      'padding:5px 10px;margin:4px 0;font-size:12px;color:#9499a0;background:rgba(128,128,128,.08);' +
      'border:1px dashed rgba(128,128,128,.4);border-radius:6px;line-height:1.6;';
    const who = info && info.name ? info.name : (info && info.uid ? 'UID ' + info.uid : '该用户');
    const collapsed = '🚫 已屏蔽 ' + who + '（' + reason + '）· 点击展开';
    const expanded = '🚫 ' + who + '（' + reason + '）· 点击收起';
    const txt = document.createElement('span');
    txt.style.cursor = 'pointer';
    txt.textContent = collapsed;
    txt.addEventListener('click', function () {
      if (el.style.display === 'none') { el.style.removeProperty('display'); txt.textContent = expanded; }
      else { el.style.setProperty('display', 'none', 'important'); txt.textContent = collapsed; }
    });
    ph.appendChild(txt);
    // 自动屏蔽（AI 文本 / 图 图片相似）都可纠正；手动 UID/关键词 屏蔽不给「正常」按钮
    if (reason === 'AI' || reason === '图') {
      const ok = document.createElement('span');
      ok.textContent = ' ✓ 这条正常';
      ok.title = '纠正误屏蔽，并记为正常样例';
      ok.style.cssText = 'cursor:pointer;margin-left:10px;color:#2ecc71;';
      ok.addEventListener('click', function (e) { e.stopPropagation(); allowExample(info); });
      ph.appendChild(ok);
    }
    return ph;
  }

  function unhide(el) {
    const rec = S.hidden.get(el);
    if (!rec) return;
    el.style.removeProperty('display');
    el.removeAttribute('data-bcp-hidden');
    if (rec.ph && rec.ph.parentNode) rec.ph.parentNode.removeChild(rec.ph);
    S.hidden.delete(el);
    reportCount();
  }

  function unhideAll() {
    Array.from(S.hidden.keys()).forEach(unhide);
  }

  // 判定缓存键：把配图并入签名，避免纯图评论按 uid+空文本 相互串键
  function classifyKey(info) {
    const imgs = info.images || [];
    const sig = (info.text || '') + (imgs.length ? ' [img]' + imgs.join(',') : '');
    return F.cacheKey(info.rpid, F.uid(info.uid), sig);
  }

  // ---------------- 扫描处理 ----------------
  function handleComment(info) {
    if (!S.scopes.comments) { if (S.hidden.has(info.el)) unhide(info.el); return; }
    NS.scanner.injectButtons(info, [
      { icon: '🚫', title: '屏蔽并学习：拉黑此用户 + 记住这条内容（图片会挡相似图）', onClick: blockAndLearn },
    ]);
    const uid = info.uid ? F.uid(info.uid) : '';
    if (uid && S.blocked.has(uid)) return applyBlock(info.el, info, 'UID', effLevel(uid));
    if (F.matchRules(info.text, S.rules)) return applyBlock(info.el, info, '关键词');
    const imgs = info.images || [];
    const imgFilterOn = !!(imgs.length && S.imageFilter && (S.imageFilter.phash || S.imageFilter.clip));
    const semOn = !!(S.semantic && S.semantic.threshold > 0 && (info.text || '').trim().length >= 2);
    if (S.llm.enabled || imgFilterOn || semOn) {
      const key = classifyKey(info);
      const v = S.cacheMem.get(key);
      const imgReason = imgs.length && !(info.text || '').trim() ? '图' : 'AI';
      if (v === true) return applyBlock(info.el, info, imgReason);
      const hasContent = (info.text || '').length >= (S.llm.minLen || 1) || (S.llm.multimodal && imgs.length > 0) || imgFilterOn || semOn;
      if (v === undefined && hasContent) enqueue(key, info);
    }
    if (S.hidden.has(info.el)) unhide(info.el);
  }

  function handleCard(info) {
    // 卡片过滤总开关：任一「卡片类」范围开启才生效；全关则恢复已隐藏卡片
    if (!cardScopesOn()) { if (S.hidden.has(info.el)) unhide(info.el); return; }
    const uid = info.uid ? F.uid(info.uid) : '';
    if (uid && S.blocked.has(uid)) return applyBlock(info.el, info, 'UID', effLevel(uid));
    if (F.matchRules(info.text, S.rules)) return applyBlock(info.el, info, '关键词');
    if (S.hidden.has(info.el)) unhide(info.el);
  }

  function cardScopesOn() {
    return S.scopes.dynamics || S.scopes.space || S.scopes.search || S.scopes.recommend;
  }

  function scan() {
    if (!S.enabled) return;
    try {
      NS.scanner.scanComments(handleComment);
      // 始终扫描卡片：即使卡片范围全关，也需要借此恢复此前隐藏的卡片
      NS.scanner.scanCards(handleCard);
    } catch (e) { console.warn('[BiliBlock] 扫描出错', e); }
  }

  // ---------------- LLM 队列 ----------------
  function enqueue(key, info) {
    if (S.inflight.has(key)) return;
    let item = S.queueMap.get(key);
    if (!item) {
      item = { key: key, id: key, text: info.text, images: info.images || [], els: new Set() };
      S.queueMap.set(key, item);
      S.queue.push(item);
    }
    item.els.add(info.el);
    scheduleFlush();
  }

  let flushTimer = null;
  function scheduleFlush() {
    if (S.queue.length >= (S.llm.batchSize || 15)) { flush(); return; }
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, 700);
  }

  async function flush() {
    clearTimeout(flushTimer);
    if (!S.queue.length) return;
    const batch = S.queue.splice(0, 100);
    batch.forEach(function (it) { S.queueMap.delete(it.key); S.inflight.add(it.key); });
    const items = batch.map(function (it) { return { id: it.id, text: it.text, images: it.images || [] }; });

    let res = null;
    try {
      res = await chrome.runtime.sendMessage({ type: 'classify', items: items });
    } catch (e) { res = null; }
    const decisions = (res && res.decisions) || {};

    const newEntries = [];
    batch.forEach(function (it) {
      S.inflight.delete(it.key);
      const b = decisions[it.id];
      if (b === true || b === false) {
        S.cacheMem.set(it.key, b);
        newEntries.push([it.key, b]);
        if (b) {
          const reason = (it.images && it.images.length && !(it.text || '').trim()) ? '图' : 'AI';
          it.els.forEach(function (el) {
            if (el.isConnected) applyBlock(el, el.__bcp || {}, reason);
          });
        }
      }
    });
    if (newEntries.length) window.postMessage({ __bcp: 'cache', entries: newEntries }, '*');
    if (S.queue.length) scheduleFlush();
  }

  // 图片评论：把配图加入黑/白库（交后台算 pHash + CLIP 向量）
  function learnImages(info, label) {
    const imgs = info.images || [];
    if (!imgs.length) return;
    try { chrome.runtime.sendMessage({ type: 'imghash', label: label, images: imgs }).catch(function () {}); } catch (e) {}
  }

  // ---------------- 屏蔽并学习（合并原「🚫 拉黑」+「🧠 学习」）----------------
  // 拉黑该用户(UID 全站生效) + 学习内容(文本→样例喂大模型；图片→pHash/CLIP 黑库挡相似图) + 隐藏本条。
  // 注意：文本样例只用于大模型 few-shot，不做本地文本相似匹配；只有图片会按相似度主动挡。
  async function blockAndLearn(info) {
    const text = (info.text || '').trim();
    const imgs = info.images || [];
    const key = classifyKey(info);
    try {
      if (info.uid) {
        await NS.store.addBlock({ uid: info.uid, name: info.name });
        S.blocked.add(F.uid(info.uid));
        pushConfig();
      }
      if (text) await NS.store.addExample({ text: text, label: 'block' });
      learnImages(info, 'block');
      // 学到新黑图且大模型关着时：清缓存重评，让本页已出现的相似图也回溯屏蔽（纯本地、零额度）
      if (imgs.length && !S.llm.enabled) { try { NS.store.requestReeval(); } catch (e) {} }
      S.cacheMem.set(key, true);
      window.postMessage({ __bcp: 'cache', entries: [[key, true]] }, '*');
      if (info.el) applyBlock(info.el, info, info.uid ? 'UID' : (imgs.length && !text ? '图' : 'AI'), info.uid ? effLevel(info.uid) : undefined);
      scan();
      toast(imgs.length ? '已屏蔽，并记住这张图（相似图也会挡）'
        : '已屏蔽' + (info.name ? '「' + info.name + '」' : '') + '，并学习这类评论');
    } catch (e) {
      const msg = String((e && e.message) || e);
      console.error('[BiliBlock] 屏蔽失败:', e);
      toast(/context invalidated|Extension context/i.test(msg) ? '扩展已重新加载，请刷新本页后再点' : '屏蔽失败：' + msg);
    }
  }

  // 纠正误屏蔽：把这条记为「正常」样例，并恢复显示
  async function allowExample(info) {
    const text = (info.text || '').trim();
    const key = classifyKey(info);
    try {
      if (text) await NS.store.addExample({ text: text, label: 'allow' });
      learnImages(info, 'allow'); // 配图入白库，压制误杀
      S.cacheMem.set(key, false);
      window.postMessage({ __bcp: 'cache', entries: [[key, false]] }, '*');
      if (info.el) unhide(info.el);
      toast('已记为「正常」，将减少此类误屏蔽');
    } catch (e) { toast('保存样例失败：' + ((e && e.message) || e)); }
  }

  let toastEl = null, toastTimer = null;
  function toast(msg) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.style.cssText =
        'position:fixed;z-index:2147483647;left:50%;bottom:40px;transform:translateX(-50%);' +
        'background:rgba(0,0,0,.82);color:#fff;padding:8px 16px;border-radius:20px;font-size:13px;' +
        'pointer-events:none;transition:opacity .3s;box-shadow:0 4px 16px rgba(0,0,0,.3);';
      (document.body || document.documentElement).appendChild(toastEl);
    }
    toastEl.textContent = 'BiliBlock：' + msg;
    toastEl.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { if (toastEl) toastEl.style.opacity = '0'; }, 2000);
  }

  // ---------------- 计数上报（角标 / 弹窗）----------------
  let countTimer = null;
  function reportCount() {
    if (window.top !== window) return; // 只由顶层帧上报，避免子帧覆盖角标
    clearTimeout(countTimer);
    countTimer = setTimeout(function () {
      try {
        chrome.runtime.sendMessage({ type: 'count', n: S.hidden.size + S.apiRemoved }).catch(function () {});
      } catch (e) {}
    }, 300);
  }

  // ---------------- 消息 ----------------
  window.addEventListener('message', function (ev) {
    if (ev.source !== window || !ev.data) return;
    const d = ev.data;
    if (d.__bcp === 'stat') { S.apiRemoved += d.n || 0; reportCount(); }
    else if (d.__bcp === 'ready') { pushConfig(); }
  });

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (msg && msg.type === 'getStats') {
      // 只由顶层帧回应，避免空子帧抢先返回 0
      if (window.top !== window) return false;
      sendResponse({ count: S.hidden.size + S.apiRemoved, blocked: S.blocked.size, enabled: S.enabled });
    } else if (msg && msg.type === 'rescan') {
      revalidateAll();
    } else if (msg && msg.type === 'toast') {
      toast(msg.msg || '');
    }
    return false;
  });

  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== 'sync') return;
    if (changes.settings) {
      S.settings = NS.mergeSettings(changes.settings.newValue || {});
      applySettings();
      pushConfig();
      revalidateAll();
    }
    if (Object.keys(changes).some(function (k) { return k.indexOf('bl:') === 0; })) {
      reloadBlocklist();
    }
    if (changes.bcp_reeval) {
      // 「清空AI缓存并重新评估」：丢弃内存判定，恢复所有 AI 屏蔽项后重扫
      S.cacheMem = new Map();
      Array.from(S.hidden.entries()).forEach(function (kv) {
        if (kv[1].reason === 'AI') unhide(kv[0]);
      });
      pushConfig();
      scan();
    }
  });

  async function reloadBlocklist() {
    const bl = await NS.store.getBlocklist();
    loadBlockedFrom(bl);
    pushConfig();
    revalidateAll();
  }

  function revalidateAll() {
    if (!S.enabled) { unhideAll(); return; }
    scan();
  }

  // ---------------- 启动 ----------------
  let scanTimer = null;
  function scheduleScan(delay) {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, delay || 200);
  }

  function start() {
    load();
    const mo = new MutationObserver(function () { scheduleScan(250); });
    mo.observe(document.documentElement, { childList: true, subtree: true });
    setInterval(function () { if (S.enabled) scan(); }, 1200);
    [0, 300, 800, 1500].forEach(function (t) { setTimeout(pushConfig, t); });
  }

  start();
})();
