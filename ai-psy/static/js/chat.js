// 聊天助手页脚本：场景切换 + 多轮对话（调用后端 /api/chat）
(function () {
  "use strict";

  var scenarioList = document.getElementById("scenarioList");
  var msgList = document.getElementById("msgList");
  var chatHead = document.getElementById("chatHead");
  var userInput = document.getElementById("userInput");
  var sendBtn = document.getElementById("sendBtn");
  var clearBtn = document.getElementById("clearBtn");
  var mockBadge = document.getElementById("mockBadge");
  var toast = document.getElementById("toast");

  // 当前场景与多轮上下文（仅 user/assistant 角色）
  var currentScenario = "college_student";
  var messages = [];
  var scenarios = {};
  var sending = false;

  // ---------- 工具 ----------
  function showToast(text) {
    toast.textContent = text;
    toast.hidden = false;
    setTimeout(function () { toast.hidden = true; }, 3000);
  }

  function scrollBottom() {
    msgList.scrollTop = msgList.scrollHeight;
  }

  // 追加一条消息气泡
  function addMsg(role, text) {
    var wrap = document.createElement("div");
    wrap.className = "msg " + (role === "user" ? "user" : "bot");
    var avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.textContent = role === "user" ? "🙂" : "🌤";
    var bubble = document.createElement("div");
    bubble.className = "bubble";
    if (role === "bot") {
      // AI 回复按 Markdown 渲染为 HTML（** → 加粗、# → 标题），不显示原始符号；
      // renderAiMarkdown 输出前统一 HTML 转义，无注入风险
      bubble.classList.add("md-out");
      bubble.innerHTML = window.renderAiMarkdown ? window.renderAiMarkdown(text) : text;
    } else {
      bubble.textContent = text;
    }
    wrap.appendChild(avatar);
    wrap.appendChild(bubble);
    msgList.appendChild(wrap);
    scrollBottom();
    return wrap;
  }

  // 打字中占位气泡
  function addTyping() {
    var wrap = document.createElement("div");
    wrap.className = "msg bot typing";
    wrap.innerHTML =
      '<div class="avatar">🌤</div><div class="bubble">' +
      '<span class="dot"></span><span class="dot"></span><span class="dot"></span></div>';
    msgList.appendChild(wrap);
    scrollBottom();
    return wrap;
  }

  // ---------- 场景渲染与切换 ----------
  function renderScenarios(list) {
    scenarioList.innerHTML = "";
    list.forEach(function (sc) {
      scenarios[sc.key] = sc;
      var btn = document.createElement("button");
      btn.className = "scenario-btn" + (sc.key === currentScenario ? " active" : "");
      btn.dataset.key = sc.key;
      btn.innerHTML = sc.name + "<small>" + sc.desc + "</small>";
      btn.addEventListener("click", function () {
        currentScenario = sc.key;
        document.querySelectorAll(".scenario-btn").forEach(function (b) {
          b.classList.toggle("active", b.dataset.key === sc.key);
        });
        chatHead.textContent = "当前场景：" + sc.name;
      });
      scenarioList.appendChild(btn);
    });
  }

  // 拉取全局配置（场景列表 + mock 标记）
  fetch("/api/config")
    .then(function (r) { return r.json(); })
    .then(function (data) {
      renderScenarios(data.scenarios || []);
      if (data.mock) { mockBadge.hidden = false; }
      var first = (data.scenarios || []).find(function (s) {
        return s.key === currentScenario;
      });
      if (first) { chatHead.textContent = "当前场景：" + first.name; }
    })
    .catch(function () { showToast("场景配置加载失败，请确认后端已启动"); });

  // ---------- 发送消息 ----------
  function send() {
    var text = userInput.value.trim();
    if (!text || sending) { return; }
    sending = true;
    sendBtn.disabled = true;
    userInput.value = "";

    messages.push({ role: "user", content: text });
    addMsg("user", text);
    var typing = addTyping();

    fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scenario: currentScenario, messages: messages }),
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        typing.remove();
        if (!res.ok || res.d.error) {
          showToast(res.d.error || "请求失败");
          messages.pop(); // 失败回滚本轮，保持上下文一致
          return;
        }
        messages.push({ role: "assistant", content: res.d.reply });
        addMsg("bot", res.d.reply);
      })
      .catch(function (e) {
        typing.remove();
        showToast("网络错误：" + e.message);
        messages.pop();
      })
      .finally(function () {
        sending = false;
        sendBtn.disabled = false;
        userInput.focus();
      });
  }

  sendBtn.addEventListener("click", send);
  userInput.addEventListener("keydown", function (e) {
    // Enter 发送，Shift+Enter 换行
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  // ---------- 清空会话 ----------
  clearBtn.addEventListener("click", function () {
    messages = [];
    msgList.innerHTML = "";
    addMsg("bot", "会话已清空，我们重新开始吧～有什么想说的尽管告诉我。");
  });
})();
