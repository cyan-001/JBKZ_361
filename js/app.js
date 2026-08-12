/* 公众号复习系列 · 网站版
 * 功能：网页朗读（Web Speech API）、句级高亮、阅读进度、上一篇/下一篇、键盘快捷键 */
(function () {
  "use strict";

  var SUPPORTED = "speechSynthesis" in window;
  var content = document.getElementById("article-content");
  var sentences = [];          // {el, text}
  var current = -1;            // 当前朗读到第几句
  var playing = false;
  var rate = 1;
  var voice = null;
  var paused = false;
  var articleId = document.body.getAttribute("data-article");

  /* ---------- 进度条 ---------- */
  var bar = document.getElementById("progress-bar");
  function onScroll() {
    if (!bar) return;
    var h = document.documentElement;
    var max = h.scrollHeight - h.clientHeight;
    var p = max > 0 ? (h.scrollTop / max) : 0;
    bar.style.width = (p * 100).toFixed(2) + "%";
    saveReading(p);
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

  /* ---------- 分句 ---------- */
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
      if (out.length <= 1) return; // 已经是短句，不用包 span
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
  }

  /* ---------- 语音 ---------- */
  function pickVoice() {
    return preferredVoice() || null;
  }
  function zhVoices() {
    try {
      return window.speechSynthesis.getVoices().filter(function (v) { return /^zh/i.test(v.lang); });
    } catch (e) { return []; }
  }
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
    // 优先李牧（优化音质），其次常见中文语音
    var names = ["李牧", "李穆", "李沐", "limu", "li mu", "婷婷", "小美", "优优", "彬彬"];
    for (var i = 0; i < names.length; i++) {
      var re = new RegExp(names[i], "i");
      var hit = vs.filter(function (x) { return re.test(x.name); })[0];
      if (hit) return hit;
    }
    return null;
  }

  function speakIndex(i) {
    if (!SUPPORTED || i < 0 || i >= sentences.length) return;
    current = i;
    updateProgress();
    var speakText = cleanForSpeech(sentences[i].text);
    if (!speakText) { advanceAfterSilence(); return; }
    var u = new SpeechSynthesisUtterance(speakText);
    var hasVoice = voice && zhVoices().indexOf(voice) >= 0;
    if (hasVoice) u.voice = voice;
    u.lang = hasVoice && voice.lang ? voice.lang : "zh-CN";
    u.rate = rate;
    u.onend = function () {
      if (playing) {
        if (current + 1 < sentences.length) {
          speakIndex(current + 1);
        } else {
          stop();
          setStatus("已读完 ✅");
        }
      }
    };
    u.onerror = function () {
      if (playing) { stop(); setStatus("朗读中断，请重试"); }
    };
    highlight(current);
    window.speechSynthesis.speak(u);
    setStatus("正在朗读：第 " + (current + 1) + " / " + sentences.length + " 句");
  }

  function advanceAfterSilence() {
    if (playing) {
      if (current + 1 < sentences.length) {
        speakIndex(current + 1);
      } else {
        stop();
        setStatus("已读完 ✅");
      }
    }
  }

  // 剔除会被语音读出来的装饰字符（保留 ①②⑶ 等编号与数字）
  var DECOR_RE = /[▸▍★☆◆⊙◇●◎○※→↳📐▪•·♪™®©¤†‡§¶]/g;
  function cleanForSpeech(s) {
    return s.replace(/→/g, "，")
      .replace(DECOR_RE, " ")
      .replace(/\u200b/g, "")
      .replace(/\s{2,}/g, " ").trim();
  }

  function highlight(i) {
    sentences.forEach(function (s, idx) {
      if (s.el) s.el.classList.toggle("reading", idx === i);
    });
    var el = sentences[i] && sentences[i].el;
    if (el) {
      try { el.scrollIntoView({ behavior: "smooth", block: "center" }); } catch (e) {}
    }
  }

  function play() {
    if (!SUPPORTED) { showFallback(); return; }
    if (paused && current >= 0) {
      window.speechSynthesis.resume();
      paused = false;
      playing = true;
      setStatus("继续朗读：第 " + (current + 1) + " / " + sentences.length + " 句");
      setPlayIcon();
      return;
    }
    if (playing) return;
    var start = current >= 0 && current < sentences.length - 1 ? current + 1 : 0;
    playing = true;
    setPlayIcon();
    speakIndex(start);
  }

  function pause() {
    if (!SUPPORTED || !playing) return;
    window.speechSynthesis.pause();
    paused = true;
    playing = false;
    setStatus("已暂停（点播放继续）");
    setPlayIcon();
  }

  function stop() {
    playing = false;
    paused = false;
    if (SUPPORTED) window.speechSynthesis.cancel();
    highlight(-1);
    setStatus("");
    setPlayIcon();
    updateProgress();
  }

  function prevSentence() {
    if (current > 0) {
      stop();
      playing = true;
      setPlayIcon();
      speakIndex(current - 1);
    }
  }
  function nextSentence() {
    if (current < sentences.length - 1) {
      stop();
      playing = true;
      setPlayIcon();
      speakIndex(current + 1);
    }
  }

  function togglePlay() {
    if (!SUPPORTED) { showFallback(); return; }
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
    var p = sentences.length ? (current + 1) / sentences.length : 0;
    var txt = sentences.length ? "第 " + (current + 1) + " / " + sentences.length + " 句" : "";
    ["tts-bar-fill", "mini-bar-fill"].forEach(function (id) {
      var bar = document.getElementById(id);
      if (bar) bar.style.width = (p * 100).toFixed(1) + "%";
    });
    ["tts-prog", "mini-prog"].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.textContent = txt;
    });
  }

  var statusEl = document.getElementById("more-status");
  function setStatus(t) { if (statusEl) statusEl.textContent = t; }

  var panel = document.getElementById("tts-panel");
  var mini = document.getElementById("tts-mini");
  var moreMenu = document.getElementById("more-menu");

  function expandPanel() {
    if (panel) panel.classList.add("open");
    if (mini) mini.classList.add("hidden");
    if (moreMenu) moreMenu.classList.remove("open");
  }
  function collapseToMini() {
    if (panel) panel.classList.remove("open");
    if (mini) mini.classList.remove("hidden");
    if (moreMenu) moreMenu.classList.remove("open");
  }
  function toggleMore(e) {
    if (e) e.stopPropagation();
    if (moreMenu) moreMenu.classList.toggle("open");
  }

  function updateVoiceTip() {
    var el = document.getElementById("more-voice");
    if (!el) return;
    el.textContent = voice
      ? "当前语音：" + voice.name
      : "使用系统默认中文语音";
  }

  function updateVoiceBtn() {
    var el = document.getElementById("btn-voice");
    if (!el) return;
    var name = voice ? voice.name : "系统默认";
    el.textContent = "声音：" + (name.length > 12 ? name.slice(0, 12) + "…" : name);
  }

  function updateVoiceList() {
    var el = document.getElementById("more-voice-list");
    if (!el) return;
    var vs = zhVoices();
    el.textContent = vs.length
      ? "可用语音：" + vs.map(function (v) { return v.name; }).join("；")
      : "可用语音：暂无（使用系统默认）";
  }

  function nextVoice() {
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
    updateVoiceTip();
    updateVoiceBtn();
    updateVoiceList();
    if (playing || paused) {
      var keep = current >= 0 ? current : 0;
      stop();
      playing = true;
      setPlayIcon();
      speakIndex(keep);
    }
  }

  function showFallback() {
    setStatus("当前浏览器不支持网页朗读，可用系统朗读（设置→辅助功能→朗读内容→朗读屏幕）");
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
  bind("btn-help", function (e) {
    e.stopPropagation();
    var el = document.getElementById("tts-help");
    if (el) el.style.display = el.style.display === "block" ? "none" : "block";
  });
  bind("btn-rate", function () {
    var rates = [0.75, 1, 1.25, 1.5, 2];
    var idx = rates.indexOf(rate);
    rate = rates[(idx + 1) % rates.length];
    var el = document.getElementById("btn-rate");
    if (el) el.textContent = "倍速 " + rate.toFixed(2).replace(/0$/, "") + "×";
  });
  bind("btn-voice", function (e) { e.stopPropagation(); nextVoice(); });
  bind("btn-done", toggleDone);
  bind("mini-play", togglePlay);
  bind("btn-expand", expandPanel);
  bind("tts-handle", collapseToMini);
  bind("btn-more", toggleMore);
  document.addEventListener("click", function () {
    if (moreMenu) moreMenu.classList.remove("open");
  });
  setPlayIcon();
  updateProgress();
  updateVoiceBtn();

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
  } else {
    showFallback();
  }
  splitSentences();
  onScroll();

  /* 双击正文 → 从该句开始朗读 */
  if (content) {
    content.addEventListener("dblclick", function (e) {
      if (!SUPPORTED) { showFallback(); return; }
      var t = e.target;
      var s = t && t.closest ? t.closest(".sent") : null;
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
      stop();
      playing = true;
      setPlayIcon();
      speakIndex(idx);
    });
  }

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
