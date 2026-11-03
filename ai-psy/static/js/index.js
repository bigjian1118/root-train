// ===== 学生端首页：直接展示心理科普文章（列表 + 分页 + 详情 + 标题搜索） =====
// 复用 articles.js 的接口：/api/articles?page&page_size、/api/articles/<id>
(function () {
  "use strict";

  var articleList = document.getElementById("articleList");
  var pager = document.getElementById("pager");
  var prevPage = document.getElementById("prevPage");
  var nextPage = document.getElementById("nextPage");
  var pageInfo = document.getElementById("pageInfo");
  var arcSearch = document.getElementById("arcSearch");
  var arcSearchClear = document.getElementById("arcSearchClear");

  var listView = document.getElementById("listView");
  var detailView = document.getElementById("detailView");
  var detailBody = document.getElementById("detailBody");
  var backBtn = document.getElementById("backBtn");

  var currentPage = 1;
  var pageSize = 12;
  var totalPages = 1;
  var allArticles = [];        // 全量缓存（本地搜索过滤用）

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function fmtDate(ts) {
    if (!ts) return "";
    var d = new Date(ts * 1000);
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }

  // 来源标签：内置权威来源过长，列表统一压缩为短标签；教师自定义来源原样展示
  function shortSource(source) {
    if (!source || source.indexOf("权威校园心理科普") !== -1) return "权威校园心理科普";
    return source;
  }

  // 详情页封面：仅在有真实封面图时渲染横幅
  function detailCoverHtml(url) {
    if (!url) return "";
    return '<div class="detail-cover"><img src="' + esc(url) + '" alt="" onerror="this.parentNode.style.display=\'none\'"></div>';
  }

  // 渲染文章列表（支持传入过滤后的数组）
  function renderList(items) {
    articleList.innerHTML = "";
    if (!items.length) {
      articleList.innerHTML = '<p class="empty-tip">未找到相关科普文章 😶‍🌫️<br><span style="font-size:12px;color:#9cb0bd;">换个关键词试试吧~</span></p>';
      pager.hidden = true;
      return;
    }
    items.forEach(function (a) {
      var card = document.createElement("a");
      card.className = "arc-card";
      card.href = "#/article/" + a.id;
      card.innerHTML =
        '<div class="arc-info">' +
          '<h3 class="arc-title">' + esc(a.title) + "</h3>" +
          '<p class="arc-summary">' + esc(a.summary) + "</p>" +
          '<span class="arc-tags">' +
            '<em class="arc-src">📌 ' + esc(shortSource(a.source)) + "</em>" +
            '<em class="arc-date">📅 ' + esc(fmtDate(a.created_at)) + "</em>" +
          "</span>" +
        "</div>" +
        '<span class="arc-go">阅读全文 →</span>';
      articleList.appendChild(card);
    });
  }

  // 加载文章列表（带全量缓存）
  function loadList(page) {
    currentPage = page;
    articleList.innerHTML = '<div class="loading">加载中…</div>';
    fetch("/api/articles?page=" + page + "&page_size=" + pageSize)
      .then(function (r) {
        if (r.status === 401) { location.href = "/login"; throw new Error("未登录"); }
        return r.json();
      })
      .then(function (d) {
        if (d.error) { articleList.innerHTML = '<p class="empty-tip">' + esc(d.error) + "</p>"; return; }
        allArticles = d.articles || [];
        totalPages = Math.max(1, Math.ceil((d.total || 0) / pageSize));

        // 如果有搜索关键词，先过滤再渲染（搜索时隐藏分页，展示全部过滤结果）
        var kw = (arcSearch.value || "").trim().toLowerCase();
        if (kw) {
          var filtered = allArticles.filter(function (a) {
            return String(a.title || "").toLowerCase().indexOf(kw) !== -1;
          });
          renderList(filtered);
          pager.hidden = true;
        } else {
          renderList(allArticles);
          pager.hidden = totalPages <= 1;
          prevPage.hidden = currentPage <= 1;
          nextPage.hidden = currentPage >= totalPages;
          pageInfo.textContent = "第 " + currentPage + " / " + totalPages + " 页";
        }
      })
      .catch(function (e) {
        if (e.message !== "未登录") articleList.innerHTML = '<p class="empty-tip">加载失败，请稍后重试。</p>';
      });
  }

  prevPage.addEventListener("click", function () {
    if (!arcSearch.value.trim() && currentPage > 1) {
      loadList(currentPage - 1);
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  });
  nextPage.addEventListener("click", function () {
    if (!arcSearch.value.trim() && currentPage < totalPages) {
      loadList(currentPage + 1);
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  });

  // ===== 搜索：标题模糊匹配，实时过滤（防抖 250ms）=====
  var searchTimer = null;
  function onSearchInput() {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(function () {
      var kw = (arcSearch.value || "").trim().toLowerCase();
      arcSearchClear.hidden = !kw;
      if (!kw) {
        // 清空：恢复原始分页列表
        loadList(currentPage);
        return;
      }
      if (!allArticles.length) {
        articleList.innerHTML = '<p class="empty-tip">加载中…</p>';
        return;
      }
      var filtered = allArticles.filter(function (a) {
        return String(a.title || "").toLowerCase().indexOf(kw) !== -1;
      });
      renderList(filtered);
      pager.hidden = true;
    }, 250);
  }

  arcSearch.addEventListener("input", onSearchInput);
  arcSearchClear.addEventListener("click", function () {
    arcSearch.value = "";
    arcSearchClear.hidden = true;
    loadList(currentPage);
    arcSearch.focus();
  });

  // 加载详情
  function loadDetail(id) {
    detailBody.innerHTML = '<div class="loading">加载中…</div>';
    fetch("/api/articles/" + encodeURIComponent(id))
      .then(function (r) {
        if (r.status === 401) { location.href = "/login"; throw new Error("未登录"); }
        if (r.status === 404) { detailBody.innerHTML = '<p class="empty-tip">文章不存在或已下架。</p>'; return null; }
        return r.json();
      })
      .then(function (d) {
        if (!d) return;
        if (d.error) { detailBody.innerHTML = '<p class="empty-tip">' + esc(d.error) + "</p>"; return; }
        var a = d.article;
        detailBody.innerHTML =
          '<p class="source-tag">📌 【' + esc(shortSource(a.source)) + "】</p>" +
          '<h1 class="detail-title">' + esc(a.title) + "</h1>" +
          '<p class="detail-date">📅 发布于 ' + esc(fmtDate(a.created_at)) + "</p>" +
          detailCoverHtml(a.cover) +
          '<div class="detail-content">' + a.content + "</div>" +
          '<p class="detail-source">📌 科普来源：' + esc(a.source || "权威校园心理科普") + "</p>" +
          '<p class="detail-doc">⚠️ 本文为校园心理科普内容，供日常生活参考；如有持续困扰，请及时联系学校心理老师或拨打心理援助热线。</p>';
      })
      .catch(function (e) {
        if (e.message !== "未登录") detailBody.innerHTML = '<p class="empty-tip">加载失败，请稍后重试。</p>';
      });
  }

  backBtn.addEventListener("click", function () { location.hash = "#/list"; });

  // ===== 回到顶部按钮 =====
  var backTopBtn = document.getElementById("backTopBtn");
  var scrollThreshold = 420;
  var backTopShown = false;

  if (backTopBtn) {
    backTopBtn.addEventListener("click", function () {
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
    window.addEventListener("scroll", function () {
      if (backTopShown && scrollY <= scrollThreshold) {
        backTopShown = false;
        backTopBtn.classList.remove("show");
      } else if (!backTopShown && scrollY > scrollThreshold) {
        backTopShown = true;
        backTopBtn.classList.add("show");
      }
    }, { passive: true });
  }

  // hash 路由
  function route() {
    var h = location.hash || "#/list";
    if (h.indexOf("#/article/") === 0) {
      listView.hidden = true;
      detailView.hidden = false;
      window.scrollTo({ top: 0, behavior: "smooth" });
      loadDetail(h.slice("#/article/".length));
    } else {
      listView.hidden = false;
      detailView.hidden = true;
      loadList(currentPage);
    }
  }

  window.addEventListener("hashchange", route);
  route();
})();
