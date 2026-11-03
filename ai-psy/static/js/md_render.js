// ===== AI 报告文本渲染器：把大模型输出的 Markdown 语法转为正式文档 HTML =====
// 仅做前端渲染转换，不改动 AI 原文语义；输出前统一 HTML 转义，防注入。
// 用法：el.innerHTML = renderAiMarkdown(text); el.classList.add("md-out");
(function () {
  "use strict";

  function esc(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // 行内语法：**加粗**、*斜体*、`代码`（输入为已转义文本）
  function inline(s) {
    s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^*<])\*([^*\n]+)\*(?![*])/g, "$1<em>$2</em>");
    // 兜底：清除未配对的 ** 与 *（模型常输出跨行包裹整段的加粗，行内无法配对）
    s = s.replace(/\*\*|\*/g, "");
    return s;
  }

  window.renderAiMarkdown = function (text) {
    if (!text) return "";
    var lines = String(text).replace(/\r\n/g, "\n").split("\n");
    var out = [];
    var para = [];        // 当前段落行缓冲
    var listStack = [];   // 已打开列表的类型栈（支持两级嵌套）
    var inCode = false, codeBuf = [];

    function flushPara() {
      if (!para.length) return;
      out.push("<p>" + para.map(function (l) { return inline(esc(l)); }).join("<br>") + "</p>");
      para = [];
    }
    function closeListsTo(depth) {
      while (listStack.length > depth) {
        out.push(listStack.pop() === "ul" ? "</ul>" : "</ol>");
      }
    }

    for (var i = 0; i < lines.length; i++) {
      var raw = lines[i];
      var line = raw.trim();

      // 代码围栏
      if (line.indexOf("```") === 0) {
        if (!inCode) { flushPara(); closeListsTo(0); inCode = true; codeBuf = []; }
        else { inCode = false; out.push("<pre><code>" + esc(codeBuf.join("\n")) + "</code></pre>"); }
        continue;
      }
      if (inCode) { codeBuf.push(raw); continue; }

      // 空行：段落/列表结束
      if (!line) { flushPara(); closeListsTo(0); continue; }

      // 标题 # ~ #+ → h4/h5/h6（层级映射，不显示 # 符号；兼容 # 后无空格的输出）
      var hm = line.match(/^(#{1,6})\s*(.*)$/);
      if (hm) {
        flushPara(); closeListsTo(0);
        var lvl = Math.min(hm[1].length, 3) + 3; // #→h4 ##→h5 ###+→h6
        out.push("<h" + lvl + ">" + inline(esc(hm[2])) + "</h" + lvl + ">");
        continue;
      }

      // 分隔线 --- *** ___
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) {
        flushPara(); closeListsTo(0);
        out.push("<hr>");
        continue;
      }

      // 引用 >（连续引用行合并为一个 blockquote）
      var bm = line.match(/^>\s?(.*)$/);
      if (bm) {
        flushPara(); closeListsTo(0);
        var quote = [bm[1]];
        while (i + 1 < lines.length && lines[i + 1].trim().match(/^>\s?(.*)$/)) {
          i++;
          quote.push(lines[i].trim().replace(/^>\s?/, ""));
        }
        out.push("<blockquote>" + quote.map(function (l) { return inline(esc(l)); }).join("<br>") + "</blockquote>");
        continue;
      }

      // 列表项：- * + 无序；1. 1、 1) 有序；缩进≥2 空格视为第二级
      var indent = (raw.match(/^\s*/) || [""])[0].length;
      var um = line.match(/^[-*+]\s+(.*)$/);
      var om = line.match(/^\d{1,3}[.、)]\s+(.*)$/);
      if (um || om) {
        flushPara();
        var depth = (indent >= 2 && listStack.length >= 1) ? 1 : 0;
        var type = um ? "ul" : "ol";
        closeListsTo(depth + 1);
        if (listStack.length < depth + 1) { out.push("<" + type + ">"); listStack.push(type); }
        else if (listStack[depth] !== type) { out.push("</" + listStack.pop() + ">"); out.push("<" + type + ">"); listStack.push(type); }
        out.push("<li>" + inline(esc(um ? um[1] : om[1])) + "</li>");
        continue;
      }

      // 普通段落行
      para.push(line);
    }

    if (inCode && codeBuf.length) out.push("<pre><code>" + esc(codeBuf.join("\n")) + "</code></pre>");
    flushPara();
    closeListsTo(0);
    return out.join("");
  };

  // 纯文本场景（如列表摘要）：剥离 Markdown 语法标记、保留文字语义
  window.stripAiMarkdown = function (text) {
    if (!text) return "";
    return String(text)
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/^\s*>\s?/gm, "")
      .replace(/^\s*[-*+]\s+/gm, "")
      .replace(/^\s*\d{1,3}[.、)]\s+/gm, "")
      .replace(/^(-{3,}|\*{3,}|_{3,})$/gm, "")
      .replace(/```[^\n]*\n?/g, "")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/\*([^*\n]+)\*/g, "$1")
      .trim();
  };
})();
