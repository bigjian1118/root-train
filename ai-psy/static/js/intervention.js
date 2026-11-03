// ===== 教师端 AI 综合干预建议全屏页：读取 URL 学生ID，生成并分「状态分析 / 干预方案」两模块渲染 =====
(function () {
  "use strict";

  var params = new URLSearchParams(location.search);
  var sid = params.get("student_id") || "";

  var loading = document.getElementById("ivLoading");
  var errorBox = document.getElementById("ivError");
  var errorText = document.getElementById("ivErrorText");
  var content = document.getElementById("ivContent");
  var meta = document.getElementById("ivMeta");
  var statusEl = document.getElementById("ivStatus");
  var planEl = document.getElementById("ivPlan");

  function fmtTime(ts) {
    return new Date(ts * 1000).toLocaleString("zh-CN", { hour12: false });
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  /** 干预方案解析：▶ 开头为维度名，· / - / * 开头为条目；无标记时回退 Markdown 渲染 */
  function renderPlan(text) {
    var dims = [];
    var cur = null;
    text.split(/\r?\n/).forEach(function (raw) {
      var line = raw.trim();
      if (!line) return;
      if (/^[▶◆■▍]/.test(line) || /^#{1,4}\s/.test(line)) {
        cur = { name: line.replace(/^[▶◆■▍]+\s*/, "").replace(/^#{1,4}\s+/, ""), items: [] };
        dims.push(cur);
      } else if (cur && /^[·•\-*]\s?/.test(line)) {
        cur.items.push(line.replace(/^[·•\-*]\s*/, ""));
      } else {
        if (!cur) { cur = { name: "干预建议", items: [] }; dims.push(cur); }
        cur.items.push(line);
      }
    });
    if (!dims.length) {
      // 兜底：模型未按约定格式输出时走通用 Markdown 渲染
      planEl.innerHTML = renderAiMarkdown(text);
      planEl.classList.add("md-out");
      return;
    }
    planEl.innerHTML = dims.map(function (d) {
      return '<div class="iv-dim">' +
        '<h3 class="iv-dim-name">' + esc(d.name) + '</h3>' +
        (d.items.length
          ? '<ul class="iv-dim-list">' + d.items.map(function (it) {
              return "<li>" + esc(it) + "</li>";
            }).join("") + '</ul>'
          : "") +
        '</div>';
    }).join("");
  }

  function render(d) {
    meta.textContent = "学生：" + d.student_name + "（" + (d["class"] || "—") + "）　生成时间：" + fmtTime(d.generated_at);
    if (d.status) {
      statusEl.innerHTML = renderAiMarkdown(d.status);
      statusEl.classList.add("md-out");
    } else {
      statusEl.textContent = "（本次生成未返回状态分析，请以下方干预方案为准）";
    }
    if (d.plan) renderPlan(d.plan);
    else planEl.textContent = "（无干预方案正文）";
    content.hidden = false;
  }

  function generate() {
    loading.hidden = false;
    errorBox.hidden = true;
    content.hidden = true;
    fetch("/api/ai/intervention", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ student_id: sid })
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        loading.hidden = true;
        if (!res.ok || res.d.error) {
          errorText.textContent = res.d.error || "AI 干预建议生成失败";
          errorBox.hidden = false;
          return;
        }
        render(res.d);
      })
      .catch(function (e) {
        loading.hidden = true;
        errorText.textContent = "网络错误：" + e.message;
        errorBox.hidden = false;
      });
  }

  document.getElementById("ivRetry").addEventListener("click", generate);

  if (!sid) {
    loading.hidden = true;
    errorText.textContent = "缺少学生标识（student_id），请从学生报告详情页点击「AI 干预建议」进入本页";
    errorBox.hidden = false;
    return;
  }
  generate();
})();
