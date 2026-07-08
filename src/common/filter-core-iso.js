;(function () {
  'use strict';
  // ⚠️ 本文件是 filter-core.js 的隔离世界专用副本，内容必须与 filter-core.js 保持一致。
  // 原因：同一个脚本文件若同时列在 MAIN 与 ISOLATED 两个 content_scripts 条目里，
  // Chrome 只会把它注入到先声明的那个世界（MAIN），导致隔离世界拿不到 NS.filter。
  // 故隔离世界改用这份独立副本，避免与 MAIN 条目的 filter-core.js 重名冲突。
  const NS = (globalThis.__BCP = globalThis.__BCP || {});

  const filter = {
    uid(x) {
      return String(x == null ? '' : x).trim();
    },

    matchRules(text, rules) {
      if (!text || !rules) return false;
      const cs = !!rules.caseSensitive;
      const hay = cs ? text : text.toLowerCase();
      const kws = rules.keywords || [];
      for (let i = 0; i < kws.length; i++) {
        const kw = kws[i];
        if (!kw) continue;
        if (hay.indexOf(cs ? kw : kw.toLowerCase()) !== -1) return true;
      }
      const rxs = rules.regexps || [];
      for (let i = 0; i < rxs.length; i++) {
        const src = rxs[i];
        if (!src) continue;
        try {
          if (new RegExp(src, cs ? '' : 'i').test(text)) return true;
        } catch (e) { /* 用户写错的正则忽略 */ }
      }
      return false;
    },

    strhash(s) {
      let h = 5381;
      for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
      return h.toString(36);
    },

    cacheKey(rpid, uid, text) {
      if (rpid) return 'r' + rpid;
      return 'h' + this.strhash(this.uid(uid) + '|' + (text || ''));
    },
  };

  NS.filter = filter;
})();
