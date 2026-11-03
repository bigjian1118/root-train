// 场景化心理测评页脚本：选场景 -> 本地题库逐题作答 -> 前端计分 -> 提交归档 -> 跳转独立报告页
// 题库与计分引擎在前端（static/js/scl90_data.js），后端只负责归档报告 + AI 解读
(function () {
  "use strict";

  var SCL90 = window.SCL90_DATA;
  var pickPanel = document.getElementById("pickPanel");
  var pickList = document.getElementById("pickList");
  var quizPanel = document.getElementById("quizPanel");
  var quizScene = document.getElementById("quizScene");
  var quizProg = document.getElementById("quizProg");
  var progFill = document.getElementById("progFill");
  var qFactor = document.getElementById("qFactor");
  var qText = document.getElementById("qText");
  var optList = document.getElementById("optList");
  var prevBtn = document.getElementById("prevBtn");
  var submitBtn = document.getElementById("submitBtn");
  var loadingMask = document.getElementById("loadingMask");
  var toast = document.getElementById("toast");

  // 场景 emoji 装饰映射（仅前端展示用，与 config.SCENARIOS 三人群一致）
  var SCENE_EMOJI = {
    primary_student: "🧒",
    junior_student: "🎒",
    college_student: "🎓",
  };

  // ---------- 本地题库（内嵌标准 90 题；场景题库 JSON 拉不到时兜底） ----------
  var QID_FACTOR = {};       // 题号 -> 因子名（反向索引）
  Object.keys(SCL90.factorMap).forEach(function (f) {
    SCL90.factorMap[f].forEach(function (qid) { QID_FACTOR[qid] = f; });
  });
  function factorOf(qid) { return QID_FACTOR[qid] || "其他"; }

  var stdQuestions = [];     // 标准 90 题：[{id, factor, question}]
  Object.keys(SCL90.questions).forEach(function (k) {
    stdQuestions.push({ id: +k, factor: factorOf(+k), question: SCL90.questions[k] });
  });

  // 默认五级选项（Likert）
  var options = [1, 2, 3, 4, 5].map(function (v) {
    return { text: SCL90.likertScale[v], value: v };
  });

  var currentScenario = null;
  var scenarioName = "";
  var questions = [];        // 当前作答的 90 题（场景题库或标准题）
  var answers = {};          // {题号: 1-5}
  var cursor = 0;            // 当前题下标
  var navigating = false;    // 自动跳转锁：防止同一题连点两次挂起多个定时器导致跳题（跳过的题未作答，提交时永远无法通过）

  function showToast(text) {
    toast.textContent = text;
    toast.hidden = false;
    setTimeout(function () { toast.hidden = true; }, 3200);
  }

  // ---------- 1. 拉取场景列表 ----------
  fetch("/api/config")
    .then(function (r) { return r.json(); })
    .then(function (data) {
      (data.scenarios || []).forEach(function (sc) {
        var card = document.createElement("div");
        card.className = "pick-card";
        card.innerHTML =
          '<div class="pick-emoji">' + (SCENE_EMOJI[sc.key] || "🙂") + "</div>" +
          "<div><h3>" + sc.name + "</h3><p>" + sc.desc + "</p></div>" +
          '<div class="pick-arrow">→</div>';
        card.addEventListener("click", function () { startQuiz(sc.key, sc.name); });
        pickList.appendChild(card);
      });
    })
    .catch(function () { showToast("场景配置加载失败，请确认后端已启动"); });

  // ---------- 2. 开始测评：加载场景题库（静态 JSON，失败兜底标准 90 题） ----------
  function startQuiz(key, name) {
    currentScenario = key;
    scenarioName = name;
    questions = stdQuestions.slice();   // 兜底：静态题库不可用时直接用标准题
    fetch("/static/data/question_bank.json")
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (bank) {
        if (bank && bank[key] && bank[key].questions
            && bank[key].questions.length === 90) {
          questions = bank[key].questions;
        }
      })
      .catch(function () { /* 无场景题库时静默用标准题 */ })
      .then(function () {
        answers = {};
        cursor = 0;
        quizScene.textContent = name + "场景";
        pickPanel.hidden = true;
        quizPanel.hidden = false;
        renderQuestion();
      });
  }

  // ---------- 3. 渲染当前题（题干来自场景题库 / 标准 90 题，选项为 Likert 五级） ----------
  function renderQuestion() {
    var q = questions[cursor];
    qFactor.textContent = "测评维度：" + (q.factor || "其他");
    qText.textContent = q.question;
    quizProg.textContent = "第 " + (cursor + 1) + "/" + questions.length + " 题";
    progFill.style.width = ((cursor + 1) / questions.length * 100) + "%";

    optList.innerHTML = "";
    options.forEach(function (opt) {
      var btn = document.createElement("button");
      btn.className = "opt-btn" + (answers[q.id] === opt.value ? " selected" : "");
      btn.innerHTML = opt.text + "<small>" + opt.value + " 分</small>";
      btn.addEventListener("click", function () {
        if (navigating) { return; }
        navigating = true;
        answers[q.id] = opt.value;
        // 选中后自动进入下一题（末题显示提交按钮）
        optList.querySelectorAll(".opt-btn").forEach(function (b) { b.classList.remove("selected"); });
        btn.classList.add("selected");
        setTimeout(function () {
          navigating = false;
          nextQuestion();
        }, 260);
      });
      optList.appendChild(btn);
    });

    prevBtn.disabled = cursor === 0;
    submitBtn.hidden = cursor !== questions.length - 1;
  }

  function nextQuestion() {
    if (cursor < questions.length - 1) {
      cursor += 1;
      renderQuestion();
    } else {
      renderQuestion(); // 末题：刷新按钮态，露出提交按钮
    }
  }

  prevBtn.addEventListener("click", function () {
    if (navigating) { return; }
    if (cursor > 0) { cursor -= 1; renderQuestion(); }
  });

  // ---------- 4. 前端计分引擎 ----------
  /**
   * 常模 Z 分数阈值分级（纯规则）
   */
  function ruleSeverity(z) {
    if (z >= 3.0) { return ["极重", 4]; }
    if (z >= 2.0) { return ["重度", 3]; }
    if (z >= 1.0) { return ["中度", 2]; }
    if (z >= 0.5) { return ["轻度", 1]; }
    return ["正常", 0];
  }

  function round2(x) { return Math.round(x * 100) / 100; }

  /**
   * answers: {题号: 1-5}
   */
  function scoreSCL90(answers) {
    var total = 0, positiveCount = 0, positiveSum = 0;
    Object.keys(answers).forEach(function (k) {
      var s = answers[k];
      total += s;
      if (s >= 3) { positiveCount += 1; positiveSum += s; }
    });

    // 因子分：均分 + 常模对比 + 规则分级
    var factors = {};
    Object.keys(SCL90.factorMap).forEach(function (name) {
      var items = SCL90.factorMap[name];
      var sum = 0;
      items.forEach(function (qid) { sum += answers[qid]; });
      var avg = round2(sum / items.length);
      var norm = SCL90.chinaNorm[name] || [1.5, 0.5];
      var z = norm[1] > 0 ? round2((avg - norm[0]) / norm[1]) : 0;
      var sev = ruleSeverity(z);
      factors[name] = {
        "均分": avg,
        "常模均值": norm[0],
        "常模标准差": norm[1],
        "标准差倍数": z,
        "严重程度": sev[0],
        "严重程度代码": sev[1],
        "严重程度来源": "规则",
      };
    });

    // 按 Z 分数从高到低排序（稳定排序，同分保持因子定义顺序）
    var sorted = {};
    Object.keys(factors)
      .sort(function (a, b) { return factors[b]["标准差倍数"] - factors[a]["标准差倍数"]; })
      .forEach(function (name) { sorted[name] = factors[name]; });

    // 危机信号：预警题得分 >= 4
    var crisis = {};
    SCL90.crisisQuestions.forEach(function (qid) {
      if (answers[qid] >= 4) { crisis[qid] = answers[qid]; }
    });

    return {
      "总分": total,
      "总均分": round2(total / 90),
      "阳性项目数": positiveCount,
      "阳性症状均分": positiveCount > 0 ? round2(positiveSum / positiveCount) : 0,
      "因子分": sorted,
      "危机信号": crisis,
    };
  }

  // ---------- 5. 提交答卷（前端计分结果交后端归档 + AI 解读） ----------
  submitBtn.addEventListener("click", function () {
    // 校验全部题目已作答
    var missing = questions.find(function (q) { return answers[q.id] == null; });
    if (missing) {
      showToast("还有未作答的题目：" + missing.question.slice(0, 18) + "…");
      cursor = questions.indexOf(missing);
      renderQuestion();
      return;
    }
    loadingMask.hidden = false;
    submitBtn.disabled = true;

    var result = scoreSCL90(answers);
    fetch("/api/test/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scenario: currentScenario, result: result,
                             answers: answers }),  // 原始答题随结果一并提交：后端随机森林混合分级 + 归档
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        loadingMask.hidden = true;
        submitBtn.disabled = false;
        if (!res.ok || res.d.error) { showToast(res.d.error || "提交失败"); return; }
        // 结果存入 sessionStorage，跳转独立报告页渲染
        res.d.scenario_name = scenarioName;
        res.d.submitted_at = Date.now();
        res.d.viewer_role = "student"; // 报告页角色区分：学生简化视图
        try {
          sessionStorage.setItem("scl90_report", JSON.stringify(res.d));
        } catch (e) { /* 存储异常时仍跳转，报告页会显示兜底提示 */ }
        window.location.href = "/test/report";
      })
      .catch(function (e) {
        loadingMask.hidden = true;
        submitBtn.disabled = false;
        showToast("网络错误：" + e.message);
      });
  });
})();
