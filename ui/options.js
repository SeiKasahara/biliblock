;(function () {
  'use strict';
  const NS = globalThis.__BCP;
  const $ = function (id) { return document.getElementById(id); };
  let settings = null;
  let blocklist = [];

  // ---------- Tab 切换 ----------
  document.querySelectorAll('.tab').forEach(function (t) {
    t.addEventListener('click', function () {
      document.querySelectorAll('.tab').forEach(function (x) { x.classList.remove('on'); });
      t.classList.add('on');
      document.querySelectorAll('[data-panel]').forEach(function (p) {
        p.classList.toggle('hidden', p.dataset.panel !== t.dataset.tab);
      });
    });
  });

  // ---------- 保存（防抖）----------
  let saveTimer = null;
  function saveSettings() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () { NS.store.setSettings(settings); }, 250);
  }

  function parseUid(v) {
    v = (v || '').trim();
    const m = v.match(/space\.bilibili\.com\/(\d+)/);
    if (m) return m[1];
    if (/^\d+$/.test(v)) return v;
    return null;
  }

  // ---------- 渲染设置 ----------
  function render() {
    $('enabled').checked = settings.enabled;
    setSeg('levelSeg', settings.blockLevel);
    document.querySelectorAll('[data-scope]').forEach(function (c) {
      c.checked = !!settings.scopes[c.dataset.scope];
    });
    $('imgPhash').checked = !!(settings.imageFilter && settings.imageFilter.phash);
    $('imgThreshold').value = (settings.imageFilter && settings.imageFilter.threshold) || 10;
    $('imgClip').checked = !!(settings.imageFilter && settings.imageFilter.clip);
    $('clipThreshold').value = (settings.imageFilter && settings.imageFilter.clipThreshold) || 0.85;
    if (!settings.semantic) settings.semantic = { threshold: 0, minSamples: 5 };
    $('semThreshold2').value = settings.semantic.threshold || 0;
    $('semMinConfidence').value = settings.semantic.minConfidence != null ? settings.semantic.minConfidence : 0.25;
    $('semDupThreshold').value = settings.semantic.dupThreshold != null ? settings.semantic.dupThreshold : 0.5;
    $('semKnn').value = settings.semantic.knn || 1;
    $('semMinSamples').value = settings.semantic.minSamples || 5;
    updateImgStat();
    updateClipStat();
    updateSemStat();
    $('keywords').value = (settings.rules.keywords || []).join('\n');
    $('regexps').value = (settings.rules.regexps || []).join('\n');
    $('caseSensitive').checked = !!settings.rules.caseSensitive;

    // LLM
    const l = settings.llm;
    $('llmEnabled').checked = l.enabled;
    $('model').value = l.model || '';
    $('endpoint').value = l.endpoint || '';
    $('apiKey').value = l.apiKey || '';
    $('systemPrompt').value = l.systemPrompt || '';
    $('batchSize').value = l.batchSize;
    $('maxConcurrent').value = l.maxConcurrent;
    $('temperature').value = l.temperature;
    $('minLen').value = l.minLen;
    $('cacheTtlDays').value = l.cacheTtlDays;
    $('llmDanmaku').checked = !!l.danmaku;
    $('llmMultimodal').checked = !!l.multimodal;
    renderProviders();
    updateProviderUI();
    updateCacheStat();
  }

  function setSeg(id, v) {
    document.querySelectorAll('#' + id + ' button').forEach(function (b) {
      b.classList.toggle('on', b.dataset.v === v);
    });
  }

  function renderProviders() {
    const sel = $('provider');
    if (!sel.options.length) {
      Object.keys(NS.PROVIDERS).forEach(function (k) {
        const o = document.createElement('option');
        o.value = k; o.textContent = NS.PROVIDERS[k].name;
        sel.appendChild(o);
      });
    }
    sel.value = settings.llm.provider; // 每次 render 都同步（导入后 provider 可能变化）
  }

  function updateProviderUI() {
    const p = NS.PROVIDERS[settings.llm.provider] || {};
    $('endpoint').placeholder = p.endpoint || '接口地址';
    $('model').placeholder = p.model || '模型名';
    $('providerNote').textContent = p.note || '';
    if (p.keyUrl) { $('keyLink').href = p.keyUrl; $('keyLink').style.display = ''; }
    else $('keyLink').style.display = 'none';
  }

  // ---------- 常规事件 ----------
  $('enabled').addEventListener('change', function () { settings.enabled = this.checked; saveSettings(); });
  document.querySelectorAll('#levelSeg button').forEach(function (b) {
    b.addEventListener('click', function () { settings.blockLevel = b.dataset.v; setSeg('levelSeg', b.dataset.v); saveSettings(); });
  });
  document.querySelectorAll('[data-scope]').forEach(function (c) {
    c.addEventListener('change', function () { settings.scopes[c.dataset.scope] = c.checked; saveSettings(); });
  });

  // 图片查重 pHash
  $('imgPhash').addEventListener('change', function () {
    if (!settings.imageFilter) settings.imageFilter = { phash: false, threshold: 10 };
    settings.imageFilter.phash = this.checked; saveSettings();
  });
  $('imgThreshold').addEventListener('input', function () {
    if (!settings.imageFilter) settings.imageFilter = { phash: false, threshold: 10 };
    settings.imageFilter.threshold = Number(this.value) || 10; saveSettings();
  });
  $('clearImgBtn').addEventListener('click', async function () {
    await NS.store.clearImgHashes(); updateImgStat();
  });
  async function updateImgStat() {
    const s = await NS.store.imgHashStats();
    $('imgStat').textContent = ' 当前：黑图库 ' + s.black + ' 张、白库 ' + s.white + ' 张。';
  }

  // 图片 CLIP（第2层）
  async function requestHfPermission() {
    try {
      return await chrome.permissions.request({ origins: ['https://huggingface.co/*', 'https://*.huggingface.co/*', 'https://*.hf.co/*'] });
    } catch (e) { return false; }
  }
  function ensureImgFilter() { if (!settings.imageFilter) settings.imageFilter = { phash: false, threshold: 10, clip: false, clipThreshold: 0.85 }; }
  $('imgClip').addEventListener('change', async function () {
    ensureImgFilter();
    settings.imageFilter.clip = this.checked;
    saveSettings();
    if (this.checked) {
      const ok = await requestHfPermission();
      $('clipStat').textContent = ok ? '已授权。建议点「下载并预热本地模型」先拉好模型。' : '未授权 huggingface.co，模型无法下载。';
    }
  });
  $('clipThreshold').addEventListener('input', function () {
    ensureImgFilter();
    settings.imageFilter.clipThreshold = Number(this.value) || 0.85;
    saveSettings();
  });
  $('warmClipBtn').addEventListener('click', async function () {
    const granted = await requestHfPermission();
    if (!granted) { $('clipStat').textContent = '需要授权访问 huggingface.co'; return; }
    $('clipStat').textContent = '正在加载模型（首次需下载，可能要几十秒）…';
    chrome.runtime.sendMessage({ type: 'warmClip' }, function (r) {
      if (chrome.runtime.lastError) { $('clipStat').textContent = '后台无响应：' + chrome.runtime.lastError.message; return; }
      if (!r || !r.ok) { $('clipStat').textContent = '加载失败：' + (r && r.error || '未知错误'); return; }
      $('clipStat').textContent = '模型就绪（后端：' + (r.backend || '?') + '）。现在点 🚫 记住图，就能挡相似图了。';
    });
  });
  $('clearVecBtn').addEventListener('click', async function () {
    await NS.store.clearImgVecs(); updateClipStat();
  });
  async function updateClipStat() {
    const s = await NS.store.imgVecStats();
    $('clipStat').textContent = ' 当前图向量：黑 ' + s.black + '、白 ' + s.white + '。';
  }

  // 语义相似屏蔽（文本）
  function ensureSemantic() { if (!settings.semantic) settings.semantic = { threshold: 0, minSamples: 5 }; }
  $('semThreshold2').addEventListener('input', function () {
    ensureSemantic(); settings.semantic.threshold = Number(this.value) || 0; saveSettings();
  });
  $('semMinConfidence').addEventListener('input', function () {
    ensureSemantic(); settings.semantic.minConfidence = Number(this.value); saveSettings();
  });
  $('semDupThreshold').addEventListener('input', function () {
    ensureSemantic(); settings.semantic.dupThreshold = Number(this.value); saveSettings();
  });
  $('semKnn').addEventListener('input', function () {
    ensureSemantic(); settings.semantic.knn = Math.max(1, Number(this.value) || 1); saveSettings();
  });
  $('semMinSamples').addEventListener('input', function () {
    ensureSemantic(); settings.semantic.minSamples = Number(this.value) || 5; saveSettings(); updateSemStat();
  });
  $('warmTextBtn').addEventListener('click', async function () {
    const ok = await requestHfPermission();
    if (!ok) { $('semStat').textContent = '需要授权访问 huggingface.co'; return; }
    $('semStat').textContent = '正在加载文本模型（首次需下载，约 24MB）…';
    chrome.runtime.sendMessage({ type: 'warmText' }, function (r) {
      if (chrome.runtime.lastError) { $('semStat').textContent = '后台无响应：' + chrome.runtime.lastError.message; return; }
      if (!r || !r.ok) { $('semStat').textContent = '加载失败：' + (r && r.error || '未知错误'); return; }
      $('semStat').textContent = '文本模型就绪（后端：' + (r.backend || '?') + '）。';
    });
  });
  async function updateSemStat() {
    ensureSemantic();
    const ex = await NS.store.getExamples();
    const blockN = ex.filter(function (e) { return e.label === 'block'; }).length;
    const min = settings.semantic.minSamples || 5;
    $('semStat').textContent = blockN >= min
      ? ('「屏蔽」样例 ' + blockN + ' 条，已满足最少 ' + min + ' 条')
      : ('「屏蔽」样例仅 ' + blockN + ' 条 < ' + min + '，功能禁用中（去「样例学习」或点 🚫 积累）');
  }

  // ---------- 规则事件 ----------
  function linesOf(v) { return v.split('\n').map(function (s) { return s.trim(); }).filter(Boolean); }
  $('keywords').addEventListener('input', function () { settings.rules.keywords = linesOf(this.value); saveSettings(); });
  $('regexps').addEventListener('input', function () { settings.rules.regexps = linesOf(this.value); saveSettings(); });
  $('caseSensitive').addEventListener('change', function () { settings.rules.caseSensitive = this.checked; saveSettings(); });

  // ---------- LLM 事件 ----------
  $('llmEnabled').addEventListener('change', async function () {
    settings.llm.enabled = this.checked;
    saveSettings();
    // 开启时顺便请求接口的访问权限（否则后台 fetch 会被 CORS 拦截且静默失败）
    if (this.checked) {
      const ok = await ensurePermission();
      if (!ok) setTest('已开启，但尚未授权访问接口；请点「测试连接」授权后才能生效', 'err');
    }
  });
  $('provider').addEventListener('change', function () { settings.llm.provider = this.value; updateProviderUI(); saveSettings(); });
  $('model').addEventListener('input', function () { settings.llm.model = this.value.trim(); saveSettings(); });
  $('endpoint').addEventListener('input', function () { settings.llm.endpoint = this.value.trim(); saveSettings(); });
  $('apiKey').addEventListener('input', function () { settings.llm.apiKey = this.value; saveSettings(); });
  $('systemPrompt').addEventListener('input', function () { settings.llm.systemPrompt = this.value; saveSettings(); });
  ['batchSize', 'maxConcurrent', 'temperature', 'minLen', 'cacheTtlDays'].forEach(function (id) {
    $(id).addEventListener('input', function () { settings.llm[id] = Number(this.value); saveSettings(); });
  });
  $('llmDanmaku').addEventListener('change', function () { settings.llm.danmaku = this.checked; saveSettings(); });
  $('llmMultimodal').addEventListener('change', function () { settings.llm.multimodal = this.checked; saveSettings(); });
  $('resetPrompt').addEventListener('click', function () {
    settings.llm.systemPrompt = NS.DEFAULT_SYSTEM_PROMPT; $('systemPrompt').value = NS.DEFAULT_SYSTEM_PROMPT; saveSettings();
  });

  function endpointOrigin() {
    const url = ($('endpoint').value.trim()) || (NS.PROVIDERS[settings.llm.provider] || {}).endpoint || '';
    try { return new URL(url).origin + '/*'; } catch (e) { return null; }
  }
  async function ensurePermission() {
    // 注意：必须在用户点击手势内“首个 await”就调用 request，
    // 若先 await contains 会丢失手势导致 request 被拒。request 对已授权的权限会立即返回 true。
    const origin = endpointOrigin();
    if (!origin) return false;
    try { return await chrome.permissions.request({ origins: [origin] }); }
    catch (e) { return false; }
  }
  $('grantBtn').addEventListener('click', async function () {
    const ok = await ensurePermission();
    setTest(ok ? '已授权访问接口 ✓' : '未授权，无法请求该接口', ok ? 'ok' : 'err');
  });

  function setTest(msg, cls) { const e = $('testResult'); e.textContent = msg; e.className = 'testres ' + (cls || ''); }
  $('testBtn').addEventListener('click', async function () {
    setTest('连接中…', '');
    const granted = await ensurePermission();
    if (!granted) { setTest('需要授权访问该接口', 'err'); return; }
    const override = {
      provider: settings.llm.provider, endpoint: $('endpoint').value.trim(), model: $('model').value.trim(),
      apiKey: $('apiKey').value, systemPrompt: $('systemPrompt').value,
      temperature: Number($('temperature').value), batchSize: Number($('batchSize').value), maxConcurrent: 1,
    };
    chrome.runtime.sendMessage({ type: 'testLLM', override: override }, function (r) {
      if (chrome.runtime.lastError) { setTest('后台无响应：' + chrome.runtime.lastError.message, 'err'); return; }
      if (!r || !r.ok) { setTest('失败：' + (r && r.error || '未知错误'), 'err'); return; }
      const d = r.decisions || {};
      const a = d.test1 === true ? '辱骂→屏蔽✓' : '辱骂→未识别✗';
      const b = d.test2 === false ? '正常→保留✓' : '正常→误判✗';
      setTest('连接成功（' + r.model + '）：' + a + '，' + b, 'ok');
    });
  });

  $('clearCacheBtn').addEventListener('click', async function () {
    await NS.store.clearCache(); updateCacheStat();
  });
  async function updateCacheStat() {
    const s = await NS.store.cacheStats();
    $('cacheStat').textContent = '缓存判定 ' + s.total + ' 条（其中屏蔽 ' + s.blocked + ' 条）';
  }

  // ---------- 屏蔽名单 ----------
  async function loadBlocklist() {
    blocklist = await NS.store.getBlocklist();
    renderTable();
  }
  function fmtDate(t) {
    if (!t) return '';
    const d = new Date(t);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function renderTable() {
    const q = ($('blSearch').value || '').toLowerCase();
    const tbody = $('blTable').querySelector('tbody');
    tbody.innerHTML = '';
    const list = blocklist.filter(function (e) {
      if (!q) return true;
      return (String(e.uid) + (e.name || '') + (e.note || '')).toLowerCase().indexOf(q) !== -1;
    });
    $('blCount').textContent = blocklist.length;
    $('blEmpty').style.display = blocklist.length ? 'none' : '';
    list.forEach(function (e) {
      const tr = document.createElement('tr');
      const uidTd = document.createElement('td');
      const a = document.createElement('a');
      a.href = 'https://space.bilibili.com/' + e.uid; a.target = '_blank'; a.textContent = e.uid;
      uidTd.appendChild(a);
      const nameTd = document.createElement('td'); nameTd.textContent = e.name || '—';
      const noteTd = document.createElement('td');
      const noteIn = document.createElement('input'); noteIn.className = 'noteedit'; noteIn.value = e.note || '';
      noteIn.placeholder = '点击备注';
      noteIn.addEventListener('change', function () { e.note = noteIn.value; NS.store.setBlocklist(blocklist); });
      noteTd.appendChild(noteIn);
      // 每人屏蔽强度：默认（跟随全局）/ 深 / 浅
      const lvTd = document.createElement('td');
      const lvSel = document.createElement('select');
      lvSel.innerHTML = '<option value="">默认</option><option value="deep">深</option><option value="shallow">浅</option>';
      lvSel.value = (e.level === 'deep' || e.level === 'shallow') ? e.level : '';
      lvSel.style.cssText = 'padding:3px 4px;font-size:12px';
      lvSel.addEventListener('change', async function () {
        if (this.value) e.level = this.value; else delete e.level;
        blocklist = await NS.store.setBlockLevel(e.uid, this.value);
      });
      lvTd.appendChild(lvSel);
      const dateTd = document.createElement('td'); dateTd.textContent = fmtDate(e.addedAt);
      const rmTd = document.createElement('td');
      const rm = document.createElement('button'); rm.className = 'rm'; rm.textContent = '移除';
      rm.addEventListener('click', async function () {
        blocklist = await NS.store.removeBlock(e.uid); renderTable();
      });
      rmTd.appendChild(rm);
      tr.append(uidTd, nameTd, noteTd, lvTd, dateTd, rmTd);
      tbody.appendChild(tr);
    });
  }
  $('blSearch').addEventListener('input', renderTable);
  async function addUid() {
    const uid = parseUid($('newUid').value);
    if (!uid) { $('newUid').focus(); return; }
    try {
      const r = await NS.store.addBlock({ uid: uid, note: $('newNote').value.trim() });
      blocklist = r.list;
      $('newUid').value = ''; $('newNote').value = '';
      renderTable();
    } catch (e) {
      $('dataMsg').textContent = '';
      alert('添加失败：' + (e.message || e) + '\n（名单可能过大超出同步配额，可改用导出备份）');
    }
  }
  $('addUidBtn').addEventListener('click', addUid);
  $('newUid').addEventListener('keydown', function (e) { if (e.key === 'Enter') addUid(); });
  $('newNote').addEventListener('keydown', function (e) { if (e.key === 'Enter') addUid(); });

  // ---------- 样例学习 ----------
  let examples = [];
  async function loadExamples() {
    examples = await NS.store.getExamples();
    renderExTable();
  }
  function renderExTable() {
    const tbody = $('exTable').querySelector('tbody');
    tbody.innerHTML = '';
    $('exCount').textContent = examples.length;
    $('exEmpty').style.display = examples.length ? 'none' : '';
    examples.forEach(function (e) {
      const tr = document.createElement('tr');
      const typeTd = document.createElement('td');
      typeTd.textContent = e.label === 'allow' ? '正常' : '应屏蔽';
      typeTd.style.color = e.label === 'allow' ? '#2ecc71' : '#eb5055';
      const txtTd = document.createElement('td'); txtTd.textContent = e.text;
      const rmTd = document.createElement('td');
      const rm = document.createElement('button'); rm.className = 'rm'; rm.textContent = '删除';
      rm.addEventListener('click', async function () { examples = await NS.store.removeExample(e.text); renderExTable(); });
      rmTd.appendChild(rm);
      tr.append(typeTd, txtTd, rmTd);
      tbody.appendChild(tr);
    });
  }
  async function addExample() {
    const text = $('exText').value.trim();
    if (!text) { $('exText').focus(); return; }
    try {
      examples = await NS.store.addExample({ text: text, label: $('exLabel').value });
      $('exText').value = '';
      renderExTable();
    } catch (e) { alert('添加失败：' + (e.message || e)); }
  }
  $('exAdd').addEventListener('click', addExample);
  $('exText').addEventListener('keydown', function (e) { if (e.key === 'Enter') addExample(); });
  $('reevalBtn').addEventListener('click', async function () {
    await NS.store.requestReeval();
    const b = $('reevalBtn'), t = b.textContent;
    b.textContent = '已清空，打开的B站页面正在按新样例重判…';
    setTimeout(function () { b.textContent = t; }, 2600);
  });

  // ---------- 导入 / 导出 ----------
  $('exportBtn').addEventListener('click', async function () {
    const data = await NS.store.exportAll();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'biliblock-' + new Date().toISOString().slice(0, 10) + '.json';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  });
  let importMode = 'merge';
  $('importMergeBtn').addEventListener('click', function () { importMode = 'merge'; $('importFile').click(); });
  $('importReplaceBtn').addEventListener('click', function () { importMode = 'replace'; $('importFile').click(); });
  $('importFile').addEventListener('change', function () {
    const file = this.files && this.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async function () {
      try {
        const obj = JSON.parse(reader.result);
        await NS.store.importAll(obj, importMode);
        settings = await NS.store.getSettings();
        await loadBlocklist();
        await loadExamples();
        render();
        $('dataMsg').textContent = '导入成功（' + (importMode === 'replace' ? '覆盖' : '合并') + '）';
      } catch (e) {
        $('dataMsg').textContent = '导入失败：' + (e.message || e);
      }
    };
    reader.readAsText(file);
    this.value = '';
  });

  // 监听其它页面/设备的名单变化，实时刷新
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area === 'sync') {
      if (Object.keys(changes).some(function (k) { return k.indexOf('bl:') === 0; })) loadBlocklist();
      if (changes.bcp_examples) { loadExamples(); updateSemStat(); }
      if (changes.bcp_imgblack || changes.bcp_imgwhite) updateImgStat();
    } else if (area === 'local') {
      if (changes.bcp_imgvec) updateClipStat();
    }
  });

  // ---------- 启动 ----------
  (async function init() {
    settings = await NS.store.getSettings();
    render();
    await loadBlocklist();
    await loadExamples();
  })();
})();
