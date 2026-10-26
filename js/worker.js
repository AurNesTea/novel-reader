/* 匯入用 Web Worker：解碼 → 切章，避免 5MB 檔案卡住畫面 */
importScripts('splitter.js?v=8');
self.onmessage = function (e) {
  var d = e.data, last = 0;
  function prog(stage, frac) {
    var now = Date.now();
    if (frac < 1 && now - last < 80) return;
    last = now; self.postMessage({ type: 'progress', stage: stage, frac: frac });
  }
  try {
    var title = NovelSplit.titleFromFilename(d.name), res;
    if (/\.js$/i.test(d.name)) {
      prog('解析書檔', 0);
      var dec0 = NovelSplit.decodeBuffer(d.buf);
      var b = NovelSplit.parseBookJs(dec0.text);
      var st = NovelSplit.statsFromChapters(b.chapters);
      res = { chapters: b.chapters, mode: 'headings', notes: ['由離線版書檔匯入（章節沿用原切分）'], analysis: [], chars: st.chars, firstNo: st.firstNo, lastNo: st.lastNo, enc: 'js' };
      title = b.title || title;
    } else {
      prog('解碼', 0);
      var dec = NovelSplit.decodeBuffer(d.buf);
      d.buf = null;
      prog('解碼', 1);
      res = NovelSplit.processText(dec.text, prog);
      res.enc = dec.enc;
    }
    res.title = title;
    self.postMessage({ type: 'done', result: res });
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err && err.message || err) });
  }
};
