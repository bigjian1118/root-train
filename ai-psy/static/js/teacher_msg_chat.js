// ===== 教师端：与学生倾诉的聊天详情（教师消息居右带头像、学生消息居左带头像，自动滚到底部） =====
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

  // 圆形头像：学生消息蓝色学生头像、教师消息绿色教师头像（与学生端 msg_chat.js 一致）
  var AVATAR_STUDENT = "\u{1F9D1}\u200D\u{1F393}";
  var AVATAR_TEACHER = "\u{1F9D1}\u200D\u{1F3EB}";

  function addMsg(m, withTime) {
    // 教师（我）= 居右 + 右侧头像；学生（对方）= 居左 + 左侧头像
    var isMe = m.sender_role === "teacher";
    var el = document.createElement("div");
    el.className = "msg " + (isMe ? "mine" : "other");
    var time = withTime || m.same_time
      ? '<div class="msg-time">' + fmtTime(m.created_at) + "</div>" : "";
    el.innerHTML =
      '<span class="avatar ' + (isMe ? "avatar-teacher" : "avatar-student") + '" aria-hidden="true">' +
      (isMe ? AVATAR_TEACHER : AVATAR_STUDENT) + "</span>" +
      '<div class="msg-main"><div class="bubble">' + esc(m.content) + "</div>" + time + "</div>";
    chatBody.appendChild(el);
  }

  var lastTs = null;
  function appendMessage(m) {
    var same = lastTs != null && (m.created_at - lastTs) < 90;
    addMsg(m, !same);
    lastTs = m.created_at;
  }

  function markRead() {
    if (!convId) return;
    fetch("/api/teacher/msg/conversation/" + encodeURIComponent(convId) + "/read", { method: "POST" })
      .then(function (r) { return r.json(); })
      .catch(function () {});
  }

  function load() {
    if (!convId) {
      loadTip.textContent = "缺少会话参数，无法打开。";
      return;
    }
    fetch("/api/teacher/msg/conversation/" + encodeURIComponent(convId))
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.error) { loadTip.textContent = d.error; return; }
        var c = d.conversation || {};
        whoName.textContent = c.student_name || "学生";
        whoTag.textContent = "学生 · " + (c.student_class || "") + " · 倾诉者";
        chatBody.innerHTML = "";
        lastTs = null;
        (d.messages || []).forEach(appendMessage);
        if (!(d.messages || []).length) {
          loadTip.textContent = "还没有留言，学生倾诉后可在此发起对话。";
        }
        markRead();   // 打开即把学生发来的留言标为已读
        scrollToBottom();
        inputBox.focus();
      })
      .catch(function () { loadTip.textContent = "加载失败，请检查网络。"; });
  }

  function send() {
    var content = inputBox.value.trim();
    if (!content || !convId) return;
    sendBtn.disabled = true;
    fetch("/api/teacher/msg/conversation/" + encodeURIComponent(convId) + "/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: content })
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.error) { alert(d.error); return; }
        inputBox.value = "";
        inputBox.style.height = "auto";
        appendMessage(d.message);
        scrollToBottom();
      })
      .catch(function () { alert("回复失败，请重试。"); })
      .finally(function () { sendBtn.disabled = false; inputBox.focus(); });
  }

  sendBtn.addEventListener("click", send);
  inputBox.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  });
  inputBox.addEventListener("input", function () {
    inputBox.style.height = "auto";
    inputBox.style.height = Math.min(120, inputBox.scrollHeight) + "px";
  });

  load();
})();