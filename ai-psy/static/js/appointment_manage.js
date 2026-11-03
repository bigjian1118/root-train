// ===== 教师端：心理咨询预约管理（教师=咨询师） =====
(function () {
  "use strict";

  var slotDate = document.getElementById("slotDate");
  var slotStart = document.getElementById("slotStart");
  var slotEnd = document.getElementById("slotEnd");
  var slotCapacity = document.getElementById("slotCapacity");
  var slotNote = document.getElementById("slotNote");
  var slotMsg = document.getElementById("slotMsg");
  var slotList = document.getElementById("slotList");
  var apptList = document.getElementById("apptList");

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function fmtTs(ts) {
    if (!ts) return "";
    return new Date(ts * 1000).toLocaleString("zh-CN", { hour12: false }).slice(0, 16);
  }
  // 预约状态：五态（中文标签严格对齐规格）
  var apptStatus = {
    pending: ["⏳ 待审核", "st-pending"],
    confirmed: ["✅ 已通过", "st-confirmed"],
    rejected: ["❌ 已驳回", "st-rejected"],
    cancelled: ["🚫 学生取消", "st-cancelled"],
    done: ["🎉 已完成", "st-done"]
  };

  // ---- 添加时段 ----
  document.getElementById("slotAdd").addEventListener("click", function () {
    var date = slotDate.value.trim();
    var start = slotStart.value.trim();
    var end = slotEnd.value.trim();
    var capacity = slotCapacity.value.trim();
    slotMsg.hidden = true;
    if (!date || !start || !end) {
      slotMsg.hidden = false; slotMsg.textContent = "请选择日期和开始/结束时间";
      return;
    }
    if (start >= end) {
      slotMsg.hidden = false; slotMsg.textContent = "结束时间需晚于开始时间";
      return;
    }
    // 最大预约人数：缺省按 1，必须是 >=1 的整数
    if (!capacity) capacity = "1";
    if (!/^\d+$/.test(capacity) || parseInt(capacity, 10) < 1) {
      slotMsg.hidden = false; slotMsg.textContent = "最大预约人数需为 >=1 的整数";
      return;
    }
    fetch("/api/teacher/appointment/slots", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        date: date, start_time: start, end_time: end,
        max_capacity: parseInt(capacity, 10), note: slotNote.value.trim()
      })
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.ok) { slotNote.value = ""; slotCapacity.value = ""; loadSlots(); }
        else { slotMsg.hidden = false; slotMsg.textContent = d.error || "添加失败"; }
      });
  });

  // ---- 我的时段 ----
  function loadSlots() {
    fetch("/api/teacher/appointment/slots")
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var slots = d.slots || [];
        slotList.innerHTML = "";
        if (!slots.length) { slotList.innerHTML = '<p class="empty-tip">你还没有排可约时段。</p>'; return; }
        slots.forEach(function (s) {
          var row = document.createElement("div");
          row.className = "slot-item";
          // 名额剩余：满员时显示置灰状态
          var full = (s.max_capacity - s.current_count) <= 0;
          row.innerHTML =
            '<span class="slot-date">' + esc(s.date) + "</span>" +
            '<span class="slot-time">' + esc(s.time_slot) + "</span>" +
            '<span class="slot-cap">已约 ' + esc(s.current_count) + "/" +
              esc(s.max_capacity) + " · 剩 " + esc(s.max_capacity - s.current_count) + "</span>" +
            (s.note ? '<span class="slot-note">' + esc(s.note) + "</span>" : "") +
            '<span class="status ' + (full ? "st-taken" : "st-open") + '">' +
              (full ? "已满员" : "可约") + "</span>" +
            '<div class="slot-ops">' +
              '<button class="btn-edit" data-id="' + esc(s.id) + '">编辑</button>' +
              '<button class="btn-del" data-id="' + esc(s.id) + '">作废</button>' +
            "</div>";
          slotList.appendChild(row);
        });
        slotList.querySelectorAll(".btn-del").forEach(function (b) {
          b.addEventListener("click", function () {
            if (!confirm("确定作废该时段吗？若已被预约会一并取消。")) return;
            fetch("/api/teacher/appointment/slots/" + encodeURIComponent(b.dataset.id),
              { method: "DELETE" })
              .then(function (r) { return r.json(); })
              .then(function (d) { if (d.ok) { loadSlots(); loadAppts(); } else alert(d.error || "作废失败"); });
          });
        });
        // 编辑按钮：打开弹窗并回填当前时段信息
        slotList.querySelectorAll(".btn-edit").forEach(function (b) {
          b.addEventListener("click", function () {
            openEditModal(b.dataset.id, slots.find(function (x) { return x.id === b.dataset.id; }));
          });
        });
      });
  }

  // ---- 编辑时段弹窗 ----
  var editMask = document.getElementById("editMask");
  var eDate = document.getElementById("edtDate");
  var eStart = document.getElementById("edtStart");
  var eEnd = document.getElementById("edtEnd");
  var eCapacity = document.getElementById("edtCapacity");
  var eNote = document.getElementById("edtNote");
  var editMsg = document.getElementById("edtMsg");
  var editingId = null;

  function openEditModal(id, slot) {
    editingId = id;
    eDate.value = slot.date;
    eStart.value = slot.start_time || "";
    eEnd.value = slot.end_time || "";
    eCapacity.value = slot.max_capacity;
    eNote.value = slot.note || "";
    editMsg.hidden = true;
    editMask.hidden = false;
  }

  editMask.addEventListener("click", function (e) { if (e.target === editMask) editMask.hidden = true; });
  document.getElementById("edtCancel").addEventListener("click", function () { editMask.hidden = true; });
  document.getElementById("edtSave").addEventListener("click", function () {
    if (!editingId) return;
    editMsg.hidden = true;
    fetch("/api/teacher/appointment/slots/" + encodeURIComponent(editingId), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        date: eDate.value.trim(),
        start_time: eStart.value.trim(),
        end_time: eEnd.value.trim(),
        max_capacity: eCapacity.value.trim() || "1",
        note: eNote.value.trim()
      })
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.ok) { editMask.hidden = true; loadSlots(); loadAppts(); }
        else { editMsg.hidden = false; editMsg.textContent = d.error || "保存失败"; }
      });
  });

  // ---- 收到的预约申请 ----
  function loadAppts() {
    // 按当前选择的状态筛选拉取
    var status = document.getElementById("statusFilter").value;
    fetch("/api/teacher/appointments?status=" + encodeURIComponent(status))
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var apps = d.appointments || [];
        apptList.innerHTML = "";
        // 新预约红色角标：统计待审核数量（全量时才有意义，过滤视图下用过滤结果数）
        var pendingCount = apps.filter(function (x) { return x.status === "pending"; }).length;
        var alertEl = document.getElementById("newAlert");
        var countEl = document.getElementById("newCount");
        if (pendingCount > 0) {
          countEl.textContent = pendingCount;
          alertEl.hidden = false;
          document.title = "(" + pendingCount + ") 预约管理";
        } else {
          alertEl.hidden = true;
          document.title = "预约管理";
        }
        if (!apps.length) { apptList.innerHTML = '<p class="empty-tip">没有符合条件的预约。</p>'; return; }
        apps.forEach(function (a) {
          var tag = apptStatus[a.status] || [esc(a.status), ""];
          var row = document.createElement("div");
          // 待审核的新预约：高亮卡片（红边 + 红点标记），一眼识别未处理申请
          row.className = "appt-item" + (a.status === "pending" ? " appt-new" : "");
          row.innerHTML =
            '<div class="appt-head">' +
              "<span><b>" + esc(a.student_name) + "</b>（" + esc(a.student_class) + "）</span>" +
              '<span class="appt-time">' + esc(a.date) + " " + esc(a.time_slot) + "</span>" +
              '<span class="status ' + tag[1] + '">' + tag[0] + "</span>" +
            "</div>" +
            (a.reason ? '<p class="appt-reason">事由：' + esc(a.reason) + "</p>" : "") +
            (a.reply ? '<p class="appt-reply">回复：' + esc(a.reply) + "</p>" : "") +
            (a.status === "pending"
              ? '<div class="appt-ops">' +
                  '<button class="btn-agree" data-id="' + esc(a.id) + '">✅ 同意</button>' +
                  '<button class="btn-reject" data-id="' + esc(a.id) + '">驳回</button>' +
                "</div>"
              : a.status === "confirmed"
              ? '<div class="appt-ops">' +
                  '<button class="btn-done" data-id="' + esc(a.id) + '">🎉 标记完成</button>' +
                "</div>"
              : "");
          apptList.appendChild(row);
        });
        // 同意：直接提交；驳回：弹出必填原因窗口
        apptList.querySelectorAll(".btn-agree").forEach(function (b) {
          b.addEventListener("click", function () {
            fetch("/api/teacher/appointment/" + encodeURIComponent(b.dataset.id) + "/decide", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ action: "confirm", reply: "" })
            })
              .then(function (r) { return r.json(); })
              .then(function (d) { if (d.ok) { loadAppts(); loadSlots(); } else alert(d.error || "处理失败"); });
          });
        });
        apptList.querySelectorAll(".btn-reject").forEach(function (b) {
          b.addEventListener("click", function () {
            openRejectModal(b.dataset.id);
          });
        });
        // 标记完成：咨询结束后教师把已通过预约置为已完成
        apptList.querySelectorAll(".btn-done").forEach(function (b) {
          b.addEventListener("click", function () {
            if (!confirm("确认该次咨询已完成？")) return;
            fetch("/api/teacher/appointment/" + encodeURIComponent(b.dataset.id) + "/decide", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ action: "complete", reply: "" })
            })
              .then(function (r) { return r.json(); })
              .then(function (d) { if (d.ok) { loadAppts(); loadSlots(); } else alert(d.error || "操作失败"); });
          });
        });
      });
  }

  // ---- 驳回预约弹窗：必须填写驳回原因 ----
  var rejectMask = document.getElementById("rejectMask");
  var rjText = document.getElementById("rjText");
  var rjMsg = document.getElementById("rjMsg");
  var rejectingId = null;

  function openRejectModal(id) {
    rejectingId = id;
    rjText.value = "";
    rjMsg.hidden = true;
    rejectMask.hidden = false;
    rjText.focus();
  }

  rejectMask.addEventListener("click", function (e) { if (e.target === rejectMask) rejectMask.hidden = true; });
  document.getElementById("rjCancel").addEventListener("click", function () { rejectMask.hidden = true; });
  document.getElementById("rjSave").addEventListener("click", function () {
    if (!rejectingId) return;
    var reason = rjText.value.trim();
    rjMsg.hidden = true;
    if (!reason) { rjMsg.hidden = false; rjMsg.textContent = "请填写驳回原因"; return; }
    fetch("/api/teacher/appointment/" + encodeURIComponent(rejectingId) + "/decide", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "reject", reply: reason })
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.ok) { rejectMask.hidden = true; loadAppts(); loadSlots(); }
        else { rjMsg.hidden = false; rjMsg.textContent = d.error || "驳回失败"; }
      });
  });

  // 状态筛选下拉：切换即重新加载预约列表
  document.getElementById("statusFilter").addEventListener("change", loadAppts);

  // ---- 历史台账 ----
  var ledgerList = document.getElementById("ledgerList");

  function loadLedger() {
    fetch("/api/teacher/appointments?status=all")
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var apps = d.appointments || [];
        ledgerList.innerHTML = "";
        if (!apps.length) { ledgerList.innerHTML = '<p class="empty-tip">暂无历史预约记录。</p>'; return; }
        apps.forEach(function (a) {
          var tag = apptStatus[a.status] || [esc(a.status), ""];
          var row = document.createElement("div");
          row.className = "ledger-item";
          row.innerHTML =
            '<div class="ledger-head">' +
              "<span><b>" + esc(a.student_name) + "</b>（" + esc(a.student_class) + "）</span>" +
              '<span class="appt-time">' + esc(a.date) + " " + esc(a.time_slot) + "</span>" +
              '<span class="status ' + tag[1] + '">' + tag[0] + "</span>" +
            "</div>" +
            (a.reason ? '<p class="appt-reason">事由：' + esc(a.reason) + "</p>" : "") +
            (a.reply ? '<p class="appt-reply">处理备注：' + esc(a.reply) + "</p>" : "") +
            '<p class="ledger-times">提交：' + esc(fmtTs(a.created_at)) +
              (a.teacher_time ? " ｜ 处理： " + esc(fmtTs(a.teacher_time)) : "") + "</p>";
          ledgerList.appendChild(row);
        });
      });
  }

  // Tab 切换：审批处理 / 历史台账
  document.querySelectorAll(".tab-btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      document.querySelectorAll(".tab-btn").forEach(function (x) { x.classList.remove("active"); });
      btn.classList.add("active");
      var pane = btn.dataset.tab;
      document.getElementById("approvePane").hidden = pane !== "approve";
      document.getElementById("ledgerPane").hidden = pane !== "ledger";
      if (pane === "ledger") loadLedger();
      else loadAppts();
    });
  });

  loadSlots();
  loadAppts();
})();