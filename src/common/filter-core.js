;(function () {
  'use strict';
  const NS = (globalThis.__BCP = globalThis.__BCP || {});

  // 纯函数：屏蔽判定逻辑。不依赖 chrome / DOM，可在任意世界复用。
  const filter = {
    // 名单里的 uid 统一按字符串比较，避免数字精度问题
    uid(x) {
      return String(x == null ? '' : x).trim();
    },

    // 关键词 + 正则匹配（命中任意一条即算屏蔽）
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
        } catch (e) {
          /* 用户写错的正则忽略 */
        }
      }
      return false;
    },

    // djb2 字符串哈希，给没有 rpid 的评论生成缓存键
    strhash(s) {
      let h = 5381;
      for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
      return h.toString(36);
    },

    // LLM 缓存键：优先用评论 id(rpid)，否则用 uid+文本 哈希
    cacheKey(rpid, uid, text) {
      if (rpid) return 'r' + rpid;
      return 'h' + this.strhash(this.uid(uid) + '|' + (text || ''));
    },
  };

  NS.filter = filter;
})();
