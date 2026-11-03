// ===== 学生端：我的倾诉会话列表（按最新消息排序，未读红点提示） =====
(function () {
  "use strict";

  var convList = document.getElementById("convList");
  var emptyTip = document.getElementById("emptyTip");

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  // 秒级时间戳 -> 最近显示的简短时间
  function fmtTime(ts) {
    if (!ts) return "";
    var d = new Date(ts * 1000);
    var now = new Date();
    var sameDay = d.toDateString() === now.toDateString();
    var hm = ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2);
    if (sameDay) return hm;
    return (d.getMonth() + 1) + "/" + d.getDate();
  }

  function render(list) {
    convList.innerHTML = "";
    emptyTip.hidden = list.length > 0;
    list.forEach(function (c) {
      var item = document.createElement("a");
      item.className = "conv-item";
      item.href = "/msg/chat?conv=" + encodeURIComponent(c.id);
      // 列表预览：显示最后一条消息，无消息时用引导文案
      var preview = esc(c.last_message || "开始一段倾诉吧");
      // 红点语义 = 未读：学生进入详情浏览后自动标已读，红点即消失；
      // 老师有新的回复消息（is_read=0）时再次亮起。与是否被回复无关。
      var dot = c.unread > 0
        ? '<span class="unread-badge">' + (c.unread > 99 ? "99+" : c.unread) + "</span>"
        : "";
      item.innerHTML =
        '<span class="conv-avatar">🧑‍🏫</span>' +
        '<div class="conv-main">' +
          '<div class="conv-row">' +
            '<span class="conv-name">' + esc(c.teacher_name) + '</span>' +
            '<span class="conv-time">' + fmtTime(c.last_time) + "</span>" +
          "</div>" +
          '<div class="conv-preview">' + preview + "</div>" +
        "</div>" + dot;
      convList.appendChild(item);
    });
  }

  function load() {
    fetch("/api/student/msg/conversations")
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.error) { emptyTip.hidden = false; emptyTip.textContent = d.error; return; }
        render(d.conversations || []);
      })
      .catch(function () {
        emptyTip.hidden = false;
        emptyTip.textContent = "加载失败，请检查网络。";
      });
  }

  document.getElementById("newBtn").addEventListener("click", function () {
    location.href = "/msg/choose";
  });

  load();
})();