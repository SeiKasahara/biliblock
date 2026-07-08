;(function () {
  'use strict';
  const NS = (globalThis.__BCP = globalThis.__BCP || {});

  // 常见「OpenAI 兼容」服务预设。endpoint 均为 /chat/completions。
  // free 标注的模型通常免费（不消耗付费额度），仅供默认参考，用户可自行修改。
  const PROVIDERS = {
    openrouter: {
      name: 'OpenRouter（含免费模型）',
      endpoint: 'https://openrouter.ai/api/v1/chat/completions',
      model: 'meta-llama/llama-3.3-70b-instruct:free',
      keyUrl: 'https://openrouter.ai/keys',
      note: '模型名带 :free 后缀的免费，需注册获取 Key。',
    },
    siliconflow: {
      name: '硅基流动 SiliconFlow',
      endpoint: 'https://api.siliconflow.cn/v1/chat/completions',
      model: 'Qwen/Qwen2.5-7B-Instruct',
      keyUrl: 'https://cloud.siliconflow.cn/account/ak',
      note: '部分小参数模型免费，注册送额度。',
    },
    zhipu: {
      name: '智谱 GLM',
      endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
      model: 'glm-4-flash',
      keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
      note: 'glm-4-flash 免费。',
    },
    groq: {
      name: 'Groq（速度快）',
      endpoint: 'https://api.groq.com/openai/v1/chat/completions',
      model: 'llama-3.3-70b-versatile',
      keyUrl: 'https://console.groq.com/keys',
      note: '免费额度较高，速度快，但国内需自备网络。',
    },
    deepseek: {
      name: 'DeepSeek',
      endpoint: 'https://api.deepseek.com/v1/chat/completions',
      model: 'deepseek-chat',
      keyUrl: 'https://platform.deepseek.com/api_keys',
      note: '低价，非免费。',
    },
    openai: {
      name: 'OpenAI',
      endpoint: 'https://api.openai.com/v1/chat/completions',
      model: 'gpt-4o-mini',
      keyUrl: 'https://platform.openai.com/api-keys',
      note: '非免费。',
    },
    ollama: {
      name: '本地 Ollama（离线免费）',
      endpoint: 'http://localhost:11434/v1/chat/completions',
      model: 'qwen2.5:7b',
      keyUrl: 'https://ollama.com/',
      note: '需本机运行 ollama serve；完全离线、免费、隐私最佳。',
    },
    custom: {
      name: '自定义',
      endpoint: '',
      model: '',
      keyUrl: '',
      note: '任意 OpenAI 兼容接口。',
    },
  };

  const DEFAULT_SYSTEM_PROMPT =
`你是我的B站评论筛选助手。我会给你一批评论（JSON 数组，每条含 id 和 text），你判断每条是否要为我屏蔽。

# 最高原则（务必遵守）
1. 宁可漏放，不可错杀：只有当评论「明确且显著」符合下面某一屏蔽类型时才屏蔽；只要有合理理由认为它是正常评论，一律保留（block:false）。
2. 不确定 = 不屏蔽。语气差、你不喜欢、但内容本身正常的，保留。
3. 若我在下方提供了「已标注样例」，其尺度优先于你的直觉。

# 应当屏蔽（block:true）—— 必须明确符合其一
- 人身攻击/辱骂：针对他人的脏话、羞辱、诅咒（如「你就是个废物」「nt」「滚」）。
- 引战/地域黑/群体歧视：挑动对立、地图炮、性别对立、贬低某一群体。
- 恶意带节奏/造谣：明显断章取义、扣帽子、煽动情绪的阴阳怪气。
- 剧透：提前透露关键剧情或结局。
- 垃圾广告/引流/诈骗：卖货、加微信、荐股、刷屏二维码、色情引流。
- 无意义刷屏：纯复读、纯表情/字符堆砌、「沙发」「前排」等零信息量灌水。

# 不要屏蔽（block:false）—— 高频误判，务必放行
- 正常的批评、吐槽、差评、不同观点（哪怕言辞犀利，只要对事不对人）。
- 认真的提问、讨论、科普、纠错、补充信息。
- 普通玩笑、玩梗、自嘲、夸赞、抖机灵。
- 与视频略微跑题但无害的闲聊。
- 情绪化但未攻击具体对象的感叹（如「这也太离谱了吧」）。

# 我的额外偏好（可为空）
（在此追加你个人想屏蔽或想放行的具体要求）

# 输出格式
只输出一个 JSON 数组，每项形如 {"id":<原id>,"block":true} 或 {"id":<原id>,"block":false}。
除该 JSON 数组外，严禁输出任何解释、前缀或代码块标记。`;

  const DEFAULT_SETTINGS = {
    enabled: true,
    blockLevel: 'deep', // 'deep' 彻底移除 | 'shallow' 折叠占位
    scopes: {
      comments: true,
      dynamics: true,
      space: true,
      search: true,
      recommend: true,
      danmaku: true,
    },
    rules: {
      keywords: [],
      regexps: [],
      caseSensitive: false,
    },
    llm: {
      enabled: false,
      provider: 'openrouter',
      endpoint: '',
      apiKey: '',
      model: '',
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      batchSize: 15, // 每次请求打包多少条评论
      temperature: 0,
      maxConcurrent: 1, // 免费模型限流，默认串行
      minLen: 1, // 文本长度小于该值的评论跳过 LLM（仍走 UID/关键词）
      cacheTtlDays: 30,
      danmaku: false, // 是否也用 LLM 筛弹幕（默认否，弹幕量大费额度）
      multimodal: false, // 带图/纯图评论用视觉模型判定（模型需支持图片输入）
    },
    imageFilter: {
      phash: false,     // 第1层 图片查重：屏蔽与「已屏蔽图片」相同/极相似的图片评论（本地感知哈希）
      threshold: 12,    // pHash 汉明距离阈值，越大越宽松（默认放宽）
      clip: false,      // 第2层 CLIP 图向量：屏蔽与黑图「语义相似」的图片评论（WebGPU 本地推理）
      clipThreshold: 0.80, // 余弦相似度阈值，越小越宽松（默认放宽）
    },
    // 语义聚类屏蔽（文本）：本地 WebGPU 文本 embedding + 最近邻。
    // 评论与「屏蔽样例」的语义距离低于 threshold 即自动屏蔽；0=关闭；样例少于 minSamples 则禁用。
    semantic: {
      threshold: 0,
      minSamples: 5,
    },
    version: 1,
  };

  NS.PROVIDERS = PROVIDERS;
  NS.DEFAULT_SYSTEM_PROMPT = DEFAULT_SYSTEM_PROMPT;
  NS.DEFAULT_SETTINGS = DEFAULT_SETTINGS;

  // 深合并：把已存设置盖在默认值上，保证新增字段有默认
  NS.mergeSettings = function (saved) {
    function deep(base, over) {
      if (Array.isArray(base)) return Array.isArray(over) ? over.slice() : base.slice();
      if (base && typeof base === 'object') {
        const out = {};
        for (const k in base) out[k] = deep(base[k], over ? over[k] : undefined);
        // 保留 over 中的额外键（一般不会有）
        if (over && typeof over === 'object') for (const k in over) if (!(k in out)) out[k] = over[k];
        return out;
      }
      return over === undefined ? base : over;
    }
    return deep(DEFAULT_SETTINGS, saved || {});
  };
})();
