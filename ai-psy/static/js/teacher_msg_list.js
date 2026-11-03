// ===== 教师端：学生倾诉留言列表（新留言高亮 + 未读数 + 班级标识） =====
(function () {
  "use strict";

  var convList = document.getElementById("convList");
  var emptyTip = document.getElementById("emptyTip");

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function fmtTime(ts) {
    if (!ts) return "";
    var d = new Date(ts * 1000);
    var now = new Date();
    var hm = ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2);
    if (d.toDateString() === now.toDateString()) return hm;
    return (d.getMonth() + 1) + "/" + d.getDate();
  }

  function render(list) {
    convList.innerHTML = "";
    emptyTip.hidden = list.length > 0;
    list.forEach(function (c) {
      var hasNew = c.unread > 0;
      // 红点语义 = 未读留言：教师进入详情浏览后自动标已读，红点即消失；
      // 收到学生新的追加留言（is_read=0）时再次亮起。与是否回复无关。
      var item = document.createElement("a");
      item.className = "conv-item" + (hasNew ? " has-new" : "");
      item.href = "/teacher/msg/chat?conv=" + encodeURIComponent(c.id);
      var dotOrCount = hasNew
        ? '<span class="unread-badge">' + (c.unread > 99 ? "99+" : c.unread) + "</span>"
        : "";
      item.innerHTML =
        '<span class="conv-avatar">🧑‍🎓</span>' +
        '<div class="conv-main">' +
          '<div class="conv-row">' +
            '<span class="conv-name">' + esc(c.student_name) + '</span>' +
            '<span class="class-tag">' + esc(c.student_class || "") + "</span>" +
            '<span class="conv-time">' + fmtTime(c.last_time) + "</span>" +
          "</div>" +
          '<div class="conv-preview">' + (hasNew ? "🟡 新留言 · " : "") +
            esc(c.last_message || "学生发来了一条留言") + "</div>" +
        "</div>" + dotOrCount;
      convList.appendChild(item);
    });
  }

  function load() {
    fetch("/api/teacher/msg/conversations")
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

  load();
})();