// ===== 学生端：选择心理老师，发起倾诉会话 =====
(function () {
  "use strict";

  var teacherList = document.getElementById("teacherList");
  var emptyTip = document.getElementById("emptyTip");

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function render(teachers) {
    teacherList.innerHTML = "";
    emptyTip.hidden = teachers.length > 0;
    teachers.forEach(function (t) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "teacher-item";
      btn.dataset.id = t.id;
      btn.innerHTML =
        '<span class="conv-avatar">👩‍🏫</span>' +
        '<span class="teacher-main">' +
          '<span class="teacher-name">' + esc(t.name) + "</span>" +
          '<span class="teacher-class">' + esc(t.class || "") + "</span>" +
        "</span>" +
        '<span class="teacher-go">去倾诉 →</span>';
      teacherList.appendChild(btn);
    });
    teacherList.querySelectorAll(".teacher-item").forEach(function (btn) {
      btn.addEventListener("click", function () {
        start(btn.dataset.id);
      });
    });
  }

  function start(teacherId) {
    fetch("/api/student/msg/conversation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ teacher_id: teacherId })
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.error) { alert(d.error); return; }
        // 打开该会话的聊天页
        location.href = "/msg/chat?conv=" + encodeURIComponent(d.conversation.id);
      })
      .catch(function () { alert("发起失败，请重试。"); });
  }

  fetch("/api/student/msg/teachers")
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (d.error) { emptyTip.hidden = false; emptyTip.textContent = d.error; return; }
      render(d.teachers || []);
    })
    .catch(function () {
      emptyTip.hidden = false;
      emptyTip.textContent = "加载失败，请检查网络。";
    });
})();