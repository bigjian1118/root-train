// ===== 学生端：心理咨询预约 =====
(function () {
  "use strict";

  var slotList = document.getElementById("slotList");
  var slotEmpty = document.getElementById("slotEmpty");
  var apptList = document.getElementById("apptList");
  var apptEmpty = document.getElementById("apptEmpty");
  var bookMask = document.getElementById("bookMask");
  var bookSlot = document.getElementById("bookSlot");
  var bookReason = document.getElementById("bookReason");
  var bookMsg = document.getElementById("bookMsg");
  var pendingSlotId = null;

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  // 时间戳 -> 可读时间（秒级时间戳）
  function fmtTs(ts) {
    if (!ts) return "";
    return new Date(ts * 1000).toLocaleString("zh-CN", { hour12: false }).slice(0, 16);
  }

  // 预约状态：五态（中文标签严格对齐规格）
  var STATUS_CN = {
    pending: "⏳ 待审核",
    confirmed: "✅ 已通过",
    rejected: "❌ 已驳回",
    cancelled: "🚫 学生取消",
    done: "🎉 已完成"
  };
  var STATUS_CLS = {
    pending: "st-pending",
    confirmed: "st-confirmed",
    rejected: "st-rejected",
    cancelled: "st-cancelled",
    done: "st-done"
  };

  // ---- 可约时段列表 ----
  function renderSlots(slots) {
    slotList.innerHTML = "";
    slotEmpty.hidden = slots.length > 0;
    slots.forEach(function (s) {
      // 满额判断：remaining <= 0 即满员
      var full = (s.remaining || 0) <= 0;
      var slotCard = document.createElement("div");
      slotCard.className = "slot-card" + (full ? " is-full" : "");
      slotCard.innerHTML =
        '<div class="slot-info">' +
          '<span class="slot-teacher">👩‍🏫 ' + esc(s.teacher_name) + "</span>" +
          '<span class="slot-time">📅 ' + esc(s.date) + " " + esc(s.time_slot) + "</span>" +
          '<span class="slot-remain">剩余 ' + esc(s.remaining) + "/" + esc(s.max_capacity) + " 个名额</span>" +
          (s.note ? '<span class="slot-note">💬 ' + esc(s.note) + "</span>" : "") +
        "</div>" +
        (full
          ? '<button class="btn-book" disabled>已满员</button>'
          : '<button class="btn-book" data-id="' + esc(s.id) + '" data-text="' +
            esc(s.date + " " + s.time_slot + " · " + s.teacher_name) + '">预约</button>');
      slotList.appendChild(slotCard);
    });
    slotList.querySelectorAll(".btn-book:not([disabled])").forEach(function (btn) {
      btn.addEventListener("click", function () {
        pendingSlotId = btn.dataset.id;
        bookSlot.textContent = "📅 " + btn.dataset.text;
        bookReason.value = "";
        bookMsg.hidden = true;
        bookMask.hidden = false;
      });
    });
  }

  function loadSlots() {
    fetch("/api/student/appointment/slots")
      .then(function (r) { return r.json(); })
      .then(function (d) { renderSlots(d.slots || []); })
      .catch(function () { slotEmpty.hidden = false; slotEmpty.textContent = "加载时段失败，请稍后重试。"; });
  }

  // ---- 我的预约 ----
  function renderAppts(appts) {
    apptList.innerHTML = "";
    apptEmpty.hidden = appts.length > 0;
    appts.forEach(function (a) {
      var item = document.createElement("div");
      item.className = "appt-item";
      item.innerHTML =
        '<div class="appt-main">' +
          '<span class="appt-who">👩‍🏫 ' + esc(a.teacher_name) + "</span>" +
          '<span class="appt-time">📅 ' + esc(a.date) + " " + esc(a.time_slot) + "</span>" +
          '<span class="status ' + (STATUS_CLS[a.status] || "") + '">' +
            (STATUS_CN[a.status] || esc(a.status)) + "</span>" +
        "</div>" +
        (a.reason ? '<p class="appt-reason">事由：' + esc(a.reason) + "</p>" : "") +
        (a.reply ? '<p class="appt-reply">教师回复：' + esc(a.reply) + "</p>" : "") +
        '<div class="appt-ops">' +
          '<button class="btn-detail" data-id="' + esc(a.id) + '">查看详情</button>' +
          (a.status === "pending"
            ? '<button class="btn-cancel-link" data-id="' + esc(a.id) + '">取消预约</button>'
            : "") +
        "</div>";
      apptList.appendChild(item);
    });
    // 详情弹窗：查看教师审批结果 / 驳回备注
    apptList.querySelectorAll(".btn-detail").forEach(function (btn) {
      btn.addEventListener("click", function () {
        openDetail(appts.find(function (x) { return x.id === btn.dataset.id; }));
      });
    });
    apptList.querySelectorAll(".btn-cancel-link").forEach(function (btn) {
      btn.addEventListener("click", function () {
        if (!confirm("确定取消这条预约吗？")) return;
        fetch("/api/student/appointment/" + encodeURIComponent(btn.dataset.id),
          { method: "DELETE" })
          .then(function (r) { return r.json(); })
          .then(function (d) {
            if (d.ok) { loadAppts(); loadSlots(); }
            else { alert(d.error || "取消失败"); }
          });
      });
    });
  }

  // ---- 预约详情弹窗 ----
  var detailMask = document.getElementById("detailMask");
  var detailBody = document.getElementById("detailBody");

  function openDetail(a) {
    if (!a) return;
    var st = STATUS_CN[a.status] || a.status;
    detailBody.innerHTML =
      '<div class="detail-row"><span class="detail-label">教师</span>' +
        '<span>' + esc(a.teacher_name) + "</span></div>" +
      '<div class="detail-row"><span class="detail-label">预约时间</span>' +
        '<span>' + esc(a.date) + " " + esc(a.time_slot) + "</span></div>" +
      '<div class="detail-row"><span class="detail-label">当前状态</span>' +
        '<span class="status ' + (STATUS_CLS[a.status] || "") + '">' + esc(st) + "</span></div>" +
      '<div class="detail-row"><span class="detail-label">提交时间</span>' +
        '<span>' + esc(fmtTs(a.created_at)) + "</span></div>" +
      '<div class="detail-row"><span class="detail-label">预约事由</span>' +
        '<span>' + (a.reason ? esc(a.reason) : "未填写") + "</span></div>" +
      '<div class="detail-row"><span class="detail-label">教师审批结果</span>' +
        '<span>' + (a.status === "rejected" ? "❌ 已驳回" :
                     a.status === "confirmed" || a.status === "done" ? "✅ 已通过" :
                     a.status === "pending" ? "⏳ 等待教师审批" : "🚫 学生取消") + "</span></div>" +
      '<div class="detail-row"><span class="detail-label">教师备注</span>' +
        '<span>' + (a.reply ? esc(a.reply) : "暂无备注") + "</span></div>";
    detailMask.hidden = false;
  }

  detailMask.addEventListener("click", function (e) {
    if (e.target === detailMask) detailMask.hidden = true;
  });
  document.getElementById("detailClose").addEventListener("click", function () {
    detailMask.hidden = true;
  });

  function loadAppts() {
    fetch("/api/student/appointments")
      .then(function (r) { return r.json(); })
      .then(function (d) { renderAppts(d.appointments || []); })
      .catch(function () { apptEmpty.hidden = false; apptEmpty.textContent = "加载预约失败，请稍后重试。"; });
  }

  // ---- 提交预约 ----
  bookMask.addEventListener("click", function (e) {
    if (e.target === bookMask) bookMask.hidden = true;
  });
  document.getElementById("bookCancel").addEventListener("click", function () {
    bookMask.hidden = true;
  });
  document.getElementById("bookConfirm").addEventListener("click", function () {
    if (!pendingSlotId) return;
    bookMsg.hidden = true;
    fetch("/api/student/appointment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slot_id: pendingSlotId, reason: bookReason.value.trim() })
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.ok) {
          bookMask.hidden = true;
          loadSlots(); loadAppts();
        } else {
          bookMsg.hidden = false;
          bookMsg.textContent = d.error || "预约失败";
        }
      })
      .catch(function () {
        bookMsg.hidden = false;
        bookMsg.textContent = "网络错误，请重试";
      });
  });

  loadSlots();
  loadAppts();
})();