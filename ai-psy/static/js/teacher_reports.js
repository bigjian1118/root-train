// ===== 教师端：本班学生测评报告列表 + 天数筛选统计 + 因子偏向柱状图 =====
(function () {
  "use strict";

  var classLabel = document.getElementById("classLabel");
  var searchBox = document.getElementById("searchBox");
  var countLabel = document.getElementById("countLabel");
  var tbody = document.getElementById("reportTbody");
  var emptyTip = document.getElementById("emptyTip");
  var toast = document.getElementById("toast");
  var daySelect = document.getElementById("daySelect");
  var classSelect = document.getElementById("classSelect");
  var dateFrom = document.getElementById("dateFrom");
  var dateTo = document.getElementById("dateTo");
  var statStudents = document.getElementById("statStudents");
  var statTodayStudents = document.getElementById("statTodayStudents");
  var statReports = document.getElementById("statReports");
  var statTodayReports = document.getElementById("statTodayReports");
  var statFocus = document.getElementById("statFocus");
  var chartTitle = document.getElementById("chartTitle");
  var factorChart = document.getElementById("factorChart");

  var allReports = [];
  var pendingReqId = 0;   // ← 请求序号：只处理最新一次响应，防竞态覆盖

  // 因子固定展示顺序（与前端 scl90_data.js 的 factorMap 一致）
  var FACTOR_ORDER = ["躯体化", "强迫症状", "人际关系敏感", "抑郁", "焦虑",
    "敌对", "恐怖", "偏执", "精神病性", "其他"];

  function showToast(text, duration) {
    toast.textContent = text;
    toast.hidden = false;
    setTimeout(function () { toast.hidden = true; }, duration || 3200);
  }

  function fmtTime(ts) {
    return new Date(ts * 1000).toLocaleString("zh-CN", { hour12: false });
  }

  function scenarioName(key) {
    var map = {
      primary_student: "小学生", junior_student: "中学生",
      college_student: "大学生", teacher: "教师（旧版）",
    };
    return map[key] || key;
  }

  /** 按所选天数过滤（value=0 表示全部） */
  function byDays(list) {
    var days = parseInt(daySelect.value, 10);
    if (!days) return list;
    var since = Date.now() / 1000 - days * 86400;
    return list.filter(function (r) { return r.created_at >= since; });
  }

  /** 按起止日期过滤（date 输入，可空；含当日 23:59:59） */
  function byDateRange(list) {
    var from = dateFrom.value ? new Date(dateFrom.value + "T00:00:00").getTime() / 1000 : null;
    var to = dateTo.value ? new Date(dateTo.value + "T23:59:59").getTime() / 1000 : null;
    return list.filter(function (r) {
      var ts = r.created_at || 0;
      if (from != null && ts < from) return false;
      if (to != null && ts > to) return false;
      return true;
    });
  }

  function dayLabel() {
    var days = parseInt(daySelect.value, 10);
    if (!days) return "全部";
    return days === 7 ? "近一周" : "近 " + days + " 天";
  }

  // ---------- 统计卡片（数据大屏 5 卡，随筛选联动） ----------
  function renderStats(list) {
    var students = {};
    var todayStudents = {};
    var focus = {};
    var todayReports = 0;
    // 今日 0 点（秒）
    var d0 = new Date(); d0.setHours(0, 0, 0, 0);
    var todayStart = d0.getTime() / 1000;
    list.forEach(function (r) {
      students[r.student_id] = true;
      if ((r.created_at || 0) >= todayStart) {
        todayReports += 1;
        todayStudents[r.student_id] = true;
      }
      // 重点关注：危机信号（想自杀）或总分 > 300
      if (r.crisis || (r.total_score != null && r.total_score > 300)) focus[r.student_id] = true;
    });
    statStudents.textContent = Object.keys(students).length;
    statTodayStudents.textContent = Object.keys(todayStudents).length;
    statReports.textContent = list.length;
    statTodayReports.textContent = todayReports;
    statFocus.textContent = Object.keys(focus).length;
  }

  // ---------- 因子偏向柱状图：读取数据库个人报告的 top_factor（最大影响因子）计数 ----------
  function renderChart(list) {
    chartTitle.textContent = dayLabel() + "内偏向各个因子的人数";
    // 每个学生可能有多份报告，取其最新一份作为判定依据（按 created_at 最大）
    var latestByStudent = {};
    list.forEach(function (r) {
      var prev = latestByStudent[r.student_id];
      if (!prev || (r.created_at || 0) >= (prev.created_at || 0)) {
        latestByStudent[r.student_id] = r;
      }
    });
    // 逐个学生：最新报告的 top_factor 即偏向因子，该生只计入这一项
    var counts = {};
    FACTOR_ORDER.forEach(function (f) { counts[f] = 0; });
    Object.keys(latestByStudent).forEach(function (sid) {
      var r = latestByStudent[sid];
      var top = r.top_factor;
      // 旧数据无 top_factor 时回退：从因子均分中现场找最大项
      if (!top) {
        var avgs = r.factor_avgs || {};
        var topScore = -Infinity;
        FACTOR_ORDER.forEach(function (f) {
          if (avgs[f] != null && avgs[f] > topScore) {
            topScore = avgs[f];
            top = f;
          }
        });
      }
      // 报告无任何因子分则不计入
      if (top && counts[top] != null) counts[top] += 1;
    });
    // 比例柱状图：柱高 = 该因子人数 / 总人数（去重学生数），满高为 100%
    // 大屏配色：主柱蓝；该因子均分 >=3 橙（重点）、>=2 黄（关注）、<2 绿（正常）
    var total = Object.keys(latestByStudent).length;
    var factorAvg = {};
    Object.keys(latestByStudent).forEach(function (sid) {
      var r = latestByStudent[sid];
      var avgs = r.factor_avgs || {};
      Object.keys(avgs).forEach(function (f) {
        if (avgs[f] == null) return;
        if (!factorAvg[f]) factorAvg[f] = { sum: 0, n: 0 };
        factorAvg[f].sum += avgs[f];
        factorAvg[f].n += 1;
      });
    });
    factorChart.innerHTML = FACTOR_ORDER.map(function (f) {
      var n = counts[f];
      var pct = total > 0 ? Math.round((n / total) * 100) : 0;
      var avg = factorAvg[f] ? factorAvg[f].sum / factorAvg[f].n : 0;
      var lvl = avg >= 3 ? "focus" : avg >= 2 ? "warn" : "ok";
      return '<div class="col">' +
        '<span class="col-num">' + n + ' 人 / ' + pct + '%</span>' +
        '<div class="col-track"><div class="col-fill lvl-' + lvl + '" data-h="' + pct + '"></div></div>' +
        '<span class="col-name">' + f + '</span>' +
        '</div>';
    }).join("");
    requestAnimationFrame(function () {
      factorChart.querySelectorAll(".col-fill").forEach(function (el) {
        el.style.height = el.dataset.h + "%";
      });
    });
  }

  // ---------- 名单列表 ----------
  function render(list) {
    tbody.innerHTML = "";
    emptyTip.hidden = list.length > 0;
    countLabel.textContent = "共 " + list.length + " 份报告";
    list.forEach(function (r) {
      var isFocus = r.crisis || (r.total_score != null && r.total_score > 300);
      var isWatch = !isFocus && r.total_score != null && r.total_score > 200;
      var tr = document.createElement("tr");
      tr.className = isFocus ? "row-focus" : (isWatch ? "row-watch" : "row-ok");
      tr.innerHTML =
        "<td><span class=\"txt-hl\">" + r.student_name + "</span></td>" +
        "<td><span class=\"txt-hl\">" + scenarioName(r.scenario) + "</span></td>" +
        "<td><span class=\"txt-hl\">" + (r.total_score != null ? r.total_score : "-") + "</span></td>" +
        "<td><span class=\"txt-hl\">" + (r.positive_count != null ? r.positive_count : "-") + "</span></td>" +
        "<td>" + (r.crisis ? '<span class="tag-crisis">⚠️ 有</span>' : '<span class="tag-ok">无</span>') + "</td>" +
        "<td><span class=\"tag-status " + (isFocus ? "focus" : isWatch ? "watch" : "ok") + "\">" +
          (isFocus ? "重点关注" : isWatch ? "需关注" : "正常") + "</span></td>" +
        "<td><span class=\"txt-hl\">" + fmtTime(r.created_at) + "</span></td>" +
        '<td><button class="btn-view" data-id="' + r.id + '">查看报告</button></td>';
      tr.querySelector(".btn-view").addEventListener("click", function () { openReport(r.id, r.student_id); });
      tbody.appendChild(tr);
    });
  }

  /** 列表去重：每位学生仅保留提交时间最新的 1 条（仅影响表格展示，统计/图表/后端数据不变） */
  function latestOnly(list) {
    var best = {};
    list.forEach(function (r) {
      var key = r.student_id != null ? "s" + r.student_id : "n" + r.student_name + "|" + r.class;
      var prev = best[key];
      if (!prev || (r.created_at || 0) > (prev.created_at || 0)) best[key] = r;
    });
    return Object.keys(best)
      .map(function (k) { return best[k]; })
      .sort(function (a, b) { return (b.created_at || 0) - (a.created_at || 0); });
  }

  // 天数 + 起止日期 + 搜索关键字联合筛选，统计/图表/列表全部联动
  function applyFilter() {
    var kw = searchBox.value.trim().toLowerCase();
    var list = byDateRange(byDays(allReports));
    if (kw) {
      list = list.filter(function (r) {
        return r.student_name.toLowerCase().indexOf(kw) >= 0 ||
               scenarioName(r.scenario).toLowerCase().indexOf(kw) >= 0;
      });
    }
    renderStats(list);
    renderChart(list);
    render(latestOnly(list));
  }

  searchBox.addEventListener("input", applyFilter);
  daySelect.addEventListener("change", applyFilter);
  dateFrom.addEventListener("change", applyFilter);
  dateTo.addEventListener("change", applyFilter);

  /** 点击学生 -> 拉取详情 + 视频指标 -> 写入 sessionStorage -> 跳转复用报告页渲染 */
  function openReport(id, sid) {
    fetch("/api/teacher/report/" + id)
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (!res.ok || res.d.error) { showToast(res.d.error || "报告加载失败"); return; }
        var d = res.d;
        var crisis = d.scores && d.scores["危机信号"] && Object.keys(d.scores["危机信号"]).length > 0;
        // 该生历史报告（用于报告页左侧历史记录与趋势图，数据已在 allReports 中，零新增请求；
        // 详情接口不含 student_id，按姓名+班级匹配）
        var history = allReports.filter(function (r) {
          return r.student_name === d.student_name && r.class === d.class;
        }).slice(0, 10);
        // 教师端视频指标：只读接口拉取该生全部视频检测（无 sid 或无数据时 face=null）
        return (sid
          ? fetch("/api/teacher/student/" + sid + "/face-reports")
              .then(function (r) { return r.ok ? r.json() : {}; })
              .catch(function () { return {}; })
          : Promise.resolve({}))
          .then(function (vd) {
            var vlist = (vd && vd.reports) || [];
            var face = null;
            if (vlist.length) {
              var m0 = (vlist[0].metrics) || {};
              face = {
                emotions: m0.emotions || {},
                face_activity: m0.face_activity || 0,
                dominant_emotion: m0.dominant_emotion || "",
                au: m0.au || {},
                // 全部历史检测原始参数（[0]=最新），供报告页趋势/单点渲染
                records: vlist.slice(0, 10).map(function (v) {
                  var m = v.metrics || {};
                  return {
                    date: fmtTime(v.created_at).slice(0, 10),
                    emotions: m.emotions || {},
                    face_activity: m.face_activity || 0,
                  };
                }),
              };
            }
            sessionStorage.setItem("scl90_report", JSON.stringify({
              scores: d.scores,
              has_crisis: crisis,
              crisis_message: crisis
                ? "⚠️ 该同学测评中出现危机信号题目（得分≥4），建议尽快约谈并联系心理中心：400-161-9995"
                : "",
              report: d.report,
              scenario_name: d.scenario_name + "（学生：" + d.student_name + " · " + d.class + "）",
              submitted_at: d.submitted_at,
              viewer_role: "teacher",
              student_name: d.student_name,
              class: d.class,
              // 供报告页「AI 干预建议」入口跳转独立页时携带
              student_id: sid || "",
              report_id: id,
              history: history,
              face: face,
            }));
            window.location.href = "/test/report";
          });
      })
      .catch(function (e) { showToast("网络错误：" + e.message); });
  }

  /** 加载班级下拉：只展示当前教师有权限的班级（后端过滤） */
  function loadClasses() {
    classLabel.textContent = "班级列表加载中…";
    fetch("/api/teacher/classes")
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, status: r.status, d: d }; }); })
      .then(function (res) {
        if (!res.ok) {
          // 后端返回了具体错误信息（区分 403 越权 / 登录过期 / 其他错误）
          var msg = res.d && res.d.error ? res.d.error : "班级列表加载失败";
          if (res.status === 401) msg = "登录已过期，请重新登录";
          else if (res.status === 403) msg = "仅教师账号可查看班级报告";
          showToast(msg);
          classLabel.textContent = "⚠️ " + msg;
          return;
        }
        var classes = res.d.classes || [];
        classSelect.innerHTML = "";
        // 默认选项：全部绑定班级（value="" 表示不传 ?class=，后端按教师绑定多班级聚合）
        var allOpt = document.createElement("option");
        allOpt.value = "";
        allOpt.textContent = "📍 我绑定的全部班级";
        classSelect.appendChild(allOpt);
        if (!classes.length) {
          var empty = document.createElement("option");
          empty.value = "";
          empty.textContent = "暂无班级";
          classSelect.appendChild(empty);
          classLabel.textContent = "当前班级：暂无（请先在个人中心绑定班级）";
          showToast("请先在个人中心绑定至少一个班级");
          allReports = [];
          applyFilter();
          return;
        }
        classes.forEach(function (c) {
          var opt = document.createElement("option");
          opt.value = c;
          opt.textContent = c;
          classSelect.appendChild(opt);
        });
        loadReports();
      })
      .catch(function (e) {
        showToast("网络错误：" + e.message);
        classLabel.textContent = "⚠️ 网络错误：" + e.message;
      });
  }

  /** 按当前选择拉取报告：选中"全部"时不传 ?class=，后端按教师绑定班级 IN 查询 */
  function loadReports() {
    var cls = classSelect.value;
    var reqId = ++pendingReqId;   // 每次调用递增，旧响应自动丢弃
    // 立即更新加载状态（用户感知明确）
    if (cls) {
      classLabel.textContent = "正在加载班级「" + cls + "」的报告…";
    } else {
      classLabel.textContent = "正在加载全部绑定班级的报告…";
    }
    fetch("/api/teacher/reports" + (cls ? ("?class=" + encodeURIComponent(cls)) : ""))
      .then(function (r) {
        return r.json().then(function (d) {
          return { ok: r.ok, status: r.status, d: d };
        });
      })
      .then(function (res) {
        // 竞态防护：只处理最新一次请求的响应
        if (reqId !== pendingReqId) return;
        if (!res.ok) {
          var msg = (res.d && res.d.error) || "报告加载失败";
          showToast(msg, 5000);
          classLabel.textContent = "⚠️ " + msg;
          allReports = [];
          applyFilter();
          return;
        }
        if (cls) {
          classLabel.textContent = "当前班级：" + cls;
        } else {
          var cs = res.d.classes || [];
          classLabel.textContent = cs.length
            ? "当前：我绑定的全部班级（" + cs.length + " 个）— " + cs.join(" / ")
            : "当前班级：暂无（请先在个人中心绑定班级）";
        }
        allReports = res.d.reports || [];
        applyFilter();
      })
      .catch(function (e) {
        if (reqId !== pendingReqId) return;   // 网络错误也要跳过旧请求
        showToast("网络错误：" + e.message, 5000);
        classLabel.textContent = "⚠️ 网络错误：" + e.message;
        allReports = [];
        applyFilter();
      });
  }

  classSelect.addEventListener("change", loadReports);
  loadClasses();
})();
