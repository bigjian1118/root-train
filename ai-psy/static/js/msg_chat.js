// ===== 学生端：与心理老师的倾诉聊天详情（学生消息居右带头像、教师消息居左带头像，自动滚到底部） =====
(function () {
  "use strict";

  var chatBody = document.getElementById("chatBody");
  var loadTip = document.getElementById("loadTip");
  var whoName = document.getElementById("whoName");
  var whoTag = document.getElementById("whoTag");
  var inputBox = document.getElementById("inputBox");
  var sendBtn = document.getElementById("sendBtn");

  var convId = new URLSearchParams(location.search).get("conv") || "";

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function fmtTime(ts) {
    if (!ts) return "";
    return new Date(ts * 1000).toLocaleString("zh-CN", { hour12: false }).slice(0, 16);
  }

  function scrollToBottom() {
    chatBody.scrollTop = chatBody.scrollHeight;
  }

  // 圆形头像：学生蓝色学生头像、教师绿色教师头像（两端 msg_chat.css 统一样式）
  var AVATAR_STUDENT = "\u{1F9D1}\u200D\u{1F393}";
  var AVATAR_TEACHER = "\u{1F9D1}\u200D\u{1F3EB}";

  function addMsg(m, withTime) {
    // 学生（我）= 居右 + 右侧头像；教师（对方）= 居左 + 左侧头像
    var isMe = m.sender_role === "student";
    var el = document.createElement("div");
    el.className = "msg " + (isMe ? "mine" : "other");
    var time = withTime || m.same_time ? '<div class="msg-time">' + fmtTime(m.created_at) + "</div>" : "";
    el.innerHTML =
      '<span class="avatar ' + (isMe ? "avatar-student" : "avatar-teacher") + '" aria-hidden="true">' +
      (isMe ? AVATAR_STUDENT : AVATAR_TEACHER) + "</span>" +
      '<div class="msg-main"><div class="bubble">' + esc(m.content) + "</div>" + time + "</div>";
    chatBody.appendChild(el);
  }

  // 消息是否与上一条同一分钟：时间戳过近就只展示一次时间，避免刷屏
  var lastTs = null;
  function appendMessage(m) {
    var same = lastTs != null && (m.created_at - lastTs) < 90;
    addMsg(m, !same);
    lastTs = m.created_at;
  }

  function markRead() {
    if (!convId) return;
    fetch("/api/student/msg/conversation/" + encodeURIComponent(convId) + "/read", { method: "POST" })
      .then(function (r) { return r.json(); })
      .catch(function () {});
  }

  function load() {
    if (!convId) {
      loadTip.textContent = "缺少会话参数，无法打开。";
      return;
    }
    fetch("/api/student/msg/conversation/" + encodeURIComponent(convId))
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.error) { loadTip.textContent = d.error; return; }
        whoName.textContent = d.conversation.teacher_name || "心理老师";
        chatBody.innerHTML = "";
        lastTs = null;
        (d.messages || []).forEach(appendMessage);
        if (!(d.messages || []).length) {
          loadTip.textContent = "和老师还没有消息，写下你的第一句话吧。";
        }
        markRead();   // 打开即把老师发来的消息标为已读
        scrollToBottom();
        inputBox.focus();
      })
      .catch(function () { loadTip.textContent = "加载失败，请检查网络。"; });
  }

  function send() {
    var content = inputBox.value.trim();
    if (!content) return;
    if (!convId) return;
    sendBtn.disabled = true;
    fetch("/api/student/msg/conversation/" + encodeURIComponent(convId) + "/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: content })
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.error) { alert(d.error); return; }
        inputBox.value = "";
        inputBox.style.height = "auto";
        // 自己刚发的默认老师还没读，无需标已读
        appendMessage(d.message);
        scrollToBottom();
      })
      .catch(function () { alert("发送失败，请重试。"); })
      .finally(function () { sendBtn.disabled = false; inputBox.focus(); });
  }

  sendBtn.addEventListener("click", send);
  inputBox.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  });
  // 输入框自适应高度
  inputBox.addEventListener("input", function () {
    inputBox.style.height = "auto";
    inputBox.style.height = Math.min(120, inputBox.scrollHeight) + "px";
  });

  load();
})();