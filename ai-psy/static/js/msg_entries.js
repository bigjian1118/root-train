// ===== 首页 / 个人中心：师生倾诉入口 + 未读红点（按角色指向对应页面） =====
// 用法：目标页面元素加 data-msg-entry + data-href-student + data-href-teacher
//   + 可选 data-badge 子元素
(function () {
  "use strict";

  var els = document.querySelectorAll("[data-msg-entry]");
  if (!els.length) return;

  // 注入入口徽标样式
  var style = document.createElement("style");
  style.textContent = [
    ".msg-entry{position:relative;}",
    ".msg-badge{display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;",
    "padding:0 5px;border-radius:999px;background:#d9483e;color:#fff;font-size:11px;font-weight:600;",
    "vertical-align:middle;margin-left:4px;}",
    ".msg-entry.entry-card{position:relative;overflow:visible;}",
    ".entry-card .msg-badge{position:absolute;top:10px;right:12px;}",
  ].join("");
  document.head.appendChild(style);

  fetch("/api/msg/unread")
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (!d || d.error) return;
      var isTeacher = d.role === "teacher";
      var total = d.total || 0;
      els.forEach(function (el) {
        var href = isTeacher
          ? el.getAttribute("data-href-teacher")
          : el.getAttribute("data-href-student");
        // <a> 用 href；按钮/导航用 data-href（profile.js 代为跳转）
        if (el.tagName === "A") {
          if (href) el.href = href;
        } else {
          el.dataset.href = href;
        }
        el.hidden = false;
        var badge = el.querySelector("[data-badge]");
        if (badge) {
          if (total > 0) {
            badge.textContent = total > 99 ? "99+" : String(total);
            badge.hidden = false;
          } else {
            badge.hidden = true;
          }
        }
      });
    })
    .catch(function () {
      // 后端不可达时保底：仅放行入口，不加红点
      els.forEach(function (el) { el.hidden = false; });
    });
})();