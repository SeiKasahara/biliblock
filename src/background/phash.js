;(function () {
  'use strict';
  const NS = (globalThis.__BCP = globalThis.__BCP || {});

  // 感知哈希 pHash：缩 32×32 灰度 → DCT → 取 8×8 低频 → 与中位数比 → 64bit
  // 在 Service Worker 里用 OffscreenCanvas，无需 WebGPU。
  const N = 32, M = 8;

  // 预计算 DCT 余弦表：COS[k][n] = cos(π(2n+1)k / 2N)，k=0..M-1, n=0..N-1
  const COS = [];
  for (let k = 0; k < M; k++) {
    const row = new Float64Array(N);
    for (let n = 0; n < N; n++) row[n] = Math.cos((Math.PI * (2 * n + 1) * k) / (2 * N));
    COS.push(row);
  }

  // 只算左上 8×8 低频系数（可分离 DCT）
  function dct8(g) {
    const rowD = new Float64Array(N * M); // rowD[r*M + k]
    for (let r = 0; r < N; r++) {
      const base = r * N;
      for (let k = 0; k < M; k++) {
        let s = 0; const ck = COS[k];
        for (let n = 0; n < N; n++) s += g[base + n] * ck[n];
        rowD[r * M + k] = s;
      }
    }
    const out = new Float64Array(M * M);
    for (let ky = 0; ky < M; ky++) {
      const cky = COS[ky];
      for (let kx = 0; kx < M; kx++) {
        let s = 0;
        for (let r = 0; r < N; r++) s += rowD[r * M + kx] * cky[r];
        out[ky * M + kx] = s;
      }
    }
    return out;
  }

  function bitsToHex(dct) {
    // 中位数（用副本排序，避免改动原数组）
    const sorted = Array.prototype.slice.call(dct).sort(function (a, b) { return a - b; });
    const mid = (sorted[31] + sorted[32]) / 2;
    let hex = '';
    for (let i = 0; i < 64; i += 4) {
      let nib = 0;
      for (let j = 0; j < 4; j++) nib = (nib << 1) | (dct[i + j] > mid ? 1 : 0);
      hex += nib.toString(16);
    }
    return hex; // 16 位十六进制 = 64bit
  }

  async function hashFromUrl(url) {
    // 取图（扩展有 hdslb host 权限，绕过 CORS）；带 referrer 规避可能的防盗链；8s 超时避免卡死
    let res = null;
    const ctrl = new AbortController();
    const timer = setTimeout(function () { ctrl.abort(); }, 8000);
    try {
      res = await fetch(url, { referrer: 'https://www.bilibili.com/', credentials: 'omit', signal: ctrl.signal });
    } catch (e) {
      try { res = await fetch(url, { signal: ctrl.signal }); } catch (e2) { res = null; }
    }
    clearTimeout(timer);
    if (!res || !res.ok) return null;
    const blob = await res.blob();
    let bmp;
    try { bmp = await createImageBitmap(blob); } catch (e) { return null; }
    const canvas = new OffscreenCanvas(N, N);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bmp, 0, 0, N, N);
    if (bmp.close) bmp.close();
    const data = ctx.getImageData(0, 0, N, N).data;
    const g = new Float64Array(N * N);
    for (let i = 0; i < N * N; i++) {
      g[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
    }
    return bitsToHex(dct8(g));
  }

  function hamming(a, b) {
    if (!a || !b || a.length !== b.length) return 64;
    let d = 0;
    for (let i = 0; i < a.length; i++) {
      let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
      while (x) { d += x & 1; x >>= 1; }
    }
    return d;
  }

  // 从 32×32 灰度数组直接算哈希（供测试/复用）
  function hashFromGray(g) { return bitsToHex(dct8(g)); }

  NS.phash = { hashFromUrl: hashFromUrl, hamming: hamming, hashFromGray: hashFromGray, N: N };
})();
