;(function () {
  'use strict';
  const NS = (globalThis.__BCP = globalThis.__BCP || {});

  const SPACE_RE = /space\.bilibili\.com\/(\d+)/;
  // 评论单元标签（大小写不敏感）：顶层楼 *-thread-renderer / 楼中楼单条 *-reply-renderer /
  // 单条评论 *-comment-renderer。用后缀匹配以兼容 B 站改名；注意 *-replies-renderer（复数容器）
  // 不会命中 *-reply-renderer，故天然被排除，避免整段楼中楼被误折叠。
  function isUnitTag(tag) {
    tag = (tag || '').toLowerCase();
    if (tag.slice(-9) !== '-renderer') return false;
    return tag.slice(-16) === '-thread-renderer' ||
      tag.slice(-15) === '-reply-renderer' ||
      tag.slice(-17) === '-comment-renderer';
  }

  // ---------- 穿透 Shadow DOM 的遍历 ----------
  // 收集匹配的元素（顺序无所谓，用于发现单元/卡片）
  function deepQueryAll(root, test, limit) {
    const out = [];
    const stack = [root];
    let count = 0;
    const cap = limit || 20000;
    while (stack.length) {
      const node = stack.pop();
      if (!node) continue;
      if (++count > cap) break;
      if (node.nodeType === 1 && test(node)) out.push(node);
      if (node.children) for (let i = 0; i < node.children.length; i++) stack.push(node.children[i]);
      if (node.shadowRoot) stack.push(node.shadowRoot);
    }
    return out;
  }

  // 按文档顺序深度优先找第一个匹配（可在嵌套单元处停止下探）
  function deepFirst(node, test, stop, start) {
    start = start || node;
    if (node.nodeType === 1) {
      if (node !== start && stop && stop(node.tagName)) return null;
      if (test(node)) return node;
    }
    const kids = node.childNodes;
    if (kids) for (let i = 0; i < kids.length; i++) {
      const r = deepFirst(kids[i], test, stop, start);
      if (r) return r;
    }
    if (node.shadowRoot) {
      const r = deepFirst(node.shadowRoot, test, stop, start);
      if (r) return r;
    }
    return null;
  }

  // 不该计入文本的元素（否则会把组件 shadow 里的 CSS/脚本抓进评论文本）
  const TEXT_SKIP = { STYLE: 1, SCRIPT: 1, TEMPLATE: 1, NOSCRIPT: 1 };

  // 穿透 shadow 的文本提取（可在嵌套单元处停止，避免根评论吞掉楼中楼文本）
  function deepText(node, opts) {
    opts = opts || {};
    const stop = opts.stop;
    const start = node;
    let budget = opts.budget || 4000;
    let s = '';
    const stack = [node];
    while (stack.length && budget > 0) {
      const cur = stack.pop();
      if (!cur) continue;
      if (cur.nodeType === 3) { s += cur.nodeValue; budget -= cur.nodeValue.length; continue; }
      if (cur.nodeType === 1 || cur.nodeType === 11) {
        if (cur.nodeType === 1 && TEXT_SKIP[cur.tagName]) continue;
        if (cur.nodeType === 1 && cur !== start && stop && stop(cur.tagName)) continue;
        if (cur.shadowRoot) stack.push(cur.shadowRoot);
        const kids = cur.childNodes;
        if (kids) for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
      }
    }
    return s.replace(/\s+/g, ' ').trim();
  }

  // 评论正文容器（用于只取正文，排除用户名/工具栏/CSS）
  function isContentNode(n) {
    if (!n.tagName) return false;
    if (n.tagName.toLowerCase() === 'bili-rich-text') return true;
    if (n.id === 'content' || n.id === 'reply-content') return true;
    if (n.classList && (n.classList.contains('reply-content') || n.classList.contains('reply-content-container'))) return true;
    return false;
  }

  // 抽取评论配图 URL（排除头像/表情/装扮），供多模态判定
  function collectImages(el, stop) {
    const out = [];
    (function rec(node, start) {
      if (node.nodeType === 1) {
        if (node !== start && stop && stop(node.tagName)) return;
        const tag = node.tagName;
        if (tag === 'STYLE' || tag === 'SCRIPT') return;
        if (tag === 'IMG') {
          const s = node.currentSrc || node.src || node.getAttribute('data-src') || '';
          if (/^https?:/.test(s) && !/\/(emote|garb|face|avatar|topic)\//.test(s)) out.push(s.split('@')[0]);
        }
      }
      const kids = node.childNodes;
      if (kids) for (let i = 0; i < kids.length; i++) rec(kids[i], start);
      if (node.shadowRoot) rec(node.shadowRoot, start);
    })(el, el);
    const seen = {}, res = [];
    for (let i = 0; i < out.length && res.length < 4; i++) {
      if (!seen[out[i]]) { seen[out[i]] = 1; res.push(out[i]); }
    }
    return res;
  }

  function isUserLink(n) {
    return n.tagName === 'A' && typeof n.href === 'string' && SPACE_RE.test(n.href);
  }

  // 按文档顺序收集本单元内所有指向用户空间的链接（可在嵌套单元处停止）
  function deepLinks(el, stop) {
    const out = [];
    (function rec(node, start) {
      if (node.nodeType === 1) {
        if (node !== start && stop && stop(node.tagName)) return;
        if (isUserLink(node)) out.push(node);
      }
      const kids = node.childNodes;
      if (kids) for (let i = 0; i < kids.length; i++) rec(kids[i], start);
      if (node.shadowRoot) rec(node.shadowRoot, start);
    })(el, el);
    return out;
  }

  function findAuthor(el, stop) {
    const links = deepLinks(el, stop);
    if (!links.length) return null;
    // 一条评论通常有「头像链接(无文字)」和「用户名链接(有文字)」两个 —— 优先取有文字的，
    // 保证 🚫 稳定落在用户名旁而非头像后。
    let link = null;
    for (let i = 0; i < links.length; i++) {
      if ((links[i].textContent || '').trim()) { link = links[i]; break; }
    }
    if (!link) link = links[0];
    const m = link.href.match(SPACE_RE);
    return { uid: m[1], name: (link.textContent || '').trim(), link: link };
  }

  // ---------- 评论单元 ----------
  const OLD_UNIT = function (n) {
    if (!n.classList) return false;
    if (!(n.classList.contains('reply-item') || n.classList.contains('list-item'))) return false;
    return !!(n.getAttribute('data-usercard-mid') || deepFirst(n, isUserLink));
  };

  function commentRoots() {
    const roots = [];
    // bili-comments 在光 DOM 里，用轻量 querySelectorAll 直接取；取不到再穿透兜底
    let hosts = document.querySelectorAll('bili-comments');
    if (!hosts.length) {
      hosts = deepQueryAll(document, function (n) {
        return n.tagName && n.tagName.toLowerCase() === 'bili-comments';
      }, 8000);
    }
    hosts.forEach(function (h) { if (h.shadowRoot) roots.push(h.shadowRoot); });
    const legacy = document.querySelector('#comment .reply-list, .comment-list, .bb-comment');
    if (legacy) roots.push(legacy);
    return roots; // 找不到评论区就返回空，避免全 document 扫描
  }

  // 注意：不缓存跳过（B站 feed 会回收复用 DOM 节点，缓存会导致张冠李戴），
  // 每次都重新抽取；el.__bcp 只作为“当前值”供占位标签引用。
  function extract(el) {
    let uid = null, name = '', link = null;
    const midAttr = el.getAttribute && el.getAttribute('data-usercard-mid');
    if (midAttr) {
      uid = String(midAttr);
      const a = deepFirst(el, function (n) { return n.tagName === 'A'; });
      if (a) { name = (a.textContent || '').trim(); link = a; }
    } else {
      // 只在本单元范围内找（stop 到嵌套单元），优先带文字的用户名链接
      const au = findAuthor(el, isUnitTag);
      if (au) { uid = au.uid; name = au.name; link = au.link; }
    }
    const rpid =
      (el.getAttribute && (el.getAttribute('data-id') || el.getAttribute('data-rpid'))) ||
      (el.dataset && (el.dataset.id || el.dataset.rpid)) || null;
    // 只取正文组件的文本/图片，避免混入用户名、时间、点赞数与组件 CSS
    const contentEl = deepFirst(el, isContentNode, isUnitTag) || el;
    const info = {
      el: el, uid: uid, name: name, link: link, rpid: rpid,
      text: deepText(contentEl, { stop: isUnitTag }),
      images: collectImages(contentEl, isUnitTag),
    };
    el.__bcp = info;
    return info;
  }

  function scanComments(cb) {
    const roots = commentRoots();
    roots.forEach(function (root) {
      deepQueryAll(root, function (n) {
        return isUnitTag(n.tagName) || OLD_UNIT(n);
      }, 15000).forEach(function (el) {
        // 每条独立 try/catch：单条出错不能中断 forEach，否则后面的评论全被跳过
        try {
          const info = extract(el);
          if (info.uid || info.text) cb(info);
        } catch (e) { console.warn('[BiliBlock] 处理评论出错', e, el); }
      });
    });
  }

  // ---------- 卡片（视频/动态/搜索/推荐）----------
  const CLASS_CARDS = ['bili-video-card', 'video-page-card-small', 'video-page-operator-card-small',
    'bili-dyn-item', 'bili-dyn-list__item', 'feed-card', 'rank-item', 'small-item', 'card-box'];
  function isCard(n) {
    if (!n.tagName) return false;
    const tag = n.tagName.toLowerCase();
    if (tag === 'bili-video-card' || tag === 'bili-dyn-item') return true;
    if (!n.classList) return false;
    for (let i = 0; i < CLASS_CARDS.length; i++) if (n.classList.contains(CLASS_CARDS[i])) return true;
    return false;
  }
  function extractCard(el) {
    const au = findAuthor(el);
    const info = {
      el: el, isCard: true,
      uid: au ? au.uid : null, name: au ? au.name : '', link: au ? au.link : null,
      text: deepText(el, { budget: 300 }),
    };
    el.__bcp = info;
    return info;
  }
  function scanCards(cb) {
    deepQueryAll(document, isCard, 20000).forEach(function (el) {
      try {
        const info = extractCard(el);
        if (info.uid) cb(info);
      } catch (e) { console.warn('[BiliBlock] 处理卡片出错', e, el); }
    });
  }

  // ---------- 行内操作按钮（一簇）----------
  // specs: [{ icon, title, onClick(info) }]
  function injectButtons(info, specs) {
    const link = info.link;
    if (!link || link.__bcpBtn) return;
    link.__bcpBtn = true;
    const wrap = document.createElement('span');
    wrap.className = 'bcp-btns';
    wrap.style.cssText = 'display:inline-flex;gap:4px;margin-left:6px;vertical-align:middle;';
    specs.forEach(function (s) {
      const b = document.createElement('span');
      b.textContent = s.icon;
      b.title = s.title;
      b.style.cssText = 'cursor:pointer;font-size:12px;opacity:.45;user-select:none;line-height:1;';
      b.addEventListener('mouseenter', function () { b.style.opacity = '1'; });
      b.addEventListener('mouseleave', function () { b.style.opacity = '.45'; });
      b.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); s.onClick(info); });
      wrap.appendChild(b);
    });
    try { link.insertAdjacentElement('afterend', wrap); } catch (e) {}
  }

  NS.scanner = {
    deepQueryAll: deepQueryAll, deepFirst: deepFirst, deepText: deepText,
    scanComments: scanComments, scanCards: scanCards, injectButtons: injectButtons, SPACE_RE: SPACE_RE,
  };
})();
