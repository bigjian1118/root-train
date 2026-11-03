// ===== 学生端：心理科普文章（列表 + 分页 + 详情） =====
// 只展示教师已上架(is_active=1)的权威校园心理科普文章
(function () {
  "use strict";

  var articleList = document.getElementById("articleList");
  var pager = document.getElementById("pager");
  var prevPage = document.getElementById("prevPage");
  var nextPage = document.getElementById("nextPage");
  var pageInfo = document.getElementById("pageInfo");

  var listView = document.getElementById("listView");
  var detailView = document.getElementById("detailView");
  var detailBody = document.getElementById("detailBody");
  var backBtn = document.getElementById("backBtn");

  var currentPage = 1;
  var pageSize = 6; // 每页文章数
  var totalPages = 1;

  // 转义防止 XSS（正文为教师填写的可信 HTML，但标题等用 esc 处理）
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // 时间戳 -> 日期（yyyy-MM-dd）
  function fmtDate(ts) {
    if (!ts) return "";
    var d = new Date(ts * 1000);
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, "0");
    var day = String(d.getDate()).padStart(2, "0");
    return y + "-" + m + "-" + day;
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

  // 加载文章列表（分页）
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
        var articles = d.articles || [];
        totalPages = Math.max(1, Math.ceil((d.total || 0) / pageSize));

        articleList.innerHTML = "";
        if (!articles.length) {
          articleList.innerHTML = '<p class="empty-tip">暂无科普文章，教师发布后即可阅读。</p>';
          pager.hidden = true;
          return;
        }
        articles.forEach(function (a) {
          var card = document.createElement("a");
          card.className = "arc-card";
          card.href = "#/article/" + a.id;
          card.innerHTML =
            '<div class="arc-info">' +
              '<h3 class="arc-title">' + esc(a.title) + "</h3>" +
              '<p class="arc-summary">' + esc(a.summary) + "</p>" +
              '<span class="arc-tags"><em class="arc-src">📌 ' + esc(shortSource(a.source)) + "</em>" +
              '<em class="arc-date">📅 ' + esc(fmtDate(a.created_at)) + "</em></span>" +
            "</div>";
          articleList.appendChild(card);
        });
        // 更新分页
        pager.hidden = totalPages <= 1;
        prevPage.hidden = currentPage <= 1;
        nextPage.hidden = currentPage >= totalPages;
        pageInfo.textContent = "第 " + currentPage + " / " + totalPages + " 页";
      })
      .catch(function (e) {
        if (e.message !== "未登录") articleList.innerHTML = '<p class="empty-tip">加载失败，请稍后重试。</p>';
      });
  }

  prevPage.addEventListener("click", function () { if (currentPage > 1) loadList(currentPage - 1); window.scrollTo(0, 0); });
  nextPage.addEventListener("click", function () { if (currentPage < totalPages) loadList(currentPage + 1); window.scrollTo(0, 0); });

  // 加载文章详情
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

  // ===== 悬浮「回到顶部」按钮 =====
  // 向下滚动超过阈值淡入，回到顶部后隐藏；点击平滑回顶。
  var backTopBtn = document.getElementById("backTopBtn");
  var scrollThreshold = 420; // 滚动超过该距离才显示
  var backTopShown = false;

  function smoothScrollToTop() {
    var supportSmooth = "scrollBehavior" in document.documentElement.style;
    if (supportSmooth) {
      window.scrollTo({ top: 0, behavior: "smooth" });
    } else {
      // 不支持平滑滚动的老环境：手动做柔和动画
      var rafId;
      var startY = window.pageYOffset || document.documentElement.scrollTop;
      var startT = null;
      var ease = function (t) { return t * t * (3 - 2 * t); }; // easeInOut
      function step(ts) {
        if (startT === null) startT = ts;
        var p = Math.min(1, (ts - startT) / 480);
        window.scrollTo(0, Math.round(startY * (1 - ease(p))));
        if (p < 1) rafId = requestAnimationFrame(step);
      }
      rafId = requestAnimationFrame(step);
      (backTopBtn._cancelRaf = rafId);
    }
  }

  if (backTopBtn) {
    backTopBtn.addEventListener("click", function () {
      if (backTopBtn._cancelRaf) cancelAnimationFrame(backTopBtn._cancelRaf);
      smoothScrollToTop();
    });
    window.addEventListener("scroll", function () {
      // 滚动距离阈值判断，减少抖动
      if (backTopShown && scrollY <= scrollThreshold) {
        backTopShown = false;
        backTopBtn.classList.remove("show");
      } else if (!backTopShown && scrollY > scrollThreshold) {
        backTopShown = true;
        backTopBtn.classList.add("show");
      }
    }, { passive: true });
  }

  // hash 路由：#/list（列表） / #/article/<id>（详情）
  function route() {
    var h = location.hash || "#/list";
    if (h.indexOf("#/article/") === 0) {
      listView.hidden = true;
      detailView.hidden = false;
      window.scrollTo(0, 0);
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