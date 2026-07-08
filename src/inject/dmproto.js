;(function () {
  'use strict';
  const NS = (globalThis.__BCP = globalThis.__BCP || {});

  // 极简 protobuf 读写，仅够解析/重编码 B 站弹幕分段（DmSegMobileReply）。
  // 出错一律回退原始字节，绝不破坏播放器。
  const dec = new TextDecoder();

  function readVarint(buf, pos) {
    let result = 0, shift = 0, b;
    do {
      b = buf[pos.i++];
      result += (b & 0x7f) * Math.pow(2, shift);
      shift += 7;
    } while (b & 0x80);
    return result;
  }

  function skipField(buf, pos, wireType) {
    switch (wireType) {
      case 0: readVarint(buf, pos); break; // varint
      case 1: pos.i += 8; break; // 64-bit
      case 2: { const len = readVarint(buf, pos); pos.i += len; break; } // length-delimited
      case 5: pos.i += 4; break; // 32-bit
      default: throw new Error('bad wire type ' + wireType);
    }
  }

  // 解析单条 DanmakuElem，取出 midHash(field6) 与 content(field7)
  function parseElem(buf, start, end) {
    const pos = { i: start };
    let midHash = '', content = '';
    while (pos.i < end) {
      const key = readVarint(buf, pos);
      const field = key >>> 3;
      const wt = key & 7;
      if (wt === 2) {
        const len = readVarint(buf, pos);
        const s = pos.i, e = pos.i + len;
        if (field === 6) midHash = dec.decode(buf.subarray(s, e));
        else if (field === 7) content = dec.decode(buf.subarray(s, e));
        pos.i = e;
      } else {
        skipField(buf, pos, wt);
      }
    }
    return { midHash: midHash, content: content };
  }

  function writeVarint(bytes, value) {
    while (value > 0x7f) {
      bytes.push((value & 0x7f) | 0x80);
      value = Math.floor(value / 128);
    }
    bytes.push(value & 0x7f);
  }

  // shouldDrop(midHash, content) => true 表示丢弃该弹幕
  function filter(buffer, shouldDrop) {
    try {
      const buf = new Uint8Array(buffer);
      const pos = { i: 0 };
      const out = []; // 输出字节
      let removed = 0, changed = false;
      while (pos.i < buf.length) {
        const keyStart = pos.i;
        const key = readVarint(buf, pos);
        const field = key >>> 3;
        const wt = key & 7;
        if (field === 1 && wt === 2) {
          const len = readVarint(buf, pos);
          const elemStart = pos.i;
          const elemEnd = pos.i + len;
          const info = parseElem(buf, elemStart, elemEnd);
          pos.i = elemEnd;
          if (shouldDrop(info.midHash, info.content)) {
            removed++;
            changed = true;
            continue; // 跳过该弹幕，不写入输出
          }
          // 保留：原样写回 tag + len + 原始 elem 字节
          writeVarint(out, key);
          writeVarint(out, len);
          for (let j = elemStart; j < elemEnd; j++) out.push(buf[j]);
        } else {
          // 其它顶层字段原样保留
          const fieldStart = keyStart;
          skipField(buf, pos, wt);
          for (let j = fieldStart; j < pos.i; j++) out.push(buf[j]);
        }
      }
      if (!changed) return { buffer: buffer, removed: 0 };
      return { buffer: new Uint8Array(out).buffer, removed: removed };
    } catch (e) {
      return { buffer: buffer, removed: 0 }; // 解析失败：原样返回
    }
  }

  NS.dmproto = { filter: filter };
})();
