;(function () {
  'use strict';
  const NS = (globalThis.__BCP = globalThis.__BCP || {});
  const F = NS.filter;

  // 判断单条内容是否应被丢弃（uid 命中 / 关键词命中 / LLM 缓存判黑）
  function shouldDrop(ctx, uid, text, rpid) {
    uid = F.uid(uid);
    if (uid && ctx.blocked.has(uid)) return true; // ctx.blocked = 深屏蔽的 uid（浅的不在此，交 DOM 折叠）
    // 关键词/缓存判定仅在"全局深"时于 API 层剔除；浅屏蔽要保留渲染以便 DOM 折叠。默认 true 向后兼容
    const applyRC = ctx.applyRulesCache !== false;
    if (applyRC && F.matchRules(text, ctx.rules)) return true;
    if (applyRC) {
      const active = ctx.cacheActive !== undefined ? ctx.cacheActive : ctx.llmEnabled;
      if (active && (rpid || uid)) {
        const k = F.cacheKey(rpid, uid, text);
        if (ctx.cache.get(k) === true) return true;
      }
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

  // 收集一条视频卡涉及的所有 UP 主 mid：主投稿人 + 联合投稿人(staff[])
  function collectMids(item, primary) {
    const mids = [];
    if (primary != null) mids.push(primary);
    const staff = item && item.staff;
    if (Array.isArray(staff)) {
      for (let i = 0; i < staff.length; i++) {
        if (staff[i] && staff[i].mid != null) mids.push(staff[i].mid);
      }
    }
    return mids;
  }
  function midsBlocked(ctx, mids) {
    for (let i = 0; i < mids.length; i++) {
      const m = F.uid(mids[i]);
      if (m && ctx.blocked.has(m)) return true;
    }
    return false;
  }

  // 就地过滤卡片数组（视频/动态/搜索项等）。getMids 返回该卡涉及的所有 mid（含联合投稿人）
  function filterArray(arr, ctx, getMids, getText, stat) {
    if (!Array.isArray(arr)) return;
    const applyRC = ctx.applyRulesCache !== false;
    for (let i = arr.length - 1; i >= 0; i--) {
      const it = arr[i];
      const mids = getMids(it) || [];
      const text = getText ? getText(it) : '';
      if (midsBlocked(ctx, mids) || (applyRC && F.matchRules(text, ctx.rules))) {
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
      if (Array.isArray(data.items)) filterArray(data.items, ctx, function (item) { return collectMids(item, dynAuthorMid(item)); }, dynText, stat);
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
        filterArray(data.list.vlist, ctx, function (v) { return collectMids(v, v.mid); }, function (v) { return v.title; }, stat);
      }
      return stat.n;
    }

    // ========== 搜索结果 ==========
    if (ctx.scopes.search && url.indexOf('/web-interface/wbi/search/') !== -1 && data) {
      if (Array.isArray(data.result)) {
        // /search/all/v2 结果是分组数组；/search/type 结果是条目数组
        if (data.result.length && data.result[0] && Array.isArray(data.result[0].data)) {
          for (const group of data.result) {
            filterArray(group.data, ctx, function (x) { return collectMids(x, x.mid); }, function (x) { return x.title || x.uname; }, stat);
          }
        } else {
          filterArray(data.result, ctx, function (x) { return collectMids(x, x.mid); }, function (x) { return x.title || x.uname; }, stat);
        }
      }
      return stat.n;
    }

    // ========== 首页/热门/相关 推荐 ==========
    if (ctx.scopes.recommend && data) {
      // 首页推荐
      if (url.indexOf('/index/top/feed/rcmd') !== -1 || url.indexOf('/index/top/rcmd') !== -1) {
        if (Array.isArray(data.item)) filterArray(data.item, ctx, function (v) { return collectMids(v, v.owner && v.owner.mid); }, function (v) { return v.title; }, stat);
        return stat.n;
      }
      // 热门 / 排行
      if (url.indexOf('/web-interface/popular') !== -1 || url.indexOf('/web-interface/ranking') !== -1) {
        if (Array.isArray(data.list)) filterArray(data.list, ctx, function (v) { return collectMids(v, v.owner && v.owner.mid); }, function (v) { return v.title; }, stat);
        return stat.n;
      }
      // 视频页「相关推荐」：data 直接是数组
      if (url.indexOf('/archive/related') !== -1 && Array.isArray(data)) {
        filterArray(data, ctx, function (v) { return collectMids(v, v.owner && v.owner.mid); }, function (v) { return v.title; }, stat);
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
