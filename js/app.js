/* 公众号复习系列 · 网站版
 * 功能：逐字朗读高亮、双引擎朗读（调用朗读=云端神经音色 / 本地朗读=系统语音）、
 *       已读标记（淡绿底纹）、阅读进度、上一篇/下一篇、键盘快捷键 */
(function () {
  "use strict";

  /* ---------- 常量 ---------- */
  var SUPPORTED = "speechSynthesis" in window;
  /* ============================================================
   * 云端 TTS Worker 配置
   * 新 Worker 基于 icheer/edgetts-cloudflare-workers-webui：
   *   - 接口：POST {WORKER_URL}/v1/audio/speech（OpenAI 兼容）
   *   - 认证：请求头 Authorization: Bearer <API_KEY>（Worker 未设 API_KEY 时可留空）
   *   - 请求体：{model, input, voice, speed, pitch, stream:true}
   *   - stream:true 时收到第一个音频块就立即回传（流式）
   * ============================================================ */
  var WORKER_URL = "https://edge-tts-stream813.screenbks-89d.workers.dev/v1/audio/speech";
  var WORKER_API_KEY = ""; // 若 Worker 部署时设置了 API_KEY，请填在这里；未设置则留空
  /* 语音包朗读：预生成音频索引与存放位置
   * - audio_manifest.json 由 _work/gen_audio.py 生成，放在网站根目录
   * - 音频文件上传到阿里云 OSS（my-voice-bucket-2026）后，PACK_AUDIO_BASE 用下面的地址；
   *   若把音频直接复制到网站目录，则改为 ""（相对路径） */
  var PACK_MANIFEST_URL = /\/articles\//.test(location.pathname) ? "../audio_manifest.json" : "audio_manifest.json";
  var PACK_AUDIO_BASE = "https://my-voice-bucket-2026.oss-cn-chengdu.aliyuncs.com/";
  var API_VOICES = [
    { id: "zh-CN-XiaohanNeural",  name: "晓涵（优雅女声）" },
    { id: "zh-CN-XiaoxiaoNeural", name: "晓晓（温柔女声）" },
    { id: "zh-CN-YunxiNeural",    name: "云希（清朗男声）" },
    { id: "zh-CN-YunjianNeural",  name: "云健（沉稳男声）" },
    { id: "zh-CN-XiaoyiNeural",   name: "晓伊（活泼女声）" },
    { id: "zh-CN-YunyeNeural",    name: "云叶（自然男声）" }
  ];
  var CHAR_MS = 220;               // 本地引擎逐字计时的基准时长/字
  var ENGINE_KEY = "wx361-engine-v1";
  var APIVOICE_KEY = "wx361-apivoice-v1";
  var RM_KEY = "wx361-readmarks-v1";

  var content = document.getElementById("article-content");
  var sentences = [];              // {el, text, chars, rawToNS}
  var current = -1;                // 当前朗读到第几句
  var playing = false;
  var paused = false;
  var rate = 1;
  var voice = null;                // 本地引擎语音
  var engine = loadEngine();       // "api" | "local" | "pack"
  var apiVoiceIdx = loadApiVoiceIdx();
  var articleId = document.body.getAttribute("data-article");
  var pack = { manifest: null, state: "idle", offsets: null, segs: null, segIdx: -1, lastDoneSent: -1, curSent: -1 }; // 语音包

  /* ---------- 进度条 ---------- */
  var bar = document.getElementById("progress-bar");
  function onScroll() {
    if (!bar) return;
    var h = document.documentElement;
    var max = h.scrollHeight - h.clientHeight;
    var p = max > 0 ? (h.scrollTop / max) : 0;
    bar.style.width = (p * 100).toFixed(2) + "%";
    saveReading(p);
    updateReadRail();
  }
  window.addEventListener("scroll", onScroll, { passive: true });

  /* ---------- 阅读进度（localStorage） ---------- */
  var KEY = "wx361-reading-v1";
  function loadAll() { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; } }
  function saveAll(o) { try { localStorage.setItem(KEY, JSON.stringify(o)); } catch (e) {} }
  function saveReading(p) {
    if (!articleId) return;
    var all = loadAll();
    var cur = all[articleId] || {};
    if (p > (cur.ratio || 0)) cur.ratio = Math.round(p * 100);
    if (p >= 0.85) cur.done = true;
    if (cur.done) cur.ratio = 100;
    all[articleId] = cur;
    saveAll(all);
    var el = document.getElementById("reading-state");
    if (el) {
      el.textContent = cur.done ? "已完成 ✅" : "已读 " + (cur.ratio || 0) + "%";
      el.className = "state " + (cur.done ? "done" : "todo");
    }
  }
  function toggleDone() {
    if (!articleId) return;
    var all = loadAll();
    var cur = all[articleId] || {};
    cur.done = !cur.done;
    if (cur.done) cur.ratio = 100;
    all[articleId] = cur;
    saveAll(all);
    updateDoneBtn(cur.done);
    var el = document.getElementById("reading-state");
    if (el) {
      el.textContent = cur.done ? "已完成 ✅" : "已读 " + (cur.ratio || 0) + "%";
      el.className = "state " + (cur.done ? "done" : "todo");
    }
  }
  function updateDoneBtn(done) {
    var el = document.getElementById("btn-done");
    if (el) el.classList.toggle("done", !!done);
  }

  /* ---------- 已读标记（逐句持久化） ---------- */
  function loadRM() { try { return JSON.parse(localStorage.getItem(RM_KEY)) || {}; } catch (e) { return {}; } }
  function saveRM(o) { try { localStorage.setItem(RM_KEY, JSON.stringify(o)); } catch (e) {} }
  function persistReadCount(n) {
    if (!articleId) return;
    var o = loadRM();
    if (n > (o[articleId] || 0)) { o[articleId] = n; saveRM(o); }
  }
  function markSentenceRead(i, persist) {
    if (i < 0 || i >= sentences.length) return;
    var s = sentences[i];
    if (s.el) { s.el.classList.remove("reading"); s.el.classList.add("read"); }
    var chars = s.chars || [];
    for (var k = 0; k < chars.length; k++) {
      chars[k].classList.remove("current");
      chars[k].classList.add("read");
    }
    if (persist !== false) persistReadCount(i + 1);
  }
  function applyReadMarks() {
    if (!articleId) return;
    var n = loadRM()[articleId] || 0;
    for (var i = 0; i < n && i < sentences.length; i++) markSentenceRead(i, false);
  }

  /* ---------- 分句 + 逐字包裹 ---------- */
  function splitSentences() {
    if (!content) return;
    var walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT, null);
    var nodes = [];
    while (walker.nextNode()) {
      var n = walker.currentNode;
      if (n.textContent.trim()) nodes.push(n);
    }
    nodes.forEach(function (node) {
      var text = node.textContent;
      // 按句末标点切分（保留标点）
      var parts = text.split(/([。！？；!?;])/);
      var out = [];
      for (var i = 0; i < parts.length; i++) {
        var p = parts[i];
        if (!p) continue;
        if (i + 1 < parts.length && /^[。！？；!?;]$/.test(parts[i + 1])) {
          p += parts[i + 1]; i++;
        }
        out.push(p);
      }
      var frag = document.createDocumentFragment();
      out.forEach(function (p) {
        if (!p.trim()) return;
        var span = document.createElement("span");
        span.className = "sent";
        span.setAttribute("data-i", sentences.length);
        span.textContent = p;
        frag.appendChild(span);
        sentences.push({ el: span, text: p.trim() });
      });
      node.parentNode.replaceChild(frag, node);
    });
    // 兜底：没切成多句时整篇作为一句
    if (sentences.length === 0 && content.textContent.trim()) {
      sentences.push({ el: null, text: content.textContent.trim() });
    }
    // 每个句子里把每个可见字包成 .ch，用于逐字高亮
    sentences.forEach(wrapChars);
  }

  function wrapChars(s) {
    if (!s.el) return;
    var walker = document.createTreeWalker(s.el, NodeFilter.SHOW_TEXT, null);
    var pending = [];
    var ns = 0, raw = 0;
    var rawToNS = [];
    var nsToRaw = [];
    while (walker.nextNode()) {
      var n = walker.currentNode;
      var t = n.textContent;
      if (!t) continue;
      var frag = document.createDocumentFragment();
      for (var k = 0; k < t.length; k++) {
        var ch = t.charAt(k);
        rawToNS.push(ns);
        if (/\s/.test(ch)) {
          frag.appendChild(document.createTextNode(ch));
          raw++;
          continue;
        }
        var sp = document.createElement("span");
        sp.className = "ch";
        sp.setAttribute("data-c", ns);
        sp.textContent = ch;
        frag.appendChild(sp);
        nsToRaw[ns] = raw;
        ns++;
        raw++;
      }
      pending.push([n, frag]);
    }
    pending.forEach(function (pair) {
      pair[0].parentNode.replaceChild(pair[1], pair[0]);
    });
    s.chars = s.el.querySelectorAll(".ch");
    s.rawToNS = rawToNS;
    s.nsToRaw = nsToRaw;
  }

  /* ---------- 语音：引擎选择 ---------- */
  function loadEngine() {
    try {
      var v = localStorage.getItem(ENGINE_KEY);
      if (v === "api" || v === "local" || v === "pack") return v;
    } catch (e) {}
    return "pack"; // 默认使用语音包（预生成音频）
  }
  function saveEngine(v) { try { localStorage.setItem(ENGINE_KEY, v); } catch (e) {} }
  function loadApiVoiceIdx() {
    try {
      var n = parseInt(localStorage.getItem(APIVOICE_KEY), 10);
      if (!isNaN(n) && n >= 0 && n < API_VOICES.length) return n;
    } catch (e) {}
    return 0;
  }
  function saveApiVoiceIdx(n) { try { localStorage.setItem(APIVOICE_KEY, String(n)); } catch (e) {} }

  function updateEngineBtn() {
    ["btn-engine-pack", "btn-engine-local"].forEach(function (id) {
      var el = document.getElementById(id);
      if (!el) return;
      var on = (id === "btn-engine-pack" && engine === "pack") || (id === "btn-engine-local" && engine === "local");
      el.classList.toggle("active", on);
    });
  }

  function setEngine(next) {
    if (next === "local" && !SUPPORTED) {
      setStatus("当前浏览器不支持本地朗读");
      return;
    }
    if (next === "pack") {
      loadPackManifest(function (man) {
        if (!man || !man.articles || !Object.keys(man.articles).length) {
          setStatus("语音包未生成：请先运行 _work/gen_audio.py 并上传音频");
          return;
        }
        engine = "pack";
        saveEngine(engine);
        applyEngineChange();
      });
      return;
    }
    engine = next;
    saveEngine(engine);
    applyEngineChange();
  }

  function applyEngineChange() {
    var wasActive = playing || paused;
    stop();
    if (wasActive && current >= 0) {
      playing = true;
      setPlayIcon();
      speakIndex(current, 0);
    }
    updateEngineBtn();
    updateVoiceTip();
    updateVoiceBtn();
    updateVoiceList();
  }

  /* ---------- 语音：本地引擎（系统 speechSynthesis） ---------- */
  function zhVoices() {
    try {
      return window.speechSynthesis.getVoices().filter(function (v) { return /^zh/i.test(v.lang); });
    } catch (e) { return []; }
  }
  function pickVoice() { return preferredVoice() || null; }
  if (SUPPORTED) {
    voice = pickVoice();
    window.speechSynthesis.onvoiceschanged = function () {
      voice = pickVoice();
      updateVoiceTip();
      updateVoiceBtn();
      updateVoiceList();
    };
  }

  var VOICE_KEY = "wx361-voice-v1";
  function savedVoiceName() {
    try { return localStorage.getItem(VOICE_KEY); } catch (e) { return null; }
  }
  function saveVoiceName(n) {
    try { localStorage.setItem(VOICE_KEY, n); } catch (e) {}
  }
  function preferredVoice() {
    var vs = zhVoices();
    if (!vs.length) return null;
    var saved = savedVoiceName();
    if (saved) {
      var v = vs.filter(function (x) { return x.name === saved; })[0];
      if (v) return v;
    }
    var names = ["李牧", "李穆", "李沐", "limu", "li mu", "婷婷", "小美", "优优", "彬彬"];
    for (var i = 0; i < names.length; i++) {
      var re = new RegExp(names[i], "i");
      var hit = vs.filter(function (x) { return re.test(x.name); })[0];
      if (hit) return hit;
    }
    return null;
  }

  // 剔除会被语音读出来的装饰字符，并记录“清洗后下标 → 原始文本下标”映射
  var DECOR_RE = /[▸▍★☆◆⊙◇●◎○※→↳📐▪•·♪™®©¤†‡§¶]/g;
  function cleanMap(s) {
    var out = "", map = [], prevSpace = false;
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      if (ch === "→") ch = "，";
      if (DECOR_RE.test(ch)) ch = " ";
      if (ch === "\u200b") continue;
      if (ch === " ") { if (prevSpace) continue; prevSpace = true; }
      else prevSpace = false;
      out += ch;
      map.push(i);
    }
    var start = 0, end = out.length;
    while (start < end && out.charAt(start) === " ") start++;
    while (end > start && out.charAt(end - 1) === " ") end--;
    return { clean: out.slice(start, end), map: map.slice(start, end) };
  }
  function cleanForSpeech(s) {
    return cleanMap(s).clean;
  }

  // 逐字标记：upto 为“非空白字符序号”（即 .ch 的下标）
  function markChars(i, upto) {
    if (i < 0 || i >= sentences.length) return;
    var s = sentences[i];
    var chars = s.chars || [];
    var hasCurrent = false;
    for (var k = 0; k < chars.length; k++) {
      chars[k].classList.toggle("read", upto > 0 && k < upto);
      var cur = upto >= 0 && k === upto;
      chars[k].classList.toggle("current", cur);
      if (cur) hasCurrent = true;
    }
    if (s.el) s.el.classList.toggle("reading", hasCurrent);
  }

  var localTimer = null;
  var localDomIdx = 0;
  function stopLocalTick() {
    if (localTimer) { clearInterval(localTimer); localTimer = null; }
  }
  function startLocalTick(i, startNS) {
    stopLocalTick();
    var chars = sentences[i].chars || [];
    if (!chars.length) return;
    localDomIdx = 0;
    while (localDomIdx < chars.length - 1 && localDomIdx < startNS) localDomIdx++;
    localTimer = setInterval(function () {
      if (!playing || current !== i || !localTimer) return;
      var el = chars[localDomIdx];
      if (el) markChars(i, localDomIdx);
      if (localDomIdx < chars.length - 1) localDomIdx++;
      else { clearInterval(localTimer); localTimer = null; }
    }, Math.max(80, CHAR_MS / rate));
  }

  function speakLocal(i, charStart) {
    var s = sentences[i];
    var chars = s.chars || [];
    var startNS = 0;
    if (chars.length) startNS = Math.min(Math.max(0, charStart || 0), chars.length - 1);
    var baseRaw = 0;
    if (startNS > 0 && s.nsToRaw && s.nsToRaw[startNS] != null) baseRaw = s.nsToRaw[startNS];
    var t = cleanMap(s.text.slice(baseRaw));
    if (!t.clean) { advanceAfterSilence(); return; }
    var u = new SpeechSynthesisUtterance(t.clean);
    var hasVoice = voice && zhVoices().indexOf(voice) >= 0;
    if (hasVoice) {
      try { u.voice = voice; } catch (e) {} // 语音对象可能过期/不被支持，失败时退回默认
    }
    u.lang = hasVoice && voice.lang ? voice.lang : "zh-CN";
    u.rate = rate;
    markChars(i, startNS);
    startLocalTick(i, startNS);
    u.onboundary = function (e) {
      if (!playing || current !== i) return;
      if (e.charIndex == null || !t.map || !s.rawToNS) return;
      // 找到清洗文本下标对应的原始文本下标，再换算成非空白序号
      var raw = 0;
      for (var j = 0; j < t.map.length; j++) {
        if (t.map[j] >= e.charIndex) { raw = t.map[j]; break; }
      }
      var origRaw = baseRaw + raw;
      var ns = s.rawToNS[Math.min(origRaw, s.rawToNS.length - 1)];
      if (ns > localDomIdx) { localDomIdx = ns; }
      markChars(i, localDomIdx);
    };
    u.onend = function () {
      if (!playing || current !== i) return;
      stopLocalTick();
      finishSentence(i);
      advanceNext(i);
    };
    u.onerror = function (e) {
      if (!playing || current !== i) return;
      stopLocalTick();
      if (e.error === "interrupted" || e.error === "canceled") return;
      stop();
      setStatus("本地朗读中断，请重试");
    };
    window.speechSynthesis.speak(u);
    setStatus("本地朗读：第 " + (current + 1) + " / " + sentences.length + " 句");
  }

  /* ---------- 语音：调用引擎（云端 Worker，edge-tts 神经音色） ---------- */
  var apiAudio = null;
  var apiState = null;       // {i, piece, pieces, baseNS, blobUrl}
  var apiTimes = {};         // "i:baseNS" -> [{startNS, times}]
  var fallbackBusy = false;
  function ensureApiAudio() {
    if (apiAudio) return apiAudio;
    apiAudio = new Audio();
    apiAudio.id = "tts-api-audio";
    apiAudio.preload = "auto";
    document.body.appendChild(apiAudio);
    apiAudio.addEventListener("timeupdate", function () {
      if (engine === "pack") packSyncChars(); else syncApiChars();
    });
    apiAudio.addEventListener("ended", apiPieceEnded);
    apiAudio.addEventListener("error", function () {
      if (playing && apiState) handleApiError();
    });
    return apiAudio;
  }

  // 超长句切成不超过 400 字的小段，逐段合成，保证接口稳定；baseNS 支持从点到的字开始
  function apiSegments(i, baseNS) {
    var s = sentences[i];
    var chars = s.chars || [];
    var ns0 = chars.length ? Math.min(Math.max(0, baseNS || 0), chars.length) : 0;
    var baseRaw = 0;
    if (ns0 > 0 && s.nsToRaw) baseRaw = s.nsToRaw[Math.min(ns0, chars.length - 1)] || 0;
    var text = s.text.slice(baseRaw);
    if (text.length <= 600) return [{ text: text, startNS: ns0, nsLen: countNS(text) }];
    var pieces = [], buf = "", startAcc = ns0, bufNS = 0;
    var cut = /[。！？；!?;]/;
    for (var k = 0; k < text.length; k++) {
      var ch = text.charAt(k);
      buf += ch;
      if (!/\s/.test(ch)) bufNS++;
      if ((bufNS >= 150 && cut.test(ch)) || bufNS >= 400) {
        pieces.push({ text: buf, startNS: startAcc, nsLen: bufNS });
        startAcc += bufNS; buf = ""; bufNS = 0;
      }
    }
    if (buf) pieces.push({ text: buf, startNS: startAcc, nsLen: bufNS });
    return pieces;
  }
  function countNS(s) {
    var n = 0;
    for (var k = 0; k < s.length; k++) if (!/\s/.test(s.charAt(k))) n++;
    return n;
  }

  function buildApiTimes(i, baseNS) {
    var key = i + ":" + (baseNS || 0);
    if (apiTimes[key]) return apiTimes[key];
    var chars = sentences[i].chars || [];
    var pieces = apiSegments(i, baseNS);
    var out = pieces.map(function (seg) {
      var weights = [], total = 0;
      for (var k = seg.startNS; k < seg.startNS + seg.nsLen && k < chars.length; k++) {
        var ch = chars[k].textContent;
        var w = /[，。！？；、：,.;:!?]/.test(ch) ? 1.7 : 1;
        if (DECOR_RE.test(ch)) w = 0.2;
        weights.push(w); total += w;
      }
      var times = [], acc = 0;
      weights.forEach(function (w) { acc += w; times.push(acc / total); });
      return { startNS: seg.startNS, times: times };
    });
    apiTimes[key] = out;
    return out;
  }
  function upperBound(arr, val) {
    var lo = 0, hi = arr.length;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (arr[mid] < val) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  function speakApi(i, charStart) {
    ensureApiAudio();
    var baseNS = charStart || 0;
    var pieces = apiSegments(i, baseNS);
    var st = 0;
    for (var k = 0; k < pieces.length; k++) {
      if (pieces[k].startNS + pieces[k].nsLen > baseNS) { st = k; break; }
    }
    apiState = { i: i, piece: st, pieces: pieces, baseNS: baseNS, blobUrl: null };
    buildApiTimes(i, baseNS);
    playApiPiece(i, st);
    setStatus("调用朗读：正在连接合成服务…");
  }

  // 请求一段文字，转成 Blob URL 后交给 <audio> 播放
  function playApiPiece(i, pieceIdx) {
    var st = apiState;
    if (!st || st.i !== i || !playing) return;
    var seg = st.pieces[pieceIdx];
    var text = cleanForSpeech(seg.text);
    if (!text) { advanceAfterSilence(); return; }
    setStatus("调用朗读：正在缓冲…");
    fetchApiAudio(text).then(function (resp) {
      return resp.blob();
    }).then(function (blob) {
      if (!playing || !apiState || apiState.i !== i) return;
      if (st.blobUrl) { try { URL.revokeObjectURL(st.blobUrl); } catch (e) {} }
      st.blobUrl = URL.createObjectURL(blob);
      apiAudio.src = st.blobUrl;
      apiAudio.currentTime = 0;
      var pt = buildApiTimes(i, st.baseNS)[pieceIdx];
      if (pt) markChars(i, pt.startNS);
      var p = apiAudio.play();
      if (p && p.catch) p.catch(function () {});
      setStatus("调用朗读：第 " + (i + 1) + " / " + sentences.length + " 句");
    }).catch(function () { handleApiError(); });
  }

  // 请求体按新 Worker 实测参数发送：stream + response_format 均为 mp3
  function fetchApiAudio(text) {
    if (typeof fetch !== "function") return Promise.reject(new Error("当前浏览器不支持网络请求"));
    var headers = { "Content-Type": "application/json" };
    if (WORKER_API_KEY) headers.Authorization = "Bearer " + WORKER_API_KEY;
    return fetch(WORKER_URL, {
      method: "POST",
      headers: headers,
      body: JSON.stringify({
        input: text,
        voice: API_VOICES[apiVoiceIdx].id,
        speed: rate,
        pitch: 1.0,
        style: "general",
        "stream": true,
        "response_format": "mp3"
      })
    }).then(function (resp) {
      if (!resp.ok) {
        return resp.text().then(function (t) {
          throw new Error("服务错误 " + resp.status + ": " + String(t).slice(0, 120));
        });
      }
      return resp;
    });
  }

  function syncApiChars() {
    var st = apiState;
    if (!st || !apiAudio) return;
    var dur = apiAudio.duration;
    var frac;
    if (isFinite(dur) && dur > 0) {
      frac = apiAudio.currentTime / dur;
    } else {
      var seg = st.pieces[st.piece];
      var estDur = Math.max(1.2, (seg && seg.nsLen || 0) * CHAR_MS / rate / 1000);
      frac = apiAudio.currentTime / estDur;
    }
    if (frac < 0) frac = 0;
    if (frac > 1) frac = 1;
    var pt = buildApiTimes(st.i, st.baseNS)[st.piece];
    if (!pt || !pt.times.length) return;
    var domIdx = upperBound(pt.times, frac);
    markChars(st.i, pt.startNS + domIdx);
  }

  function apiPieceEnded() {
    if (engine === "pack") {
      if (!playing || pack.segIdx < 0 || !pack.segs) return;
      var seg = pack.segs[pack.segIdx];
      var endSent = sentenceIndexForRaw(seg.e - 1);
      if (endSent >= 0) markSentenceRead(endSent, true);
      if (pack.segIdx + 1 < pack.segs.length) {
        pack.segIdx++;
        playPackSegmentFromStart(pack.segIdx);
      } else {
        finishPlay();
      }
      return;
    }
    var st = apiState;
    if (!st || !playing) return;
    abortApiBlob();
    if (st.piece + 1 < st.pieces.length) {
      st.piece++;
      playApiPiece(st.i, st.piece);
      return;
    }
    finishSentence(st.i);
    advanceNext(st.i);
  }

  function abortApiBlob() {
    var st = apiState;
    if (!st || !st.blobUrl) return;
    try { URL.revokeObjectURL(st.blobUrl); } catch (e) {}
    st.blobUrl = null;
  }

  function handleApiError() {
    if (!playing || !apiState) return;
    if (engine === "pack") { packFail(); return; }
    apiFail();
  }

  function resetApiCache() {
    apiTimes = {};
  }

  function apiFail() {
    if (fallbackBusy) return;
    fallbackBusy = true;
    var keep = current >= 0 ? current : 0;
    if (!SUPPORTED) {
      stop();
      setStatus("调用朗读失败（网络或服务异常），且当前浏览器不支持本地朗读");
      fallbackBusy = false;
      return;
    }
    setStatus("调用朗读失败，已自动切换到本地朗读");
    engine = "local";
    saveEngine("local");
    stop();
    updateEngineBtn();
    updateVoiceTip();
    updateVoiceBtn();
    updateVoiceList();
    playing = true;
    setPlayIcon();
    speakIndex(keep, 0);
    fallbackBusy = false;
  }

  /* ---------- 语音包引擎（预生成音频，按 manifest 索引播放） ---------- */
  function loadPackManifest(cb) {
    if (pack.state === "loaded") { cb(pack.manifest); return; }
    if (pack.state === "loading") { setTimeout(function () { loadPackManifest(cb); }, 150); return; }
    if (pack.state === "failed") { cb(null); return; }
    pack.state = "loading";
    fetch(PACK_MANIFEST_URL, { cache: "no-store" }).then(function (resp) {
      if (!resp.ok) throw new Error("manifest " + resp.status);
      return resp.json();
    }).then(function (man) {
      pack.manifest = man;
      pack.state = "loaded";
      cb(man);
    }).catch(function () {
      pack.state = "failed";
      cb(null);
    });
  }

  // 每个句子的原始文本起始偏移（与 gen_audio.py 的坐标一致）
  function buildPackOffsets() {
    if (pack.offsets && pack.offsets.length === sentences.length) return pack.offsets;
    var offs = [0];
    for (var k = 0; k < sentences.length; k++) {
      var len = sentences[k].el ? sentences[k].el.textContent.length : sentences[k].text.length;
      offs.push(offs[k] + len);
    }
    pack.offsets = offs;
    return offs;
  }

  function sentenceIndexForRaw(raw) {
    var offs = buildPackOffsets();
    var lo = 0, hi = offs.length - 1;
    while (lo < hi) {
      var mid = (lo + hi + 1) >> 1;
      if (offs[mid] <= raw) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  function packSegIndexForRaw(raw) {
    var segs = pack.segs || [];
    var lo = 0, hi = segs.length - 1;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (segs[mid].e <= raw) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  function speakPack(i, charStart) {
    ensureApiAudio();
    apiState = { i: i, piece: -1, pieces: [], baseNS: 0, blobUrl: null, pack: true };
    loadPackManifest(function (man) {
      if (!playing || current !== i) return;
      var list = man && man.articles && man.articles[articleId];
      if (!man || !list || !list.length) {
        setStatus("语音包未生成：请先在 _work 里运行 gen_audio.py 并上传音频");
        packFail();
        return;
      }
      pack.segs = list;
      buildPackOffsets();
      var s = sentences[i];
      var nsToRaw = s.nsToRaw || [];
      var ns = 0;
      if (charStart > 0 && nsToRaw[charStart] != null) ns = nsToRaw[charStart];
      var raw = (pack.offsets[i] || 0) + ns;
      var k = packSegIndexForRaw(raw);
      pack.segIdx = k;
      pack.lastDoneSent = -1;
      playPackSegment(i, k, raw);
    });
  }

  function playPackSegment(i, k, startRaw) {
    if (!pack.segs || k < 0 || k >= pack.segs.length) return;
    var seg = pack.segs[k];
    pack.segIdx = k;
    var url = PACK_AUDIO_BASE + seg.f;
    apiAudio.src = url;
    apiAudio.playbackRate = rate;
    apiAudio.currentTime = 0;
    markPackRange(startRaw, startRaw);
    var p = apiAudio.play();
    if (p && p.catch) p.catch(function () {});
    setStatus("语音包：第 " + (k + 1) + " / " + pack.segs.length + " 段");
    updateProgress();
  }

  function playPackSegmentFromStart(k) {
    if (!pack.segs || k < 0 || k >= pack.segs.length) return;
    pack.segIdx = k;
    playPackSegment(current, k, pack.segs[k].s);
  }

  // 把原始字符区间映射到句子并做已读/当前高亮（大致定位）
  function markPackRange(fromRaw, toRaw) {
    if (!pack.offsets) return;
    var s0 = sentenceIndexForRaw(fromRaw);
    var s1 = sentenceIndexForRaw(toRaw);
    pack.curSent = s1;
    var last = pack.lastDoneSent;
    for (var k = Math.max(s0, last + 1); k < s1; k++) markSentenceRead(k, false);
    pack.lastDoneSent = Math.max(last, s1 - 1);
    var s = sentences[s1];
    if (!s) return;
    var rawIn = toRaw - (pack.offsets[s1] || 0);
    var r2n = s.rawToNS || [];
    var ns = 0;
    if (rawIn > 0 && rawIn < r2n.length) ns = r2n[rawIn];
    else if (rawIn >= r2n.length && s.chars && s.chars.length) ns = s.chars.length - 1;
    markChars(s1, ns);
  }

  function packSyncChars() {
    if (pack.segIdx < 0 || !pack.segs || !apiAudio) return;
    var seg = pack.segs[pack.segIdx];
    var dur = apiAudio.duration;
    var frac = (isFinite(dur) && dur > 0) ? (apiAudio.currentTime / dur) : 0;
    if (frac < 0) frac = 0;
    if (frac > 1) frac = 1;
    var curRaw = seg.s + (seg.e - seg.s) * frac;
    markPackRange(seg.s, curRaw);
    updateReadRail();
  }

  function packFail() {
    if (!playing) return;
    var keep = current >= 0 ? current : 0;
    if (engine !== "pack") return;
    setStatus("语音包不可用，已切换到本地朗读");
    engine = "local";
    saveEngine("local");
    stop();
    updateEngineBtn();
    updateVoiceTip();
    updateVoiceBtn();
    updateVoiceList();
    playing = true;
    setPlayIcon();
    speakIndex(keep, 0);
  }

  /* ---------- 统一播放控制 ---------- */
  function speakIndex(i, charStart) {
    if (i < 0 || i >= sentences.length) return;
    current = i;
    paused = false;
    updateProgress();
    scrollCurrentIntoView();
    updateReadRail();
    var text = cleanForSpeech(sentences[i].text);
    if (!text) { advanceAfterSilence(); return; }
    if (engine === "api") speakApi(i, charStart || 0);
    else if (engine === "pack") speakPack(i, charStart || 0);
    else if (SUPPORTED) speakLocal(i, charStart || 0);
    else { showFallback(); }
  }

  function finishSentence(i) {
    markSentenceRead(i, true);
  }

  function advanceNext(i) {
    if (!playing || current !== i) return;
    if (i + 1 < sentences.length) {
      speakIndex(i + 1, 0);
    } else {
      finishPlay();
    }
  }
  function advanceAfterSilence() {
    if (playing) advanceNext(current);
  }
  function finishPlay() {
    stop();
    setStatus("已读完 ✅");
  }

  function scrollCurrentIntoView() {
    var idx = engine === "pack" && pack.curSent >= 0 ? pack.curSent : current;
    var el = sentences[idx] && sentences[idx].el;
    if (el) {
      try { el.scrollIntoView({ behavior: "smooth", block: "center" }); } catch (e) {}
    }
  }

  /* ---------- 朗读点居中跟随：朗读时朗读行持续保持在屏幕中间 ---------- */
  var followTimer = null;
  function hasReadPoint() {
    return current >= 0 || pack.curSent >= 0;
  }
  function currentReadEl() {
    var idx = engine === "pack" && pack.curSent >= 0 ? pack.curSent : current;
    return sentences[idx] && sentences[idx].el;
  }
  function centerReadLine() {
    scrollCurrentIntoView();
  }
  function startFollow() {
    if (followTimer) return;
    followTimer = setInterval(function () {
      if (!playing || !hasReadPoint()) return;
      var el = currentReadEl();
      if (!el) return;
      var r = el.getBoundingClientRect();
      var cy = r.top + r.height / 2;
      var vh = window.innerHeight || document.documentElement.clientHeight;
      if (Math.abs(cy - vh / 2) > vh * 0.25) {
        try { el.scrollIntoView({ behavior: "smooth", block: "center" }); } catch (e) {}
      }
    }, 1200);
  }
  function stopFollow() {
    if (followTimer) { clearInterval(followTimer); followTimer = null; }
  }

  function play() {
    if (engine === "local" && !SUPPORTED) { showFallback(); return; }
    if (paused && current >= 0) { resume(); return; }
    if (playing) return;
    var start = current >= 0 && current < sentences.length - 1 ? current + 1 : 0;
    playing = true;
    paused = false;
    setPlayIcon();
    startFollow();
    if (engine === "local") keepAudioSession(true);
    speakIndex(start, 0);
  }

  function resume() {
    paused = false;
    playing = true;
    setPlayIcon();
    if (engine === "local") {
      if (SUPPORTED) {
        window.speechSynthesis.resume();
        startLocalTick(current, lastMarkedNS(current));
      }
    } else if (apiAudio && apiAudio.src) {
      var p = apiAudio.play();
      if (p && p.catch) p.catch(function () {});
    }
    setStatus("继续朗读：第 " + (current + 1) + " / " + sentences.length + " 句");
  }

  function lastMarkedNS(i) {
    var chars = sentences[i] && sentences[i].chars;
    if (!chars) return 0;
    for (var k = chars.length - 1; k >= 0; k--) {
      if (chars[k].classList.contains("current") || chars[k].classList.contains("read")) return k + 1;
    }
    return 0;
  }

  function pause() {
    if (!playing) return;
    if (engine === "local") {
      if (SUPPORTED) {
        window.speechSynthesis.pause();
        stopLocalTick();
      }
    } else if (apiAudio) {
      apiAudio.pause();
    }
    paused = true;
    playing = false;
    setStatus("已暂停（点播放继续）");
    setPlayIcon();
  }

  function stop() {
    playing = false;
    paused = false;
    stopFollow();
    pack.segIdx = -1;
    pack.lastDoneSent = -1;
    stopLocalTick();
    if (SUPPORTED) { try { window.speechSynthesis.cancel(); } catch (e) {} }
    if (apiAudio) {
      apiAudio.pause();
      abortApiBlob();
      try { apiAudio.removeAttribute("src"); apiAudio.load(); } catch (e) {}
    }
    apiState = null;
    clearAllCurrent();
    setStatus("");
    setPlayIcon();
    updateProgress();
    updateReadRail();
    keepAudioSession(false);
  }

  function clearAllCurrent() {
    sentences.forEach(function (s) {
      if (s.el) s.el.classList.remove("reading");
      var chars = s.chars || [];
      for (var k = 0; k < chars.length; k++) chars[k].classList.remove("current");
    });
  }

  function prevSentence() {
    if (current > 0) {
      stop();
      playing = true;
      setPlayIcon();
      speakIndex(current - 1, 0);
    }
  }
  function nextSentence() {
    if (current < sentences.length - 1) {
      stop();
      playing = true;
      setPlayIcon();
      speakIndex(current + 1, 0);
    }
  }

  function togglePlay() {
    if (playing) pause(); else play();
  }

  function setPlayIcon() {
    ["btn-play", "mini-play"].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.classList.toggle("playing", playing);
    });
    ["tts-eq", "mini-eq"].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.classList.toggle("paused", !playing);
    });
  }

  function updateProgress() {
    var p, txt;
    if (engine === "pack" && pack.segs && pack.segIdx >= 0) {
      p = (pack.segIdx + 1) / pack.segs.length;
      txt = "语音包：第 " + (pack.segIdx + 1) + " / " + pack.segs.length + " 段";
    } else {
      p = sentences.length ? (current + 1) / sentences.length : 0;
      txt = sentences.length ? "第 " + (current + 1) + " / " + sentences.length + " 句" : "";
    }
    ["tts-bar-fill", "mini-bar-fill"].forEach(function (id) {
      var bar = document.getElementById(id);
      if (bar) bar.style.width = (p * 100).toFixed(1) + "%";
    });
    ["tts-prog", "mini-prog"].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.textContent = txt;
    });
  }

  function setStatus(t) {
    ["tts-status", "more-status"].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.textContent = t;
    });
  }

  /* ---------- 倍速（候选列表） ---------- */
  function setRate(r) {
    rate = r;
    var el = document.getElementById("btn-rate");
    if (el) el.textContent = "倍速 " + rate.toFixed(2).replace(/0$/, "") + "×";
    document.querySelectorAll(".rate-item").forEach(function (b) {
      b.classList.toggle("active", parseFloat(b.getAttribute("data-rate")) === rate);
    });
    if (engine === "pack") {
      if (apiAudio) apiAudio.playbackRate = rate; // 语音包直接变速
    } else {
      if (engine === "api") resetApiCache();
      if (playing || paused) restartCurrent();
    }
  }
  function closeRateMenu() {
    var m = document.getElementById("rate-menu");
    if (m) m.classList.remove("open");
  }
  /* ---------- 左侧阅读标尺 ---------- */
  function readRailFraction() {
    var sent = null;
    if (engine === "pack" && pack.curSent >= 0 && sentences[pack.curSent]) sent = sentences[pack.curSent];
    else if (current >= 0 && sentences[current]) sent = sentences[current];
    if (sent && sent.el) {
      var r = sent.el.getBoundingClientRect();
      var top = window.scrollY + r.top + r.height / 2;
      var docH = document.documentElement.scrollHeight || 1;
      return top / docH;
    }
    var max = document.documentElement.scrollHeight - window.innerHeight;
    return max > 0 ? window.scrollY / max : 0;
  }
  function updateReadRail() {
    var fill = document.getElementById("read-rail-fill");
    var dot = document.getElementById("read-rail-dot");
    if (!fill) return;
    var f = readRailFraction();
    if (f < 0) f = 0;
    if (f > 1) f = 1;
    fill.style.height = (f * 100).toFixed(2) + "%";
    if (dot) dot.style.top = (f * 100).toFixed(2) + "%";
  }
  (function buildReadRail() {
    if (document.getElementById("read-rail")) return;
    var rail = document.createElement("div");
    rail.id = "read-rail";
    rail.innerHTML = '<span id="read-rail-fill"></span><i id="read-rail-dot"></i>';
    document.body.appendChild(rail);
  })();

  var panel = document.getElementById("tts-panel");
  var mini = document.getElementById("tts-mini");
  var moreMenu = document.getElementById("more-menu");

  function expandPanel() {
    if (panel) panel.classList.add("open");
    if (mini) mini.classList.add("hidden");
    if (moreMenu) moreMenu.classList.remove("open");
    armIdleCollapse();
  }
  function collapseToMini() {
    if (panel) panel.classList.remove("open");
    if (mini) mini.classList.remove("hidden");
    if (moreMenu) moreMenu.classList.remove("open");
    disarmIdleCollapse();
  }
  function toggleMore(e) {
    if (e) e.stopPropagation();
    if (moreMenu) moreMenu.classList.toggle("open");
  }

  /* 展开面板后 10 秒无操作，自动收成迷你条 */
  var idleTimer = null;
  function armIdleCollapse() {
    disarmIdleCollapse();
    idleTimer = setTimeout(function () {
      collapseToMini();
      if (hasReadPoint()) {
        centerReadLine();
        if (playing) startFollow();
      }
    }, 10000);
  }
  function disarmIdleCollapse() {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  }
  ["pointerdown", "keydown", "wheel", "touchstart"].forEach(function (ev) {
    document.addEventListener(ev, function () {
      if (panel && panel.classList.contains("open")) armIdleCollapse();
    }, { passive: true });
  });

  function updateVoiceTip() {
    var el = document.getElementById("more-voice");
    if (!el) return;
    el.textContent = engine === "api"
      ? "当前引擎：调用朗读（云端神经音色）"
      : engine === "local"
        ? "当前引擎：本地朗读（系统语音）"
        : "当前引擎：语音包朗读（预生成音频，晓涵，离线可用）";
  }

  function updateVoiceBtn() {
    var el = document.getElementById("btn-voice");
    if (!el) return;
    var name;
    if (engine === "api") {
      name = API_VOICES[apiVoiceIdx].name;
      el.textContent = "云端：" + (name.length > 12 ? name.slice(0, 12) + "…" : name);
    } else if (engine === "pack") {
      el.textContent = "语音包：晓涵（固定）";
    } else {
      name = voice ? voice.name : "系统默认";
      el.textContent = "声音：" + (name.length > 12 ? name.slice(0, 12) + "…" : name);
    }
  }

  function updateVoiceList() {
    var el = document.getElementById("more-voice-list");
    if (!el) return;
    if (engine === "api") {
      el.textContent = "云端音色：" + API_VOICES.map(function (v) { return v.name; }).join("；");
      return;
    }
    if (engine === "pack") {
      el.textContent = "语音包音色：晓涵（重新生成语音包才能换音色）";
      return;
    }
    var vs = zhVoices();
    el.textContent = vs.length
      ? "可用语音：" + vs.map(function (v) { return v.name; }).join("；")
      : "可用语音：暂无（使用系统默认）";
  }

  function nextVoice() {
    if (engine === "api") {
      apiVoiceIdx = (apiVoiceIdx + 1) % API_VOICES.length;
      saveApiVoiceIdx(apiVoiceIdx);
      setStatus("云端声音已切换到：" + API_VOICES[apiVoiceIdx].name);
    } else if (engine === "pack") {
      setStatus("语音包音色固定为晓涵，换音色需重新运行 gen_audio.py 生成");
    } else {
      if (!SUPPORTED) { showFallback(); return; }
      var vs = zhVoices();
      var idx = voice ? vs.indexOf(voice) : -1;
      if (!vs.length) {
        voice = null;
        saveVoiceName("");
        setStatus("没有可切换的语音，跟随 iPhone 设置");
      } else if (idx === vs.length - 1) {
        voice = null;
        saveVoiceName("");
        setStatus("已切回系统默认语音（跟随 iPhone 设置）");
      } else {
        voice = vs[(idx + 1) % vs.length];
        saveVoiceName(voice.name);
        setStatus("已切换到：" + voice.name);
      }
    }
    updateVoiceTip();
    updateVoiceBtn();
    updateVoiceList();
    if ((engine === "api" || engine === "local") && (playing || paused)) restartCurrent();
  }

  function restartCurrent() {
    var keep = current >= 0 ? current : 0;
    stop();
    playing = true;
    setPlayIcon();
    speakIndex(keep, 0);
  }

  function showFallback() {
    setStatus("当前浏览器不支持本地朗读，可改用“调用朗读”（云端神经音色）");
  }

  /* 静音音频保活：让 iOS 在锁屏/切后台时尽量不中断本地网页朗读（实测为准） */
  var bgCtx = null;
  function keepAudioSession(on) {
    try {
      if (on) {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        if (!bgCtx) {
          bgCtx = new AC();
          var buf = bgCtx.createBuffer(1, 1, 22050);
          var src = bgCtx.createBufferSource();
          src.buffer = buf;
          src.loop = true;
          var g = bgCtx.createGain();
          g.gain.value = 0;
          src.connect(g);
          g.connect(bgCtx.destination);
          src.start();
        }
        if (bgCtx.state === "suspended") bgCtx.resume();
      }
    } catch (e) {}
  }

  /* ---------- 按钮绑定 ---------- */
  function bind(id, fn) {
    var el = document.getElementById(id);
    if (el) el.addEventListener("click", fn);
  }
  bind("btn-play", togglePlay);
  bind("btn-pause", pause);
  bind("btn-stop", stop);
  bind("btn-prev", prevSentence);
  bind("btn-next", nextSentence);
  bind("btn-engine-pack", function () { setEngine("pack"); });
  bind("btn-engine-local", function () { setEngine("local"); });
  bind("btn-back", function () {
    if (current < 0 && pack.curSent < 0) { setStatus("还没有开始朗读"); return; }
    scrollCurrentIntoView();
    startFollow();
    setStatus("已回到朗读位置");
  });
  bind("btn-help", function (e) {
    e.stopPropagation();
    var el = document.getElementById("tts-help");
    if (el) el.style.display = el.style.display === "block" ? "none" : "block";
  });
  bind("btn-rate", function (e) {
    e.stopPropagation();
    var m = document.getElementById("rate-menu");
    if (m) m.classList.toggle("open");
  });
  document.querySelectorAll(".rate-item").forEach(function (b) {
    b.addEventListener("click", function (e) {
      e.stopPropagation();
      setRate(parseFloat(b.getAttribute("data-rate")));
      closeRateMenu();
    });
  });
  bind("btn-voice", function (e) { e.stopPropagation(); nextVoice(); });
  bind("btn-done", toggleDone);
  bind("mini-play", togglePlay);
  bind("btn-expand", expandPanel);
  bind("tts-handle", collapseToMini);
  bind("btn-more", toggleMore);
  bind("btn-nav-series", openSheet);
  document.addEventListener("click", function () {
    if (moreMenu) moreMenu.classList.remove("open");
    closeRateMenu();
  });
  setPlayIcon();
  updateProgress();
  setRate(rate);
  updateReadRail();
  updateVoiceBtn();
  updateEngineBtn();

  /* ---------- 目录 / 导航 弹层 ---------- */
  var overlay = document.getElementById("sheet-overlay");
  var sheet = document.getElementById("sheet");
  var tocPane = document.getElementById("pane-toc");

  function openSheet() {
    if (overlay) overlay.classList.add("open");
    if (sheet) sheet.classList.add("open");
    document.body.style.overflow = "hidden";
  }
  function closeSheet() {
    if (overlay) overlay.classList.remove("open");
    if (sheet) sheet.classList.remove("open");
    document.body.style.overflow = "";
  }
  bind("btn-toc", openSheet);
  bind("sheet-close", closeSheet);
  if (overlay) overlay.addEventListener("click", closeSheet);
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") closeSheet();
  });

  /* 从后台/锁屏返回时尝试恢复朗读 */
  document.addEventListener("visibilitychange", function () {
    if (document.hidden || !playing || paused) return;
    if (engine === "local" && SUPPORTED) {
      try { window.speechSynthesis.resume(); } catch (e) {}
    } else if (engine === "api" && apiAudio && apiAudio.src) {
      var p = apiAudio.play();
      if (p && p.catch) p.catch(function () {});
    }
  });

  // Tab 切换
  document.querySelectorAll(".sheet-tab").forEach(function (tab) {
    tab.addEventListener("click", function () {
      document.querySelectorAll(".sheet-tab").forEach(function (t) { t.classList.remove("active"); });
      document.querySelectorAll(".sheet-pane").forEach(function (p) { p.classList.remove("active"); });
      tab.classList.add("active");
      var pane = document.getElementById("pane-" + tab.getAttribute("data-tab"));
      if (pane) pane.classList.add("active");
    });
  });

  // 自动生成“本文目录”
  function buildToc() {
    if (!content || !tocPane) return;
    var items = [];
    var divs = content.querySelectorAll("div");
    divs.forEach(function (el) {
      var st = el.getAttribute("style") || "";
      var text = (el.textContent || "").trim();
      if (!text) return;
      var level = 0;
      if (/font-size:19px/.test(st) && /border-left/.test(st)) level = 1;
      else if (/font-size:17px/.test(st)) level = 2;
      else if (/background-color:#eaf5f2/.test(st)) level = 3;
      if (!level) return;
      text = text.replace(/^[▍\s]+/, "").replace(/★+$/, "").trim();
      if (!text || text.length > 60) return;
      items.push({ el: el, text: text, level: level });
    });
    if (!items.length) {
      tocPane.innerHTML = '<div class="toc-empty">本篇没有小标题</div>';
      return;
    }
    var dotSizes = [8, 6, 4];
    var html = items.map(function (it, idx) {
      var dot = '<span style="display:inline-block;width:%dpx;height:%dpx;border-radius:50%%;'
        + 'background-color:%s;flex:none;vertical-align:middle;"></span>'
        .replace("%d", dotSizes[it.level - 1])
        .replace("%d", dotSizes[it.level - 1])
        .replace("%s", it.level === 1 ? "#0e5f57" : it.level === 2 ? "#94a3b8" : "#cbd5e1");
      return '<button class="toc-item lv%d" data-i="%d">%s<span class="tt">%s</span></button>'
        .replace("%d", it.level).replace("%d", idx)
        .replace("%s", dot).replace("%s", escHtml(it.text));
    }).join("");
    tocPane.innerHTML = html;
    tocPane.querySelectorAll(".toc-item").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var it = items[parseInt(btn.getAttribute("data-i"), 10)];
        if (it && it.el) {
          try { it.el.scrollIntoView({ behavior: "smooth", block: "start" }); } catch (e) {}
        }
        closeSheet();
      });
    });
  }
  function escHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  buildToc();

  /* ---------- 键盘 ---------- */
  document.addEventListener("keydown", function (e) {
    if (/INPUT|TEXTAREA/.test(document.activeElement.tagName)) return;
    if (e.code === "Space") { e.preventDefault(); playing ? pause() : play(); }
    if (e.key === "ArrowLeft" && !e.metaKey && !e.ctrlKey) {
      var prev = document.querySelector(".page-nav a.prev[href]");
      if (prev) location.href = prev.getAttribute("href");
    }
    if (e.key === "ArrowRight" && !e.metaKey && !e.ctrlKey) {
      var next = document.querySelector(".page-nav a.next[href]");
      if (next) location.href = next.getAttribute("href");
    }
  });

  /* ---------- 初始化 ---------- */
  if (SUPPORTED) {
    try { window.speechSynthesis.getVoices(); } catch (e) {}
    updateVoiceTip();
    updateVoiceList();
  }
  splitSentences();
  applyReadMarks();
  onScroll();

  /* 单击正文 → 从点击的那个字开始朗读 */
  // 用光标位置定位到具体字（兼容点在高亮色块、嵌套元素上的情况）
  function nsFromPoint(x, y) {
    var range = null;
    try {
      if (document.caretRangeFromPoint) {
        range = document.caretRangeFromPoint(x, y);
      } else if (document.caretPositionFromPoint) {
        var pos = document.caretPositionFromPoint(x, y);
        if (pos && pos.offsetNode) {
          range = document.createRange();
          range.setStart(pos.offsetNode, pos.offset);
          range.collapse(true);
        }
      }
    } catch (e) {}
    if (!range) return -1;
    var node = range.startContainer;
    var offset = range.startOffset;
    var sent = node && node.nodeType === 3 ? node.parentNode : node;
    while (sent && !(sent.classList && sent.classList.contains("sent"))) sent = sent.parentNode;
    if (!sent) return -1;
    var i = parseInt(sent.getAttribute("data-i"), 10);
    if (isNaN(i) || i < 0 || i >= sentences.length) return -1;
    var walker = document.createTreeWalker(sent, NodeFilter.SHOW_TEXT, null);
    var ns = 0, hit = false;
    while (walker.nextNode()) {
      var tn = walker.currentNode;
      var t2 = tn.textContent || "";
      if (tn === node) {
        var part = t2.slice(0, offset);
        for (var k = 0; k < part.length; k++) if (!/\s/.test(part.charAt(k))) ns++;
        hit = true;
        break;
      }
      for (var k2 = 0; k2 < t2.length; k2++) if (!/\s/.test(t2.charAt(k2))) ns++;
    }
    if (!hit) return -1;
    var chars = sentences[i].chars || [];
    if (!chars.length) return 0;
    // 浏览器光标通常在点击字符之后，回退一个字，让“点到的字”成为朗读起点
    return Math.max(0, Math.min(ns - 1, chars.length - 1));
  }

  if (content) {
    content.addEventListener("click", function (e) {
      if (engine === "local" && !SUPPORTED) { showFallback(); return; }
      if (e.target.closest && e.target.closest("button, a, .sheet, .tts-bar, .tts-mini, #scroll-rail")) return;
      var ch = e.target.closest && e.target.closest(".ch");
      var s = e.target.closest && e.target.closest(".sent");
      var idx = s ? parseInt(s.getAttribute("data-i"), 10) : -1;
      if (idx < 0) {
        var y = e.clientY, best = -1, bd = 1e9;
        sentences.forEach(function (it, i) {
          if (!it.el) return;
          var r = it.el.getBoundingClientRect();
          var d = Math.abs(r.top + r.height / 2 - y);
          if (d < bd) { bd = d; best = i; }
        });
        idx = best;
      }
      if (idx < 0 || !sentences[idx]) return;
      var startNS = 0;
      if (ch) {
        var c = parseInt(ch.getAttribute("data-c"), 10);
        if (!isNaN(c)) startNS = c;
      } else {
        var nsPt = nsFromPoint(e.clientX, e.clientY);
        if (nsPt >= 0) startNS = nsPt;
      }
      stop();
      playing = true;
      paused = false;
      setPlayIcon();
      startFollow();
      speakIndex(idx, startNS);
    });
  }

  /* 右侧贴边上下滑动控制条 */
  (function buildScrollRail() {
    if (document.getElementById("scroll-rail")) return;
    var rail = document.createElement("div");
    rail.id = "scroll-rail";
    rail.innerHTML =
      '<button class="scroll-btn scroll-up" aria-label="向上滚动">' +
        '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M12 6l8 8H4z"/></svg>' +
      '</button>' +
      '<button class="scroll-btn scroll-down" aria-label="向下滚动">' +
        '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M12 18l-8-8h16z"/></svg>' +
      '</button>';
    document.body.appendChild(rail);
    function scrollByScreen(dir) {
      var h = window.innerHeight || document.documentElement.clientHeight;
      window.scrollBy({ top: h * 0.8 * dir, behavior: "smooth" });
    }
    rail.querySelector(".scroll-up").addEventListener("click", function () { scrollByScreen(-1); });
    rail.querySelector(".scroll-down").addEventListener("click", function () { scrollByScreen(1); });
  })();

  var stateEl = document.getElementById("reading-state");
  if (stateEl && articleId) {
    var st = loadAll()[articleId];
    updateDoneBtn(st && st.done);
    if (st && st.done) { stateEl.textContent = "已完成 ✅"; stateEl.className = "state done"; }
    else if (st && st.ratio) { stateEl.textContent = "已读 " + st.ratio + "%"; stateEl.className = "state todo"; }
  }

  /* 首页进度渲染 */
  if (document.getElementById("cards")) {
    var all = loadAll();
    document.querySelectorAll("[data-article]").forEach(function (card) {
      var id = card.getAttribute("data-article");
      var st = all[id];
      var el = card.querySelector(".state");
      if (!el) return;
      if (st && st.done) { el.textContent = "已完成 ✅"; el.className = "state done"; }
      else if (st && st.ratio) { el.textContent = "已读 " + st.ratio + "%"; el.className = "state todo"; }
    });
  }
})();
