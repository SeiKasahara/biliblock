;(function () {
  'use strict';
  // 共享命名空间（内容脚本隔离世界 / 主世界 / 后台 各自独立一份，互不干扰）
  const NS = (globalThis.__BCP = globalThis.__BCP || {});

  // 标准 IEEE CRC32 —— B 站弹幕的 midHash 即用户 mid(十进制字符串) 的 CRC32 十六进制
  const TABLE = (function () {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(str) {
    let crc = 0xffffffff;
    for (let i = 0; i < str.length; i++) {
      // mid 全是 ASCII 数字，直接取 charCode 即可
      crc = (crc >>> 8) ^ TABLE[(crc ^ str.charCodeAt(i)) & 0xff];
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  // 去掉前导 0 便于与 B 站返回值宽松比较
  function stripZero(hex) {
    return hex.replace(/^0+(?=.)/, '');
  }

  NS.crc32 = {
    hash: crc32,
    hex: function (uid) {
      return stripZero(crc32(String(uid)).toString(16));
    },
    stripZero: stripZero,
  };
})();
