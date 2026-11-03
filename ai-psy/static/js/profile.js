// ===== 个人中心：侧边栏功能跳转 + 个人信息展示/编辑（除 id 外全部字段）=====
(function () {
  "use strict";

  var toast = document.getElementById("toast");
  var fields = document.getElementById("infoFields");
  var editBtn = document.getElementById("editBtn");
  var user = null;    // 最新个人信息（保存后以数据库返回为准）
  var editing = false;

  function showToast(text) {
    toast.textContent = text;
    toast.hidden = false;
    setTimeout(function () { toast.hidden = true; }, 3200);
  }

  /**
   * 防 XSS：用户可编辑字段（姓名/手机号/班级）渲染前统一转义
   */
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function fmtTime(ts) {
    if (!ts) return "—";
    return new Date(ts * 1000).toLocaleString("zh-CN", { hour12: false });
  }

  function display(v) {
    return (v != null && v !== "") ? v : "—";
  }

  function buildRows() {
    var isTeacher = user.role === "teacher";
    var noLabel = isTeacher ? "工号" : "学号";
    // 班级在教师端显示多选 chips（classes 数组），学生端为单值 class
    var classDisplay, classValue;
    if (isTeacher) {
      classDisplay = (user.classes || []).length
        ? (user.classes.map(function (c) { return esc(c); }).join(" / "))
        : "—";
      classValue = user.classes || [];
    } else {
      classDisplay = display(user["class"]);
      classValue = user["class"];
    }
    return [
      { label: "姓名", key: "name", editable: true, value: user.name },
      { label: "身份", key: null, editable: false, value: user.role_name },
      { label: noLabel, key: null, editable: false, value: user.no },
      { label: "手机号", key: "phone", editable: true, value: user.phone },
      {
        label: isTeacher ? "绑定班级（多选）" : "班级",
        key: "class",
        editable: true,
        value: isTeacher ? classValue : classValue,
        display: classDisplay,
        isClass: true,
      },
      { label: "登录账号", key: null, editable: false, value: user.account },
      { label: "注册时间", key: null, editable: false, value: fmtTime(user.created_at) },
    ];
  }

  // ---------- 教师端多选班级组件 ----------
  var CLASS_FORBIDDEN_RE = /[,，、\n\r\t]/;

  function renderChips(currentClasses) {
    var wrap = document.createElement("div");
    wrap.className = "chips-wrap";
    currentClasses = currentClasses.slice();

    function redraw() {
      wrap.innerHTML = "";
      currentClasses.forEach(function (c, idx) {
        var chip = document.createElement("span");
        chip.className = "chip";
        chip.innerHTML = esc(c) + ' <span class="chip-x" data-idx="' + idx + '">×</span>';
        wrap.appendChild(chip);
      });
      var input = document.createElement("input");
      input.type = "text";
      input.className = "chip-input";
      input.placeholder = "+ 添加班级（回车确认，逗号/顿号分隔粘贴多班）";

      function tryAdd(vs) {
        vs.forEach(function (s) {
          s = s.trim();
          if (!s) return;
          if (CLASS_FORBIDDEN_RE.test(s)) {
            showToast("班级名「" + s + "」不能包含逗号、顿号等分隔符");
            return;
          }
          if (currentClasses.indexOf(s) === -1) currentClasses.push(s);
        });
      }

      // 回车或逗号触发确认
      input.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === "," || e.key === "，") {
          e.preventDefault();
          var v = input.value.trim();
          if (v) {
            tryAdd(v.split(/[,，、\s]+/));
            input.value = "";
            redraw();
          }
        }
      });
      // 失焦时也触发一次（兼容没按回车直接点别处）
      input.addEventListener("blur", function () {
        var v = input.value.trim();
        if (v) {
          tryAdd([v]);
          input.value = "";
          redraw();
        }
      });
      wrap.appendChild(input);
    }

    wrap.addEventListener("click", function (e) {
      var x = e.target.closest(".chip-x");
      if (x) {
        currentClasses.splice(parseInt(x.dataset.idx, 10), 1);
        redraw();
      } else if (e.target.classList.contains("chip")) {
        input.focus();
      }
    });

    redraw();
    wrap._getClasses = function () { return currentClasses.slice(); };
    return wrap;
  }

  /**
   * 渲染信息卡：只读态展示文本，编辑态可编辑字段变输入框 + 底部保存/取消
   */
  function render() {
    var isTeacher = user.role === "teacher";
    var html = buildRows().map(function (r) {
      var body;
      if (r.isClass && isTeacher) {
        if (!editing) {
          body = '<span class="fv">' + r.display + "</span>";
        } else {
          // 教师多选编辑态：chips 容器稍后挂 DOM
          body = '<div class="chips-container" data-field="class"></div>';
        }
      } else if (!editing || !r.editable) {
        body = '<span class="fv">' + esc(display(r.value)) + "</span>";
      } else {
        body = '<input class="edit-input" name="' + r.key + '" value="' +
          esc(r.value == null ? "" : r.value) + '" placeholder="请输入' + r.label + '">';
      }
      return '<div class="field"><span class="fk">' + r.label + "</span>" + body + "</div>";
    }).join("");
    if (editing) {
      html += '<div class="edit-actions">' +
        '<button class="btn-save" id="saveBtn" type="button">💾 保存</button>' +
        '<button class="btn-cancel" id="cancelBtn" type="button">取消</button>' +
        "</div>";
    }
    fields.innerHTML = html;
    editBtn.hidden = editing; // 编辑态隐藏右上角编辑按钮，由保存/取消接管

    // 编辑态下把 chips 组件挂到容器上，并把引用存 DOM 方便 save 时取值
    if (editing && isTeacher) {
      var container = fields.querySelector(".chips-container");
      if (container) {
        var chips = renderChips(user.classes || []);
        container.appendChild(chips);
        container._chips = chips;
      }
    }
  }

  function startEdit() { editing = true; render(); }

  function cancelEdit() { editing = false; render(); }

  function saveEdit() {
    var isTeacher = user.role === "teacher";
    var name = (fields.querySelector('input[name="name"]').value || "").trim();
    var phone = (fields.querySelector('input[name="phone"]').value || "").trim();
    var payload = { name: name, phone: phone || null };
    var classContainer = fields.querySelector(".chips-container");
    var clazzInput = fields.querySelector('input[name="class"]');

    if (!name) { showToast("请填写姓名"); return; }
    if (phone && !/^\d{7,15}$/.test(phone)) {
      showToast("手机号格式不正确（需 7-15 位数字）");
      return;
    }

    if (isTeacher) {
      var classes = (classContainer && classContainer._chips)
        ? classContainer._chips._getClasses()
        : [];
      if (!classes.length) { showToast("至少绑定一个班级"); return; }
      payload.classes = classes;
    } else {
      var clazz = (clazzInput ? clazzInput.value : "").trim();
      if (!clazz) { showToast("请填写班级"); return; }
      payload["class"] = clazz;
    }

    fetch("/api/auth/profile/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (!res.ok || res.d.error) { showToast(res.d.error || "保存失败，请稍后重试"); return; }
        user = res.d.user;
        editing = false;
        render();
        // 同步顶栏徽章中的姓名，无需刷新即可看到新名字
        var badgeName = document.querySelector(".auth-badge .who b");
        if (badgeName) badgeName.textContent = user.name;
        showToast("保存成功");
      })
      .catch(function (e) { showToast("网络错误：" + e.message); });
  }

  // 侧边栏：功能项跳转对应页面；个人信息项仅切换高亮（本页即个人信息页）
  document.getElementById("sideNav").addEventListener("click", function (e) {
    var btn = e.target.closest(".nav-item");
    if (!btn) return;
    if (btn.id === "logoutBtn") {
      fetch("/api/auth/logout", { method: "POST" })
        .then(function () { location.href = "/login"; });
      return;
    }
    if (btn.dataset.href) { location.href = btn.dataset.href; return; }
    document.querySelectorAll(".nav-item").forEach(function (x) { x.classList.remove("active"); });
    btn.classList.add("active");
  });

  // 编辑 / 保存 / 取消（fields 内事件委托）
  editBtn.addEventListener("click", startEdit);
  fields.addEventListener("click", function (e) {
    if (e.target.id === "saveBtn") saveEdit();
    if (e.target.id === "cancelBtn") cancelEdit();
  });

  // 拉取个人信息并渲染
  fetch("/api/auth/profile")
    .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
    .then(function (res) {
      if (!res.ok || res.d.error) { showToast(res.d.error || "信息加载失败"); return; }
      user = res.d;
      var isTeacher = user.role === "teacher";
      // 按角色显示侧边栏专属入口（教师：班级测评报告 + 预约管理）
      var navTeachers = document.querySelectorAll(".nav-teacher");
      var navStudent = document.querySelector(".nav-student");
      if (isTeacher && navTeachers.length) {
        navTeachers.forEach(function (x) { x.hidden = false; });
      }
      if (!isTeacher && navStudent) navStudent.hidden = false;
      render();
    })
    .catch(function (e) { showToast("网络错误：" + e.message); });
})();
