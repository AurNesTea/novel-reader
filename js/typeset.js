/* 排版優化（只在顯示時處理，不改動原始文字）：
   1. 段落重排：原檔把一句話斷成好幾行（行尾是「，」之類）時，合併成同一段。
   2. 引號統一：" “ ” ″ ＂ → 「」，‘ ’ → 『』（每段內依序開／關）。
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
  function reflow(lines) {
    var out = [], cur = null;
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i];
      if (cur && canJoin(cur.text, l)) { cur.text += l.replace(/^[\s　]+/, ''); cur.count++; continue; }
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

  // 每段內把直引號／彎引號換成「」『』，依出現順序開／關
  function quotes(t) {
    var d = 0, s = 0;
    return t.replace(/["“”″＂‘’]/g, function (c) {
      if (c === '‘' || c === '’') { s ^= 1; return s ? '『' : '』'; }
      d ^= 1; return d ? '「' : '」';
    });
  }

  // 原始行號 r → 段落索引（二分搜尋）
  function paraOfRaw(paras, r) {
    var lo = 0, hi = paras.length - 1;
    if (hi < 0) return 0;
    while (lo < hi) { var mid = (lo + hi + 1) >> 1; if (paras[mid].start <= r) lo = mid; else hi = mid - 1; }
    return lo;
  }

  // 把章節文字變成要顯示的段落（on=false 時一行一段，等同舊版）
  function layout(text, on) {
    var lines = String(text || '').split('\n').filter(function (t) { return t; });
    var paras = on ? reflow(lines) : lines.map(function (t, i) { return { text: t, start: i, count: 1 }; });
    if (on) paras.forEach(function (p) { p.text = quotes(p.text); });
    return paras;
  }

  var api = { reflow: reflow, canJoin: canJoin, quotes: quotes, paraOfRaw: paraOfRaw, layout: layout };
  if (typeof module === 'object' && module.exports) module.exports = api; else root.Typeset = api;
})(this);
