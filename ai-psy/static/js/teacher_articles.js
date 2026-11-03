// 教师端心理科普文章管理：列表 + 新建/编辑弹窗 + 删除二次确认
// 接口仅教师可用（后端 _require_teacher 403 守卫）；数据落 psy.db articles 表，学生端刷新自动同步。
// 内置 seed 文章（id 以 seed- 开头）只读展示，不可编辑/删除。
(function () {
  "use strict";

  var table = document.getElementById("artTable");
  var emptyTip = document.getElementById("emptyTip");
  var pager = document.getElementById("pager");
  var prevPage = document.getElementById("prevPage");
  var nextPage = document.getElementById("nextPage");
  var pageInfo = document.getElementById("pageInfo");
  var createBtn = document.getElementById("createBtn");

  var editModal = document.getElementById("editModal");
  var editModalTitle = document.getElementById("editModalTitle");
  var editForm = document.getElementById("editForm");
  var editClose = document.getElementById("editClose");
  var editCancel = document.getElementById("editCancel");
  var editSubmit = document.getElementById("editSubmit");
  var artTitle = document.getElementById("artTitle");
  var artSource = document.getElementById("artSource");
  var artSummary = document.getElementById("artSummary");
  var artContent = document.getElementById("artContent");

  var confirmModal = document.getElementById("confirmModal");
  var confirmText = document.getElementById("confirmText");
  var confirmClose = document.getElementById("confirmClose");
  var confirmCancel = document.getElementById("confirmCancel");
  var confirmOk = document.getElementById("confirmOk");

  var toast = document.getElementById("toast");

  var state = { page: 1, pageSize: 10, total: 0 };
  var editingId = null;        // 当前编辑的文章 id（null = 新建）
  var pendingDeleteId = null;  // 待删除的文章 id

  function showToast(text) {
    toast.textContent = text;
    toast.hidden = false;
    setTimeout(function () { toast.hidden = true; }, 3200);
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function fmtDate(ts) {
    if (!ts) return "—";
    var d = new Date(ts * 1000);
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" +
      String(d.getDate()).padStart(2, "0") + " " +
      String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  }

  function isBuiltin(id) { return String(id).indexOf("seed-") === 0; }

  // ---------- 1. 列表 ----------
  function loadList() {
    table.innerHTML = '<div class="loading">加载中…</div>';
    emptyTip.hidden = true;
    fetch("/api/teacher/articles?page=" + state.page + "&page_size=" + state.pageSize)
      .then(function (r) {
        if (r.status === 403) { throw new Error("仅教师账号可管理心理科普文章"); }
        if (r.status === 401) { throw new Error("登录已失效，请刷新页面重新登录"); }
        return r.json();
      })
      .then(function (d) {
        if (d.error) { throw new Error(d.error); }
        state.total = d.total || 0;
        renderList(d.articles || []);
        renderPager();
      })
      .catch(function (e) {
        table.innerHTML = '<div class="loading">' + escapeHtml(e.message) + "</div>";
      });
  }

  function renderList(list) {
    table.innerHTML = "";
    if (!list.length) {
      emptyTip.hidden = false;
      return;
    }
    list.forEach(function (a) {
      var builtin = isBuiltin(a.id);
      var row = document.createElement("div");
      row.className = "art-row";
      row.innerHTML =
        '<div class="art-info">' +
          '<div class="art-title-line">' +
            '<span class="art-title">' + escapeHtml(a.title) + "</span>" +
            (builtin
              ? '<span class="art-tag builtin">系统内置</span>'
              : '<span class="art-tag">教师发布</span>') +
          "</div>" +
          '<div class="art-meta">' +
            "来源：" + escapeHtml(a.source || "系统默认权威来源") +
            (a.author ? " · 发布人：" + escapeHtml(a.author) : "") +
            " · 发布于 " + fmtDate(a.created_at) +
            (a.updated_at ? " · 更新于 " + fmtDate(a.updated_at) : "") +
          "</div>" +
        "</div>" +
        '<div class="art-ops">' +
          '<button type="button" class="btn btn-ghost" data-edit' +
          (builtin ? " disabled title='内置文章不可编辑'" : "") + ">编辑</button>" +
          '<button type="button" class="btn btn-danger-ghost" data-del' +
          (builtin ? " disabled title='内置文章不可删除'" : "") + ">删除</button>" +
        "</div>";
      if (!builtin) {
        row.querySelector("[data-edit]").addEventListener("click", function () { openEdit(a); });
        row.querySelector("[data-del]").addEventListener("click", function () { askDelete(a); });
      }
      table.appendChild(row);
    });
  }

  function renderPager() {
    var pages = Math.max(1, Math.ceil(state.total / state.pageSize));
    if (state.total === 0) { pager.hidden = true; return; }
    pager.hidden = false;
    pageInfo.textContent = "第 " + state.page + " / " + pages + " 页 · 共 " + state.total + " 篇文章";
    prevPage.disabled = state.page <= 1;
    nextPage.disabled = state.page >= pages;
  }

  prevPage.addEventListener("click", function () {
    if (state.page > 1) { state.page -= 1; loadList(); }
  });
  nextPage.addEventListener("click", function () {
    var pages = Math.max(1, Math.ceil(state.total / state.pageSize));
    if (state.page < pages) { state.page += 1; loadList(); }
  });

  // ---------- 2. 新建 / 编辑弹窗 ----------
  function autoGrow() {
    artContent.style.height = "auto";
    artContent.style.height = Math.min(artContent.scrollHeight + 2, 520) + "px";
  }
  artContent.addEventListener("input", autoGrow);

  function openCreate() {
    editingId = null;
    editModalTitle.textContent = "＋ 新建文章";
    editForm.reset();
    editSubmit.disabled = false;
    editSubmit.textContent = "保存";
    editModal.hidden = false;
    autoGrow();
    artTitle.focus();
  }

  function openEdit(a) {
    editingId = a.id;
    editModalTitle.textContent = "✏️ 编辑文章";
    artTitle.value = a.title || "";
    artSource.value = a.source || "";
    artSummary.value = a.summary || "";
    artContent.value = a.content || "";
    editSubmit.disabled = false;
    editSubmit.textContent = "保存";
    editModal.hidden = false;
    autoGrow();
  }

  function closeEdit() {
    editModal.hidden = true;
    editingId = null;
  }

  createBtn.addEventListener("click", openCreate);
  editClose.addEventListener("click", closeEdit);
  editCancel.addEventListener("click", closeEdit);
  editModal.addEventListener("click", function (e) { if (e.target === editModal) { closeEdit(); } });

  editForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var title = artTitle.value.trim();
    var content = artContent.value.trim();
    if (!title) { showToast("请填写文章标题"); artTitle.focus(); return; }
    if (!content) { showToast("请填写文章正文"); artContent.focus(); return; }

    var payload = {
      title: title,
      source: artSource.value.trim(),
      summary: artSummary.value.trim(),
      content: content,
    };
    var url = editingId ? "/api/teacher/articles/" + encodeURIComponent(editingId) : "/api/teacher/articles";
    var method = editingId ? "PUT" : "POST";

    editSubmit.disabled = true;
    editSubmit.textContent = "保存中…";
    fetch(url, {
      method: method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then(function (r) {
        if (r.status === 403) { throw new Error("仅教师账号可管理心理科普文章"); }
        return r.json().then(function (d) { return { ok: r.ok, d: d }; });
      })
      .then(function (res) {
        if (!res.ok || res.d.error) { throw new Error(res.d.error || "保存失败"); }
        var wasCreate = !editingId;
        showToast(wasCreate ? "文章发布成功，学生端刷新即可看到" : "文章已更新，学生端刷新即可看到");
        closeEdit();
        if (wasCreate) { state.page = 1; }
        loadList();
      })
      .catch(function (err) {
        editSubmit.disabled = false;
        editSubmit.textContent = "保存";
        showToast(err.message || "保存失败，请重试");
      });
  });

  // ---------- 3. 删除二次确认 ----------
  function askDelete(a) {
    pendingDeleteId = a.id;
    confirmText.textContent = "确定要删除文章《" + a.title + "》吗？删除后学生端将不再展示，且不可恢复。";
    confirmModal.hidden = false;
  }
  function closeConfirm() {
    confirmModal.hidden = true;
    pendingDeleteId = null;
  }
  confirmClose.addEventListener("click", closeConfirm);
  confirmCancel.addEventListener("click", closeConfirm);
  confirmModal.addEventListener("click", function (e) { if (e.target === confirmModal) { closeConfirm(); } });

  confirmOk.addEventListener("click", function () {
    if (!pendingDeleteId) { return; }
    var id = pendingDeleteId;
    confirmOk.disabled = true;
    fetch("/api/teacher/articles/" + encodeURIComponent(id), { method: "DELETE" })
      .then(function (r) {
        if (r.status === 403) { throw new Error("系统内置文章不可删除"); }
        return r.json().then(function (d) { return { ok: r.ok, d: d }; });
      })
      .then(function (res) {
        if (!res.ok || res.d.error) { throw new Error(res.d.error || "删除失败"); }
        showToast("文章已删除");
        closeConfirm();
        loadList();
      })
      .catch(function (err) { showToast(err.message || "删除失败，请重试"); })
      .finally(function () { confirmOk.disabled = false; });
  });

  // ---------- 初始化 ----------
  loadList();
})();
