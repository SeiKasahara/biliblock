;(function () {
  'use strict';
  const NS = (globalThis.__BCP = globalThis.__BCP || {});

  // 合并服务商预设，补全 endpoint / model
  function resolveCfg(cfg) {
    const p = (NS.PROVIDERS && NS.PROVIDERS[cfg.provider]) || {};
    return {
      endpoint: (cfg.endpoint && cfg.endpoint.trim()) || p.endpoint || '',
      model: (cfg.model && cfg.model.trim()) || p.model || '',
      apiKey: cfg.apiKey || '',
      systemPrompt: cfg.systemPrompt || NS.DEFAULT_SYSTEM_PROMPT,
      temperature: typeof cfg.temperature === 'number' ? cfg.temperature : 0,
      batchSize: cfg.batchSize || 15,
      maxConcurrent: Math.max(1, cfg.maxConcurrent || 1),
      provider: cfg.provider,
    };
  }

  function chunk(arr, n) {
    const out = [];
    for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
    return out;
  }

  // 从模型自由文本里抠出 JSON 数组
  function extractJsonArray(text) {
    if (!text) return null;
    let t = text.trim();
    // 去掉 ```json ... ``` 代码块围栏
    t = t.replace(/^```[a-zA-Z]*\s*/,'').replace(/\s*```$/,'');
    const a = t.indexOf('[');
    const b = t.lastIndexOf(']');
    if (a === -1 || b === -1 || b < a) return null;
    try { return JSON.parse(t.slice(a, b + 1)); } catch (e) { return null; }
  }

  function parseDecisions(content, items) {
    const arr = extractJsonArray(content);
    if (!Array.isArray(arr)) return {};
    const want = {};
    items.forEach(function (it) { want[String(it.id)] = true; });
    const out = {};
    arr.forEach(function (o) {
      if (!o || o.id == null) return;
      const id = String(o.id);
      if (!want[id]) return;
      out[id] = o.block === true || o.block === 'true' || o.block === 1;
    });
    return out;
  }

  // 把用户亲自标注的样例拼成 few-shot 参考文本
  function buildExamplesBlock(examples) {
    if (!examples || !examples.length) return '';
    const blk = [], alw = [];
    examples.forEach(function (e) {
      const line = '- ' + String(e.text || '').replace(/\n/g, ' ').slice(0, 80);
      if (e.label === 'allow') alw.push(line); else blk.push(line);
    });
    let s = '以下是我亲自标注过的样例，请严格据此把握屏蔽尺度（其优先级高于你的直觉）：\n';
    if (blk.length) s += '【这些我要屏蔽】\n' + blk.join('\n') + '\n';
    if (alw.length) s += '【这些是正常评论，不要屏蔽】\n' + alw.join('\n') + '\n';
    return s + '\n';
  }

  async function classifyBatch(items, cfg, examples) {
    if (!cfg.endpoint) throw new Error('未配置 LLM 接口地址');
    const payload = items.map(function (it) {
      const text = (it.text || '').slice(0, 300);
      return { id: it.id, text: text };
    });
    const userMsg = buildExamplesBlock(examples) + '请判断以下评论：\n' + JSON.stringify(payload);
    const body = {
      model: cfg.model,
      temperature: cfg.temperature,
      stream: false,
      messages: [
        { role: 'system', content: cfg.systemPrompt },
        { role: 'user', content: userMsg },
      ],
    };
    const headers = { 'Content-Type': 'application/json' };
    if (cfg.apiKey) headers['Authorization'] = 'Bearer ' + cfg.apiKey;
    if (cfg.provider === 'openrouter') {
      headers['HTTP-Referer'] = 'https://github.com/biliblock';
      headers['X-Title'] = 'BiliBlock';
    }
    const res = await fetch(cfg.endpoint, { method: 'POST', headers: headers, body: JSON.stringify(body) });
    if (!res.ok) {
      const msg = await res.text().catch(function () { return ''; });
      throw new Error('HTTP ' + res.status + ' ' + msg.slice(0, 200));
    }
    const json = await res.json();
    const content =
      (json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content) ||
      (json.message && json.message.content) || '';
    return parseDecisions(content, items);
  }

  // 批量分类：内部按 batchSize 分块 + maxConcurrent 并发；返回 { id: bool }
  async function classify(items, rawCfg, examples) {
    const cfg = resolveCfg(rawCfg);
    if (!items.length) return {};
    const chunks = chunk(items, cfg.batchSize);
    const out = {};
    let idx = 0;
    async function worker() {
      while (idx < chunks.length) {
        const c = chunks[idx++];
        try {
          const r = await classifyBatch(c, cfg, examples);
          Object.assign(out, r);
        } catch (e) {
          console.warn('[BiliBlock] LLM 分类失败：', e && e.message);
        }
      }
    }
    const workers = [];
    for (let i = 0; i < cfg.maxConcurrent; i++) workers.push(worker());
    await Promise.all(workers);
    return out;
  }

  // 解析单条判定（{"block":true} / 数组 / 裸 true-false）
  function parseSingle(content) {
    if (!content) return undefined;
    const m = content.match(/\{[^{}]*"block"[^{}]*\}/);
    if (m) { try { const o = JSON.parse(m[0]); return o.block === true || o.block === 'true' || o.block === 1; } catch (e) {} }
    const arr = extractJsonArray(content);
    if (Array.isArray(arr) && arr[0]) return arr[0].block === true;
    if (/block\D{0,3}true/i.test(content)) return true;
    if (/block\D{0,3}false/i.test(content)) return false;
    return undefined;
  }

  // 单条带图评论 → 视觉模型
  async function classifyVisionOne(item, cfg, examples) {
    const imgs = (item.images || []).slice(0, 4);
    const parts = [{
      type: 'text',
      text: buildExamplesBlock(examples) +
        '判断这条B站评论是否该屏蔽（评论含配图，请结合图片一起判断）。' +
        '只输出 {"block":true} 或 {"block":false}，不要任何解释。\n' +
        '评论文本：' + ((item.text || '').slice(0, 300) || '（无文字，仅图片）'),
    }];
    imgs.forEach(function (u) { parts.push({ type: 'image_url', image_url: { url: u } }); });
    const body = {
      model: cfg.model, temperature: cfg.temperature, stream: false,
      messages: [{ role: 'system', content: cfg.systemPrompt }, { role: 'user', content: parts }],
    };
    const headers = { 'Content-Type': 'application/json' };
    if (cfg.apiKey) headers['Authorization'] = 'Bearer ' + cfg.apiKey;
    if (cfg.provider === 'openrouter') { headers['HTTP-Referer'] = 'https://github.com/biliblock'; headers['X-Title'] = 'BiliBlock'; }
    const res = await fetch(cfg.endpoint, { method: 'POST', headers: headers, body: JSON.stringify(body) });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + (await res.text().catch(function () { return ''; })).slice(0, 150));
    const json = await res.json();
    const content = (json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content) || '';
    return parseSingle(content);
  }

  // 批量带图评论（每条一次请求，maxConcurrent 并发）；返回 { id: bool }
  async function classifyVision(items, rawCfg, examples) {
    const cfg = resolveCfg(rawCfg);
    if (!items.length) return {};
    if (!cfg.endpoint) return {}; // 与文本路径一致：接口未配置则降级为空，不拖垮整批
    const out = {};
    let idx = 0;
    async function worker() {
      while (idx < items.length) {
        const it = items[idx++];
        try {
          const b = await classifyVisionOne(it, cfg, examples);
          if (b === true || b === false) out[it.id] = b;
        } catch (e) { console.warn('[BiliBlock] 视觉分类失败：', e && e.message); }
      }
    }
    const ws = [];
    for (let i = 0; i < cfg.maxConcurrent; i++) ws.push(worker());
    await Promise.all(ws);
    return out;
  }

  // 供设置页「测试连接」用
  async function test(rawCfg, examples) {
    const cfg = resolveCfg(rawCfg);
    const r = await classifyBatch(
      [{ id: 'test1', text: '你这种人也配评论？给我滚出去' }, { id: 'test2', text: '这个视频讲得很清楚，谢谢up主' }],
      cfg, examples
    );
    return { ok: true, decisions: r, endpoint: cfg.endpoint, model: cfg.model };
  }

  NS.llm = { classify: classify, classifyVision: classifyVision, test: test, resolveCfg: resolveCfg };
})();
