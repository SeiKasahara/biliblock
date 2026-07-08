;(function () {
  'use strict';
  // 主世界（页面 JS 环境）脚本：在 document_start 抢先劫持 window.fetch，
  // 在 B 站 API 返回时就把被屏蔽 UID 的数据剔除，做到「深屏蔽」无闪现。
  // 无法访问 chrome.* —— 配置由隔离世界内容脚本通过 postMessage 推送过来。
  const NS = globalThis.__BCP || {};
  const F = NS.filter;
  const EP = NS.endpoints;
  const DM = NS.dmproto;
  const CRC = NS.crc32;

  const state = {
    enabled: false,
    active: false, // enabled 且 blockLevel==='deep' 时才在 API 层剔除（浅屏蔽交给 DOM 折叠）
    blockLevel: 'deep',
    blocked: new Set(),
    rules: { keywords: [], regexps: [], caseSensitive: false },
    scopes: {},
    llmEnabled: false,
    cacheActive: false,
    cache: new Map(),
    dmHashes: new Set(), // 被屏蔽 uid 的 crc32，用于弹幕 midHash 匹配
  };

  function rebuildDmHashes() {
    state.dmHashes = new Set();
    if (!CRC) return;
    state.blocked.forEach(function (uid) {
      state.dmHashes.add(CRC.hex(uid));
    });
  }

  window.addEventListener('message', function (ev) {
    if (ev.source !== window || !ev.data) return;
    const d = ev.data;
    if (d.__bcp === 'cfg') {
      state.enabled = !!d.enabled;
      state.blockLevel = d.blockLevel || 'deep';
      state.active = state.enabled && state.blockLevel === 'deep';
      state.blocked = new Set((d.uids || []).map(String));
      state.rules = d.rules || state.rules;
      state.scopes = d.scopes || {};
      state.llmEnabled = !!d.llmEnabled;
      state.cacheActive = d.cacheActive !== undefined ? !!d.cacheActive : !!d.llmEnabled;
      if (Array.isArray(d.cache)) {
        state.cache = new Map(d.cache);
      }
      rebuildDmHashes();
    } else if (d.__bcp === 'cache') {
      // 增量更新 LLM 判定缓存
      (d.entries || []).forEach(function (kv) {
        state.cache.set(kv[0], kv[1]);
      });
    }
  });

  function ctx() {
    return {
      blocked: state.blocked,
      rules: state.rules,
      scopes: state.scopes,
      llmEnabled: state.llmEnabled,
      cacheActive: state.cacheActive,
      cache: state.cache,
    };
  }

  function postStat(n) {
    if (n > 0) window.postMessage({ __bcp: 'stat', n: n }, '*');
  }

  function urlOf(input) {
    if (typeof input === 'string') return input;
    if (input && typeof input.url === 'string') return input.url;
    try { return String(input); } catch (e) { return ''; }
  }

  // 复制响应头，去掉会导致长度/编码不匹配的字段
  function cloneHeaders(res) {
    const h = new Headers();
    res.headers.forEach(function (v, k) {
      const lk = k.toLowerCase();
      if (lk === 'content-length' || lk === 'content-encoding') return;
      h.set(k, v);
    });
    return h;
  }

  function dmShouldDrop(midHash, content) {
    if (state.rules && F.matchRules(content, state.rules)) return true;
    if (midHash) {
      const h = CRC.stripZero(String(midHash).toLowerCase());
      if (state.dmHashes.has(h)) return true;
    }
    return false;
  }

  const isDanmaku = function (url) {
    // 只处理弹幕分段 seg.so（含弹幕元素）；弹幕配置 view 不动，避免破坏播放器
    return url.indexOf('/dm/web/seg.so') !== -1;
  };

  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      const p = origFetch.apply(this, arguments);
      if (!state.enabled) return p;
      const url = urlOf(input);
      const danmaku = state.scopes.danmaku && isDanmaku(url);
      const jsonTarget = state.active && EP.isTargetJson(url);
      if (!danmaku && !jsonTarget) return p;

      return p.then(function (res) {
        try {
          if (!res || !res.ok) return res;

          if (danmaku && DM && url.indexOf('/seg.so') !== -1) {
            return res.clone().arrayBuffer().then(function (buf) {
              const r = DM.filter(buf, dmShouldDrop);
              if (!r.removed) return res;
              postStat(r.removed);
              return new Response(r.buffer, { status: res.status, statusText: res.statusText, headers: cloneHeaders(res) });
            }).catch(function () { return res; });
          }

          if (jsonTarget) {
            return res.clone().text().then(function (text) {
              let json;
              try { json = JSON.parse(text); } catch (e) { return res; }
              const removed = EP.applyToResponse(url, json, ctx());
              if (!removed) return res;
              postStat(removed);
              return new Response(JSON.stringify(json), { status: res.status, statusText: res.statusText, headers: cloneHeaders(res) });
            }).catch(function () { return res; });
          }
        } catch (e) { /* 出错回退原响应 */ }
        return res;
      });
    };
  }

  // 说明：B 站评论/动态/推荐等接口现以 fetch 为主，故仅劫持 fetch。
  // 其余走 XHR 或服务端直出的内容由隔离世界的 DOM 扫描器兜底处理。

  // 通知隔离世界内容脚本：主世界已就绪，请把配置推过来
  window.postMessage({ __bcp: 'ready' }, '*');
})();
