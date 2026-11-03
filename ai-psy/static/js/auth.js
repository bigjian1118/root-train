// ===== 全站登录守卫：未登录跳转独立登录页 /login；已登录显示右上角用户徽章 =====
(function () {
  "use strict";

  // 注入徽章样式（仅顶栏用户信息，登录页样式见 login.css）
  var style = document.createElement("style");
  style.textContent = [
    "[hidden]{display:none !important;}",
    ".auth-badge{position:fixed;top:18px;right:20px;z-index:9999;display:flex;align-items:center;gap:10px;",
    "background:rgba(255,255,255,.92);border:2px solid #d8efe1;border-radius:999px;padding:6px 8px 6px 16px;",
    "font-size:13px;color:#274a38;box-shadow:0 4px 14px rgba(63,158,110,.12);cursor:grab;",
    "user-select:none;-webkit-user-select:none;touch-action:none;}",
    ".auth-badge.auth-dragging{cursor:grabbing;}",
    ".auth-badge .who b{color:#3f9e6e;}",
    ".auth-badge button{border:none;background:#eef7f1;color:#3f9e6e;border-radius:999px;padding:5px 12px;",
    "font-size:12px;cursor:pointer;}",
    ".auth-badge button:hover{background:#ddefe3;}",
    ".auth-badge .auth-logout{text-decoration:none;color:#274a38;font-size:13px;padding:2px 2px;}",
    ".auth-badge .auth-logout:hover{color:#3f9e6e;text-decoration:underline;}",
  ].join("");
  document.head.appendChild(style);

  var badge = document.createElement("div");
  badge.className = "auth-badge";
  badge.hidden = true;
  // 悬浮窗形态：脱离文档流，固定挂在 body 上（默认右上角），全页面统一
  document.body.appendChild(badge);

  // ---------- 可拖动悬浮窗：按住任意区域拖动，视口内自由移动，释放不回弹 ----------
  (function () {
    var dragging = false, moved = false, startX = 0, startY = 0, origLeft = 0, origTop = 0;
    function swallowClick(e) { e.stopPropagation(); e.preventDefault(); }
    badge.addEventListener("mousedown", function (e) {
      if (e.button !== 0) return;
      dragging = true; moved = false;
      var r = badge.getBoundingClientRect();
      // 切换为 left/top 锚定，避免 right 锚定时拖动跳位
      badge.style.left = r.left + "px";
      badge.style.top = r.top + "px";
      badge.style.right = "auto";
      startX = e.clientX; startY = e.clientY;
      origLeft = r.left; origTop = r.top;
      badge.classList.add("auth-dragging");
      e.preventDefault();
    });
    document.addEventListener("mousemove", function (e) {
      if (!dragging) return;
      var dx = e.clientX - startX, dy = e.clientY - startY;
      if (!moved && Math.abs(dx) + Math.abs(dy) > 3) moved = true;
      if (!moved) return;
      var x = Math.min(Math.max(origLeft + dx, 0), window.innerWidth - badge.offsetWidth);
      var y = Math.min(Math.max(origTop + dy, 0), window.innerHeight - badge.offsetHeight);
      badge.style.left = x + "px";
      badge.style.top = y + "px";
    });
    document.addEventListener("mouseup", function () {
      if (!dragging) return;
      dragging = false;
      badge.classList.remove("auth-dragging");
      if (moved) {
        // 拖动结束时吞掉紧随的 click，防止误触「个人中心 / 退出」
        badge.addEventListener("click", swallowClick, true);
        setTimeout(function () { badge.removeEventListener("click", swallowClick, true); }, 0);
      }
    });
  })();

  function renderBadge(user) {
    badge.hidden = false;
    var roleName = user.role === "teacher" ? "" : "";
    // 个人中心页自身不显示"个人中心"回跳按钮，避免重复
    var onProfile = location.pathname === "/profile";
    badge.innerHTML =
      '<span class="who">你好，<b>' + user.name + "</b>" + roleName + "</span>" +
      (onProfile ? "" : '<button type="button" id="authProfile">🏠 个人中心</button>') +
      '<a href="#" id="authLogout" class="auth-logout">退出</a>';
    var profileBtn = badge.querySelector("#authProfile");
    if (profileBtn) {
      profileBtn.addEventListener("click", function () {
        location.href = "/profile";
      });
    }
    badge.querySelector("#authLogout").addEventListener("click", function (e) {
      e.preventDefault();
      fetch("/api/auth/logout", { method: "POST" }).then(function () {
        location.href = "/login";
      });
    });
    // 按角色显示首页专属入口窗口：教师=班级报告管理，学生=我的报告
    var zoneId = user.role === "teacher" ? "teacherZone" : "studentZone";
    var zone = document.getElementById(zoneId);
    if (zone) zone.hidden = false;
    // 教师角色：隐藏学生专属功能入口（聊天 / 视频分析 / 测评；页面与 API 已同步拦截）
    if (user.role === "teacher") {
      document.querySelectorAll(".student-feature").forEach(function (el) {
        el.hidden = true;
      });
    }
    // 教师专属入口（预约管理）：仅教师显示，非教师隐藏
    var isTeacher = user.role === "teacher";
    document.querySelectorAll(".teacher-feature").forEach(function (el) {
      el.hidden = !isTeacher;
    });
  }

  // 进入页面即校验登录态：未登录跳转登录页，并用 next 记住当前页面
  fetch("/api/auth/me")
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (d.logged_in && d.user) {
        renderBadge(d.user);
      } else {
        location.replace("/login?next=" + encodeURIComponent(location.pathname + location.search));
      }
    })
    .catch(function () {
      // 后端不可达时不跳转，避免登录页死循环，让页面自身接口报错提示
      badge.hidden = true;
    });
})();
