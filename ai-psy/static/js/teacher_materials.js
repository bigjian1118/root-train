// 教师端心理活动素材库：搜索 + 卡片列表 + 分页 + 详情弹窗 + 上传弹窗（文件二进制入库）
// 全部接口仅教师可用（后端 _require_teacher 403 守卫）；上传文件不落盘，直接存 activity_material.file_blob
(function () {
  "use strict";

  var grid = document.getElementById("matGrid");
  var emptyTip = document.getElementById("emptyTip");
  var pager = document.getElementById("pager");
  var prevPage = document.getElementById("prevPage");
  var nextPage = document.getElementById("nextPage");
  var pageInfo = document.getElementById("pageInfo");
  var searchInput = document.getElementById("searchInput");
  var searchClear = document.getElementById("searchClear");
  var categoryFilter = document.getElementById("categoryFilter");
  var uploadBtn = document.getElementById("uploadBtn");

  var uploadModal = document.getElementById("uploadModal");
  var uploadForm = document.getElementById("uploadForm");
  var uploadClose = document.getElementById("uploadClose");
  var uploadCancel = document.getElementById("uploadCancel");
  var uploadSubmit = document.getElementById("uploadSubmit");
  var matTitle = document.getElementById("matTitle");
  var matCategory = document.getElementById("matCategory");
  var matBrief = document.getElementById("matBrief");
  var filePick = document.getElementById("filePick");
  var filePickText = document.getElementById("filePickText");
  var matFile = document.getElementById("matFile");

  var detailModal = document.getElementById("detailModal");
  var detailBody = document.getElementById("detailBody");
  var detailDownload = document.getElementById("detailDownload");
  var detailClose = document.getElementById("detailClose");
  var detailCloseBtn = document.getElementById("detailCloseBtn");

  var toast = document.getElementById("toast");

  var state = { page: 1, pageSize: 8, q: "", category: "", total: 0 };

  function showToast(text) {
    toast.textContent = text;
    toast.hidden = false;
    setTimeout(function () { toast.hidden = true; }, 3200);
  }

  function fmtSize(n) {
    if (n >= 1024 * 1024) { return (n / 1024 / 1024).toFixed(2) + " MB"; }
    if (n >= 1024) { return (n / 1024).toFixed(1) + " KB"; }
    return n + " B";
  }

  // ---------- 1. 列表加载与渲染 ----------
  function loadList() {
    grid.innerHTML = '<div class="loading">加载中…</div>';
    emptyTip.hidden = true;
    var params = new URLSearchParams({
      page: state.page, page_size: state.pageSize,
      q: state.q, category: state.category,
    });
    fetch("/api/teacher/materials?" + params.toString())
      .then(function (r) {
        if (r.status === 403) { throw new Error("仅教师账号可访问素材库"); }
        if (r.status === 401) { throw new Error("登录已失效，请刷新页面重新登录"); }
        return r.json();
      })
      .then(function (d) {
        state.total = d.total || 0;
        renderList(d.materials || []);
        renderPager();
      })
      .catch(function (e) {
        grid.innerHTML = '<div class="loading">' + e.message + "</div>";
      });
  }

  function catClass(cat) {
    return { "团体活动方案": "cat-团体活动方案", "心理科普PPT": "cat-心理科普PPT" }[cat] || "";
  }

  function renderList(list) {
    grid.innerHTML = "";
    if (!list.length) {
      emptyTip.hidden = false;
      return;
    }
    list.forEach(function (m) {
      var card = document.createElement("div");
      card.className = "mat-card";
      card.innerHTML =
        '<div class="mat-top"><span class="mat-cat ' + catClass(m.category) + '">' + m.category + "</span></div>" +
        '<div class="mat-title">' + escapeHtml(m.title) + "</div>" +
        (m.brief ? '<div class="mat-brief">' + escapeHtml(m.brief) + "</div>" : "") +
        '<div class="mat-meta">📎 ' + escapeHtml(m.file_name) + " · 上传：" + escapeHtml(m.uploader_name) + " · " + m.upload_time + "</div>" +
        '<div class="mat-foot">' +
        '  <button type="button" class="btn btn-ghost" data-detail="' + m.material_id + '">查看详情</button>' +
        '  <a class="btn btn-primary" href="/api/teacher/materials/' + m.material_id + '/download">⬇ 下载</a>' +
        "</div>";
      card.querySelector("[data-detail]").addEventListener("click", function () { openDetail(m.material_id); });
      grid.appendChild(card);
    });
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function renderPager() {
    var pages = Math.max(1, Math.ceil(state.total / state.pageSize));
    if (state.total === 0) { pager.hidden = true; return; }
    pager.hidden = false;
    pageInfo.textContent = "第 " + state.page + " / " + pages + " 页 · 共 " + state.total + " 份素材";
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

  // 搜索（输入防抖 350ms）+ 分类筛选
  var searchTimer = null;
  searchInput.addEventListener("input", function () {
    searchClear.hidden = !searchInput.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function () {
      state.q = searchInput.value.trim();
      state.page = 1;
      loadList();
    }, 350);
  });
  searchClear.addEventListener("click", function () {
    searchInput.value = "";
    searchClear.hidden = true;
    state.q = "";
    state.page = 1;
    loadList();
  });
  categoryFilter.addEventListener("change", function () {
    state.category = categoryFilter.value;
    state.page = 1;
    loadList();
  });

  // ---------- 2. 上传素材 ----------
  uploadBtn.addEventListener("click", function () {
    uploadModal.hidden = false;
  });
  function closeUpload() {
    uploadModal.hidden = true;
    uploadForm.reset();
    matFile.value = "";
    filePick.classList.remove("has-file");
    filePickText.textContent = "📎 点击选择本地文件（支持 pdf / docx / pptx，不限大小）";
    uploadSubmit.disabled = false;
    uploadSubmit.textContent = "提交上传";
  }
  uploadClose.addEventListener("click", closeUpload);
  uploadCancel.addEventListener("click", closeUpload);

  filePick.addEventListener("click", function () { matFile.click(); });
  matFile.addEventListener("change", function () {
    var f = matFile.files[0];
    if (!f) { return; }
    var ext = f.name.slice(f.name.lastIndexOf(".")).toLowerCase();
    if ([".pdf", ".docx", ".pptx"].indexOf(ext) === -1) {
      matFile.value = "";
      filePick.classList.remove("has-file");
      filePickText.textContent = "📎 点击选择本地文件（支持 pdf / docx / pptx，不限大小）";
      showToast("仅支持 pdf / docx / pptx 格式");
      return;
    }
    filePick.classList.add("has-file");
    filePickText.textContent = "✅ " + f.name;
  });

  uploadForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var title = matTitle.value.trim();
    var f = matFile.files[0];
    if (!title) { showToast("请填写素材标题"); return; }
    if (!f) { showToast("请选择要上传的文件"); return; }

    var fd = new FormData();
    fd.append("title", title);
    fd.append("category", matCategory.value);
    fd.append("brief", matBrief.value.trim());
    fd.append("file", f);

    uploadSubmit.disabled = true;
    uploadSubmit.textContent = "上传中…";
    fetch("/api/teacher/materials/upload", { method: "POST", body: fd })
      .then(function (r) {
        if (r.status === 403) { throw new Error("仅教师账号可上传素材"); }
        return r.json().then(function (d) { return { ok: r.ok, d: d }; });
      })
      .then(function (res) {
        if (!res.ok || res.d.error) { throw new Error(res.d.error || "上传失败"); }
        showToast("素材上传成功");
        closeUpload();
        state.page = 1;
        loadList();
      })
      .catch(function (e) {
        uploadSubmit.disabled = false;
        uploadSubmit.textContent = "提交上传";
        showToast(e.message || "上传失败，请重试");
      });
  });

  // ---------- 3. 素材详情 ----------
  function openDetail(id) {
    detailModal.hidden = false;
    detailBody.textContent = "加载中…";
    detailDownload.href = "/api/teacher/materials/" + id + "/download";
    fetch("/api/teacher/materials/" + id)
      .then(function (r) {
        if (r.status === 403) { throw new Error("仅教师账号可查看素材详情"); }
        return r.json();
      })
      .then(function (d) {
        if (d.error) { throw new Error(d.error); }
        detailBody.innerHTML =
          '<div class="detail-title">' + escapeHtml(d.title) + "</div>" +
          '<span class="detail-chip">' + escapeHtml(d.category) + "</span>" +
          '<div class="detail-meta">📎 ' + escapeHtml(d.file_name) + "（" + fmtSize(d.file_size) + "）<br>" +
          "上传：" + escapeHtml(d.uploader_name) + " · " + d.upload_time + "</div>" +
          (d.brief ? '<div class="detail-brief">' + escapeHtml(d.brief) + "</div>" : '<div class="detail-meta">暂无简介</div>');
      })
      .catch(function (e) {
        detailBody.innerHTML = '<div class="detail-meta">' + e.message + "</div>";
      });
  }
  function closeDetail() { detailModal.hidden = true; }
  detailClose.addEventListener("click", closeDetail);
  detailCloseBtn.addEventListener("click", closeDetail);

  // 点击遮罩关闭弹窗
  uploadModal.addEventListener("click", function (e) { if (e.target === uploadModal) { closeUpload(); } });
  detailModal.addEventListener("click", function (e) { if (e.target === detailModal) { closeDetail(); } });

  // ---------- 初始化 ----------
  loadList();
})();
