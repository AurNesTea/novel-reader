/* 章節切分 — 由 tools/build.py（離線版）逐項移植。可在 Web Worker、主執行緒或 Node 中使用。
   對外：NovelSplit.decodeBuffer(arrayBuffer) / NovelSplit.processText(text, onProgress) / NovelSplit.parseBookJs(text) */
(function (root) {
  'use strict';
  var CHUNK = 5000;
  var CN = { '零': 0, '〇': 0, '○': 0, '一': 1, '二': 2, '兩': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };
  var UNIT = { '十': 10, '百': 100, '千': 1000 };
  var NUMCH = '0-9０-９零〇○一二三四五六七八九十百千萬万兩两';
  var CH_END = '章回節节話话張';

  function cn2int(s) {
    s = s.trim().replace(/[０-９]/g, function (c) { return String(c.charCodeAt(0) - 0xFF10); });
    if (/^\d+$/.test(s)) return parseInt(s, 10);
    var total = 0, section = 0, num = 0, seen = false;
    for (var i = 0; i < s.length; i++) {
      var ch = s[i];
      if (ch in CN) { num = CN[ch]; seen = true; }
      else if (ch in UNIT) { section += ((num || seen) ? num : 1) * UNIT[ch]; num = 0; seen = false; }
      else if (ch === '萬' || ch === '万') { total += (section + num) * 10000; section = 0; num = 0; seen = false; }
      else return null;
    }
    return total + section + num;
  }

  /* ---- 編碼偵測：UTF-8（嚴格）→ GB18030/GBK、Big5（以常用字評分擇優） ---- */
  var COMMON = '的一是不了我他你在有這这個个們们來来說说們會会對对時时為为麼么';
  function tryDecode(enc, bytes) {
    try { return new TextDecoder(enc, { fatal: true }).decode(bytes); } catch (e) { return null; }
  }
  function cjkRatio(t) {
    var n = Math.min(t.length, 20000), c = 0;
    for (var i = 0; i < n; i++) { var x = t.charCodeAt(i); if (x >= 0x4e00 && x <= 0x9fff) c++; }
    return n ? c / n : 0;
  }
  function score(t) {
    var n = Math.min(t.length, 50000), s = 0;
    for (var i = 0; i < n; i++) if (COMMON.indexOf(t[i]) >= 0) s++;
    return s;
  }
  function decodeBuffer(buf) {
    var b = new Uint8Array(buf), t;
    if (b.length >= 2 && b[0] === 0xFF && b[1] === 0xFE) return { text: new TextDecoder('utf-16le').decode(b.subarray(2)), enc: 'utf-16le' };
    if (b.length >= 2 && b[0] === 0xFE && b[1] === 0xFF) return { text: new TextDecoder('utf-16be').decode(b.subarray(2)), enc: 'utf-16be' };
    if (b.length >= 3 && b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) b = b.subarray(3);
    t = tryDecode('utf-8', b);
    if (t !== null) return { text: t, enc: 'utf-8' };
    var g = tryDecode('gb18030', b), bg = tryDecode('big5', b);
    if (g !== null && cjkRatio(g) <= 0.3) g = null;
    if (bg !== null && cjkRatio(bg) <= 0.3) bg = null;
    if (g !== null && bg !== null) return score(g) >= score(bg) ? { text: g, enc: 'gbk' } : { text: bg, enc: 'big5' };
    if (g !== null) return { text: g, enc: 'gbk' };
    if (bg !== null) return { text: bg, enc: 'big5' };
    return { text: new TextDecoder('utf-8').decode(b), enc: 'utf-8(replace)' };
  }

  /* ---- 標題偵測 ---- */
  var RE_A = /^標題\s*[:：]\s*(?:正文\s*)?(.*)$/;
  var RE_B = /^={3,}\s*(?:正文\s*)?(.+?)\s*={3,}$/;
  var RE_C = new RegExp('^(?:正文[\\s　]*)?(?:[【\\[(（]\\s*)?' +
    '((?:第[\\s　]*[' + NUMCH + ']+[\\s　]*[卷部集篇][\\s　]*)?' +
    '第[\\s　]*[' + NUMCH + ']+[\\s　]*[' + CH_END + '](?:[\\s　:：、.．\\-—－·]+[^\\n]{0,50})?)$');
  var RE_SPECIAL = /^(?:正文[\s　]*)?((?:序章|序幕|序言|序|楔子|引子|前言|尾聲|尾声|終章|终章|後記|后记|跋|番外|外傳|外传|大結局|大结局|完結感言|完结感言)[^\n]{0,30})$/;
  var END_PUNCT = '。！？!?，,；;、…”」』"';
  var PART_RE = /\s*[（(]\s*(\d+|[一二三四五六七八九十]+|上|中|下)\s*[）)]\s*$/;
  var BARE = new RegExp('^第[\\s　]*[' + NUMCH + ']+[\\s　]*[' + CH_END + ']$');
  var META = /^(?:內容\s*[:：]?|URL\s*[:：].*|標題\s*[:：].*)$/;
  var RE_NOCHAPNO = new RegExp('第[\\s　]*([' + NUMCH + ']+)[\\s　]*[' + CH_END + ']');
  var RE_VOLNO = new RegExp('^第[\\s　]*([' + NUMCH + ']+)[\\s　]*[卷部集篇]');
  var RE_URL = /^URL\s*[:：]\s*https?:\/\/\S+$/;

  function headingTitle(line) {
    var s = line.trim();
    if (!s || s.length > 70) return null;
    var m = RE_A.exec(s);
    if (m && m[1].trim()) return m[1].trim();
    m = RE_B.exec(s);
    if (m) return m[1].trim();
    m = RE_C.exec(s);
    if (m) {
      var t = m[1].trim();
      if ('。！？!?，,；;'.indexOf(t[t.length - 1]) >= 0) return null;
      if (t.length > 50) return null;
      return t;
    }
    m = RE_SPECIAL.exec(s);
    if (m) {
      var t2 = m[1].trim();
      if (END_PUNCT.indexOf(t2[t2.length - 1]) >= 0) return null;
      return t2;
    }
    return null;
  }
  function chapterNo(title) { var m = RE_NOCHAPNO.exec(title); return m ? cn2int(m[1]) : null; }
  function volumeOf(title) { var m = RE_VOLNO.exec(title); return m ? cn2int(m[1]) : 0; }

  var STRIP_RE = /^[ \t\u3000\xa0]+|[ \t\u3000\xa0]+$/g;
  function cleanParas(lines) {
    var out = [];
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i].replace(/\u200b/g, '').replace(/\ufeff/g, '').replace(STRIP_RE, '');
      if (l && !RE_URL.test(l)) out.push(l);
    }
    return out;
  }
  function sumLen(paras) { var n = 0; for (var i = 0; i < paras.length; i++) n += paras[i].length; return n; }

  function splitBook(text, progress) {
    progress = progress || function () {};
    text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    var lines = text.split('\n'), heads = [], i;
    for (i = 0; i < lines.length; i++) {
      var t = headingTitle(lines[i]);
      if (t !== null) heads.push([i, t]);
      if ((i & 16383) === 0) progress('偵測章節', i / lines.length);
    }
    progress('偵測章節', 1);
    var notes = [];
    if (heads.length < 3 && text.length > 20000) {
      var paras = cleanParas(lines), chunks = [], cur = [], n = 0;
      for (i = 0; i < paras.length; i++) {
        cur.push(paras[i]); n += paras[i].length;
        if (n >= CHUNK) { chunks.push(cur); cur = []; n = 0; }
      }
      if (cur.length) {
        if (chunks.length && n < CHUNK * 0.3) chunks[chunks.length - 1] = chunks[chunks.length - 1].concat(cur);
        else chunks.push(cur);
      }
      return {
        chs: chunks.map(function (c, k) { return { title: '第 ' + (k + 1) + ' 段', paras: c, no: null, parts: 1 }; }),
        mode: 'chunked', notes: ['未偵測到章節標題，改以約 ' + CHUNK + ' 字為單位分段']
      };
    }
    if (!heads.length) {
      var all = cleanParas(lines);
      return { chs: [{ title: '全文', paras: all, no: null, parts: 1 }], mode: 'chunked', notes: ['未偵測到章節標題，全文列為單一章節'] };
    }
    var chs = [];
    var pre = cleanParas(lines.slice(0, heads[0][0]).filter(function (l) { return !/^#{3,}.*#{3,}$/.test(l.trim()); }));
    if (sumLen(pre) >= 200) {
      chs.push({ title: '前言', paras: pre, no: null, parts: 1, raw: '前言' });
      notes.push('第一個標題前有 ' + sumLen(pre) + ' 字內容，已列為「前言」');
    }
    var raws = [];
    for (var k = 0; k < heads.length; k++) {
      var j = k + 1 < heads.length ? heads[k + 1][0] : lines.length;
      raws.push([heads[k][1], lines.slice(heads[k][0] + 1, j)]);
    }
    progress('整理章節', 0.2);
    var folded = [];
    raws.forEach(function (r) {
      var t = r[0], body = r[1];
      if (folded.length) {
        var last = folded[folded.length - 1];
        if (BARE.test(t) && chapterNo(t) !== null && chapterNo(t) === chapterNo(last[0]) && !BARE.test(last[0]) &&
            last[1].every(function (l) { var s = l.trim(); return !s || META.test(s); })) {
          last[1] = last[1].concat([''], body);
          if (notes.length < 3) notes.push('「' + last[0].slice(0, 16) + '」後的重複標題已併入');
          return;
        }
      }
      folded.push([t, body]);
    });
    progress('整理章節', 0.5);
    for (var idx = 0; idx < folded.length; idx++) {
      var tt = folded[idx][0], body2 = folded[idx][1], q = 0;
      while (q < body2.length) {
        var st = body2[q].trim();
        if (!st) { q++; continue; }
        if (META.test(st)) { body2[q] = ''; q++; continue; }
        break;
      }
      var ps = cleanParas(body2);
      if (!ps.length && idx + 1 < folded.length) { notes.push('空白章節標題「' + tt.slice(0, 20) + '」已略過（內容在其後的標題中）'); continue; }
      chs.push({ title: tt, paras: ps, no: chapterNo(tt), parts: 1, raw: tt });
    }
    var merged = [], nparts = 0;
    chs.forEach(function (c) {
      var m = PART_RE.exec(c.title);
      var base = m ? c.title.replace(PART_RE, '') : c.title;
      var last = merged[merged.length - 1];
      if (last && m && last.base === base && last.no === c.no) {
        last.paras = last.paras.concat(c.paras); last.parts++; nparts++;
        return;
      }
      c.base = base;
      if (m) c.title = base;
      merged.push(c);
    });
    merged.forEach(function (c) { if (c.parts === 1) c.title = c.raw != null ? c.raw : c.title; });
    if (nparts) notes.push('合併了 ' + nparts + ' 個「（N）」分段標題（原始標題數 ' + chs.length + ' → 章節數 ' + merged.length + '）');
    return { chs: merged, mode: 'headings', notes: notes };
  }

  /* ---- 顯示用：超長單行段落在「」／“” 對話邊界斷行 ---- */
  function softSplit(p) {
    if (p.length <= 300) return [p];
    var parts = [], start = 0, i;
    for (i = 1; i < p.length; i++) {
      if ('”」』'.indexOf(p[i - 1]) >= 0 && '“「『'.indexOf(p[i]) >= 0) { parts.push(p.slice(start, i)); start = i; }
    }
    parts.push(p.slice(start));
    var out = [], cur = '';
    parts.forEach(function (x) {
      if (cur && cur.length + x.length > 220) { out.push(cur); cur = x; } else cur += x;
    });
    if (cur) out.push(cur);
    return out;
  }

  /* ---- 章節檢查（對應 analyse） ---- */
  function ranges(nums) {
    var out = [], s = null, p = null;
    nums.forEach(function (n) {
      if (s === null) { s = p = n; }
      else if (n === p + 1) p = n;
      else { out.push([s, p]); s = p = n; }
    });
    if (s !== null) out.push([s, p]);
    return out.map(function (r) { return r[0] === r[1] ? String(r[0]) : r[0] + '–' + r[1]; }).join(', ');
  }
  function analyse(chs) {
    var an = [], nos = [];
    chs.forEach(function (c) { if (c.no !== null) nos.push(c.no); });
    var volSet = {};
    chs.forEach(function (c) { volSet[volumeOf(c.title)] = 1; });
    var vols = Object.keys(volSet).map(Number).sort(function (a, b) { return a - b; });
    if (nos.length) {
      var mn = Math.min.apply(null, nos), mx = Math.max.apply(null, nos);
      an.push('章號範圍：' + mn + ' – ' + mx + '（共 ' + chs.length + ' 章）' + (vols.length > 1 ? '；含 ' + vols.length + ' 卷，每卷章號各自編號' : ''));
      var seen = {}, order = [];
      chs.forEach(function (c) {
        if (c.no === null) return;
        var key = volumeOf(c.title) + ':' + c.no;
        if (!seen[key]) { seen[key] = []; order.push([volumeOf(c.title), c.no, key]); }
        seen[key].push(c.title);
      });
      var dups = order.filter(function (o) { return seen[o[2]].length > 1; });
      if (dups.length) an.push('重複章號 ' + dups.length + ' 個：' + dups.slice(0, 8).map(function (o) { return '第' + o[1] + '章×' + seen[o[2]].length + '（' + seen[o[2]].map(function (t) { return t.slice(0, 14); }).join(' / ') + '）'; }).join('；') + (dups.length > 8 ? ' …' : ''));
      vols.forEach(function (v) {
        var vn = order.filter(function (o) { return o[0] === v; }).map(function (o) { return o[1]; });
        if (!vn.length) return;
        var a = Math.min.apply(null, vn), b = Math.max.apply(null, vn), missing = [];
        for (var n = a; n <= b; n++) if (!seen[v + ':' + n]) missing.push(n);
        if (missing.length) an.push((vols.length > 1 ? '第' + v + '卷：' : '') + '缺少章號 ' + missing.length + ' 個：' + ranges(missing).slice(0, 300));
      });
      var back = [], prev = null;
      chs.forEach(function (c) {
        if (c.no === null) return;
        var cur = [volumeOf(c.title), c.no];
        if (prev && (cur[0] < prev[0][0] || (cur[0] === prev[0][0] && cur[1] < prev[0][1]))) back.push(prev[1].slice(0, 14) + '→' + c.title.slice(0, 14));
        prev = [cur, c.title];
      });
      if (back.length) an.push('章號順序倒退 ' + back.length + ' 處：' + back.slice(0, 6).join('；'));
      if (vols.length === 1 && mn > 1) an.push('此檔從第 ' + mn + ' 章開始（前面章節不在檔案中）');
    }
    var lens = chs.map(function (c) { return sumLen(c.paras); }).sort(function (a, b) { return a - b; });
    if (lens.length) {
      var med = lens[Math.floor(lens.length / 2)];
      var tiny = chs.filter(function (c) { return sumLen(c.paras) < 200; }).map(function (c) { return c.title.slice(0, 14); });
      if (tiny.length) an.push('內容極短（<200字）章節 ' + tiny.length + ' 個：' + tiny.slice(0, 6).join('；'));
      an.push('章節字數：最短 ' + lens[0] + '／中位數 ' + med + '／最長 ' + lens[lens.length - 1]);
    }
    return an;
  }

  function titleFromFilename(name) {
    return name.replace(/\.(txt|js)$/i, '').replace(/^[_＿ ]+/, '').trim();
  }

  /* 結果：{ chapters:[[title,text]], mode, notes, analysis, chars, firstNo, lastNo, softSplit } */
  function processText(text, onProgress) {
    var r = splitBook(text, onProgress);
    var nSoft = 0, chars = 0, nos = [];
    var chapters = r.chs.map(function (c) {
      var np = [];
      c.paras.forEach(function (p) { var sp = softSplit(p); if (sp.length > 1) nSoft++; np = np.concat(sp); });
      var body = np.join('\n');
      chars += sumLen(np);
      if (c.no !== null) nos.push(c.no);
      return [c.title, body];
    });
    if (onProgress) onProgress('完成', 1);
    var analysis = r.mode === 'headings' ? analyse(r.chs) : [];
    return {
      chapters: chapters, mode: r.mode, notes: r.notes, analysis: analysis, chars: chars, softSplit: nSoft,
      firstNo: nos.length ? Math.min.apply(null, nos) : null, lastNo: nos.length ? Math.max.apply(null, nos) : null
    };
  }

  /* 離線版 books/*.js 格式（不執行程式碼，只解析資料） */
  function parseBookJs(text) {
    var m = /\]=\{id:("(?:[^"\\]|\\.)*"),title:("(?:[^"\\]|\\.)*"),chapters:/.exec(text);
    if (!m) throw new Error('不是離線版的 books/*.js 書檔');
    var rest = text.slice(m.index + m[0].length).replace(/\s+$/, '');
    if (rest.slice(-2) !== '};') throw new Error('書檔結尾格式不符');
    var chapters = JSON.parse(rest.slice(0, -2));
    if (!Array.isArray(chapters)) throw new Error('書檔格式錯誤');
    return { title: JSON.parse(m[2]), chapters: chapters };
  }
  function statsFromChapters(chapters) {
    var chars = 0, nos = [];
    chapters.forEach(function (c) { chars += c[1].length; var n = chapterNo(c[0]); if (n !== null) nos.push(n); });
    return { chars: chars, firstNo: nos.length ? Math.min.apply(null, nos) : null, lastNo: nos.length ? Math.max.apply(null, nos) : null };
  }

  root.NovelSplit = {
    decodeBuffer: decodeBuffer, processText: processText, parseBookJs: parseBookJs, statsFromChapters: statsFromChapters,
    titleFromFilename: titleFromFilename, cn2int: cn2int
  };
})(typeof self !== 'undefined' ? self : this);
