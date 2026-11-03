// ===== 测评报告独立页：读取 sessionStorage 结果，按角色（学生整合 / 教师专业）渲染 =====
// 学生直访 /student/reports（无 sessionStorage）时：自动拉取最新一期文本报告 + 配套视频数据渲染，
// 文本报告与视频报告在同一页面内分模块完整呈现。
(function () {
  const STORAGE_KEY = 'scl90_report';

  const emptyPanel = document.getElementById('emptyPanel');
  const resultPanel = document.getElementById('resultPanel');
  const reportMeta = document.getElementById('reportMeta');
  const crisisBox = document.getElementById('crisisBox');
  const roleChip = document.getElementById('roleChip');

  // 情绪中文名映射（与 face.js 一致）
  const EMOTION_CN = {
    anger: '愤怒', disgust: '厌恶', fear: '恐惧',
    happiness: '快乐', sadness: '悲伤', surprise: '惊讶', unknown: '未识别',
  };

  function fmtTime(ts) {
    return new Date(ts * 1000).toLocaleString('zh-CN', { hour12: false });
  }

  /**
   * 视频检测整套指标拉取（列表 + 逐份详情补齐 metrics 与 AI 正文）
   * 返回 { emotions, face_activity, dominant_emotion, emotion_max, au, records:[...] }
   * records[0]=最新，每条含 ts（秒）/ date / emotions / face_activity / report / top_factor，
   * 供视频模块按文本报告提交时间配对切换。
   */
  function fetchFaceBundle() {
    return fetch('/api/face/reports')
      .then(r => r.json()).catch(() => ({}))
      .then(vd => {
        const vlist = (vd && vd.reports) || [];
        if (!vlist.length) return { emotions: {}, face_activity: 0, dominant_emotion: '', au: {}, records: [] };
        return Promise.all(vlist.slice(0, 10).map(v =>
          fetch('/api/face/report/' + v.id)
            .then(r => r.ok ? r.json() : {})
            .catch(() => ({}))
        )).then(details => {
          const m0 = (details[0] && details[0].metrics) || {};
          return {
            emotions: m0.emotions || {},
            face_activity: m0.face_activity || 0,
            dominant_emotion: m0.dominant_emotion || '',
            emotion_max: m0.emotion_max || {},
            au: m0.au || {},
            records: details.map((dt, i) => {
              const m = (dt && dt.metrics) || {};
              return {
                date: fmtTime(vlist[i].created_at).slice(0, 10),
                ts: vlist[i].created_at,
                emotions: m.emotions || {},
                face_activity: m.face_activity || 0,
                report: (dt && dt.report) || '',
                top_factor: (dt && dt.top_factor) || '',
              };
            }),
          };
        });
      });
  }

  /**
   * 直访兜底：无 sessionStorage 时自动加载最新一期整合报告
   * 拉到数据后写入 sessionStorage 并刷新，复用下方既有渲染管线。
   */
  function autoLoadLatest() {
    return fetch('/api/student/reports')
      .then(r => r.ok ? r.json() : {})
      .catch(() => ({}))
      .then(d => {
        const list = (d && d.reports) || [];
        if (!list.length) return false;
        return fetch('/api/student/report/' + list[0].id)
          .then(r => r.ok ? r.json() : {})
          .catch(() => ({}))
          .then(td => {
            if (!td || !td.scores) return false;
            const crisis = td.scores['危机信号'] && Object.keys(td.scores['危机信号']).length > 0;
            return fetchFaceBundle().then(face => {
              sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
                scores: td.scores,
                has_crisis: crisis,
                crisis_message: crisis ? '⚠️ 本次测评中你勾选了危机信号题目，请记得寻求专业帮助：400-161-9995' : '',
                report: td.report,
                scenario_name: td.scenario_name,
                submitted_at: td.submitted_at,
                viewer_role: 'student',
                face: face,
              }));
              window.location.reload();
              return true;
            });
          });
      });
  }

  let payload = null;
  try {
    payload = JSON.parse(sessionStorage.getItem(STORAGE_KEY));
  } catch (e) {
    payload = null;
  }

  if (!payload || !payload.scores) {
    // 学生整合报告页直访：自动加载最新一期；无任何测评记录才显示空态
    autoLoadLatest().then(ok => { if (!ok) emptyPanel.hidden = false; });
    return;
  }

  const s = payload.scores;
  const isTeacher = payload.viewer_role === 'teacher';

  // 学生端未附带视频数据（/test 提交后跳转的旧写入）或格式过旧（records 缺 ts）：
  // 补齐整套视频指标后刷新
  const faceStale = !payload.face || !(payload.face.records || []).every(r => r.ts);
  if (!isTeacher && faceStale) {
    fetchFaceBundle().then(face => {
      payload.face = face;
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
      window.location.reload();
    });
    return;
  }

  resultPanel.hidden = false;

  // ---------- 角色徽章 ----------
  roleChip.textContent = isTeacher ? '👩‍🏫 教师专业视图' : '🙋 我的整合报告';
  roleChip.classList.add(isTeacher ? 'role-teacher' : 'role-student');

  // ---------- 教师视图：「AI 干预建议」入口（跳独立全屏页，携带学生ID与报告ID） ----------
  if (isTeacher) {
    const aiBtn = document.getElementById('aiInterventionBtn');
    aiBtn.hidden = false;
    aiBtn.addEventListener('click', () => {
      const sid = payload.student_id || '';
      const rid = payload.report_id || '';
      if (!sid) { alert('缺少学生标识，请从班级报告列表点击「查看报告」进入后重试'); return; }
      window.location.href = '/teacher/intervention?student_id=' + encodeURIComponent(sid)
        + '&report_id=' + encodeURIComponent(rid);
    });
  }

  // ---------- 元信息 ----------
  const scenarioName = payload.scenario_name || '通用';
  const time = payload.submitted_at
    ? new Date(payload.submitted_at).toLocaleString('zh-CN', { hour12: false })
    : '';
  reportMeta.textContent = `测评人群：${scenarioName}　|　提交时间：${time}`;

  // ---------- 危机信号 ----------
  if (payload.has_crisis && payload.crisis_message) {
    crisisBox.textContent = payload.crisis_message;
    crisisBox.hidden = false;
  }

  // ---------- 左侧：个人信息栏 ----------
  const studentName = payload.student_name || (isTeacher ? '' : '我');
  const infoRows = [
    ['姓名', studentName || '—'],
    ['性别', payload.gender || '—'],
    ['年龄', payload.age || '—'],
    ['身份', isTeacher ? '学生（教师端查看）' : scenarioName],
    ['班级', payload.class || '—'],
    ['检测时间', time || '—'],
  ];
  document.getElementById('infoRows').innerHTML = infoRows.map(r =>
    `<div class="info-row"><span class="ik">${r[0]}</span><span class="iv">${r[1]}</span></div>`
  ).join('');

  // ---------- 历史检测记录 + 综合状态趋势 ----------
  function fmtDate(ms) { return new Date(ms).toLocaleDateString('zh-CN'); }

  function renderHistory(list) {
    const ul = document.getElementById('historyList');
    if (!list || !list.length) {
      ul.innerHTML = '<li class="h-empty">暂无历史记录</li>';
      return;
    }
    ul.innerHTML = list.map(r => {
      const ts = r.created_at ? r.created_at * 1000 : (r.submitted_at || 0);
      return `<li class="h-item" data-id="${r.id}">` +
        `<span class="h-date">${fmtDate(ts)}</span>` +
        `<span class="h-score${r.total_score > 200 ? ' warn' : ''}">${r.total_score ?? '—'}</span>` +
        (r.crisis ? '<span class="h-crisis">⚠️</span>' : '') +
        '</li>';
    }).join('');
    ul.querySelectorAll('.h-item').forEach(li => {
      li.addEventListener('click', () => loadReportById(li.dataset.id));
    });
  }

  /** 趋势折线图（SVG 手绘） */
  function renderTrend(list) {
    const box = document.getElementById('trendChart');
    const pts = (list || []).slice().reverse()
      .map(r => ({ v: r.total_score, t: r.created_at }))
      .filter(p => p.v != null);
    if (pts.length < 2) {
      box.innerHTML = '<p class="h-empty">至少 2 次检测后显示趋势</p>';
      return;
    }
    const W = 250, H = 130, padL = 26, padR = 10, padT = 12, padB = 18;
    const iw = W - padL - padR, ih = H - padT - padB;
    const vs = pts.map(p => p.v);
    const min = Math.min(...vs, 90), max = Math.max(...vs, 150);
    const stepX = iw / (pts.length - 1);
    const xy = pts.map((p, i) => ({
      x: padL + i * stepX,
      y: padT + (1 - (p.v - min) / Math.max(1, max - min)) * ih,
      v: p.v,
    }));
    let grid = '';
    for (let g = 0; g <= 3; g++) {
      const gy = padT + ih * g / 3;
      grid += `<line x1="${padL}" y1="${gy}" x2="${W - padR}" y2="${gy}" stroke="rgba(126,200,242,0.16)"/>`;
      grid += `<text x="${padL - 4}" y="${gy + 3}" text-anchor="end" class="ax">${Math.round(max - (max - min) * g / 3)}</text>`;
    }
    const line = xy.map((p, i) => (i ? 'L' : 'M') + p.x + ',' + p.y).join(' ');
    const area = line + ` L${xy[xy.length - 1].x},${H - padB} L${xy[0].x},${H - padB} Z`;
    const nodes = xy.map((p, i) => {
      const cur = i === xy.length - 1;
      return `<circle cx="${p.x}" cy="${p.y}" r="${cur ? 5 : 3.5}" class="node${cur ? ' cur' : ''}"><title>${p.v} 分</title></circle>`;
    }).join('');
    box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" class="line-svg">
      <defs><linearGradient id="trendArea" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="rgba(126,200,242,0.5)"/>
        <stop offset="100%" stop-color="rgba(126,200,242,0.04)"/></linearGradient></defs>
      ${grid}
      <path d="${area}" fill="url(#trendArea)"/>
      <path d="${line}" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" opacity="0.9"/>
      <path d="${line}" fill="none" stroke="#3a9bd8" stroke-width="2" stroke-linecap="round"/>
      ${nodes}</svg>`;
  }

  /** 点击历史记录：走既有详情接口重载本页数据 */
  function loadReportById(id) {
    if (!id) return;
    const url = isTeacher ? '/api/teacher/report/' + id : '/api/student/report/' + id;
    fetch(url)
      .then(r => r.json().then(d => ({ ok: r.ok, d })))
      .then(res => {
        if (!res.ok || res.d.error) { alert(res.d.error || '报告加载失败'); return; }
        const p = Object.assign({}, res.d, {
          viewer_role: payload.viewer_role,
          student_name: res.d.student_name || payload.student_name,
          scenario_name: res.d.scenario_name,
          submitted_at: res.d.submitted_at,
          history: payload.history,
          face: payload.face,   // 视频整套参数不随文本详情接口返回，沿用已拉取的原始数据
        });
        if (p.scores) {
          sessionStorage.setItem(STORAGE_KEY, JSON.stringify(p));
          window.location.reload();
        }
      })
      .catch(e => alert('网络错误：' + e.message));
  }

  // 历史数据来源：写入端 payload.history（教师端已带）；学生端复用既有列表接口
  if (payload.history) {
    renderHistory(payload.history);
    renderTrend(payload.history);
  } else if (!isTeacher) {
    fetch('/api/student/reports')
      .then(r => r.json())
      .then(d => {
        const list = (d.reports || []).slice(0, 10);
        renderHistory(list);
        renderTrend(list);
      })
      .catch(() => renderHistory(null));
  } else {
    renderHistory(null);
    renderTrend(null);
  }

  // ---------- 学生简化视图 ----------
  const studentSimple = document.getElementById('studentSimple');
  const videoCol = document.getElementById('videoCol');
  const textCol = document.getElementById('textCol');

  function verdictOf() {
    const total = s['总分'] || 0;
    if (payload.has_crisis) return { txt: '测评中出现了需要认真对待的信号，请务必联系专业心理老师或拨打心理援助热线 400-161-9995。', cls: 'bad' };
    if (total > 200) return { txt: '近期可能存在一些心理困扰，建议关注自己的情绪变化，必要时与心理老师聊一聊。', cls: 'warn' };
    if (total > 160) return { txt: '整体状态尚可，个别方面有些波动，注意规律作息与心情调节。', cls: 'mid' };
    return { txt: '整体心理状态良好，请继续保持健康的生活与学习节奏。', cls: 'ok' };
  }

  if (!isTeacher) {
    studentSimple.hidden = false;
    const v = verdictOf();
    const vt = document.getElementById('verdictText');
    vt.textContent = v.txt;
    vt.classList.add('v-' + v.cls);
    const report = payload.report || '';
    const aiFailed = !report || report.indexOf('（AI 报告生成失败') === 0;
    const adviceEl = document.getElementById('adviceText');
    if (aiFailed) {
      adviceEl.textContent = 'AI 服务当前不可用，请稍后再试；可先参考上方的整体状态结论。';
    } else {
      // Markdown 语法转正式文档排版（去 ** ## - 等标记，保留语义）
      adviceEl.innerHTML = renderAiMarkdown(report);
      adviceEl.classList.add('md-out');
    }
    // ---------- 学生整合视图：视频心理测试报告模块 ----------
    // 配对规则：取「提交时间之前最近一次」视频检测；该期之前无记录则取最新一次，
    // 与文本报告一一对应；历史切换（reload 后按新 submitted_at）自动同步。
    const studentVideo = document.getElementById('studentVideo');
    studentVideo.hidden = false;
    (function renderStudentVideo() {
      const metaEl = document.getElementById('videoMeta');
      const bodyEl = document.getElementById('videoReportText');
      const face = payload.face || {};
      const recs = face.records || [];
      if (!recs.length) {
        metaEl.textContent = '';
        bodyEl.textContent = '暂无视频心理检测报告，去录制一段面部视频分析吧。';
        return;
      }
      const subSec = (payload.submitted_at || 0) / 1000;
      const rec = recs.find(r => r.ts <= subSec) || recs[0];
      metaEl.textContent = '主导情绪：' + (EMOTION_CN[rec.top_factor] || rec.top_factor || '—')
        + '　检测时间：' + (rec.ts ? fmtTime(rec.ts) : rec.date);
      if (rec.report) {
        bodyEl.innerHTML = renderAiMarkdown(rec.report);
        bodyEl.classList.add('md-out');
      } else {
        bodyEl.textContent = '（本期视频检测暂无 AI 分析正文）';
      }
    })();
    // 学生简化视图：隐藏专业图表区
    document.querySelector('.report-main').classList.add('simple-mode');
  } else {
    // ---------- 教师专业视图：文本测评栏 ----------
    textCol.hidden = false;

    // 阴性均分由总分/阳性项目数/PSDI 反推（标准公式）
    const posN = s['阳性项目数'] || 0;
    const psdi = s['阳性症状均分'] || 0;
    const negAvg = posN < 90
      ? (((s['总分'] || 0) - posN * psdi) / (90 - posN)).toFixed(2)
      : '—';

    const kpis = [
      { num: s['总分'], lbl: '总分（90-450）' },
      { num: s['总均分'], lbl: '总体严重指数 GSI' },
      { num: posN, lbl: '阳性项目数' },
      { num: psdi, lbl: '痛苦指数 PSI（阳性症状均分）' },
      { num: negAvg, lbl: '阴性均分' },
    ];
    document.getElementById('kpiRow').innerHTML = kpis.map(k =>
      `<div class="kpi glass"><div class="num hl-num">${k.num}</div><div class="lbl"><span class="txt-hl">${k.lbl}</span></div></div>`
    ).join('');

    // 因子条（蓝/绿/黄/橙分级）
    const sevClass = code => (code >= 3 ? 'bad' : code >= 1 ? 'warn' : '');
    const factorBars = document.getElementById('factorBars');
    factorBars.innerHTML = Object.entries(s['因子分']).map(([name, f]) => {
      const pct = Math.max(4, Math.min(100, ((f['均分'] - 1) / 4) * 100));
      const cls = sevClass(f['严重程度代码']);
      return `
        <div class="bar-row">
          <span class="bar-name txt-hl">${name}</span>
          <div class="bar-track"><div class="bar-fill ${cls}" data-w="${pct}"></div></div>
          <span class="bar-val txt-hl"><b class="${cls}">${f['均分'].toFixed(2)}</b>
            常模${f['常模均值'].toFixed(2)} · Z=${f['标准差倍数'].toFixed(2)} · ${f['严重程度']}</span>
        </div>`;
    }).join('');
    requestAnimationFrame(() => {
      factorBars.querySelectorAll('.bar-fill').forEach(el => { el.style.width = el.dataset.w + '%'; });
    });

    // 六种情绪变化趋势（视频情绪识别输出）：六张小图，两列 × 每列三张
    // 多条历史检测 → 每张画趋势折线；仅单次 → 只画单点标记 + 数值标签，不画折线
    (function drawEmotionTrends() {
      const box = document.getElementById('emotionTrends');
      const face = payload.face;
      const EMO = [
        ['anger', '愤怒'], ['disgust', '厌恶'], ['fear', '恐惧'],
        ['happiness', '快乐'], ['sadness', '悲伤'], ['surprise', '惊讶'],
      ];
      const recs = (face && face.records && face.records.length ? face.records.slice() : [])
        .reverse();   // records[0]=最新 → 反转为时间升序
      if (!recs.length) {
        box.innerHTML = '<p class="h-empty">暂无视频情绪检测数据</p>';
        return;
      }
      const multi = recs.length >= 2;
      box.innerHTML = EMO.map(([key, cn]) => {
        const W = 300, H = 130, padL = 30, padR = 12, padT = 12, padB = 22;
        const iw = W - padL - padR, ih = H - padT - padB;
        const n = recs.length;
        const X = i => n === 1 ? padL + iw / 2 : padL + iw * i / (n - 1);
        const vals = recs.map(r => Math.max(0, Math.min(1, (r.emotions && r.emotions[key]) || 0)));
        const Y = v => padT + (1 - v) * ih;
        let grid = '';
        for (let g = 0; g <= 2; g++) {
          const gy = padT + ih * g / 2;
          grid += `<line x1="${padL}" y1="${gy}" x2="${W - padR}" y2="${gy}" stroke="rgba(126,200,242,0.16)"/>`;
          grid += `<text x="${padL - 4}" y="${gy + 3}" text-anchor="end" class="ax">${100 - g * 50}%</text>`;
        }
        let body = '';
        if (multi) {
          const path = vals.map((v, i) => (i ? 'L' : 'M') + X(i).toFixed(1) + ',' + Y(v).toFixed(1)).join(' ');
          body += `<path d="${path}" fill="none" stroke="rgba(58,155,216,0.12)" stroke-width="12" stroke-linecap="round"/>`;
          body += `<path d="${path}" fill="none" stroke="#3a9bd8" stroke-width="2" stroke-linecap="round"/>`;
          body += vals.map((v, i) =>
            `<circle cx="${X(i).toFixed(1)}" cy="${Y(v).toFixed(1)}" r="${i === n - 1 ? 4.5 : 3}" class="node" style="${i === n - 1 ? '' : 'fill:#fff;stroke:#3a9bd8;stroke-width:1.6'}"><title>${recs[i].date || ''} ${Math.round(v * 100)}%</title></circle>`
          ).join('');
          const last = vals[n - 1];
          body += `<text x="${(X(n - 1) - 2).toFixed(1)}" y="${(Y(last) - 8).toFixed(1)}" text-anchor="end" class="ax" style="fill:var(--hl-num);font-weight:700">${Math.round(last * 100)}%</text>`;
        } else {
          body += `<circle cx="${X(0).toFixed(1)}" cy="${Y(vals[0]).toFixed(1)}" r="6" class="node cur"><title>${Math.round(vals[0] * 100)}%</title></circle>`;
          body += `<text x="${(X(0) + 10).toFixed(1)}" y="${(Y(vals[0]) + 4).toFixed(1)}" class="ax" style="fill:var(--hl-num);font-weight:700">${Math.round(vals[0] * 100)}%</text>`;
        }
        const xLabels = multi
          ? `<text x="${X(0).toFixed(1)}" y="${H - 6}" text-anchor="start" class="ax">${recs[0].date || ''}</text>
             <text x="${X(n - 1).toFixed(1)}" y="${H - 6}" text-anchor="end" class="ax">${recs[n - 1].date || ''}</text>`
          : `<text x="${X(0).toFixed(1)}" y="${H - 6}" text-anchor="middle" class="ax">${recs[0].date || '本次检测'}</text>`;
        return `<div class="emo-mini"><h5><span class="txt-hl">${cn}</span></h5>
          <svg viewBox="0 0 ${W} ${H}" class="line-svg">${grid}${body}${xLabels}</svg></div>`;
      }).join('');
    })();

    // AI 解读（教师：完整正文；失败时降级参数表）
    const aiTitle = document.getElementById('aiTitle');
    const reportText = document.getElementById('reportText');
    const report = payload.report || '';
    const aiFailed = !report || report.indexOf('（AI 报告生成失败') === 0;
    if (aiFailed) {
      aiTitle.textContent = '测评参数结果';
      const rows = [];
      rows.push(['总分', s['总分']]);
      rows.push(['总体严重指数 GSI', s['总均分']]);
      rows.push(['阳性项目数', s['阳性项目数']]);
      rows.push(['痛苦指数 PSI', s['阳性症状均分']]);
      rows.push(['阴性均分', negAvg]);
      Object.entries(s['因子分']).forEach(([name, f]) => {
        rows.push([`因子 · ${name}`, `均分 ${f['均分'].toFixed(2)}（常模 ${f['常模均值'].toFixed(2)}，Z=${f['标准差倍数'].toFixed(2)}，${f['严重程度']}）`]);
      });
      reportText.innerHTML =
        '<p class="ai-off">AI 服务当前不可用，以下仅展示各参数对应值：</p>' +
        '<table class="param-table"><tbody>' +
        rows.map(r => `<tr><td class="pk">${r[0]}</td><td class="pv">${r[1]}</td></tr>`).join('') +
        '</tbody></table>';
    } else {
      // Markdown 语法转正式文档排版（去 ** ## - 等标记，保留语义）
      reportText.innerHTML = renderAiMarkdown(report);
      reportText.classList.add('md-out');
    }

    // ---------- 视频分析栏：payload 附带 face 指标才渲染，否则占位 ----------
    videoCol.hidden = false;
    const face = payload.face;
    if (face && face.emotions && Object.keys(face.emotions).length) {
      renderVideoCol(face);
    } else {
      videoCol.querySelector('.video-grid').innerHTML =
        '<div class="glass video-empty">本报告未附带视频检测数据。学生完成面部视频分析后，情绪参数与分级曲线将在此联动展示。</div>';
      document.getElementById('estTip').hidden = true;
    }
  }

  /** 视频栏渲染（有 face 指标时） */
  function renderVideoCol(m) {
    const EMOTION_CN = {
      anger: '愤怒', disgust: '厌恶', fear: '恐惧',
      happiness: '快乐', sadness: '悲伤', surprise: '惊讶',
    };
    // 多次检测原始参数（[0]=最新）；仅 1 次时全部图表只渲染单点+数值标签，不画折线
    const recs = (m.records && m.records.length ? m.records : [{
      date: '', emotions: m.emotions || {}, face_activity: m.face_activity || 0,
    }]).slice().reverse();   // 升序（旧→新）
    const multi = recs.length >= 2;
    const emoKeys = Object.keys(m.emotions || EMOTION_CN);

    // 情绪参数表：七种情绪 均值/峰值 + 主导情绪
    const et = document.getElementById('emotionTable');
    et.innerHTML = '<table class="emotion-tb"><thead><tr><th>情绪</th><th>均值</th><th>峰值</th></tr></thead><tbody>' +
      emoKeys.map(k =>
        `<tr><td><span class="txt-hl">${EMOTION_CN[k] || k}</span></td><td>${((m.emotions[k] || 0) * 100).toFixed(1)}%</td><td>${((m.emotion_max && m.emotion_max[k] || m.emotions[k] || 0) * 100).toFixed(1)}%</td></tr>`
      ).join('') +
      `<tr><td><span class="txt-hl">主导情绪</span></td><td colspan="2">${EMOTION_CN[m.dominant_emotion] || m.dominant_emotion || '—'}</td></tr>` +
      '</tbody></table>';

    // 生理诊断指标：面部检出活跃度 + AU 动作单元（有数据才展示）
    const pc = document.getElementById('physioCard');
    const aus = Object.entries(m.au || {});
    pc.innerHTML =
      `<table class="emotion-tb"><tbody>` +
      `<tr><td>面部检出活跃度</td><td><b class="hl-num">${((m.face_activity || 0) * 100).toFixed(1)}%</b></td></tr>` +
      (aus.length ? aus.map(([k, v]) =>
        `<tr><td>${k} ${(v && v.label) || ''}</td><td>均值 ${(((v && v.mean) || 0) * 100).toFixed(0)}% · 峰值 ${(((v && v.max) || 0) * 100).toFixed(0)}%</td></tr>`
      ).join('') : '<tr><td colspan="2" style="color:var(--ink-pale)">本次检测未返回 AU 生理参数</td></tr>') +
      `</tbody></table>`;

    // 心态分布曲线（最新一次检测）：平滑曲线 + 每点数值标签
    const box = document.getElementById('emotionCurve');
    const keys = emoKeys;
    if (keys.length) {
      const W = 480, H = 180, padL = 34, padR = 14, padT = 14, padB = 26;
      const iw = W - padL - padR, ih = H - padT - padB;
      const stepX = iw / Math.max(1, keys.length - 1);
      const pts = keys.map((k, i) => ({
        x: padL + i * stepX,
        y: padT + (1 - Math.max(0, Math.min(1, m.emotions[k] || 0))) * ih,
        v: m.emotions[k] || 0, k,
      }));
      let grid = '';
      for (let g = 0; g <= 4; g++) {
        const gy = padT + ih * g / 4;
        grid += `<line x1="${padL}" y1="${gy}" x2="${W - padR}" y2="${gy}" stroke="rgba(126,200,242,0.16)"/>`;
      }
      const d = pts.map((p, i) => (i ? 'L' : 'M') + p.x + ',' + p.y).join(' ');
      const refY = padT + (1 - 1 / keys.length) * ih;
      box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" class="line-svg">
        ${grid}
        <line x1="${padL}" y1="${refY}" x2="${W - padR}" y2="${refY}" stroke="#3a9bd8" stroke-width="1.2" stroke-dasharray="5 4"/>
        <path d="${d}" fill="none" stroke="rgba(111,194,151,0.16)" stroke-width="16" stroke-linecap="round"/>
        <path d="${d}" fill="none" stroke="#6fc297" stroke-width="2.4" stroke-linecap="round"/>
        ${pts.map(p => `<circle cx="${p.x}" cy="${p.y}" r="4" class="node"><title>${EMOTION_CN[p.k] || p.k} ${Math.round(p.v * 100)}%</title></circle>`).join('')}
        ${pts.map(p => `<text x="${p.x}" y="${Math.max(p.y - 8, 10)}" text-anchor="middle" class="ax" style="font-weight:700;fill:var(--hl-num)">${Math.round(p.v * 100)}%</text>`).join('')}
        ${pts.map(p => `<text x="${p.x}" y="${H - 8}" text-anchor="middle" class="ax">${EMOTION_CN[p.k] || p.k}</text>`).join('')}
      </svg>`;
    }

    // 视频参数变化趋势：疲劳度/集中力/压力度/情绪状态 四条派生指标曲线
    // 多条历史 → 完整趋势折线；仅单次 → 单点标记 + 数值标签，不画折线
    function derive(emotions, activity) {
      const neg = (emotions.anger || 0) + (emotions.disgust || 0) + (emotions.fear || 0) + (emotions.sadness || 0);
      return [
        Math.round(Math.min(1, Math.max(0, (1 - activity) * 0.6 + neg * 0.6)) * 100),
        Math.round(Math.max(0, 100 - Math.abs(activity - 0.5) * 160)),
        Math.round(Math.min(1, neg) * 100),
        Math.round(Math.min(1, (emotions.happiness || 0) + (emotions.surprise || 0)) * 100),
      ];
    }
    const SERIES = [
      { name: '大脑疲劳度', color: '#e8935a' },
      { name: '集中力', color: '#3a9bd8' },
      { name: '压力度', color: '#d9a520' },
      { name: '情绪状态', color: '#6fc297' },
    ];
    const vt = document.getElementById('videoTrend');
    const series = recs.map(r => derive(r.emotions, r.face_activity));
    const dates = recs.map(r => r.date);
    (function drawTrend() {
      const W = 640, H = 210, padL = 34, padR = 14, padT = 16, padB = 28;
      const iw = W - padL - padR, ih = H - padT - padB;
      const n = series.length;
      const X = i => n === 1 ? padL + iw / 2 : padL + iw * i / (n - 1);
      const Y = v => padT + (1 - Math.max(0, Math.min(100, v)) / 100) * ih;
      let grid = '';
      for (let g = 0; g <= 4; g++) {
        const gy = padT + ih * g / 4;
        grid += `<line x1="${padL}" y1="${gy}" x2="${W - padR}" y2="${gy}" stroke="rgba(126,200,242,0.16)"/>`;
        grid += `<text x="${padL - 5}" y="${gy + 3}" text-anchor="end" class="ax">${100 - g * 25}</text>`;
      }
      let body = '';
      SERIES.forEach((sr, si) => {
        const vals = series.map(s => s[si]);
        if (multi) {
          const path = vals.map((v, i) => (i ? 'L' : 'M') + X(i).toFixed(1) + ',' + Y(v).toFixed(1)).join(' ');
          body += `<path d="${path}" fill="none" stroke="${sr.color}" stroke-width="2" stroke-linecap="round" opacity="0.9"/>`;
          body += vals.map((v, i) =>
            `<circle cx="${X(i).toFixed(1)}" cy="${Y(v).toFixed(1)}" r="${i === vals.length - 1 ? 4.5 : 3}" class="node" style="fill:${sr.color}"><title>${dates[i] || ''} ${sr.name} ${v}</title></circle>`
          ).join('');
          const last = vals[vals.length - 1];
          body += `<text x="${(X(vals.length - 1) + 6).toFixed(1)}" y="${(Y(last) + 3).toFixed(1)}" class="ax" style="fill:${sr.color};font-weight:700">${last}</text>`;
        } else {
          // 单次检测：仅最新一组参数标记点 + 数值标签
          body += `<circle cx="${X(0).toFixed(1)}" cy="${Y(vals[0]).toFixed(1)}" r="6" class="node cur" style="fill:${sr.color}"><title>${sr.name} ${vals[0]}</title></circle>`;
          body += `<text x="${(X(0) + 12).toFixed(1)}" y="${(Y(vals[0]) + 4).toFixed(1)}" class="ax" style="fill:${sr.color};font-weight:700">${sr.name} ${vals[0]}</text>`;
        }
      });
      const xLabels = multi
        ? dates.map((d, i) => `<text x="${X(i).toFixed(1)}" y="${H - 8}" text-anchor="middle" class="ax">${d}</text>`).join('')
        : `<text x="${X(0).toFixed(1)}" y="${H - 8}" text-anchor="middle" class="ax">${dates[0] || '本次检测'}（单次记录）</text>`;
      vt.innerHTML = `<svg viewBox="0 0 ${W} ${H}" class="line-svg">${grid}${body}${xLabels}</svg>`;
    })();

    // 启发式分级卡（基于最新一次检测）
    const emotions = m.emotions || {};
    const neg = (emotions.anger || 0) + (emotions.disgust || 0) + (emotions.fear || 0) + (emotions.sadness || 0);
    const activity = m.face_activity || 0;
    const cards = [
      { name: '大脑疲劳度', val: Math.round(Math.min(1, Math.max(0, (1 - activity) * 0.6 + neg * 0.6)) * 100), dir: 'low' },
      { name: '集中力', val: Math.round(Math.max(0, 100 - Math.abs(activity - 0.5) * 160)), dir: 'high' },
      { name: '压力度', val: Math.round(Math.min(1, neg) * 100), dir: 'low' },
      { name: '情绪状态', val: Math.round(Math.min(1, (emotions.happiness || 0) + (emotions.surprise || 0)) * 100), dir: 'high' },
    ];
    function grade(v, dir) {
      const good = dir === 'high' ? v : 100 - v;
      if (good >= 70) return { txt: '良好', cls: 'ok' };
      if (good >= 45) return { txt: '需关注', cls: 'warn' };
      return { txt: '重点', cls: 'focus' };
    }
    document.getElementById('indexCards').innerHTML = cards.map(c => {
      const g = grade(c.val, c.dir);
      return `<div class="index-card glass">
        <div class="idx-name txt-hl">${c.name}</div>
        <div class="idx-val hl-num">${c.val}</div>
        <div class="idx-bar"><span class="idx-fill ${g.cls}" style="width:${c.val}%"></span></div>
        <div class="idx-grade ${g.cls}">${g.txt}</div>
      </div>`;
    }).join('');
    document.getElementById('estTip').hidden = false;
  }

  // ---------- 导出 PDF：调用浏览器打印，目标选「另存为 PDF」 ----------
  document.getElementById('exportPdfBtn').addEventListener('click', function () {
    const factorBars = document.getElementById('factorBars');
    if (factorBars) {
      factorBars.querySelectorAll('.bar-fill').forEach(function (el) {
        el.style.transition = 'none';
        el.style.width = el.dataset.w + '%';
      });
    }
    window.print();
  });
})();
