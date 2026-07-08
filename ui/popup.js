;(function () {
  'use strict';
  const NS = globalThis.__BCP;
  const $ = function (id) { return document.getElementById(id); };
  let settings = null;

  function parseUid(v) {
    v = (v || '').trim();
    const m = v.match(/space\.bilibili\.com\/(\d+)/);
    if (m) return m[1];
    if (/^\d+$/.test(v)) return v;
    return null;
  }

  function ensureImgFilter() {
    if (!settings.imageFilter) settings.imageFilter = { phash: false, threshold: 12, clip: false, clipThreshold: 0.8 };
  }

  async function refresh() {
    settings = await NS.store.getSettings();
    $('enabled').checked = settings.enabled;
    $('llm').checked = settings.llm.enabled;
    $('phash').checked = !!(settings.imageFilter && settings.imageFilter.phash);
    $('clip').checked = !!(settings.imageFilter && settings.imageFilter.clip);
    setLevel(settings.blockLevel);

    const bl = await NS.store.getBlocklist();
    $('listCount').textContent = bl.length;
    updatePageCount();
  }

  // 本页已屏蔽计数：AI 分类是异步的（页面加载后几秒才陆续判完），
  // 弹窗打开期间轮询刷新，才能实时反映 AI 后续屏蔽的条数。
  function updatePageCount() {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      const tab = tabs && tabs[0];
      if (!tab || !/bilibili\.com/.test(tab.url || '')) { $('pageCount').textContent = '—'; return; }
      chrome.tabs.sendMessage(tab.id, { type: 'getStats' }, function (resp) {
        if (chrome.runtime.lastError || !resp) { $('pageCount').textContent = '0'; return; }
        $('pageCount').textContent = resp.count || 0;
      });
    });
  }
  setInterval(updatePageCount, 1000);

  function setLevel(v) {
    document.querySelectorAll('#levelSeg button').forEach(function (b) {
      b.classList.toggle('on', b.dataset.v === v);
    });
  }

  function save() { NS.store.setSettings(settings); }

  function hint(msg, cls) {
    const h = $('hint');
    h.textContent = msg;
    h.className = 'hint ' + (cls || '');
    if (msg && cls !== 'ok') setTimeout(function () { if (h.textContent === msg) { h.textContent = ''; h.className = 'hint'; } }, 3500);
  }

  $('enabled').addEventListener('change', function () { settings.enabled = this.checked; save(); });

  document.querySelectorAll('#levelSeg button').forEach(function (b) {
    b.addEventListener('click', function () { settings.blockLevel = b.dataset.v; setLevel(b.dataset.v); save(); });
  });

  // 相同图片自动屏蔽（pHash，本地免费）
  $('phash').addEventListener('change', function () {
    ensureImgFilter();
    settings.imageFilter.phash = this.checked;
    save();
    if (this.checked) hint('已开启：点评论旁 🚫 记住恶心图，之后同图自动挡', 'ok');
  });

  // 相似图片自动屏蔽（CLIP，本地，需下载模型 + 授权 HF）
  $('clip').addEventListener('change', async function () {
    ensureImgFilter();
    settings.imageFilter.clip = this.checked;
    save();
    if (!this.checked) return;
    // 首个 await 就是权限请求，保住用户手势
    const ok = await chrome.permissions.request({
      origins: ['https://huggingface.co/*', 'https://*.huggingface.co/*', 'https://*.hf.co/*'],
    }).catch(function () { return false; });
    if (!ok) { hint('未授权 huggingface.co，无法下载模型', 'err'); return; }
    hint('正在后台下载/预热本地模型…', 'ok');
    chrome.runtime.sendMessage({ type: 'warmClip' }, function (r) {
      if (chrome.runtime.lastError) { hint('后台无响应，请在设置页重试', 'err'); return; }
      if (r && r.ok) hint('本地图片模型就绪（' + (r.backend || '') + '）', 'ok');
      else hint('模型加载失败：' + ((r && r.error) || '详见设置页'), 'err');
    });
  });

  // 大模型筛选评论（消耗 token）
  $('llm').addEventListener('change', function () {
    settings.llm.enabled = this.checked;
    save();
    if (!this.checked) return;
    const hasEp = settings.llm.endpoint || (NS.PROVIDERS[settings.llm.provider] || {}).endpoint;
    if (!hasEp) hint('请先到设置里配置大模型接口', 'err');
    else hint('⚠ 已开启：大模型会消耗 API token，注意用量', 'ok');
  });

  async function addUid() {
    const uid = parseUid($('uid').value);
    if (!uid) { hint('无法识别 UID', 'err'); return; }
    try {
      const r = await NS.store.addBlock({ uid: uid });
      $('uid').value = '';
      $('listCount').textContent = r.list.length;
      hint(r.added ? ('已屏蔽 UID ' + uid) : ('UID ' + uid + ' 已在名单中'), 'ok');
    } catch (e) { hint(String(e.message || e), 'err'); }
  }
  $('addBtn').addEventListener('click', addUid);
  $('uid').addEventListener('keydown', function (e) { if (e.key === 'Enter') addUid(); });

  $('openOptions').addEventListener('click', function () {
    if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
    else window.open(chrome.runtime.getURL('ui/options.html'));
  });

  refresh();
})();
