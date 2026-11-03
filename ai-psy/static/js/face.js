// 人脸视频分析页脚本：配置栏 -> getUserMedia 预览 -> MediaRecorder 录制 -> 上传 /api/face/analyze -> 渲染报告
// 上传契约：FormData{video} -> POST /api/face/analyze
(function () {
  "use strict";

  var preview = document.getElementById("preview");
  var videoPlaceholder = document.getElementById("videoPlaceholder");
  var openBtn = document.getElementById("openBtn");
  var recBtn = document.getElementById("recBtn");
  var recDot = document.getElementById("recDot");
  var countdown = document.getElementById("countdown");
  var segCount = document.getElementById("segCount");
  var sideTip = document.getElementById("sideTip");
  var recordPanel = document.getElementById("recordPanel");
  var loadingPanel = document.getElementById("loadingPanel");
  var resultPanel = document.getElementById("resultPanel");
  var reportText = document.getElementById("reportText");
  var emotionBars = document.getElementById("emotionBars");
  var auBars = document.getElementById("auBars");
  var emotionCurve = document.getElementById("emotionCurve");
  var indexCards = document.getElementById("indexCards");
  var dominantEmotion = document.getElementById("dominantEmotion");
  var metaLine = document.getElementById("metaLine");
  var retryBtn = document.getElementById("retryBtn");
  var toast = document.getElementById("toast");

  // 左栏控件
  var recType = document.getElementById("recType");
  var recDuration = document.getElementById("recDuration");
  var shotMode = document.getElementById("shotMode");
  var cameraSelect = document.getElementById("cameraSelect");
  var lightMode = document.getElementById("lightMode");
  var multiOps = document.getElementById("multiOps");
  var againBtn = document.getElementById("againBtn");
  var submitBtn = document.getElementById("submitBtn");

  var mediaStream = null;
  var recorder = null;
  var chunks = [];      // 当前段缓冲
  var allChunks = [];   // 多次拍摄累积（跨段）
  var segments = 0;     // 已录段数
  var timer = null;

  var EMOTION_CN = {
    anger: "愤怒", disgust: "厌恶", fear: "恐惧",
    happiness: "快乐", sadness: "悲伤", surprise: "惊讶",
  };
  var LIGHT_TIP = {
    natural: "自然光：请在光线均匀的窗边拍摄，避免逆光。",
    indoor: "室内灯：请注意面部无强阴影，正对光源。",
    dim: "暗光：光线较弱可能影响识别准确度，建议补光。",
  };

  function showToast(text) {
    toast.textContent = text;
    toast.hidden = false;
    setTimeout(function () { toast.hidden = true; }, 3500);
  }

  function fmtClock(totalSeconds) {
    var s = Math.max(0, Math.floor(totalSeconds));
    var mm = String(Math.floor(s / 60)).padStart(2, "0");
    var ss = String(s % 60).padStart(2, "0");
    return "00:" + mm + ":" + ss;
  }

  // ---------- 0. 枚举摄像头设备 ----------
  function loadCameras() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    navigator.mediaDevices.enumerateDevices().then(function (devices) {
      var cams = devices.filter(function (d) { return d.kind === "videoinput"; });
      // 保留默认项，追加检测到的设备
      cameraSelect.innerHTML = '<option value="">本机摄像头（默认）</option>';
      cams.forEach(function (c, i) {
        var opt = document.createElement("option");
        opt.value = c.deviceId;
        opt.textContent = c.label || ("摄像头 " + (i + 1));
        cameraSelect.appendChild(opt);
      });
    }).catch(function () { /* 未授权前 label 可能为空，忽略 */ });
  }
  loadCameras();

  // ---------- 1. 开启摄像头 ----------
  openBtn.addEventListener("click", function () {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showToast("当前环境不支持摄像头，请使用 https 或 localhost 访问");
      return;
    }
    var videoConstraint = { width: 640, height: 360 };
    var camId = cameraSelect.value;
    if (camId) videoConstraint.deviceId = { exact: camId };

    navigator.mediaDevices.getUserMedia({ video: videoConstraint, audio: false })
      .then(function (stream) {
        mediaStream = stream;
        preview.srcObject = stream;
        videoPlaceholder.hidden = true;
        recBtn.disabled = false;
        openBtn.disabled = true;
        sideTip.textContent = (LIGHT_TIP[lightMode.value] || "摄像头已就绪。") + " 请正对镜头保持放松表情。";
        loadCameras(); // 授权后可读到真实 label，刷新一次
        // 自动模式：延时 1.5s 后自动开始录制
        if (recType.value === "auto") {
          setTimeout(function () {
            if (mediaStream && !recorder) startRecording();
          }, 1500);
        }
      })
      .catch(function (e) {
        showToast("摄像头开启失败：" + e.message);
      });
  });

  // ---------- 2. 录制 ----------
  recBtn.addEventListener("click", function () { startRecording(); });

  function startRecording() {
    if (!mediaStream) { return; }
    if (recorder && recorder.state === "recording") { return; }

    chunks = [];
    var mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
      ? "video/webm;codecs=vp9" : "video/webm";
    recorder = new MediaRecorder(mediaStream, { mimeType: mime });
    recorder.ondataavailable = function (e) {
      if (e.data && e.data.size > 0) { chunks.push(e.data); }
    };
    recorder.onstop = onSegmentStop;

    recorder.start();
    recBtn.disabled = true;
    recDot.hidden = false;

    var total = parseInt(recDuration.value, 10) || 10;
    var left = total;
    countdown.hidden = false;
    countdown.textContent = fmtClock(total);
    timer = setInterval(function () {
      left -= 1;
      countdown.textContent = fmtClock(left);
      if (left <= 0) {
        clearInterval(timer);
        recorder.stop(); // 触发 onstop
      }
    }, 1000);
  }

  /** 单段录制结束 */
  function onSegmentStop() {
    recDot.hidden = true;
    countdown.hidden = true;
    segments += 1;
    // 把本段合并为独立 blob 累积（多次拍摄保留每段，提交时拼接）
    var segBlob = new Blob(chunks, { type: "video/webm" });
    if (segBlob.size > 0) allChunks.push(segBlob);

    if (shotMode.value === "multi") {
      // 多次拍摄：不自动上传，展示操作按钮
      segCount.hidden = false;
      segCount.textContent = "已录 " + segments + " 段";
      multiOps.hidden = false;
      recBtn.disabled = false; // 可再录
      return;
    }
    // 单次拍摄：关闭摄像头并上传
    finishAndUpload();
  }

  againBtn.addEventListener("click", function () {
    multiOps.hidden = true;
    startRecording();
  });
  submitBtn.addEventListener("click", function () {
    multiOps.hidden = true;
    finishAndUpload();
  });

  // ---------- 3. 结束录制 -> 上传分析 ----------
  function finishAndUpload() {
    if (mediaStream) {
      mediaStream.getTracks().forEach(function (t) { t.stop(); });
      mediaStream = null;
    }
    var blob;
    if (allChunks.length === 1) {
      blob = allChunks[0];
    } else if (allChunks.length > 1) {
      // 多段：以原始字节拼接（webm 容器拼接浏览器一般可解码；若失败后端会返回错误提示）
      blob = new Blob(allChunks, { type: "video/webm" });
    } else {
      blob = new Blob(chunks, { type: "video/webm" });
    }
    if (!blob || blob.size === 0) { showToast("未采集到视频数据，请重试"); resetButtons(); return; }

    recordPanel.hidden = true;
    loadingPanel.hidden = false;
    resultPanel.hidden = true;

    var form = new FormData();
    form.append("video", blob, "face.webm");

    // 隐私保护：视频已交给 FormData 上传，立即释放 JS 侧录制缓冲引用，
    // 避免录制内容在报告返回后仍驻留浏览器内存（原逻辑仅在失败/重录时清理）
    chunks = [];
    allChunks = [];

    fetch("/api/face/analyze", { method: "POST", body: form })
      .then(function (r) {
        // 后端异常时可能返回 HTML 错误页，先检查 content-type，
        // 非 JSON 给出可定位的明确提示
        var ct = r.headers.get("content-type") || "";
        if (ct.indexOf("application/json") < 0) {
          return { ok: false, d: { error: "服务器返回异常响应（HTTP " + r.status + "），" +
            "可能是视频分析超时或 py-feat 环境异常，请查看服务器日志" } };
        }
        return r.json().then(function (d) { return { ok: r.ok, d: d }; });
      })
      .then(function (res) {
        loadingPanel.hidden = true;
        if (!res.ok || res.d.error) {
          recordPanel.hidden = false;
          showToast(res.d.error || "分析失败，请重试");
          resetButtons();
          return;
        }
        renderResult(res.d);
      })
      .catch(function (e) {
        loadingPanel.hidden = true;
        recordPanel.hidden = false;
        showToast("网络错误：" + e.message);
        resetButtons();
      });
  }

  function resetButtons() {
    openBtn.disabled = false;
    recBtn.disabled = true;
    multiOps.hidden = true;
    segCount.hidden = true;
    segments = 0;
    allChunks = [];
  }

  // ---------- 4. 渲染结果 ----------
  function makeBar(name, value, hot) {
    var row = document.createElement("div");
    row.className = "bar-row";
    row.innerHTML =
      '<div class="bar-name">' + name + "</div>" +
      '<div class="bar-track"><div class="bar-fill' + (hot ? " hot" : "") + '"></div></div>' +
      '<div class="bar-val">' + Math.round(value * 100) + "%</div>";
    requestAnimationFrame(function () {
      row.querySelector(".bar-fill").style.width = Math.min(100, value * 100) + "%";
    });
    return row;
  }

  /** 心态分布曲线：由 6 项情绪概率绘平滑面积曲线（SVG 手绘） */
  function drawEmotionCurve(emotions) {
    var keys = Object.keys(emotions || {});
    if (!keys.length) { emotionCurve.innerHTML = '<p class="empty-tip">无情绪数据</p>'; return; }
    var W = 520, H = 200, padL = 34, padR = 16, padT = 16, padB = 28;
    var innerW = W - padL - padR, innerH = H - padT - padB;
    var n = keys.length;
    var stepX = innerW / Math.max(1, n - 1);
    var pts = keys.map(function (k, i) {
      var v = Math.max(0, Math.min(1, emotions[k] || 0));
      return { x: padL + i * stepX, y: padT + (1 - v) * innerH, v: v, k: k };
    });
    // 平滑路径（二次贝塞尔）
    function smoothPath(list) {
      var d = "M" + list[0].x + "," + list[0].y;
      for (var i = 1; i < list.length; i++) {
        var p0 = list[i - 1], p1 = list[i];
        var mx = (p0.x + p1.x) / 2;
        d += " Q" + p0.x + "," + p0.y + " " + mx + "," + ((p0.y + p1.y) / 2);
        d += " Q" + p1.x + "," + p1.y + " " + p1.x + "," + p1.y;
      }
      return d;
    }
    var line = smoothPath(pts);
    var area = line + " L" + pts[n - 1].x + "," + (H - padB) + " L" + pts[0].x + "," + (H - padB) + " Z";
    var refY = padT + (1 - 1 / n) * innerH; // 均匀分布参考线
    var grid = "";
    for (var g = 0; g <= 4; g++) {
      var gy = padT + innerH * g / 4;
      grid += '<line x1="' + padL + '" y1="' + gy + '" x2="' + (W - padR) + '" y2="' + gy + '" stroke="rgba(126,200,242,0.16)" stroke-width="1"/>';
      grid += '<text x="' + (padL - 6) + '" y="' + (gy + 3) + '" text-anchor="end" class="ax">' + Math.round((1 - g / 4) * 100) + '%</text>';
    }
    var labels = pts.map(function (p) {
      return '<text x="' + p.x + '" y="' + (H - 8) + '" text-anchor="middle" class="ax">' + (EMOTION_CN[p.k] || p.k) + '</text>';
    }).join("");
    var nodes = pts.map(function (p) {
      return '<circle cx="' + p.x + '" cy="' + p.y + '" r="4" class="node"><title>' + (EMOTION_CN[p.k] || p.k) + " " + Math.round(p.v * 100) + "%</title></circle>";
    }).join("");
    emotionCurve.innerHTML =
      '<svg viewBox="0 0 ' + W + " " + H + '" class="curve-svg">' +
      '<defs><linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="rgba(111,194,151,0.55)"/>' +
      '<stop offset="100%" stop-color="rgba(111,194,151,0.05)"/></linearGradient></defs>' +
      grid +
      '<line x1="' + padL + '" y1="' + refY + '" x2="' + (W - padR) + '" y2="' + refY + '" stroke="#3a9bd8" stroke-width="1.2" stroke-dasharray="5 4"/>' +
      '<path d="' + area + '" fill="url(#areaGrad)"/>' +
      '<path d="' + line + '" fill="none" stroke="#6fc297" stroke-width="2.4" stroke-linecap="round"/>' +
      nodes + labels +
      "</svg>";
  }

  /** 启发式分级指标（前端估算）：由负面情绪占比 + 面部活跃度推导 */
  function renderIndexCards(m) {
    var emotions = m.emotions || {};
    var neg = (emotions.anger || 0) + (emotions.disgust || 0) + (emotions.fear || 0) + (emotions.sadness || 0);
    var activity = m.face_activity || 0;
    // 0-100 分级：压力度=负面情绪占比，情绪状态=快乐/惊讶正向占比，集中力=活跃度适中度，疲劳度=低活跃+高负面
    var pressure = Math.round(Math.min(1, neg) * 100);
    var mood = Math.round(Math.min(1, (emotions.happiness || 0) + (emotions.surprise || 0)) * 100);
    var focus = Math.round(Math.max(0, 100 - Math.abs(activity - 0.5) * 160));
    var fatigue = Math.round(Math.min(1, Math.max(0, (1 - activity) * 0.6 + neg * 0.6)) * 100);
    var cards = [
      { name: "大脑疲劳度", val: fatigue, dir: "low" },
      { name: "集中力", val: focus, dir: "high" },
      { name: "压力度", val: pressure, dir: "low" },
      { name: "情绪状态", val: mood, dir: "high" },
    ];
    function grade(v, dir) {
      // dir=low 表示越低越好；dir=high 表示越高越好
      var good = dir === "high" ? v : 100 - v;
      if (good >= 70) return { txt: "良好", cls: "ok" };
      if (good >= 45) return { txt: "需关注", cls: "warn" };
      return { txt: "重点", cls: "focus" };
    }
    indexCards.innerHTML = cards.map(function (c) {
      var g = grade(c.val, c.dir);
      return '<div class="index-card glass">' +
        '<div class="idx-name">' + c.name + "</div>" +
        '<div class="idx-val hl-num">' + c.val + "</div>" +
        '<div class="idx-bar"><span class="idx-fill ' + g.cls + '" style="width:' + c.val + '%"></span></div>' +
        '<div class="idx-grade ' + g.cls + '">' + g.txt + "</div>" +
        "</div>";
    }).join("");
  }

  function renderResult(data) {
    resultPanel.hidden = false;
    var m = data.metrics || {};

    // Markdown 语法转正式文档排版（去 ** ## - 等标记，保留语义）
    reportText.innerHTML = data.report ? renderAiMarkdown(data.report) : "（无报告文本）";
    reportText.classList.add("md-out");
    dominantEmotion.textContent =
      EMOTION_CN[m.dominant_emotion] || m.dominant_emotion || "-";

    emotionBars.innerHTML = "";
    Object.keys(m.emotions || {}).forEach(function (key) {
      var v = m.emotions[key];
      emotionBars.appendChild(makeBar((EMOTION_CN[key] || key), v, v >= 0.4));
    });

    auBars.innerHTML = "";
    Object.keys(m.au || {}).forEach(function (key) {
      var item = m.au[key];
      auBars.appendChild(makeBar(key + " " + (item.label || ""), item.mean, item.mean >= 0.6));
    });

    drawEmotionCurve(m.emotions);
    renderIndexCards(m);

    metaLine.textContent =
      "抽帧 " + (m.total_frames || 0) + " 帧 / 检出人脸 " + (m.face_frames || 0) +
      " 帧 / 面部活跃度 " + Math.round((m.face_activity || 0) * 100) + "%" +
      (m.mock ? "（Mock 演示数据）" : "");
  }

  // ---------- 重新录制 ----------
  retryBtn.addEventListener("click", function () {
    resultPanel.hidden = true;
    recordPanel.hidden = false;
    resetButtons();
    videoPlaceholder.hidden = false;
    sideTip.textContent = "提示：需在 https 或 localhost 环境下授权摄像头。";
  });
})();
