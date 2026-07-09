;(function () {
  'use strict';
  const NS = (globalThis.__BCP = globalThis.__BCP || {});

  // 文本近重复：字符 n-gram 的 Jaccard / 含占比，专治复读（copypasta）刷屏。
  // 纯 JS、零模型、对正常评论几乎零误伤（实测正常最大分 ~0.33，复读 0.6~1.0）。

  // 归一化：去空白/标点/符号/emoji/拉丁字母数字，只留中文等表意字符
  function normalize(s) {
    return String(s == null ? '' : s).replace(/[\s\p{P}\p{S}]/gu, '').replace(/[a-z0-9]/gi, '');
  }
  function ngrams(s) {
    s = normalize(s);
    const set = new Set();
    if (s.length < 2) { if (s) set.add(s); return set; }
    for (let i = 0; i + 2 <= s.length; i++) set.add(s.slice(i, i + 2));
    return set;
  }
  function jaccard(a, b) {
    if (!a.size || !b.size) return 0;
    let inter = 0;
    a.forEach(function (x) { if (b.has(x)) inter++; });
    return inter / (a.size + b.size - inter);
  }
  function containment(a, b) { // a 的多少落在 b 里
    if (!a.size) return 0;
    let inter = 0;
    a.forEach(function (x) { if (b.has(x)) inter++; });
    return inter / a.size;
  }

  // 一条评论对一组样例 ngram 集合的最大近重复分数
  function score(commentText, sampleSets) {
    const c = ngrams(commentText);
    if (c.size < 1) return 0;
    let best = 0;
    for (let i = 0; i < sampleSets.length; i++) {
      const s = sampleSets[i];
      const j = jaccard(c, s);
      // 含占比仅在评论足够长时启用，避免超短正常评论被长样例吞噬而误伤
      const co = c.size >= 3 ? containment(c, s) : 0;
      const v = j > co ? j : co;
      if (v > best) best = v;
    }
    return best;
  }

  NS.textdup = { normalize: normalize, ngrams: ngrams, jaccard: jaccard, containment: containment, score: score };
})();
