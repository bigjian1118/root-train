// ===== 登录 / 注册独立页面逻辑：成功后跳回 next 参数指定的页面（默认首页）=====
(function () {
  "use strict";

  var tabs = document.querySelectorAll(".auth-tabs button");
  var roleLabels = document.querySelectorAll("#rolePick label");
  var form = document.getElementById("authForm");
  var errBox = document.getElementById("authError");
  var submitBtn = document.getElementById("authSubmit");
  var hint = document.getElementById("authHint");
  var mode = "login"; // login | register

  // 多班级相关 DOM
  var classInputWrap = document.getElementById("classInputWrap");
  var addClassBtn = document.getElementById("addClassBtn");
  var classHint = document.getElementById("classHint");
  var CLASS_FORBIDDEN_RE = /[,，、\n\r\t]/;
  var CLASS_ROW_IDX = 1; // 已追加的班级输入框序号（第一个原输入框算 0）

  function _isTeacherRegister() {
    return mode === "register" && selectedRole() === "teacher";
  }

  function _toggleClassMulti() {
    var multi = _isTeacherRegister();
    addClassBtn.hidden = !multi;
    classHint.hidden = !multi;
    // 如果切换角色时已有多个输入框，非教师时只留第一个
    var inputs = classInputWrap.querySelectorAll("input");
    if (!multi && inputs.length > 1) {
      for (var i = 1; i < inputs.length; i++) {
        inputs[i].parentElement.remove();
      }
      CLASS_ROW_IDX = 1;
    }
  }

  addClassBtn.addEventListener("click", function () {
    var row = document.createElement("div");
    row.className = "class-row";
    row.innerHTML =
      '<input type="text" class="class-extra" placeholder="请输入另一个班级">' +
      '<button type="button" class="class-remove" title="删除">×</button>';
    classInputWrap.appendChild(row);
    row.querySelector(".class-remove").addEventListener("click", function () {
      row.remove();
    });
    CLASS_ROW_IDX++;
  });

  function _collectClasses() {
    var inputs = classInputWrap.querySelectorAll("input");
    var vals = [];
    for (var i = 0; i < inputs.length; i++) {
      var v = inputs[i].value.trim();
      if (v) vals.push(v);
    }
    return vals;
  }

  function _validateClasses(classes) {
    if (!classes || !classes.length) return "请至少填写一个班级";
    for (var i = 0; i < classes.length; i++) {
      if (CLASS_FORBIDDEN_RE.test(classes[i])) {
        return "班级名「" + classes[i] + "」不能包含逗号、顿号等分隔符";
      }
    }
    return null;
  }

  // 登录后回跳地址：/login?next=/test（仅允许站内相对路径，防跳转攻击）
  function nextUrl() {
    var n = new URLSearchParams(location.search).get("next") || "/";
    return n.charAt(0) === "/" && n.charAt(1) !== "/" ? n : "/";
  }

  // 已登录直接进入，避免重复登录
  fetch("/api/auth/me")
    .then(function (r) { return r.json(); })
    .then(function (d) { if (d.logged_in) { location.replace(nextUrl()); } });

  function selectedRole() {
    var r = document.querySelector('input[name="auth-role"]:checked');
    return r ? r.value : "student";
  }

  // 根据模式 + 角色刷新表单（登录只留账号密码；注册按学生/教师改标签）
  function refreshForm() {
    var isStudent = selectedRole() === "student";
    document.getElementById("fieldNo").hidden = mode === "login";
    document.getElementById("fieldName").hidden = mode === "login";
    document.getElementById("fieldClass").hidden = mode === "login";
    if (mode === "register") {
      var noLabel = document.querySelector("#fieldNo label");
      noLabel.textContent = isStudent ? "学号" : "工号";
      form.no.placeholder = isStudent ? "请输入学号" : "请输入工号";
    }
    tabs.forEach(function (b) { b.classList.toggle("active", b.dataset.tab === mode); });
    submitBtn.textContent = mode === "login" ? "登 录" : "注 册";
    hint.innerHTML = mode === "login"
      ? '还没有账号？<a id="toRegister">立即注册</a>'
      : '已有账号？<a id="toRegister">返回登录</a>';
    document.getElementById("toRegister").addEventListener("click", function () {
      setMode(mode === "login" ? "register" : "login");
    });
    errBox.textContent = "";
    _toggleClassMulti();
  }

  function setMode(m) {
    mode = m;
    refreshForm();
  }

  tabs.forEach(function (b) {
    b.addEventListener("click", function () { setMode(this.dataset.tab); });
  });
  roleLabels.forEach(function (lb) {
    lb.addEventListener("click", function () {
      roleLabels.forEach(function (x) { x.classList.remove("checked"); });
      this.classList.add("checked");
      this.querySelector("input").checked = true;
      refreshForm();
    });
  });

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    errBox.textContent = "";
    submitBtn.disabled = true;

    var payload = {
      role: selectedRole(),
      account: form.account.value.trim(),
      password: form.password.value,
    };
    if (mode === "register") {
      payload.no = form.no.value.trim();
      payload.name = form.name.value.trim();
      if (_isTeacherRegister()) {
        // 教师注册：多班级数组 + 校验
        var classes = _collectClasses();
        var cerr = _validateClasses(classes);
        if (cerr) {
          errBox.textContent = cerr;
          submitBtn.disabled = false;
          return;
        }
        payload.classes = classes;
        payload["class"] = classes[0]; // 向后兼容旧后端
      } else {
        // 学生注册：单班级
        var cls = form["class"].value.trim();
        if (!cls) {
          errBox.textContent = "请填写班级";
          submitBtn.disabled = false;
          return;
        }
        if (CLASS_FORBIDDEN_RE.test(cls)) {
          errBox.textContent = "班级名不能包含逗号、顿号等分隔符";
          submitBtn.disabled = false;
          return;
        }
        payload["class"] = cls;
      }
    }

    var url = mode === "login" ? "/api/auth/login" : "/api/auth/register";
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        submitBtn.disabled = false;
        if (!res.ok || res.d.error) {
          errBox.textContent = res.d.error || "请求失败，请稍后重试";
          return;
        }
        // 教师账号登录成功直接进入个人中心；学生跳转 next 指定页或首页
        if (res.d.user && res.d.user.role === "teacher") {
          location.href = "/profile";
        } else {
          location.href = nextUrl();
        }
      })
      .catch(function (err) {
        submitBtn.disabled = false;
        errBox.textContent = "网络错误：" + err.message;
      });
  });

  refreshForm();
})();
