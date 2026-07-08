;(function () {
  'use strict';
  const NS = (globalThis.__BCP = globalThis.__BCP || {});
  const F = NS.filter;

  // 判断单条内容是否应被丢弃（uid 命中 / 关键词命中 / LLM 缓存判黑）
  function shouldDrop(ctx, uid, text, rpid) {
    uid = F.uid(uid);
    if (uid && ctx.blocked.has(uid)) return true;
    if (F.matchRules(text, ctx.rules)) return true;
    // 缓存判定（大模型 / pHash / CLIP 的结果）；cacheActive 兼容旧字段 llmEnabled
    const active = ctx.cacheActive !== undefined ? ctx.cacheActive : ctx.llmEnabled;
    if (active && (rpid || uid)) {
      const k = F.cacheKey(rpid, uid, text);
      if (ctx.cache.get(k) === true) return true;
    }
    return false;
  }

  // 递归过滤评论回复（含楼中楼）
  function filterReplies(arr, ctx, stat) {
    if (!Array.isArray(arr)) return arr;
    const out = [];
    for (let i = 0; i < arr.length; i++) {
      const r = arr[i];
      const uid = r && r.member && r.member.mid;
      const text = r && r.content && r.content.message;
      const rpid = r && (r.rpid_str || r.rpid);
      if (shouldDrop(ctx, uid, text, rpid)) {
        stat.n++;
        continue;
      }
      if (r && r.replies) r.replies = filterReplies(r.replies, ctx, stat);
      out.push(r);
    }
    return out;
  }

  // 就地过滤卡片数组（视频/动态/搜索项等）
  function filterArray(arr, ctx, getUid, getText, stat) {
    if (!Array.isArray(arr)) return;
    for (let i = arr.length - 1; i >= 0; i--) {
      const it = arr[i];
      const uid = getUid(it);
      const text = getText ? getText(it) : '';
      if (shouldDrop(ctx, uid, text, null)) {
        arr.splice(i, 1);
        stat.n++;
      }
    }
  }

  function dynAuthorMid(item) {
    try {
      return item.modules.module_author.mid;
    } catch (e) {
      return null;
    }
  }
  function dynText(item) {
    try {
      const md = item.modules.module_dynamic || {};
      let t = (md.desc && md.desc.text) || '';
      const mj = md.major;
      if (mj) {
        if (mj.archive) t += ' ' + (mj.archive.title || '') + ' ' + (mj.archive.desc || '');
        if (mj.opus) {
          if (mj.opus.title) t += ' ' + mj.opus.title;
          if (mj.opus.summary && mj.opus.summary.text) t += ' ' + mj.opus.summary.text;
        }
      }
      return t;
    } catch (e) {
      return '';
    }
  }

  // 主入口：按 URL 分派处理，返回被移除的条数
  function applyToResponse(url, json, ctx) {
    if (!json || typeof json !== 'object') return 0;
    const data = json.data;
    const stat = { n: 0 };

    // ========== 评论 ==========
    if (ctx.scopes.comments && url.indexOf('/x/v2/reply') !== -1 && data) {
      if (Array.isArray(data.replies)) data.replies = filterReplies(data.replies, ctx, stat);
      if (Array.isArray(data.top_replies)) data.top_replies = filterReplies(data.top_replies, ctx, stat);
      // 部分接口把根评论放在 data.root / data.reply
      if (data.root && data.root.replies) data.root.replies = filterReplies(data.root.replies, ctx, stat);
      return stat.n;
    }

    // ========== 动态 ==========
    if (ctx.scopes.dynamics && url.indexOf('/web-dynamic/') !== -1 && data) {
      if (Array.isArray(data.items)) filterArray(data.items, ctx, dynAuthorMid, dynText, stat);
      if (data.item && shouldDrop(ctx, dynAuthorMid(data.item), dynText(data.item), null)) {
        // 单条动态详情：整条置空
        json.data = { item: null };
        stat.n++;
      }
      return stat.n;
    }

    // ========== 用户投稿（空间视频列表）==========
    if (ctx.scopes.space && url.indexOf('/x/space/') !== -1 && url.indexOf('arc/search') !== -1 && data) {
      if (data.list && Array.isArray(data.list.vlist)) {
        filterArray(data.list.vlist, ctx, function (v) { return v.mid; }, function (v) { return v.title; }, stat);
      }
      return stat.n;
    }

    // ========== 搜索结果 ==========
    if (ctx.scopes.search && url.indexOf('/web-interface/wbi/search/') !== -1 && data) {
      if (Array.isArray(data.result)) {
        // /search/all/v2 结果是分组数组；/search/type 结果是条目数组
        if (data.result.length && data.result[0] && Array.isArray(data.result[0].data)) {
          for (const group of data.result) {
            filterArray(group.data, ctx, function (x) { return x.mid; }, function (x) { return x.title || x.uname; }, stat);
          }
        } else {
          filterArray(data.result, ctx, function (x) { return x.mid; }, function (x) { return x.title || x.uname; }, stat);
        }
      }
      return stat.n;
    }

    // ========== 首页/热门/相关 推荐 ==========
    if (ctx.scopes.recommend && data) {
      // 首页推荐
      if (url.indexOf('/index/top/feed/rcmd') !== -1 || url.indexOf('/index/top/rcmd') !== -1) {
        if (Array.isArray(data.item)) filterArray(data.item, ctx, function (v) { return v.owner && v.owner.mid; }, function (v) { return v.title; }, stat);
        return stat.n;
      }
      // 热门 / 排行
      if (url.indexOf('/web-interface/popular') !== -1 || url.indexOf('/web-interface/ranking') !== -1) {
        if (Array.isArray(data.list)) filterArray(data.list, ctx, function (v) { return v.owner && v.owner.mid; }, function (v) { return v.title; }, stat);
        return stat.n;
      }
      // 视频页「相关推荐」：data 直接是数组
      if (url.indexOf('/archive/related') !== -1 && Array.isArray(data)) {
        filterArray(data, ctx, function (v) { return v.owner && v.owner.mid; }, function (v) { return v.title; }, stat);
        return stat.n;
      }
    }

    return stat.n;
  }

  // 快速判断某 URL 是否属于我们要处理的接口（避免对无关请求做 clone+解析）
  function isTargetJson(url) {
    return (
      url.indexOf('/x/v2/reply') !== -1 ||
      url.indexOf('/web-dynamic/') !== -1 ||
      (url.indexOf('/x/space/') !== -1 && url.indexOf('arc/search') !== -1) ||
      url.indexOf('/web-interface/wbi/search/') !== -1 ||
      url.indexOf('/index/top/feed/rcmd') !== -1 ||
      url.indexOf('/index/top/rcmd') !== -1 ||
      url.indexOf('/web-interface/popular') !== -1 ||
      url.indexOf('/web-interface/ranking') !== -1 ||
      url.indexOf('/archive/related') !== -1
    );
  }

  NS.endpoints = { applyToResponse: applyToResponse, isTargetJson: isTargetJson, shouldDrop: shouldDrop };
})();
