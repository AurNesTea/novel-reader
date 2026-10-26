/* 排版優化（只在顯示時處理，不改動原始文字）：
   1. 段落重排：原檔把一句話斷成好幾行（行尾是「，」之類）時，合併成同一段。
   2. 引號統一：" “ ” ″ ＂ → 「」，‘ ’ → 『』（整章追蹤開／關狀態）。
   位置相容：進度／書籤記錄的 para 一律是「原始行號」（每個非空行一號，與舊版一致），
   reflow() 回傳每段涵蓋的原始行範圍，用來在原始行號與畫面段落之間換算。 */
(function (root) {
  'use strict';
  var END_RE = /([。！？!?…⋯～~]|\.{3,}|——|──|[」』”’"'″＂）)】》〉])\s*$/;   // 行尾是句末／收尾 → 保留斷行
  var SOFT_END_RE = /[，、；,;]\s*$/;                                              // 行尾是逗號類 → 句子還沒完
  var COLON_RE = /[：:]\s*$/;
  var OPEN_RE = /^\s*[「『“‘"″＂（(【《〈]/;                                         // 下一行以引號／括號開頭 → 對話或新段
  var MID_RE = /^\s*[，、；：。！？,;:!?…）)」』”’]/;                               // 下一行以標點開頭 → 明顯接續上一句
  var HEAD_RE = /^\s*(第[\s　]*[0-9０-９零〇一二兩三四五六七八九十百千萬]+[\s　]*[章回節卷集話部篇]|序章|楔子|番外|尾聲|後記|终章|終章)/;
  var SEP_RE = /^\s*([*＊※◇◆○●☆★─—\-=＝~～#·.。]\s*){3,}\s*$/;                    // 分隔線（場景切換）
  var MAX_MERGE = 1200;                                                              // 合併後段落的字數上限（保守）

  function isHard(l) { return HEAD_RE.test(l) || SEP_RE.test(l); }

  // lines：非空原始行陣列；回傳 [{ text, start, count }]
  function reflow(lines, quoteJoin) {
    var out = [], cur = null;
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i];
      if (cur && (canJoin(cur.text, l) || (quoteJoin && unclosed(cur.text) && closesQuote(l) && !isHard(l) && cur.text.length + l.length <= MAX_MERGE))) { cur.text += l.replace(/^[\s　]+/, ''); cur.count++; continue; }
      cur = { text: l, start: i, count: 1 }; out.push(cur);
    }
    return out;
  }
  function canJoin(prev, next) {
    if (isHard(prev) || isHard(next)) return false;
    if (prev.length + next.length > MAX_MERGE) return false;
    var p = prev.replace(/[\s　]+$/, '');
    if (MID_RE.test(next)) return true;                       // 下一行從句子中間開始
    if (END_RE.test(p)) return false;                         // 句末、收引號
    if (OPEN_RE.test(next)) return false;                     // 下一行是對話／引文：保留分段
    if (COLON_RE.test(p)) return true;                        // 「：」後面不是引號 → 接續
    if (SOFT_END_RE.test(p)) return true;                     // 行尾逗號類
    // 行尾沒有標點：通常是硬折行，但短行可能是小標題，保守處理
    return p.replace(/[\s　]/g, '').length >= 12;
  }

  // 引號統一（整章連續追蹤開／關狀態，每章重新開始）：
  //   彎引號 “ ” ‘ ’ 方向明確時照原方向；兩種方向數量差不多才採信；只有一種或差很多（來源亂用）視為不明確。
  //   直引號 " ″ ＂ 方向不明確，看前後文：行首／空白／冒號之後 → 開；後面是標點或行尾、
  //   或前面是！？。…～ → 關；其餘依目前狀態切換。原文已有的「」『』也會更新狀態。
  var PUNCT_AFTER = /[，。！？、；：,.!?;:…⋯～~」』）)】》—\-]/;
  var CLOSE_BEFORE = /[！？。!?…⋯～~]/;
  function makeQuoter(text) {
    function balanced(a, b) { var x = (text.match(a) || []).length, y = (text.match(b) || []).length; return x > 0 && y > 0 && Math.min(x, y) / Math.max(x, y) >= 0.6; }
    var dirD = balanced(/“/g, /”/g), dirS = balanced(/‘/g, /’/g);
    var st = { d: false, s: false };
    function decide(open, line, i) {
      var prev = i > 0 ? line.charAt(i - 1) : '', next = i + 1 < line.length ? line.charAt(i + 1) : '';
      var atStart = /^[\s　]*$/.test(line.slice(0, i)), atEnd = /^[\s　]*$/.test(line.slice(i + 1));
      if (atStart && !atEnd) return true;
      if (atEnd && !atStart) return false;
      if (/[：:\s　]/.test(prev)) return true;
      if (PUNCT_AFTER.test(next) || CLOSE_BEFORE.test(prev)) return false;
      return !open;
    }
    function line(l) {
      var out = '';
      for (var i = 0; i < l.length; i++) {
        var c = l.charAt(i), o;
        if (c === '「') st.d = true; else if (c === '」') st.d = false;
        else if (c === '『') st.s = true; else if (c === '』') st.s = false;
        else if (c === '"' || c === '″' || c === '＂' || c === '“' || c === '”') {
          o = (dirD && c === '“') ? true : (dirD && c === '”') ? false : decide(st.d, l, i);
          st.d = o; c = o ? '「' : '」';
        } else if (c === '‘' || c === '’') {
          o = (dirS && c === '‘') ? true : (dirS && c === '’') ? false : decide(st.s, l, i);
          st.s = o; c = o ? '『' : '』';
        }
        out += c;
      }
      return out;
    }
    return { line: line, state: st };
  }
  // 單獨使用（測試用）：整段文字視為同一章
  function quotes(t) { var q = makeQuoter(t); return t.split('\n').map(q.line).join('\n'); }

  // 未閉合的引號：上一段「…還沒收，下一行沒有新的「、而且以 」收尾 → 視為同一句話被斷開，合併
  function unclosed(t) { var a = t.lastIndexOf('「'), b = t.lastIndexOf('」'); return a > b; }
  function closesQuote(n) { var t = n.replace(/[\s　]+$/, ''); return t.indexOf('「') < 0 && /」$/.test(t) && t.length <= 200; }

  // 原始行號 r → 段落索引（二分搜尋）
  function paraOfRaw(paras, r) {
    var lo = 0, hi = paras.length - 1;
    if (hi < 0) return 0;
    while (lo < hi) { var mid = (lo + hi + 1) >> 1; if (paras[mid].start <= r) lo = mid; else hi = mid - 1; }
    return lo;
  }

  // 把章節文字變成要顯示的段落（on=false 時一行一段，等同舊版）。
  // on 時先整章轉換引號（行號不變），再重排；每段去掉開頭／結尾空白（含全形空白），縮排一律交給 CSS。
  function layout(text, on) {
    var lines = String(text || '').split('\n').filter(function (t) { return t; });
    if (!on) return lines.map(function (t, i) { return { text: t, start: i, count: 1 }; });
    var q = makeQuoter(lines.join('\n'));
    var conv = lines.map(q.line);
    var paras = reflow(conv, true);
    paras.forEach(function (p) { p.text = p.text.replace(/^[\s\u3000\u00a0\ufeff]+|[\s\u3000\u00a0]+$/g, ''); });
    return paras;
  }

  var api = { makeQuoter: makeQuoter, unclosed: unclosed, reflow: reflow, canJoin: canJoin, quotes: quotes, paraOfRaw: paraOfRaw, layout: layout };
  if (typeof module === 'object' && module.exports) module.exports = api; else root.Typeset = api;
})(this);
