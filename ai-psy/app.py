# -*- coding: utf-8 -*-
"""
心理测试分析网站 - Flask 后端主程序（运行于 pyfeat_env，端口 6006）

三大功能：
  1. AI 聊天助手   /api/chat            多轮对话 + 三人群 system prompt 切换
  2. 人脸视频分析  /api/face/analyze    前端录制上传 -> py-feat -> 大模型报告
  3. 场景化测评    题库与计分在前端（static/js/scl90_data.js + test.js）
                 /api/test/submit      前端计分结果归档 + 大模型解读报告

启动：
  python app.py            # 正式模式（需 vLLM 8000 端口 + py-feat 就绪）
  python app.py --mock     # 本地演示模式（无 GPU / 无 py-feat 也可启动）
"""
import argparse
import io
import json
import os
import random
import re
import sqlite3
import time
import uuid
from datetime import datetime

from flask import Flask, jsonify, redirect, request, send_file, send_from_directory, session
from werkzeug.security import check_password_hash, generate_password_hash

import config
import create_db
import feat_analyzer
import llm_client
from rf import predictor

# ==================== 初始化 ====================
app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = config.MAX_CONTENT_LENGTH
app.secret_key = config.SECRET_KEY

# 页面目录：static/html；静态资源：static/js、static/css、static/data
HTML_DIR = os.path.join("static", "html")
STATIC_DIR = "static"

os.makedirs(config.UPLOAD_DIR, exist_ok=True)


def _cleanup_stale_uploads():
    """启动时清理 UPLOAD_DIR 残留视频（用户面部隐私保护）。

    正常请求在 api_face_analyze 的 finally 中即已删除暂存视频；
    能残留到进程重启的文件必为异常终止（崩溃/强杀）遗留，一律删除。
    注意：本服务为单进程部署（app.run），若未来改多 worker 需重新评估时序竞争。
    """
    removed = 0
    try:
        for fname in os.listdir(config.UPLOAD_DIR):
            fpath = os.path.join(config.UPLOAD_DIR, fname)
            if not os.path.isfile(fpath):
                continue
            try:
                os.remove(fpath)
                removed += 1
            except OSError:
                pass
    except OSError:
        return
    if removed:
        print(f"[privacy] 启动清理异常终止残留视频 {removed} 个：{config.UPLOAD_DIR}")


_cleanup_stale_uploads()

# articles 表补列迁移（source/author/updated_at）仅需执行一次，进程内标记避免每次请求重复 PRAGMA
_ARTICLES_MIGRATED = False


def _page(filename: str):
    """返回 static/html 下的页面文件"""
    return send_from_directory(HTML_DIR, filename)


# ==================== 页面路由 ====================
@app.get("/login")
def login_page():
    """登录 / 注册独立页面：未登录时由 auth.js 守卫跳转至此，成功后按 next 参数回跳"""
    return _page("login.html")


@app.get("/teacher/reports")
def teacher_reports_page():
    """教师管理员页面：查看本班级同学心理测评报告列表"""
    return _page("teacher_reports.html")


@app.get("/student/reports")
def student_reports_page():
    """学生端整合报告页：文本 + 视频心理测试报告同页分模块展示（与 /test/report 复用同一渲染页）"""
    return _page("report.html")


@app.get("/face/reports")
def face_reports_page():
    """原「我的表情报告」独立页已并入「我的心理测试报告」合并页，旧地址重定向"""
    user = session.get("user")
    if user and user.get("role") == "teacher":
        return _page("teacher_reports.html")
    return redirect("/student/reports", code=302)


@app.get("/profile")
def profile_page():
    """个人中心：左侧边栏（个人信息 + 对应功能入口），默认展示个人信息页"""
    return _page("profile.html")


@app.get("/")
def index():
    """首页：三大功能导航；未登录直接 302 跳登录页（后端守卫，避免前端闪烁）"""
    user = session.get("user")
    if not user:
        return redirect("/login?next=/", code=302)
    return _page("index.html")


@app.get("/chat")
def chat_page():
    """AI 聊天助手页（教师不可用）"""
    return _guard_teacher_page() or _page("chat.html")


@app.get("/face")
def face_page():
    """人脸视频分析页（教师不可用）"""
    return _guard_teacher_page() or _page("face.html")


@app.get("/test")
def test_page():
    """心理测评选择页：SCL-90 量表卡片入口（教师不可用）"""
    return _guard_teacher_page() or _page("test_select.html")


@app.get("/test/scl90")
def test_scl90_page():
    """SCL-90 症状自评量表答题页（教师不可用；题库与计分在前端）"""
    return _guard_teacher_page() or _page("test.html")


@app.get("/appointment")
def appointment_page():
    """心理咨询预约页（教师=咨询师，学生预约；教师访问回班级报告页）"""
    return _guard_teacher_page() or _page("appointment.html")


@app.get("/msg")
def msg_list_page():
    """学生端「师生倾诉」会话列表页（教师访问回班级报告页）"""
    return _guard_teacher_page() or _page("msg_list.html")


@app.get("/msg/choose")
def msg_choose_page():
    """学生端「选择倾诉老师」页（教师访问回班级报告页）"""
    return _guard_teacher_page() or _page("msg_choose.html")


@app.get("/msg/chat")
def msg_chat_page():
    """学生端与某老师的倾诉聊天详情页（教师访问回班级报告页）"""
    return _guard_teacher_page() or _page("msg_chat.html")


@app.get("/teacher/msg")
def teacher_msg_list_page():
    """教师端「学生倾诉留言」列表页（仅教师）"""
    return _page("teacher_msg_list.html")


@app.get("/teacher/msg/chat")
def teacher_msg_chat_page():
    """教师端与学生倾诉的聊天详情页（仅教师）"""
    return _page("teacher_msg_chat.html")


@app.get("/articles")
def articles_page():
    """心理科普文章页（仅学生可访问）：列表 + 详情。教师访问回班级报告页（完全隐藏）"""
    return _guard_teacher_page() or _page("articles.html")


@app.get("/teacher/appointment")
def teacher_appointment_page():
    """教师端心理咨询预约管理页（教师=咨询师，排时段 + 审批预约）"""
    return _page("appointment_manage.html")


@app.get("/teacher/materials")
def teacher_materials_page():
    """教师端心理活动素材库页（仅教师；已登录学生访问重定向到自己的合并报告页）"""
    user = session.get("user")
    if user and user.get("role") != "teacher":
        return redirect("/student/reports", code=302)
    return _page("teacher_materials.html")


@app.get("/teacher/articles")
def teacher_articles_page():
    """教师端心理科普文章管理页（仅教师；已登录学生访问重定向到自己的合并报告页）"""
    user = session.get("user")
    if user and user.get("role") != "teacher":
        return redirect("/student/reports", code=302)
    return _page("teacher_articles.html")


@app.get("/test/report")
def test_report_page():
    """测评报告独立页面：由 /test 提交成功后跳转，前端从 sessionStorage 读取结果渲染"""
    return _page("report.html")


@app.get("/teacher/intervention")
def teacher_intervention_page():
    """教师端 AI 综合干预建议全屏页（仅教师；已登录学生访问重定向到自己的合并报告页）"""
    user = session.get("user")
    if user and user.get("role") != "teacher":
        return redirect("/student/reports", code=302)
    return _page("intervention.html")


# 前端静态资源（js / css / data / picture）由 Flask 统一从 static 目录提供
@app.get("/static/<path:relpath>")
def static_files(relpath: str):
    """静态资源路由：/static/js/chat.js、/static/css/index.css、/static/picture/*.svg 等"""
    return send_from_directory(STATIC_DIR, relpath)


# 教师角色仅保留「查看班级测试情况」：/chat、/face、/test、/face/reports
# 页面与对应 API 均拦截（个人中心 /profile、班级报告 /teacher/reports、
# 报告详情复用页 /test/report 不拦截）
def _guard_teacher_page():
    """教师访问测评 / 聊天 / 视频分析等功能页时拦截：跳回班级报告页。
    返回 None 表示放行（未登录由前端 auth.js 守卫处理）。"""
    user = session.get("user")
    if user and user.get("role") == "teacher":
        return _page("teacher_reports.html")
    return None


def _reject_teacher_api():
    """教师角色功能 API 拦截：测评 / 聊天 / 视频分析接口仅学生与游客可用。
    返回 None 表示放行，否则为 403 错误响应。"""
    user = session.get("user")
    if user and user.get("role") == "teacher":
        return jsonify({"error": "教师账号仅保留查看班级测试情况功能"}), 403
    return None


# ==================== 统一业务数据库（psy.db 单库 12 表，按 表格.md 规范） ====================
def _user_table(role: str):
    """按角色返回表名。role: 'student' | 'teacher'"""
    if role == "student":
        return "student"
    if role == "teacher":
        return "teacher"
    return None


def _connect_db():
    """连接统一业务库 psy.db（autodl-fs/psydb/psy.db）。
    库 / 表不存在时自动创建（幂等，无需先跑 create_db.py 即可注册登录）。"""
    global _ARTICLES_MIGRATED
    os.makedirs(config.PSY_DB_DIR, exist_ok=True)
    conn = sqlite3.connect(config.PSY_DB)
    conn.row_factory = sqlite3.Row
    conn.executescript(create_db.DDL)
    if not _ARTICLES_MIGRATED:
        create_db.migrate_articles_columns(conn)
        _ARTICLES_MIGRATED = True
    conn.commit()
    return conn


def _now_ms() -> int:
    """全库统一毫秒时间戳"""
    return int(time.time() * 1000)


def _teacher_classes(tid=None):
    """按教师 id 从 teacher_class 关联表取其绑定的全部班级（class_id，按创建时间升序）。
    teacher.class 列冗余保留（逗号拼接，向后兼容展示），业务查询以本函数为唯一入口。"""
    if not tid:
        return []
    try:
        conn = _connect_db()
        try:
            rows = conn.execute(
                "SELECT class_id FROM teacher_class WHERE teacher_id=? ORDER BY create_timestamp ASC",
                (tid,)).fetchall()
            return [r["class_id"] for r in rows]
        finally:
            conn.close()
    except sqlite3.Error:
        return []


def _validate_class_names(classes):
    """校验班级名称数组：
    - 不能为空（全部是空白字符串也不行）
    - 每个班级名不能包含 , ， 、 等分隔符（禁止用这些做分隔）
    返回 (clean_list, error_message)；error_message 为 None 表示通过。
    """
    if not isinstance(classes, list):
        return [], "班级格式错误"
    clean = []
    for raw_item in classes:
        cleaned_name = str(raw_item).strip() if raw_item is not None else ""
        if not cleaned_name:
            continue
        if re.search(r"[,，、\n\r\t]", cleaned_name):
            return [], f"班级名「{cleaned_name}」不能包含逗号、顿号等分隔符"
        clean.append(cleaned_name)
    if not clean:
        return [], "请至少填写一个班级"
    # 去重（保序）
    seen = set()
    dedup = []
    for c in clean:
        if c not in seen:
            seen.add(c)
            dedup.append(c)
    return dedup, None


def _teacher_name_map(teacher_ids):
    """批量查教师姓名（teacher 表）：{teacher_id: name}；素材列表/详情仅展示姓名不暴露教师 id"""
    ids = list({t for t in teacher_ids if t})
    if not ids:
        return {}
    conn = _connect_db()
    try:
        marks = ",".join("?" * len(ids))
        rows = conn.execute(
            f"SELECT teacher_id, name FROM teacher WHERE teacher_id IN ({marks})",
            ids).fetchall()
        return {r["teacher_id"]: r["name"] for r in rows}
    finally:
        conn.close()


def _make_user_id(no: str) -> str:
    """用户不可见 ID：当前时间 年月日时分秒 + 学号/工号"""
    return datetime.now().strftime("%Y%m%d%H%M%S") + str(no).strip()


def _make_report_id() -> str:
    """报告 ID：当前时间 年月日时分秒 + 4 位随机数（文本测评 / 视频检测通用）"""
    return datetime.now().strftime("%Y%m%d%H%M%S") + f"{random.randint(0, 9999):04d}"


def _ensure_db_schema():
    """
    启动时统一业务库自愈（psy.db 单库 12 表，按 表格.md 规范）：
      库文件 / 目录 / 表不存在：自动创建（幂等，无需先跑 create_db.py 即可注册登录）。
    旧 8 个分库已废弃；全新重建请运行：python create_db.py --wipe
    """
    conn = _connect_db()
    try:
        table_count = conn.execute(
            "SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table'").fetchone()["c"]
        print(f"[db] 统一业务库就绪（{table_count} 张表）：{config.PSY_DB}")
    finally:
        conn.close()


def _text_top_factor(result: dict) -> str:
    """从 SCL-90 计分结果中取均分最大的因子名（文本测试后最大影响因子）。"""
    factors = result.get("因子分") or {}
    best_name, best_avg = "", None
    for name, f in factors.items():
        avg = f.get("均分") if isinstance(f, dict) else None
        if avg is not None and (best_avg is None or avg > best_avg):
            best_name, best_avg = name, avg
    return best_name


# ---------- scl90_text_report 拆列 <-> 前端计分 JSON 互转 ----------
_SCL90_FACTOR_COLS = list(predictor.FACTOR_EN_MAP.values())  # 10 个英文因子列


def _parse_item_answers(raw):
    """前端提交的 90 题原始分 {题号: 1-5} 规整为 {int: int}；缺失/非法返回 None（走规则判定）"""
    if not isinstance(raw, dict) or not raw:
        return None
    out = {}
    for k, v in raw.items():
        try:
            q, s = int(k), int(v)
        except (TypeError, ValueError):
            return None
        if not (1 <= q <= 90 and 1 <= s <= 5):
            return None
        out[q] = s
    return out


def _apply_rf_severity(factors: dict, answers) -> None:
    """文本链路混合模式（与视频链路 feat_analyzer 一致）：随机森林可用则以模型为主，
    模型不可用 / 缺原始答题特征时保留调用方已算好的规则结果，不向业务层抛异常。
    factors: {因子中文名: {"均分"/"严重程度"/"严重程度代码"/...}}，就地修改。"""
    if not answers:
        return
    for cn, f in factors.items():
        avg = f.get("均分")
        if avg is None or cn not in predictor.FACTOR_MAP:
            continue
        res = predictor.predict_factor_severity(
            cn, predictor.text_feature(cn, answers, float(avg)))
        if res is not None:
            f["严重程度"], f["严重程度代码"] = res
            f["严重程度来源"] = "rf"


def _row_item_answers(row):
    """从报告行取 90 题原始分 {题号int: 分值}；旧行无数据或显式列查询缺列时返回 None"""
    try:
        raw_json = row["item_answers"]
    except (IndexError, KeyError):
        return None
    if not raw_json:
        return None
    try:
        return {int(k): int(v) for k, v in json.loads(raw_json).items()}
    except (ValueError, TypeError):
        return None


def build_scl90_scores(row) -> dict:
    """由 scl90_text_report 行的因子均分列重算前端兼容计分 JSON
    （结构与前端 test.js scoreSCL90() 输出逐字段一致；常模/Z 分数/严重程度按中国常模规则重算）。"""
    factors = {}
    for cn, col in predictor.FACTOR_EN_MAP.items():
        avg = row[col]
        if avg is None:
            continue
        norm_mean, norm_std = predictor.CHINA_NORM[cn]
        sev_cn, sev_code = predictor.rule_factor_severity(avg, norm_mean, norm_std)
        z_score = round((avg - norm_mean) / norm_std, 2) if norm_std > 0 else 0
        factors[cn] = {
            "均分": round(float(avg), 2),
            "常模均值": norm_mean,
            "常模标准差": norm_std,
            "标准差倍数": z_score,
            "严重程度": sev_cn,
            "严重程度代码": sev_code,
            "严重程度来源": "规则",
        }
    # 混合模式：随机森林可用且有原始答题特征时以模型为主，否则保留上方规则结果
    _apply_rf_severity(factors, _row_item_answers(row))
    # 按 Z 分数降序（与前端一致）
    sorted_factors = dict(sorted(factors.items(),
                                 key=lambda kv: kv[1]["标准差倍数"], reverse=True))
    total = row["total_score"] or 0
    gsi = row["gsi"]
    psdi = row["psdi"]
    crisis = {} if not row["risk_signal"] else {"风险标记": 1}
    return {
        "总分": total,
        "总均分": gsi if gsi is not None else round(total / 90, 2),
        "阳性项目数": row["pos_item_count"] or 0,
        "阳性症状均分": psdi if psdi is not None else 0,
        "因子分": sorted_factors,
        "危机信号": crisis,
    }


def _scl90_row_public(row) -> dict:
    """scl90_text_report 行 -> 前端契约列表项（字段名与旧 text_reports 保持一致）"""
    factor_avgs = {
        cn: (row[col] if row[col] is not None else None)
        for cn, col in predictor.FACTOR_EN_MAP.items()
    }
    # top_factor：均分最大的因子中文名（全空则空串）
    top_factor = ""
    best = None
    for cn, v in factor_avgs.items():
        if v is not None and (best is None or v > best):
            top_factor, best = cn, v
    return {
        "id": row["report_id"],
        "student_id": row["student_id"],
        "student_name": row["student_name"],
        "class": row["student_class"],
        "scenario": _crowd_tag_to_scenario(row["crowd_tag"]),
        "total_score": row["total_score"],
        "positive_count": row["pos_item_count"],
        "crisis": row["risk_signal"] or 0,
        "top_factor": top_factor,
        "factor_avgs": factor_avgs,
        "created_at": (row["submit_timestamp"] // 1000) if row["submit_timestamp"] else None,
    }


# ---------- AI 解读正文统一归档（ai_analysis_report.ai_content） ----------
def _save_ai_content(conn, ai_content: str, user,
                     text_report_id=None, video_report_id=None):
    """把大模型生成的报告正文归档进 ai_analysis_report（冗余学生四件套）。
    单测评解读：只填 text/video 一侧；综合分析功能：两侧都填。同事务调用方负责 commit。
    返回新插入行的 seq_id（未插入返回 None）。"""
    if not user or not ai_content:
        return None
    uid = user.get("id", "")
    no_val, phone, clazz = None, None, user.get("class", "")
    if user.get("role") == "student":
        srow = conn.execute(
            "SELECT student_no, phone, class FROM student WHERE student_id=?",
            (uid,)).fetchone()
        if srow:
            no_val, phone = srow["student_no"], srow["phone"]
            clazz = srow["class"] or clazz
    cur = conn.execute(
        "INSERT INTO ai_analysis_report (student_name, student_class, student_no, phone, "
        "text_report_id, video_report_id, ai_content, create_timestamp) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (user.get("name", "匿名用户"), clazz, no_val, phone,
         text_report_id, video_report_id, ai_content, _now_ms()),
    )
    return cur.lastrowid


def _load_ai_content(conn, text_report_id=None, video_report_id=None):
    """读取某份报告最新的 AI 解读正文（无则空串）"""
    if text_report_id:
        row = conn.execute(
            "SELECT ai_content FROM ai_analysis_report WHERE text_report_id=? "
            "ORDER BY create_timestamp DESC LIMIT 1", (text_report_id,)).fetchone()
    elif video_report_id:
        row = conn.execute(
            "SELECT ai_content FROM ai_analysis_report WHERE video_report_id=? "
            "ORDER BY create_timestamp DESC LIMIT 1", (video_report_id,)).fetchone()
    else:
        row = None
    return (row["ai_content"] or "") if row else ""


# 旧版场景键展示名（历史报告兼容：教师场景已从测评中移除，但存量报告仍需正确显示）
_SCENARIO_NAME_LEGACY = {"teacher": "教师"}


def _scenario_display_name(key: str) -> str:
    """场景键 -> 展示名：先查当前三人群配置，再查旧版映射，最后原样返回"""
    return config.SCENARIOS.get(key, {}).get(
        "name", _SCENARIO_NAME_LEGACY.get(key, key))


# 人群标签（crowd_tag，中文）-> 场景键（前端契约 scenario）反查表
_CROWD_TAG_TO_KEY = {v["name"]: k for k, v in config.SCENARIOS.items()}


def _crowd_tag_to_scenario(tag: str) -> str:
    """crowd_tag 中文名 -> 场景键；旧数据存的是场景键则原样返回"""
    return _CROWD_TAG_TO_KEY.get(tag, tag)


@app.post("/api/auth/register")
def api_auth_register():
    """
    注册：请求体 {role, no, name, class?, classes?, account, password}
      role=student  -> student 表，no 为学号（student_no），单班级
      role=teacher  -> teacher 表，no 为工号（job_number），支持多班级（classes 数组）
    服务端生成不可见 teacher_id/student_id（时间戳+学号/工号），密码 PBKDF2 加盐哈希存 password 列。
    teacher.class 列冗余保留（逗号拼接全部班级，向后兼容展示），多对多绑定写 teacher_class 关联表。
    """
    data = request.get_json(silent=True) or {}
    role = data.get("role")
    user_no = str(data.get("no", "")).strip()
    name = str(data.get("name", "")).strip()
    account = str(data.get("account", "")).strip()
    password = str(data.get("password", ""))

    table = _user_table(role)
    if table is None:
        return jsonify({"error": "注册身份只能是 student 或 teacher"}), 400
    no_col = "job_number" if role == "teacher" else "student_no"
    id_col = "teacher_id" if role == "teacher" else "student_id"

    # ---------- 班级参数：学生单班级 / 教师多班级 ----------
    if role == "teacher":
        # 优先 classes 数组（前端新格式），回退 class 单字符串（旧格式兼容）
        raw_classes = data.get("classes")
        if raw_classes is None:
            raw_classes = [data.get("class", "")]
        classes, err = _validate_class_names(raw_classes)
        if err:
            return jsonify({"error": err}), 400
        clazz = ",".join(classes)  # 全部班级逗号拼接写入 teacher.class 冗余列
    else:
        clazz = str(data.get("class", "")).strip()
        if not clazz:
            return jsonify({"error": "请填写班级"}), 400
        # 学生班级名也禁止分隔符
        if re.search(r"[,，、\n\r\t]", clazz):
            return jsonify({"error": "班级名不能包含逗号、顿号等分隔符"}), 400
        classes = [clazz]

    # ---------- 通用字段校验 ----------
    if not user_no:
        return jsonify({"error": "请填写学号/工号"}), 400
    if not name:
        return jsonify({"error": "请填写姓名"}), 400
    if len(account) < 3:
        return jsonify({"error": "账号至少 3 个字符"}), 400
    if len(password) < 6:
        return jsonify({"error": "密码至少 6 位"}), 400

    conn = _connect_db()
    try:
        cur = conn.cursor()
        if cur.execute(f"SELECT 1 FROM {table} WHERE account=?", (account,)).fetchone():
            return jsonify({"error": "该账号已被注册"}), 409
        if cur.execute(f"SELECT 1 FROM {table} WHERE {no_col}=?", (user_no,)).fetchone():
            return jsonify({"error": "该学号/工号已被注册"}), 409
        uid = _make_user_id(user_no)
        now_ms = _now_ms()

        if role == "teacher":
            cur.execute(
                "INSERT INTO teacher (teacher_id, name, class, job_number, account, password) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (uid, name, clazz, user_no, account, generate_password_hash(password)),
            )
            # 多对多真正存储：teacher_class 关联表（同事务）
            for class_name in classes:
                cur.execute(
                    "INSERT OR IGNORE INTO teacher_class "
                    "(teacher_id, class_id, create_timestamp) VALUES (?,?,?)",
                    (uid, class_name, now_ms))
        else:
            cur.execute(
                "INSERT INTO student (student_id, name, class, student_no, account, "
                "password, register_timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (uid, name, clazz, user_no, account,
                 generate_password_hash(password), now_ms),
            )
        conn.commit()
    except sqlite3.IntegrityError:
        return jsonify({"error": "账号或学号/工号重复"}), 409
    finally:
        conn.close()

    # 注册成功即登录：教师从关联表取完整班级列表；学生用注册时的 classes
    if role == "teacher":
        classes = _teacher_classes(tid=uid)
    session["user"] = {"id": uid, "role": role, "name": name, "account": account,
                       "classes": classes,
                       "class": classes[0] if classes else ""}   # 向后兼容单列
    return jsonify({"ok": True, "user": {k: v for k, v in session["user"].items() if k != "id"}})


@app.post("/api/auth/login")
def api_auth_login():
    """登录：请求体 {account, password, role}（role 决定查 teacher / student 表）。
    教师登录成功刷新 teacher.login_timestamp（最近登录毫秒）。"""
    data = request.get_json(silent=True) or {}
    role = data.get("role")
    account = str(data.get("account", "")).strip()
    password = str(data.get("password", ""))

    table = _user_table(role)
    if table is None:
        return jsonify({"error": "登录身份只能是 student 或 teacher"}), 400
    if not account or not password:
        return jsonify({"error": "请填写账号和密码"}), 400

    conn = _connect_db()
    try:
        if role == "teacher":
            row = conn.execute(
                "SELECT teacher_id, name, account, password FROM teacher WHERE account=?",
                (account,),
            ).fetchone()
        else:
            row = conn.execute(
                "SELECT student_id, name, class, account, password FROM student WHERE account=?",
                (account,),
            ).fetchone()
    finally:
        conn.close()

    if not row or not check_password_hash(row["password"], password):
        return jsonify({"error": "账号或密码错误"}), 401

    uid = row["teacher_id"] if role == "teacher" else row["student_id"]
    # 教师登录：查 teacher_class 取班级列表 + 刷新 login_timestamp；学生仍为单班级数组
    if role == "teacher":
        classes = _teacher_classes(tid=uid)
        conn = _connect_db()
        try:
            conn.execute("UPDATE teacher SET login_timestamp=? WHERE teacher_id=?",
                         (_now_ms(), uid))
            conn.commit()
        finally:
            conn.close()
    else:
        classes = [row["class"]]

    session["user"] = {
        "id": uid, "role": role,
        "name": row["name"], "account": row["account"],
        "classes": classes,
        "class": classes[0] if classes else "",   # 向后兼容单列 class（报告归档等场景依赖）
    }
    return jsonify({"ok": True, "user": {k: v for k, v in session["user"].items() if k != "id"}})


@app.post("/api/auth/logout")
def api_auth_logout():
    """登出：清除服务端 session"""
    session.pop("user", None)
    return jsonify({"ok": True})


@app.get("/api/auth/me")
def api_auth_me():
    """返回当前登录用户；未登录返回 logged_in=False，供前端决定是否弹登录框。
    注意：id 为用户不可见字段，不下发给前端。"""
    user = session.get("user")
    if not user:
        return jsonify({"logged_in": False, "user": None})
    safe = {k: v for k, v in user.items() if k != "id"}
    return jsonify({"logged_in": True, "user": safe})


def _profile_payload(user):
    """按登录用户组装个人信息返回体：优先从数据库读最新值（保证编辑后刷新不回滚）。
    库内时间戳为毫秒，响应层转回秒（created_at）供前端 new Date(ts*1000) 消费。"""
    is_teacher = user.get("role") == "teacher"
    name, account = user.get("name"), user.get("account")
    phone = user.get("phone")
    no_val, created_ms = None, None
    classes = user.get("classes") or []
    conn = _connect_db()
    try:
        if is_teacher:
            row = conn.execute(
                "SELECT job_number, name, account, phone, login_timestamp FROM teacher "
                "WHERE teacher_id=?",
                (user["id"],)
            ).fetchone()
            if row:
                no_val, name, account, phone, created_ms = (
                    row["job_number"], row["name"], row["account"],
                    row["phone"], row["login_timestamp"],
                )
                classes = _teacher_classes(tid=user["id"])
        else:
            row = conn.execute(
                "SELECT student_no, name, class, account, phone, register_timestamp "
                "FROM student WHERE student_id=?",
                (user["id"],)
            ).fetchone()
            if row:
                no_val, name, account, phone, created_ms = (
                    row["student_no"], row["name"], row["account"],
                    row["phone"], row["register_timestamp"],
                )
                classes = [row["class"]] if row["class"] else []
    except sqlite3.Error:
        pass
    finally:
        conn.close()
    return {
        "role": user.get("role"),
        "role_name": "教师" if is_teacher else "学生",
        "name": name,
        "account": account,
        "classes": classes,          # 数组：多班级（教师）或单班级（学生）
        "class": ", ".join(classes), # 兼容旧前端：拼接字符串
        "no": no_val,
        "phone": phone,
        "created_at": (created_ms // 1000) if created_ms else None,
    }


@app.get("/api/auth/profile")
def api_auth_profile():
    """个人信息：返回除 id（用户不可见）与密码外的全部字段 + 注册时间。"""
    user = session.get("user")
    if not user:
        return jsonify({"error": "请先登录"}), 401
    return jsonify(_profile_payload(user))


@app.post("/api/auth/profile/update")
def api_auth_profile_update():
    """编辑个人信息：可改姓名 / 手机号 / 班级（账号、学号工号、注册时间不可改）。
    教师端班级绑定 teacher_class 关联表（多对多全量覆盖），同时同步 teacher.class 冗余列（逗号拼接）；
    学生端仍为单一 class 列。立即落库并同步更新会话，刷新页面不回滚。"""
    user = session.get("user")
    if not user:
        return jsonify({"error": "请先登录"}), 401
    data = request.get_json(silent=True) or {}
    name = str(data.get("name", "")).strip()
    phone = str(data.get("phone", "")).strip()
    is_teacher = user.get("role") == "teacher"

    if not name:
        return jsonify({"error": "请填写姓名"}), 400
    if phone and (not phone.isdigit() or not (7 <= len(phone) <= 15)):
        return jsonify({"error": "手机号格式不正确（需 7-15 位数字）"}), 400

    if is_teacher:
        classes_raw = data.get("classes")
        classes, err = _validate_class_names(classes_raw if classes_raw is not None else [])
        if err:
            return jsonify({"error": err}), 400
    else:
        clazz = str(data.get("class", "")).strip()
        if not clazz:
            return jsonify({"error": "请填写班级"}), 400
        if re.search(r"[,，、\n\r\t]", clazz):
            return jsonify({"error": "班级名不能包含逗号、顿号等分隔符"}), 400

    conn = _connect_db()
    try:
        if is_teacher:
            # teacher.class 冗余列 = 全部班级逗号拼接
            conn.execute(
                "UPDATE teacher SET name=?, phone=?, class=? WHERE teacher_id=?",
                (name, phone or None, ",".join(classes), user["id"]))
            # teacher_class 关联表：全量覆盖（先删后插，同事务）
            conn.execute("DELETE FROM teacher_class WHERE teacher_id=?", (user["id"],))
            now_ms = _now_ms()
            for c in classes:
                conn.execute(
                    "INSERT INTO teacher_class (teacher_id, class_id, create_timestamp) VALUES (?,?,?)",
                    (user["id"], c, now_ms))
            new_classes = classes
        else:
            conn.execute(
                "UPDATE student SET name=?, class=?, phone=? WHERE student_id=?",
                (name, clazz, phone or None, user["id"]),
            )
            new_classes = [clazz]
        conn.commit()
    except sqlite3.Error:
        return jsonify({"error": "保存失败，请稍后重试"}), 500
    finally:
        conn.close()

    session["user"]["name"] = name
    session["user"]["classes"] = new_classes
    session["user"]["class"] = new_classes[0] if new_classes else ""   # 向后兼容单列（不能 pop！）
    session["user"]["phone"] = phone or None
    session.modified = True
    return jsonify({"ok": True, "user": _profile_payload(session["user"])})


# ==================== API：全局配置 ====================
@app.get("/api/config")
def api_config():
    """返回三人群场景列表（小学生/中学生/大学生），供前端渲染场景切换按钮"""
    scenarios = [
        {"key": key, "name": sc["name"], "desc": sc["desc"]}
        for key, sc in config.SCENARIOS.items()
    ]
    return jsonify({"scenarios": scenarios, "mock": config.MOCK_MODE})


# ==================== API：AI 聊天助手 ====================
@app.post("/api/chat")
def api_chat():
    """
    多轮聊天：请求体 {scenario, messages:[{role,content}...]}
    后端注入场景 system prompt 后调 vLLM，返回 {reply}
    """
    err = _reject_teacher_api()
    if err:
        return err
    data = request.get_json(silent=True) or {}
    scenario = data.get("scenario", "college_student")
    history = data.get("messages", [])
    if scenario not in config.SCENARIOS:
        return jsonify({"error": f"未知场景：{scenario}"}), 400
    # 取最后一条 user 消息作为本轮输入，其余作为历史
    user_texts = [m for m in history if m.get("role") == "user"]
    if not user_texts:
        return jsonify({"error": "缺少用户消息"}), 400
    user_text = user_texts[-1].get("content", "")
    prior = [m for m in history[:-1] if m.get("role") in ("user", "assistant")]

    try:
        messages = llm_client.build_messages(scenario, prior, user_text)
        # 聊天走 ai_chat 通用聊天适配器（LORA_ENABLED 开启且适配器已部署时）
        reply = llm_client.chat(messages, use_chat_lora=True)
    except llm_client.LLMError as e:
        return jsonify({"error": str(e)}), 502
    return jsonify({"reply": reply})


# ==================== API：人脸视频分析 ====================
@app.post("/api/face/analyze")
def api_face_analyze():
    """
    视频分析：multipart 字段 video（webm/mp4，≤50MB）
    流程：存盘 -> py-feat 指标 -> 大模型报告，返回 {metrics, report}
    """
    err = _reject_teacher_api()
    if err:
        return err
    file = request.files.get("video")
    if file is None or file.filename == "":
        return jsonify({"error": "未上传视频文件"}), 400

    # 仅按扩展名白名单落盘，文件名用 uuid 防路径穿越/覆盖
    ext = os.path.splitext(file.filename)[1].lower()
    if ext not in (".webm", ".mp4", ".mov"):
        return jsonify({"error": "仅支持 webm / mp4 / mov 视频"}), 400
    save_path = os.path.join(config.UPLOAD_DIR, f"{uuid.uuid4().hex}{ext}")
    file.save(save_path)

    try:
        # 1. py-feat 客观指标
        try:
            metrics = feat_analyzer.analyze_video(save_path)
        except feat_analyzer.FaceAnalysisError as e:
            return jsonify({"error": f"视频分析失败：{e}"}), 422
        except Exception as e:
            return jsonify({"error": f"py-feat 运行异常：{e}"}), 500

        # 2. 大模型生成心理状态报告
        prompt = config.FACE_REPORT_PROMPT.format(
            metrics_json=json.dumps(metrics, ensure_ascii=False, indent=2)
        )
        try:
            report = llm_client.chat(
                [{"role": "user", "content": prompt}],
                temperature=0.5, max_tokens=1024,
            )
        except llm_client.LLMError as e:
            # 报告失败不阻塞：仍返回客观指标
            report = f"（AI 报告生成失败：{e}）"

        # 3. 报告归档到统一业务库 video_face_report（登录用户才归档，按注册 id 归属）
        user = session.get("user")
        if user:
            try:
                conn = _connect_db()
                try:
                    rid = _make_report_id()
                    au_json = json.dumps(
                        {"au": metrics.get("au") or {},
                         "total_frames": metrics.get("total_frames"),
                         "face_frames": metrics.get("face_frames"),
                         "face_activity": metrics.get("face_activity")},
                        ensure_ascii=False)
                    emotion_json = json.dumps(
                        {"emotions": metrics.get("emotions") or {},
                         "dominant_emotion": metrics.get("dominant_emotion", ""),
                         "dominant_emotion_source": metrics.get("dominant_emotion_source", ""),
                         "smile_detected": metrics.get("smile_detected", False)},
                        ensure_ascii=False)
                    conn.execute(
                        "INSERT INTO video_face_report (video_report_id, student_id, "
                        "au_json, emotion_json, landmark_json, prominent_dimension, "
                        "create_timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)",
                        (rid, user.get("id", ""), au_json, emotion_json, None,
                         metrics.get("dominant_emotion", ""), _now_ms()),
                    )
                    # AI 报告正文归档 ai_analysis_report
                    _save_ai_content(conn, report, user, video_report_id=rid)
                    # 学生表同步记录最新视频检测报告 id
                    if user.get("role") == "student":
                        conn.execute(
                            "UPDATE student SET latest_video_report_id=? WHERE student_id=?",
                            (rid, user["id"]),
                        )
                    conn.commit()
                finally:
                    conn.close()
            except sqlite3.Error as e:
                print(f"[db] ⚠️ 视频检测报告归档失败（不影响本次结果返回）：{e}")

        return jsonify({"metrics": metrics, "report": report})
    finally:
        # 隐私保护：报告流程一结束立即删除暂存视频（无论成功/失败），避免磁盘堆积与人脸数据残留
        try:
            os.remove(save_path)
        except OSError:
            pass


# ==================== API：场景化心理测试（题库与计分在前端 static/js/scl90_data.js） ====================
# 危机提示文案（前端计分检测到危机信号时随报告返回展示）
CRISIS_HOTLINE_TEXT = (
    "全国24小时心理援助热线：400-161-9995\n"
    "北京心理危机研究与干预中心：010-82951332"
)


@app.post("/api/test/submit")
def api_test_submit():
    """
    提交答卷：请求体 {scenario, result}
    计分由前端完成（static/js/test.js，数据来自 static/js/scl90_data.js），
    result 结构与原后端计分引擎一致：总分/总均分/阳性项目数/阳性症状均分/因子分/危机信号
    返回：{scores(计分结果), has_crisis, crisis_message(危机提示), report(AI 解读)}
    """
    err = _reject_teacher_api()
    if err:
        return err
    data = request.get_json(silent=True) or {}
    scenario = data.get("scenario", "college_student")
    if scenario not in config.SCENARIOS:
        return jsonify({"error": f"未知场景：{scenario}"}), 400

    # ---------- 校验前端计分结果（结构完整即可，计分逻辑在前端） ----------
    result = data.get("result")
    if (not isinstance(result, dict)
            or "总分" not in result
            or not isinstance(result.get("因子分"), dict)
            or not result["因子分"]):
        return jsonify({"error": "计分结果缺失或格式非法，请完成全部 90 题后再提交"}), 400
    crisis = result.get("危机信号")
    if not isinstance(crisis, dict):
        crisis = {}

    # ---------- 文本链路混合模式（与视频 feat_analyzer 一致）：随机森林可用则以模型为主，
    # 覆盖前端规则分级后再进 AI 解读与结果返回；缺原始答题/模型不可用时保持规则结果 ----------
    answers = _parse_item_answers(data.get("answers"))
    _apply_rf_severity(result.get("因子分") or {}, answers)

    # ---------- 大模型生成个性化解读 ----------
    prompt = config.REPORT_PROMPT.format(
        scenario_name=config.SCENARIOS[scenario]["name"],
        result_data=json.dumps(result, ensure_ascii=False, indent=2),
    )
    try:
        # 报告解读走通用模型 + 场景 system prompt
        report = llm_client.chat(
            [{"role": "system", "content": config.SCENARIOS[scenario]["system_prompt"]},
             {"role": "user", "content": prompt}],
            temperature=0.5, max_tokens=1536,
        )
    except llm_client.LLMError as e:
        report = f"（AI 报告生成失败：{e}）"

    # ---------- 报告归档到统一业务库 scl90_text_report（10 因子拆列；登录用户才归档） ----------
    user = session.get("user")
    if user:
        try:
            conn = _connect_db()
            try:
                rid = _make_report_id()
                factors = result.get("因子分") or {}
                factor_cols = {}
                for cn, col in predictor.FACTOR_EN_MAP.items():
                    factor_data = factors.get(cn)
                    factor_cols[col] = factor_data.get("均分") if isinstance(factor_data, dict) else None
                pos = result.get("阳性项目数") or 0
                max_avg = max((v for v in factor_cols.values() if v is not None), default=None)
                conn.execute(
                    "INSERT INTO scl90_text_report (report_id, student_id, student_name, "
                    "student_class, crowd_tag, total_score, pos_item_count, neg_item_count, "
                    "risk_signal, " + ", ".join(_SCL90_FACTOR_COLS) + ", "
                    "max_factor_score, gsi, psdi, submit_timestamp, item_answers) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, " +
                    ", ".join("?" * len(_SCL90_FACTOR_COLS)) + ", ?, ?, ?, ?, ?)",
                    (rid, user.get("id", ""), user.get("name", "匿名用户"),
                     user.get("class", ""), config.SCENARIOS[scenario]["name"],
                     result.get("总分"), pos, 90 - pos,
                     1 if crisis else 0,
                     *factor_cols.values(),
                     max_avg, result.get("总均分"), result.get("阳性症状均分"), _now_ms(),
                     json.dumps(answers) if answers else None),
                )
                # AI 解读正文归档 ai_analysis_report
                _save_ai_content(conn, report, user, text_report_id=rid)
                # 学生表同步记录最新文本测评报告 id
                conn.execute(
                    "UPDATE student SET latest_text_report_id=? WHERE student_id=?",
                    (rid, user.get("id", "")),
                )
                conn.commit()
            finally:
                conn.close()
        except sqlite3.Error as e:
            print(f"[db] ⚠️ 文本测评报告归档失败（不影响本次结果返回）：{e}")

    return jsonify({
        "scores": result,
        "has_crisis": len(crisis) > 0,
        "crisis_message": (
            "⚠️ 测评中检测到你可能正处于比较痛苦的阶段，请务必寻求专业帮助：\n"
            + CRISIS_HOTLINE_TEXT
        ) if crisis else "",
        "report": report,
    })


# ==================== API：教师管理员（查看本班学生测评报告） ====================
def _require_teacher():
    """教师权限校验：返回 (user, None) 或 (None, 错误响应)。"""
    user = session.get("user")
    if not user:
        return None, (jsonify({"error": "请先登录"}), 401)
    if user.get("role") != "teacher":
        return None, (jsonify({"error": "仅教师账号可查看班级报告"}), 403)
    return user, None


@app.get("/api/teacher/classes")
def api_teacher_classes():
    """当前教师绑定的班级列表（从独立库 teacher_classes 实时查询，前端下拉专用，只展示有权限的班级）"""
    user, err = _require_teacher()
    if err:
        return err
    # 实时取绑定班级（按绑定时间升序）
    classes = _teacher_classes(tid=user["id"])
    return jsonify({"classes": classes})


@app.get("/api/teacher/reports")
def api_teacher_reports():
    """测评报告列表（按提交时间倒序）：
    - 从独立库 teacher_classes 实时取该教师绑定的全部班级（权限基准）
    - 前端 ?class= 必须在绑定列表内，否则 403（防越权）
    - 缺省 ?class= 时返回绑定的全部班级聚合数据
    """
    user, err = _require_teacher()
    if err:
        return err
    tid = user["id"]

    # ① 后端强校验：实时取权限范围（不依赖 session 缓存）
    authorized = _teacher_classes(tid=tid)
    if not authorized:
        return jsonify({"class": "", "classes": [], "reports": []})

    # ② 前端 ?class= 必须是自己绑定的，否则直接 403
    single_clazz = (request.args.get("class") or "").strip()
    if single_clazz:
        if single_clazz not in authorized:
            return jsonify({"error": "无权查看该班级数据"}), 403
        target_classes = [single_clazz]
    else:
        target_classes = authorized

    conn = _connect_db()
    try:
        cols = ("report_id, student_id, student_name, student_class, crowd_tag, "
                "total_score, pos_item_count, risk_signal, "
                + ", ".join(_SCL90_FACTOR_COLS) +
                ", max_factor_score, submit_timestamp")
        if len(target_classes) == 1:
            rows = conn.execute(
                f"SELECT {cols} FROM scl90_text_report "
                "WHERE student_class=? ORDER BY submit_timestamp DESC",
                (target_classes[0],),
            ).fetchall()
        else:
            placeholders = ",".join("?" * len(target_classes))
            rows = conn.execute(
                f"SELECT {cols} FROM scl90_text_report "
                f"WHERE student_class IN ({placeholders}) ORDER BY submit_timestamp DESC",
                target_classes,
            ).fetchall()
    finally:
        conn.close()
    reports = [_scl90_row_public(r) for r in rows]
    return jsonify({
        "class": single_clazz or ", ".join(target_classes),   # 兼容旧前端：展示用
        "classes": target_classes,                              # 多班级数组：前端新组件用
        "reports": reports,
    })


@app.get("/api/teacher/report/<report_id>")
def api_teacher_report_detail(report_id: str):
    """单份报告详情：由因子均分列重算完整计分 JSON + AI 解读；教师可查看全部班级的报告"""
    user, err = _require_teacher()
    if err:
        return err
    conn = _connect_db()
    try:
        row = conn.execute(
            "SELECT * FROM scl90_text_report WHERE report_id=?",
            (report_id,),
        ).fetchone()
        if not row:
            return jsonify({"error": "报告不存在"}), 404
        scenario = _crowd_tag_to_scenario(row["crowd_tag"])
        return jsonify({
            "id": row["report_id"],
            "student_name": row["student_name"],
            "class": row["student_class"],
            "scenario": scenario,
            "scenario_name": _scenario_display_name(scenario),
            "scores": build_scl90_scores(row),
            "report": _load_ai_content(conn, text_report_id=row["report_id"]),
            "submitted_at": row["submit_timestamp"],  # 毫秒时间戳，与 /test 跳转报告页格式一致
        })
    finally:
        conn.close()


# ==================== API：AI 综合分析（SCL-90 + 视频报告联合解读，写 ai_analysis_report） ====================
def _latest_scl90_row(conn, student_id):
    """某学生最新一份 SCL-90 报告行（无则 None）"""
    cols = ("report_id, student_id, student_name, student_class, crowd_tag, "
            "total_score, pos_item_count, risk_signal, "
            + ", ".join(_SCL90_FACTOR_COLS) +
            ", max_factor_score, gsi, psdi, submit_timestamp, item_answers")
    return conn.execute(
        f"SELECT {cols} FROM scl90_text_report WHERE student_id=? "
        "ORDER BY submit_timestamp DESC LIMIT 1", (student_id,)).fetchone()


def _latest_video_row(conn, student_id):
    """某学生最新一份视频检测报告行（无则 None）"""
    return conn.execute(
        "SELECT * FROM video_face_report WHERE student_id=? "
        "ORDER BY create_timestamp DESC LIMIT 1", (student_id,)).fetchone()


def _analysis_public(row) -> dict:
    """ai_analysis_report 行 -> 对外 JSON（不泄露学号/手机号）"""
    return {
        "id": row["seq_id"],
        "student_name": row["student_name"],
        "class": row["student_class"] or "",
        "text_report_id": row["text_report_id"] or "",
        "video_report_id": row["video_report_id"] or "",
        "ai_content": row["ai_content"] or "",
        "created_at": (row["create_timestamp"] // 1000) if row["create_timestamp"] else None,
    }


def _analyses_for_student(conn, srow):
    """按学生行查其综合分析历史（表无 student_id：学号优先，缺学号回退姓名+班级）"""
    if srow["student_no"]:
        return conn.execute(
            "SELECT * FROM ai_analysis_report WHERE student_no=? "
            "ORDER BY create_timestamp DESC", (srow["student_no"],)).fetchall()
    return conn.execute(
        "SELECT * FROM ai_analysis_report "
        "WHERE (student_no IS NULL OR student_no='') AND student_name=? AND student_class=? "
        "ORDER BY create_timestamp DESC", (srow["name"], srow["class"])).fetchall()


@app.post("/api/ai/analysis")
def api_ai_analysis_create():
    """生成 AI 综合分析：取学生最新 SCL-90 + 最新视频报告两类数据联合喂大模型。
    学生仅能为本人生成；教师可传 {student_id} 为绑定班级内学生生成。"""
    user, err = _require_login()
    if err:
        return err
    role = user.get("role")
    target_sid = user["id"]
    if role == "teacher":
        data = request.get_json(silent=True) or {}
        target_sid = str(data.get("student_id", "")).strip()
        if not target_sid:
            return jsonify({"error": "请指定学生 student_id"}), 400
    conn = _connect_db()
    try:
        srow = conn.execute(
            "SELECT student_id, name, class, student_no, phone FROM student WHERE student_id=?",
            (target_sid,)).fetchone()
        if not srow:
            return jsonify({"error": "学生不存在"}), 404
        # 教师越权校验：该生班级必须在教师绑定班级内
        if role == "teacher":
            authorized = _teacher_classes(tid=user["id"])
            if srow["class"] not in authorized:
                return jsonify({"error": "无权为该学生生成综合分析"}), 403
        text_row = _latest_scl90_row(conn, target_sid)
        video_row = _latest_video_row(conn, target_sid)
        if not text_row and not video_row:
            return jsonify({"error": "该学生还没有任何测评数据，请先完成 SCL-90 测评或视频检测"}), 400
        scl90_json = (json.dumps(build_scl90_scores(text_row), ensure_ascii=False, indent=2)
                      if text_row else "（无 SCL-90 测评数据）")
        if video_row:
            metrics = {}
            for col in ("au_json", "emotion_json"):
                if not video_row[col]:
                    continue
                try:
                    metrics.update(json.loads(video_row[col]))
                except (ValueError, TypeError):
                    pass
            face_json = json.dumps(metrics, ensure_ascii=False, indent=2)
        else:
            face_json = "（无视频表情分析数据）"
        prompt = config.ANALYSIS_PROMPT.format(
            student_name=srow["name"], scl90_json=scl90_json, face_json=face_json)
        try:
            content = llm_client.chat(
                [{"role": "system", "content": "你是一位温暖专业的心理健康顾问。"},
                 {"role": "user", "content": prompt}],
                temperature=0.5, max_tokens=1536)
        except llm_client.LLMError as e:
            return jsonify({"error": f"AI 综合分析生成失败：{e}"}), 502
        # 归档：以目标学生身份写入（补齐学号/手机号冗余），两侧报告 ID 都填
        owner = {"id": target_sid, "name": srow["name"], "class": srow["class"], "role": "student"}
        aid = _save_ai_content(
            conn, content, owner,
            text_report_id=text_row["report_id"] if text_row else None,
            video_report_id=video_row["video_report_id"] if video_row else None)
        conn.commit()
        row = conn.execute(
            "SELECT * FROM ai_analysis_report WHERE seq_id=?", (aid,)).fetchone()
    finally:
        conn.close()
    return jsonify({"ok": True, "analysis": _analysis_public(row)})


@app.get("/api/ai/analyses")
def api_ai_analysis_list():
    """综合分析历史列表。
    学生：本人历史；教师：绑定班级全部，可 ?student_id= 聚焦单个学生（越权 403）。"""
    user, err = _require_login()
    if err:
        return err
    conn = _connect_db()
    try:
        if user.get("role") == "student":
            srow = conn.execute(
                "SELECT name, class, student_no FROM student WHERE student_id=?",
                (user["id"],)).fetchone()
            if not srow:
                return jsonify({"analyses": []})
            rows = _analyses_for_student(conn, srow)
        else:
            authorized = _teacher_classes(tid=user["id"])
            if not authorized:
                return jsonify({"analyses": []})
            sid = (request.args.get("student_id") or "").strip()
            if sid:
                srow = conn.execute(
                    "SELECT name, class, student_no FROM student WHERE student_id=?",
                    (sid,)).fetchone()
                if not srow or srow["class"] not in authorized:
                    return jsonify({"error": "无权查看该学生的综合分析"}), 403
                rows = _analyses_for_student(conn, srow)
            else:
                placeholders = ",".join("?" * len(authorized))
                rows = conn.execute(
                    f"SELECT * FROM ai_analysis_report WHERE student_class IN ({placeholders}) "
                    "ORDER BY create_timestamp DESC", authorized).fetchall()
    finally:
        conn.close()
    return jsonify({"analyses": [_analysis_public(r) for r in rows]})


def _split_intervention(text):
    """干预建议正文按【状态分析】/【干预方案】固定标记拆两段；缺标记时整体归入方案段。"""
    s_mark, p_mark = "【状态分析】", "【干预方案】"
    i, j = text.find(s_mark), text.find(p_mark)
    if i != -1 and j != -1 and j > i:
        return text[i + len(s_mark):j].strip(), text[j + len(p_mark):].strip()
    return "", text.strip()


@app.post("/api/ai/intervention")
def api_ai_intervention():
    """教师端 AI 综合干预建议：只读该生最新 SCL-90 + 最新视频报告生成研判与方案。
    仅教师可用且限绑定班级；不修改学生原有报告数据、不写入归档表。"""
    user, err = _require_login()
    if err:
        return err
    if user.get("role") != "teacher":
        return jsonify({"error": "仅教师账号可使用 AI 干预建议"}), 403
    data = request.get_json(silent=True) or {}
    target_sid = str(data.get("student_id", "")).strip()
    if not target_sid:
        return jsonify({"error": "请指定学生 student_id"}), 400
    conn = _connect_db()
    try:
        srow = conn.execute(
            "SELECT student_id, name, class FROM student WHERE student_id=?",
            (target_sid,)).fetchone()
        if not srow:
            return jsonify({"error": "学生不存在"}), 404
        # 教师越权校验：该生班级必须在教师绑定班级内
        authorized = _teacher_classes(tid=user["id"])
        if srow["class"] not in authorized:
            return jsonify({"error": "无权为该学生生成干预建议"}), 403
        text_row = _latest_scl90_row(conn, target_sid)
        video_row = _latest_video_row(conn, target_sid)
        if not text_row and not video_row:
            return jsonify({"error": "该学生还没有任何测评数据，无法生成干预建议"}), 400
        scl90_json = (json.dumps(build_scl90_scores(text_row), ensure_ascii=False, indent=2)
                      if text_row else "（无 SCL-90 测评数据）")
        if video_row:
            metrics = {}
            for col in ("au_json", "emotion_json"):
                if not video_row[col]:
                    continue
                try:
                    metrics.update(json.loads(video_row[col]))
                except (ValueError, TypeError):
                    pass
            face_json = json.dumps(metrics, ensure_ascii=False, indent=2)
        else:
            face_json = "（无视频表情分析数据）"
        prompt = config.INTERVENTION_PROMPT.format(
            student_name=srow["name"], scl90_json=scl90_json, face_json=face_json)
        try:
            content = llm_client.chat(
                [{"role": "system",
                  "content": "你是资深学校心理健康教育指导教师，为班主任提供客观研判与可落地的干预建议。"},
                 {"role": "user", "content": prompt}],
                temperature=0.5, max_tokens=1536)
        except llm_client.LLMError as e:
            return jsonify({"error": f"AI 干预建议生成失败：{e}"}), 502
    finally:
        conn.close()
    status_text, plan_text = _split_intervention(content)
    return jsonify({
        "ok": True,
        "student_name": srow["name"],
        "class": srow["class"] or "",
        "status": status_text,
        "plan": plan_text,
        "generated_at": int(time.time()),
    })


# ==================== API：学生本人（查看 / 删除自己的测评报告） ====================
def _require_login():
    """登录校验：返回 (user, None) 或 (None, 错误响应)。"""
    user = session.get("user")
    if not user:
        return None, (jsonify({"error": "请先登录"}), 401)
    return user, None


# ==================== API：心理咨询预约（教师=咨询师，学生可约所有教师） ====================
# 周期：教师排可约时段 counseling_slots -> 学生提交预约 appointments(pending)
#       -> 教师同意/拒绝(status=accepted/rejected, 附 reply) -> 学生可取消未确认的预约
# 库内 status 按 表格.md 枚举 pending/accepted/rejected/canceled（+done 完成标记扩展值）；
# API 响应层映射回前端旧契约 confirmed/cancelled（前端零改动），入参筛选反向映射。
_APPT_STATUS_TO_API = {"accepted": "confirmed", "canceled": "cancelled"}
_APPT_STATUS_FROM_API = {"confirmed": "accepted", "cancelled": "canceled"}
_APPT_STATUS_API_SET = {"pending", "confirmed", "rejected", "cancelled", "done"}


def _appt_public(row) -> dict:
    """appointments 行 -> 前端契约 dict（status 映射回旧值 + 毫秒转秒）"""
    row_dict = dict(row)
    row_dict["status"] = _APPT_STATUS_TO_API.get(row["status"], row["status"])
    if row_dict.get("created_at"):
        row_dict["created_at"] = row_dict["created_at"] // 1000
    if row_dict.get("teacher_time"):
        row_dict["teacher_time"] = row_dict["teacher_time"] // 1000
    return row_dict


@app.get("/api/student/appointment/slots")
def api_student_appointment_slots():
    """学生查所有可约时段（含咨询师姓名 + 名额信息）。

    返回每个时段的 max_capacity / current_count / remaining，
    前端据此展示剩余名额并置灰满额时段。
    """
    user, err = _require_login()
    if err:
        return err
    today = datetime.now().strftime("%Y-%m-%d")
    conn = _connect_db()
    try:
        rows = conn.execute(
            "SELECT id, teacher_id, teacher_name, date, time_slot, note, "
            "max_capacity, current_count "
            "FROM counseling_slots WHERE date >= ? "
            "ORDER BY date ASC, time_slot ASC",
            (today,),
        ).fetchall()
    finally:
        conn.close()
    slots = []
    for r in rows:
        slot_dict = dict(r)
        slot_dict["remaining"] = max(slot_dict.get("max_capacity", 1) - slot_dict.get("current_count", 0), 0)
        slots.append(slot_dict)
    return jsonify({"slots": slots})


@app.post("/api/student/appointment")
def api_student_appointment_create():
    """学生提交预约：占用一个时段的一个名额，生成待确认预约。

    多人名额 & 并发安全：
      - 使用条件 UPDATE（current_count < max_capacity）原子占位，冲突返回 409
      - 同一学生不能重复预约同一个教师同一个时段（去重校验）
    """
    user, err = _require_login()
    if err:
        return err
    if user.get("role") != "student":
        return jsonify({"error": "仅学生可发起心理咨询预约"}), 403
    data = request.get_json(silent=True) or {}
    slot_id = str(data.get("slot_id", "")).strip()
    reason = str(data.get("reason", "")).strip()
    if not slot_id:
        return jsonify({"error": "缺少时段 slot_id"}), 400
    conn = _connect_db()
    appt_id = _make_report_id()
    try:
        conn.execute("BEGIN")
        # 读取时段信息（存在性校验）
        slot = conn.execute(
            "SELECT id, teacher_id, teacher_name, date, time_slot "
            "FROM counseling_slots WHERE id=?",
            (slot_id,),
        ).fetchone()
        if not slot:
            conn.rollback()
            return jsonify({"error": "该时段不存在"}), 404
        # 去重校验：同一学生同一教师同一日期同一时间段，不允许重复预约（未取消/未拒绝的仍有效）
        dup = conn.execute(
            "SELECT id FROM appointments WHERE student_id=? AND teacher_id=? "
            "AND date=? AND time_slot=? AND status IN ('pending','accepted')",
            (user["id"], slot["teacher_id"], slot["date"], slot["time_slot"]),
        ).fetchone()
        if dup:
            conn.rollback()
            return jsonify({"error": "你已预约过该教师该时段的时段，请勿重复预约"}), 409
        # 原子占位：仅当未满员时，current_count + 1
        cur = conn.execute(
            "UPDATE counseling_slots SET current_count = current_count + 1 "
            "WHERE id=? AND current_count < max_capacity",
            (slot_id,),
        )
        if cur.rowcount == 0:
            conn.rollback()
            return jsonify({"error": "该时段名额已满，请选择其他时段"}), 409
        conn.execute(
            "INSERT INTO appointments (id, slot_id, teacher_id, teacher_name, "
            "student_id, student_name, student_class, date, time_slot, reason, "
            "status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            (appt_id, slot_id, slot["teacher_id"], slot["teacher_name"],
             user["id"], user.get("name", ""), user.get("class", ""),
             slot["date"], slot["time_slot"], reason or None,
             "pending", _now_ms()),
        )
        conn.commit()
    except Exception as e:
        try:
            conn.rollback()
        except Exception:
            pass
        return jsonify({"error": f"预约提交失败：{e}"}), 500
    finally:
        conn.close()
    return jsonify({"ok": True, "appointment_id": appt_id})


@app.get("/api/student/appointments")
def api_student_appointments():
    """学生查自己的预约列表（含状态与教师回复），按时间倒序"""
    user, err = _require_login()
    if err:
        return err
    conn = _connect_db()
    try:
        rows = conn.execute(
            "SELECT id, teacher_name, date, time_slot, reason, status, reply, created_at "
            "FROM appointments WHERE student_id=? ORDER BY created_at DESC",
            (user["id"],),
        ).fetchall()
    finally:
        conn.close()
    return jsonify({"appointments": [_appt_public(r) for r in rows]})


@app.delete("/api/student/appointment/<appointment_id>")
def api_student_appointment_cancel(appointment_id: str):
    """学生取消自己的预约：仅可取消 pending（待审核）状态；取消后释放一个名额"""
    user, err = _require_login()
    if err:
        return err
    conn = _connect_db()
    try:
        conn.execute("BEGIN")
        row = conn.execute(
            "SELECT id, slot_id, status FROM appointments WHERE id=? AND student_id=?",
            (appointment_id, user["id"]),
        ).fetchone()
        if not row:
            conn.rollback()
            return jsonify({"error": "预约不存在或不属于你"}), 404
        if row["status"] != "pending":
            conn.rollback()
            return jsonify({"error": "仅待审核状态的预约可取消"}), 400
        conn.execute("UPDATE appointments SET status='canceled' WHERE id=?", (row["id"],))
        # 释放该时段的一个名额（current_count >=1 时才减，避免负数）
        conn.execute(
            "UPDATE counseling_slots SET current_count = current_count - 1 "
            "WHERE id=? AND current_count > 0",
            (row["slot_id"],),
        )
        conn.commit()
    finally:
        conn.close()
    return jsonify({"ok": True})


# ---------------- 教师端（教师=咨询师） ----------------
@app.post("/api/teacher/appointment/slots")
def api_teacher_appointment_slot_create():
    """教师创建可约时段（本教师名下）。

    参数：date 预约日期、start_time 开始时间、end_time 结束时间、
          max_capacity 最大预约人数（可选，默认 1）、note 备注（可选）。
    """
    user, err = _require_login()
    if err:
        return err
    if user.get("role") != "teacher":
        return jsonify({"error": "仅教师可排可约时段"}), 403
    data = request.get_json(silent=True) or {}
    date = str(data.get("date", "")).strip()
    start_time = str(data.get("start_time", "")).strip()
    end_time = str(data.get("end_time", "")).strip()
    note = str(data.get("note", "")).strip()
    # 最大预约人数：必须 >=1，缺省按 1 处理
    try:
        max_capacity = int(data.get("max_capacity", 1) or 1)
    except (TypeError, ValueError):
        return jsonify({"error": "最大预约人数必须是整数"}), 400
    if max_capacity < 1:
        return jsonify({"error": "最大预约人数至少为 1"}), 400
    if not date or not start_time or not end_time:
        return jsonify({"error": "日期与开始/结束时间不能为空"}), 400
    if start_time >= end_time:
        return jsonify({"error": "结束时间需晚于开始时间"}), 400
    # 拼接展示用时间段 "09:00-09:30"
    time_slot = f"{start_time}-{end_time}"
    slot_id = _make_report_id()
    conn = _connect_db()
    try:
        conn.execute(
            "INSERT INTO counseling_slots (id, teacher_id, teacher_name, date, "
            "time_slot, start_time, end_time, max_capacity, current_count, "
            "note, status, created_at) VALUES (?,?,?,?,?,?,?,?,0,?,?,?)",
            (slot_id, user["id"], user.get("name", ""), date, time_slot,
             start_time, end_time, max_capacity, note or None, "open", _now_ms()),
        )
        conn.commit()
    finally:
        conn.close()
    return jsonify({"ok": True, "slot_id": slot_id})


@app.put("/api/teacher/appointment/slots/<slot_id>")
def api_teacher_appointment_slot_update(slot_id: str):
    """教师编辑自己的时段：修改日期 / 起止时间 / 最大人数 / 备注。

    上限约束：已有人预约时，新名额不能小于当前已约人数；
    已通过的预约占用名额，改动日期/时间需一并同步已确认预约（保持台账一致）。
    """
    user, err = _require_login()
    if err:
        return err
    if user.get("role") != "teacher":
        return jsonify({"error": "仅教师可编辑时段"}), 403
    data = request.get_json(silent=True) or {}
    date = str(data.get("date", "")).strip()
    start_time = str(data.get("start_time", "")).strip()
    end_time = str(data.get("end_time", "")).strip()
    note = str(data.get("note", "")).strip()
    try:
        max_capacity = int(data.get("max_capacity", 1) or 1)
    except (TypeError, ValueError):
        return jsonify({"error": "最大预约人数必须是整数"}), 400
    if max_capacity < 1:
        return jsonify({"error": "最大预约人数至少为 1"}), 400
    if not date or not start_time or not end_time:
        return jsonify({"error": "日期与开始/结束时间不能为空"}), 400
    if start_time >= end_time:
        return jsonify({"error": "结束时间需晚于开始时间"}), 400
    time_slot = f"{start_time}-{end_time}"
    conn = _connect_db()
    try:
        conn.execute("BEGIN")
        row = conn.execute(
            "SELECT id, current_count FROM counseling_slots WHERE id=? AND teacher_id=?",
            (slot_id, user["id"]),
        ).fetchone()
        if not row:
            conn.rollback()
            return jsonify({"error": "时段不存在或不属于你"}), 404
        # 名额不能小于当前已约人数
        if max_capacity < row["current_count"]:
            conn.rollback()
            return jsonify({
                "error": f"新名额不能小于当前已约人数（{row['current_count']}）"}), 400
        conn.execute(
            "UPDATE counseling_slots SET date=?, time_slot=?, start_time=?, "
            "end_time=?, max_capacity=?, note=? WHERE id=?",
            (date, time_slot, start_time, end_time, max_capacity,
             note or None, slot_id),
        )
        # 同步已审核通过的预约的日期/时间段（保持台账一致，避免约会信息错位）
        conn.execute(
            "UPDATE appointments SET date=?, time_slot=? "
            "WHERE slot_id=? AND status IN ('pending','accepted')",
            (date, time_slot, slot_id),
        )
        conn.commit()
    finally:
        conn.close()
    return jsonify({"ok": True})


@app.get("/api/teacher/appointment/slots")
def api_teacher_appointment_slots():
    """教师查自己排的所有时段（含名额：最大人数 / 当前已约 / 剩余）"""
    user, err = _require_login()
    if err:
        return err
    if user.get("role") != "teacher":
        return jsonify({"error": "仅教师可查看排班"}), 403
    conn = _connect_db()
    try:
        rows = conn.execute(
            "SELECT id, date, time_slot, start_time, end_time, note, status, "
            "max_capacity, current_count, created_at "
            "FROM counseling_slots WHERE teacher_id=? ORDER BY date DESC, time_slot DESC",
            (user["id"],),
        ).fetchall()
    finally:
        conn.close()
    # created_at 毫秒 -> 秒（前端 fmtTs 按秒消费）
    slots = []
    for r in rows:
        slot_dict = dict(r)
        if slot_dict.get("created_at"):
            slot_dict["created_at"] = slot_dict["created_at"] // 1000
        slots.append(slot_dict)
    return jsonify({"slots": slots})


@app.delete("/api/teacher/appointment/slots/<slot_id>")
def api_teacher_appointment_slot_delete(slot_id: str):
    """教师作废自己的时段：同时取消该时段下待审核/已确认的预约并释放名额"""
    user, err = _require_login()
    if err:
        return err
    if user.get("role") != "teacher":
        return jsonify({"error": "仅教师可作废时段"}), 403
    conn = _connect_db()
    try:
        conn.execute("BEGIN")
        row = conn.execute(
            "SELECT id FROM counseling_slots WHERE id=? AND teacher_id=?",
            (slot_id, user["id"]),
        ).fetchone()
        if not row:
            conn.rollback()
            return jsonify({"error": "时段不存在或不属于你"}), 404
        # 该时段下仍未结束（待审核 / 已通过）的预约一并取消
        conn.execute(
            "UPDATE appointments SET status='canceled' "
            "WHERE slot_id=? AND status IN ('pending','accepted')",
            (slot_id,),
        )
        conn.execute("DELETE FROM counseling_slots WHERE id=?", (slot_id,))
        conn.commit()
    finally:
        conn.close()
    return jsonify({"ok": True})


@app.get("/api/teacher/appointments")
def api_teacher_appointments():
    """教师查投递到自己时段的预约，学生姓名+班级+事由。

    支持状态筛选：可选 query 参数 status，取值 all / pending / confirmed /
    rejected / cancelled；缺省 all（全部）。
    """
    user, err = _require_login()
    if err:
        return err
    if user.get("role") != "teacher":
        return jsonify({"error": "仅教师可查看预约"}), 403
    # 状态筛选：all 或某个具体状态（前端旧契约值 -> 库内文档枚举）
    filter_status = str(request.args.get("status", "all")).strip()
    if filter_status != "all" and filter_status not in _APPT_STATUS_API_SET:
        return jsonify({"error": "非法的筛选状态"}), 400
    db_status = _APPT_STATUS_FROM_API.get(filter_status, filter_status)
    conn = _connect_db()
    try:
        if filter_status == "all":
            rows = conn.execute(
                "SELECT id, student_name, student_class, date, time_slot, reason, "
                "status, reply, created_at, teacher_time FROM appointments "
                "WHERE teacher_id=? ORDER BY created_at DESC",
                (user["id"],),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT id, student_name, student_class, date, time_slot, reason, "
                "status, reply, created_at, teacher_time FROM appointments "
                "WHERE teacher_id=? AND status=? ORDER BY created_at DESC",
                (user["id"], db_status),
            ).fetchall()
    finally:
        conn.close()
    return jsonify({"appointments": [_appt_public(r) for r in rows]})


@app.post("/api/teacher/appointment/<appointment_id>/decide")
def api_teacher_appointment_decide(appointment_id: str):
    """教师处理预约：body {action: 'confirm'|'reject'|'complete', reply: 回复/驳回原因}

    规则：
      - confirm（通过）：仅待审核 pending -> 已通过 confirmed
      - reject（驳回）：仅待审核 pending -> 已驳回 rejected，必须填写驳回原因
      - complete（完成）：仅已通过 confirmed -> 已完成 done（咨询结束标记，不释放名额）
    """
    user, err = _require_login()
    if err:
        return err
    if user.get("role") != "teacher":
        return jsonify({"error": "仅教师可处理预约"}), 403
    data = request.get_json(silent=True) or {}
    action = data.get("action")
    reply = str(data.get("reply", "")).strip()
    if action not in ("confirm", "reject", "complete"):
        return jsonify({"error": "action 需为 confirm / reject / complete"}), 400
    # 驳回必须说明原因，学生端详情页会展示
    if action == "reject" and not reply:
        return jsonify({"error": "驳回预约必须填写驳回原因"}), 400
    status_map = {"confirm": "accepted", "reject": "rejected", "complete": "done"}
    status = status_map[action]
    conn = _connect_db()
    try:
        conn.execute("BEGIN")
        row = conn.execute(
            "SELECT id, status, slot_id, reply FROM appointments "
            "WHERE id=? AND teacher_id=?",
            (appointment_id, user["id"]),
        ).fetchone()
        if not row:
            conn.rollback()
            return jsonify({"error": "预约不存在或不属于你"}), 404
        # 状态机校验：通过/驳回只能处理待审核；完成只能处理已通过
        if action in ("confirm", "reject") and row["status"] != "pending":
            conn.rollback()
            return jsonify({"error": "仅待审核状态的预约可处理"}), 400
        if action == "complete" and row["status"] != "accepted":
            conn.rollback()
            return jsonify({"error": "仅已通过状态的预约可标记完成"}), 400
        # 记录处理时间；complete 时保留原回复，不改写
        new_reply = reply if action != "complete" else row["reply"]
        conn.execute(
            "UPDATE appointments SET status=?, reply=?, teacher_time=? WHERE id=?",
            (status, new_reply or None, _now_ms(), row["id"]),
        )
        if action == "reject":
            # 拒绝预约 -> 释放该时段的一个名额
            conn.execute(
                "UPDATE counseling_slots SET current_count = current_count - 1 "
                "WHERE id=? AND current_count > 0",
                (row["slot_id"],),
            )
        conn.commit()
    finally:
        conn.close()
    return jsonify({"ok": True})


@app.get("/api/student/reports")
def api_student_reports():
    """我的测评报告列表（按提交时间倒序）：仅学生角色可用"""
    user, err = _require_login()
    if err:
        return err
    if user.get("role") != "student":
        return jsonify({"error": "仅学生账号可查看个人报告"}), 403
    cols = ("report_id, student_id, student_name, student_class, crowd_tag, "
            "total_score, pos_item_count, risk_signal, "
            + ", ".join(_SCL90_FACTOR_COLS) +
            ", max_factor_score, submit_timestamp")
    conn = _connect_db()
    try:
        rows = conn.execute(
            f"SELECT {cols} FROM scl90_text_report "
            "WHERE student_id=? ORDER BY submit_timestamp DESC",
            (user["id"],),
        ).fetchall()
    finally:
        conn.close()
    return jsonify({"reports": [_scl90_row_public(r) for r in rows]})


@app.get("/api/student/report/<report_id>")
def api_student_report_detail(report_id: str):
    """我的单份报告详情：仅报告归属本人可见"""
    user, err = _require_login()
    if err:
        return err
    if user.get("role") != "student":
        return jsonify({"error": "仅学生账号可查看个人报告"}), 403
    conn = _connect_db()
    try:
        row = conn.execute(
            "SELECT * FROM scl90_text_report WHERE report_id=? AND student_id=?",
            (report_id, user["id"]),
        ).fetchone()
        if not row:
            return jsonify({"error": "报告不存在或不属于你"}), 404
        scenario = _crowd_tag_to_scenario(row["crowd_tag"])
        return jsonify({
            "id": row["report_id"],
            "scenario": scenario,
            "scenario_name": _scenario_display_name(scenario),
            "scores": build_scl90_scores(row),
            "report": _load_ai_content(conn, text_report_id=row["report_id"]),
            "submitted_at": row["submit_timestamp"],
        })
    finally:
        conn.close()


@app.delete("/api/student/report/<report_id>")
def api_student_report_delete(report_id: str):
    """学生自主删除自己的报告：SQL 强制 student_id=本人；教师无删除接口，不可删除学生报告"""
    user, err = _require_login()
    if err:
        return err
    if user.get("role") != "student":
        return jsonify({"error": "仅学生本人可删除自己的报告（教师无删除权限）"}), 403
    conn = _connect_db()
    try:
        cur = conn.execute(
            "DELETE FROM scl90_text_report WHERE report_id=? AND student_id=?",
            (report_id, user["id"]),
        )
        conn.commit()
    finally:
        conn.close()
    if cur.rowcount == 0:
        return jsonify({"error": "报告不存在或不属于你"}), 404
    return jsonify({"ok": True})


# ==================== API：视频心理检测报告（学生 / 教师均可查看本人报告） ====================
def _video_row_public(row, with_metrics=False):
    """video_face_report 行 -> 前端契约（au/emotion/landmark 三 JSON 列合并还原 metrics 结构）"""
    metrics = {}
    if row["au_json"]:
        try:
            metrics.update(json.loads(row["au_json"]))
        except (ValueError, TypeError):
            pass
    if row["emotion_json"]:
        try:
            metrics.update(json.loads(row["emotion_json"]))
        except (ValueError, TypeError):
            pass
    item = {
        "id": row["video_report_id"],
        "user_name": row["user_name"],
        "top_factor": row["prominent_dimension"],
        "created_at": (row["create_timestamp"] // 1000) if row["create_timestamp"] else None,
    }
    if with_metrics:
        item["metrics"] = metrics
        item["report"] = row["ai_content"] or ""
        item["submitted_at"] = row["create_timestamp"]  # 毫秒时间戳，与前端 toLocaleString 一致
    return item


@app.get("/api/face/reports")
def api_face_reports():
    """我的视频心理检测报告列表（按测试时间倒序），仅返回本人注册 id 的报告"""
    user, err = _require_login()
    if err:
        return err
    conn = _connect_db()
    try:
        rows = conn.execute(
            "SELECT v.*, s.name AS user_name "
            "FROM video_face_report v LEFT JOIN student s ON s.student_id = v.student_id "
            "WHERE v.student_id=? ORDER BY v.create_timestamp DESC",
            (user["id"],),
        ).fetchall()
    finally:
        conn.close()
    return jsonify({"reports": [_video_row_public(r) for r in rows]})


@app.get("/api/face/report/<report_id>")
def api_face_report_detail(report_id: str):
    """单份视频检测报告详情：AI 报告正文 + py-feat 指标（三 JSON 列合并）；仅归属本人可见"""
    user, err = _require_login()
    if err:
        return err
    conn = _connect_db()
    try:
        row = conn.execute(
            "SELECT v.*, s.name AS user_name, "
            "(SELECT ai_content FROM ai_analysis_report a "
            " WHERE a.video_report_id = v.video_report_id "
            " ORDER BY a.create_timestamp DESC LIMIT 1) AS ai_content "
            "FROM video_face_report v LEFT JOIN student s ON s.student_id = v.student_id "
            "WHERE v.video_report_id=? AND v.student_id=?",
            (report_id, user["id"]),
        ).fetchone()
    finally:
        conn.close()
    if not row:
        return jsonify({"error": "报告不存在或不属于你"}), 404
    return jsonify(_video_row_public(row, with_metrics=True))


@app.get("/api/teacher/student/<sid>/face-reports")
def api_teacher_student_face_reports(sid: str):
    """教师只读查看绑定班级学生的视频检测指标（报告页视频栏联动用）：
    权限基准与 /api/teacher/report 一致——学生班级必须在教师绑定班级内。"""
    user, err = _require_teacher()
    if err:
        return err
    conn = _connect_db()
    try:
        srow = conn.execute(
            "SELECT student_id, class FROM student WHERE student_id=?", (sid,)).fetchone()
        if not srow:
            return jsonify({"error": "学生不存在"}), 404
        if srow["class"] not in _teacher_classes(tid=user["id"]):
            return jsonify({"error": "无权查看该学生的视频报告"}), 403
        rows = conn.execute(
            "SELECT v.*, s.name AS user_name, "
            "(SELECT ai_content FROM ai_analysis_report a "
            " WHERE a.video_report_id = v.video_report_id "
            " ORDER BY a.create_timestamp DESC LIMIT 1) AS ai_content "
            "FROM video_face_report v LEFT JOIN student s ON s.student_id = v.student_id "
            "WHERE v.student_id=? ORDER BY v.create_timestamp DESC",
            (sid,)).fetchall()
    finally:
        conn.close()
    return jsonify({"reports": [_video_row_public(r, with_metrics=True) for r in rows]})


@app.delete("/api/face/report/<report_id>")
def api_face_report_delete(report_id: str):
    """用户自主删除自己的视频检测报告：SQL 强制 student_id=本人"""
    user, err = _require_login()
    if err:
        return err
    conn = _connect_db()
    try:
        cur = conn.execute(
            "DELETE FROM video_face_report WHERE video_report_id=? AND student_id=?",
            (report_id, user["id"]),
        )
        conn.commit()
    finally:
        conn.close()
    if cur.rowcount == 0:
        return jsonify({"error": "报告不存在或不属于你"}), 404
    return jsonify({"ok": True})


# ==================== 统一错误处理 ====================
@app.errorhandler(413)
def too_large(_e):
    return jsonify({"error": "上传文件超过 50MB 限制"}), 413


@app.errorhandler(404)
def not_found(_e):
    return jsonify({"error": "接口不存在"}), 404


@app.errorhandler(Exception)
def server_error(e):
    return jsonify({"error": f"服务器内部错误：{e}"}), 500


# ==================== 心理科普文章模块（学生只读 + 教师管理） ====================
# 权限：学生账号可阅读全部已上架文章（内置 + 教师发布）；
#       教师账号在 /teacher/articles 管理面板新增 / 编辑 / 删除文章，
#       数据落 psy.db articles 表，学生端刷新即自动同步最新内容。
# 内置文章（article_seed.py）启动时幂等写入，与教师文章按发布时间倒序共同展示。
import article_seed


def _plain_text_to_html(text: str) -> str:
    """教师填写的纯文本正文 -> 分段 HTML（按空行/换行切段，先转义再包 <p>）。

    内置 seed 文章本身已是 h2/p 结构化 HTML，因此仅对不含标签的纯文本做转换，
    保证学生端详情页沿用既有 .detail-content 排版，无需改前端渲染逻辑。
    """
    if "<" in text and ">" in text:
        return text  # 已是结构化 HTML，原样返回
    import html as _html
    paras = [p.strip() for p in text.replace("\r\n", "\n").split("\n") if p.strip()]
    return "".join(f"<p>{_html.escape(p)}</p>" for p in paras)


def _article_public_dict(row):
    """把 article 行转成学生端可见字典，并附带来源标注。

    source：教师发布文章用自定义来源；内置 seed 文章（source 为空）用默认权威来源。
    """
    return {
        "id": row["id"],
        "cover": row["cover"] or "",
        "title": row["title"],
        "summary": row["summary"] or "",
        "content": _plain_text_to_html(row["content"] or ""),
        # 库内毫秒 -> 响应秒（前端 fmtDate 按秒消费）
        "created_at": (row["created_at"] // 1000) if row["created_at"] else row["created_at"],
        "source": row["source"] or article_seed.ARTICLE_SOURCE,
    }


# ---------- 学生端：心理科普阅读（内置 + 教师发布，仅看已上架） ----------
@app.get("/api/articles")
def api_articles_list():
    """学生端科普文章列表：返回全部上架(is_active=1)文章，支持分页。

    query 参数：page(默认1) + page_size(默认6)。需登录。
    """
    user, err = _require_login()
    if err:
        return err
    try:
        page = max(1, int(request.args.get("page", 1)))
        page_size = min(50, max(1, int(request.args.get("page_size", 6))))
    except (TypeError, ValueError):
        return jsonify({"error": "分页参数不合法"}), 400
    conn = _connect_db()
    try:
        total = conn.execute(
            "SELECT COUNT(*) AS c FROM articles WHERE is_active=1"
        ).fetchone()["c"]
        offset = (page - 1) * page_size
        rows = conn.execute(
            "SELECT id, cover, title, summary, content, source, is_active, created_at "
            "FROM articles WHERE is_active=1 "
            "ORDER BY created_at DESC LIMIT ? OFFSET ?",
            (page_size, offset),
        ).fetchall()
    finally:
        conn.close()
    return jsonify({
        "articles": [_article_public_dict(r) for r in rows],
        "total": total,
        "page": page,
        "page_size": page_size,
    })


@app.get("/api/articles/<article_id>")
def api_article_detail(article_id: str):
    """学生端科普文章详情：仅返回上架文章；不存在返回 404。需登录。"""
    user, err = _require_login()
    if err:
        return err
    conn = _connect_db()
    try:
        row = conn.execute(
            "SELECT id, cover, title, summary, content, source, is_active, created_at "
            "FROM articles WHERE id=? AND is_active=1",
            (article_id,),
        ).fetchone()
    finally:
        conn.close()
    if not row:
        return jsonify({"error": "文章不存在"}), 404
    return jsonify({"article": _article_public_dict(row)})


# ---------- 教师端：心理科普文章管理（新增 / 编辑 / 删除） ----------
def _article_teacher_dict(row):
    """教师管理列表用的文章字典。

    content 返回库内原始正文（编辑弹窗直接回填，不做 HTML 转换）；
    另附 updated_at（毫秒转秒）与 author 供列表展示。
    """
    return {
        "id": row["id"],
        "title": row["title"],
        "summary": row["summary"] or "",
        "content": row["content"] or "",
        "source": row["source"] or "",
        "author": row["author"] or "",
        "is_active": row["is_active"],
        "created_at": (row["created_at"] // 1000) if row["created_at"] else row["created_at"],
        "updated_at": (row["updated_at"] // 1000) if row["updated_at"] else None,
    }


@app.get("/api/teacher/articles")
def api_teacher_articles_list():
    """教师端文章列表：返回全部文章（内置 + 教师发布，含上下架），按发布时间倒序，支持分页。"""
    user, err = _require_teacher()
    if err:
        return err
    page = max(1, request.args.get("page", 1, type=int))
    page_size = min(50, max(1, request.args.get("page_size", 10, type=int)))
    conn = _connect_db()
    try:
        total = conn.execute("SELECT COUNT(*) AS c FROM articles").fetchone()["c"]
        rows = conn.execute(
            "SELECT id, cover, title, summary, content, source, author, is_active, "
            "created_at, updated_at FROM articles "
            "ORDER BY created_at DESC LIMIT ? OFFSET ?",
            (page_size, (page - 1) * page_size),
        ).fetchall()
    finally:
        conn.close()
    return jsonify({
        "articles": [_article_teacher_dict(r) for r in rows],
        "total": total,
        "page": page,
        "page_size": page_size,
    })


@app.post("/api/teacher/articles")
def api_teacher_articles_create():
    """教师新增文章：title 必填，content 必填；source 选填（留空用默认来源）。"""
    user, err = _require_teacher()
    if err:
        return err
    data = request.get_json(silent=True) or {}
    title = (data.get("title") or "").strip()
    content = (data.get("content") or "").strip()
    summary = (data.get("summary") or "").strip()
    source = (data.get("source") or "").strip()
    if not title:
        return jsonify({"error": "文章标题不能为空"}), 400
    if not content:
        return jsonify({"error": "文章正文不能为空"}), 400
    art_id = f"art-{_now_ms()}"
    now = _now_ms()
    conn = _connect_db()
    try:
        conn.execute(
            "INSERT INTO articles (id, cover, title, summary, content, source, author, "
            "is_active, created_at, updated_at) VALUES (?, NULL, ?, ?, ?, ?, ?, 1, ?, ?)",
            (art_id, title, summary, content, source or None, user.get("name"), now, now),
        )
        conn.commit()
    finally:
        conn.close()
    return jsonify({"ok": True, "id": art_id}), 201


@app.put("/api/teacher/articles/<article_id>")
def api_teacher_articles_update(article_id: str):
    """教师编辑文章：可更新 title / summary / source / content；内置 seed 文章不可编辑。"""
    user, err = _require_teacher()
    if err:
        return err
    if article_id.startswith("seed-"):
        return jsonify({"error": "系统内置文章不可编辑"}), 403
    data = request.get_json(silent=True) or {}
    title = (data.get("title") or "").strip()
    content = (data.get("content") or "").strip()
    summary = (data.get("summary") or "").strip()
    source = (data.get("source") or "").strip()
    if not title:
        return jsonify({"error": "文章标题不能为空"}), 400
    if not content:
        return jsonify({"error": "文章正文不能为空"}), 400
    conn = _connect_db()
    try:
        row = conn.execute("SELECT id FROM articles WHERE id=?", (article_id,)).fetchone()
        if not row:
            return jsonify({"error": "文章不存在"}), 404
        conn.execute(
            "UPDATE articles SET title=?, summary=?, content=?, source=?, updated_at=? "
            "WHERE id=?",
            (title, summary, content, source or None, _now_ms(), article_id),
        )
        conn.commit()
    finally:
        conn.close()
    return jsonify({"ok": True})


@app.delete("/api/teacher/articles/<article_id>")
def api_teacher_articles_delete(article_id: str):
    """教师删除文章：物理删除；内置 seed 文章不可删除。"""
    user, err = _require_teacher()
    if err:
        return err
    if article_id.startswith("seed-"):
        return jsonify({"error": "系统内置文章不可删除"}), 403
    conn = _connect_db()
    try:
        cur = conn.execute("DELETE FROM articles WHERE id=?", (article_id,))
        conn.commit()
    finally:
        conn.close()
    if cur.rowcount == 0:
        return jsonify({"error": "文章不存在"}), 404
    return jsonify({"ok": True})


# ==================== API：师生私密留言倾诉（并入统一库 psy.db） ====================
# 定位：学生向任意心理老师发起一对一私密留言倾诉，老师回复答疑疏导。
#   - conversation：一对一师生会话（student_id + teacher_id 唯一）
#   - message：会话内消息（sender_role=student/teacher 区分气泡，is_read 区分已读）
# 私密性：会话仅归属双方，接口按角色校验读写权限，他人不可见；无删除、无撤回，永久留存。
# 库内毫秒时间戳；响应层统一转秒（前端 fmtTime 按秒消费，零改动）。


def _require_student():
    """学生权限校验：仅学生账号可用学生端倾诉功能。返回 (user, None) 或 (None, 错误响应)。"""
    user = session.get("user")
    if not user:
        return None, (jsonify({"error": "请先登录"}), 401)
    if user.get("role") != "student":
        return None, (jsonify({"error": "仅学生账号可使用倾诉留言功能"}), 403)
    return user, None


def _msg_dict(row):
    """消息行 -> 前端 JSON（库内毫秒 -> 响应秒）"""
    return {
        "id": row["id"],
        "conversation_id": row["conversation_id"],
        "sender_id": row["sender_id"],
        "sender_role": row["sender_role"],
        "content": row["content"],
        "is_read": bool(row["is_read"]),
        "created_at": row["create_timestamp"] // 1000,
    }


def _conv_meta(conn, cid: str):
    """按会话 id 取会话行，不存在返回 None"""
    return conn.execute(
        "SELECT * FROM conversation WHERE id=?", (cid,)).fetchone()


def _find_or_create_conversation(conn, student_id, teacher_id,
                                 student_name, teacher_name):
    """返还该师生的一对一会话；不存在则创建（唯一索引保证不重复）。"""
    row = conn.execute(
        "SELECT * FROM conversation WHERE student_id=? AND teacher_id=?",
        (student_id, teacher_id)).fetchone()
    if row:
        return row, False
    now = _now_ms()
    cid = _make_report_id()
    conn.execute(
        "INSERT INTO conversation "
        "(id, student_id, teacher_id, student_name, teacher_name, updated_timestamp, create_timestamp) "
        "VALUES (?,?,?,?,?,?,?)",
        (cid, student_id, teacher_id, student_name, teacher_name, now, now))
    conn.commit()
    return _conv_meta(conn, cid), True


# ---------- 学生端：选择教师 ----------
@app.get("/api/student/msg/teachers")
def api_student_msg_teachers():
    """学生可选的所有心理老师列表（供发起倾诉时选择）。
    统一库内直接 JOIN teacher_class 聚合班级，无需跨库 ATTACH。"""
    user, err = _require_student()
    if err:
        return err
    conn = _connect_db()
    try:
        rows = conn.execute(
            "SELECT t.teacher_id AS id, t.name, "
            "GROUP_CONCAT(tc.class_id, ', ') AS class, "
            "(SELECT COUNT(*) FROM teacher_class tc2 WHERE tc2.teacher_id=t.teacher_id) AS class_count "
            "FROM teacher t LEFT JOIN teacher_class tc ON tc.teacher_id=t.teacher_id "
            "GROUP BY t.teacher_id ORDER BY t.name").fetchall()
    finally:
        conn.close()
    result = []
    for r in rows:
        teacher_dict = dict(r)
        teacher_dict["classes"] = [c.strip() for c in (teacher_dict.pop("class") or "").split(",") if c.strip()]
        result.append(teacher_dict)
    return jsonify({"teachers": result})


# ---------- 学生端：会话列表（按最新消息排序，含未读数） ----------
@app.get("/api/student/msg/conversations")
def api_student_msg_conversations():
    """学生自己的倾诉会话列表：按最新消息时间倒序 + 未读老师消息数 + 最后一条预览。"""
    user, err = _require_student()
    if err:
        return err
    conn = _connect_db()
    try:
        rows = conn.execute(
            "SELECT * FROM conversation WHERE student_id=? "
            "ORDER BY updated_timestamp DESC", (user["id"],)).fetchall()
        conversations = []
        for c in rows:
            last = conn.execute(
                "SELECT content, create_timestamp FROM message WHERE conversation_id=? "
                "ORDER BY create_timestamp DESC LIMIT 1", (c["id"],)).fetchone()
            unread = conn.execute(
                "SELECT COUNT(*) AS n FROM message WHERE conversation_id=? "
                "AND sender_role='teacher' AND is_read=0", (c["id"],)).fetchone()["n"]
            conversations.append({
                "id": c["id"],
                "teacher_id": c["teacher_id"],
                "teacher_name": c["teacher_name"],
                "last_message": last["content"] if last else "",
                # 毫秒 -> 秒（前端 fmtTime 按秒消费）
                "last_time": (last["create_timestamp"] if last else c["create_timestamp"]) // 1000,
                "unread": unread,
            })
    finally:
        conn.close()
    return jsonify({"conversations": conversations})


# ---------- 学生端：创建 / 打开与某教师的会话 ----------
@app.post("/api/student/msg/conversation")
def api_student_msg_conversation_create():
    """学生向指定教师发起倾诉会话：不存在则创建，已存在则直接打开（一对一唯一）。"""
    user, err = _require_student()
    if err:
        return err
    data = request.get_json(silent=True) or {}
    teacher_id = (data.get("teacher_id") or "").strip()
    if not teacher_id:
        return jsonify({"error": "请选择要倾诉的老师"}), 400
    conn = _connect_db()
    try:
        teacher = conn.execute(
            "SELECT teacher_id AS id, name FROM teacher WHERE teacher_id=?",
            (teacher_id,)).fetchone()
        if not teacher:
            return jsonify({"error": "所选老师不存在"}), 404
        conv, created = _find_or_create_conversation(
            conn, user["id"], teacher_id, user["name"], teacher["name"])
    finally:
        conn.close()
    return jsonify({
        "conversation": {
            "id": conv["id"],
            "teacher_id": conv["teacher_id"],
            "teacher_name": conv["teacher_name"],
            "created": created,
        }
    })


# ---------- 学生端 / 教师端：消息记录（归属校验，他人不可见） ----------
@app.get("/api/student/msg/conversation/<cid>")
def api_student_msg_conversation_detail(cid: str):
    """学生查看与某教师的完整聊天记录（仅本人会话可见）。"""
    user, err = _require_student()
    if err:
        return err
    conn = _connect_db()
    try:
        conv_row = _conv_meta(conn, cid)
        if not conv_row or conv_row["student_id"] != user["id"]:
            return jsonify({"error": "会话不存在"}), 404
        msgs = [dict(_msg_dict(msg_row)) for msg_row in conn.execute(
            "SELECT * FROM message WHERE conversation_id=? ORDER BY create_timestamp ASC",
            (cid,))]
    finally:
        conn.close()
    return jsonify({
        "conversation": {
            "id": conv_row["id"],
            "teacher_id": conv_row["teacher_id"],
            "teacher_name": conv_row["teacher_name"],
            "student_name": conv_row["student_name"],
        },
        "messages": msgs,
    })


@app.get("/api/teacher/msg/conversation/<cid>")
def api_teacher_msg_conversation_detail(cid: str):
    """教师查看与某学生的完整聊天记录（仅本人会话可见）。"""
    user, err = _require_teacher()
    if err:
        return err
    conn = _connect_db()
    try:
        conv_row = _conv_meta(conn, cid)
        if not conv_row or conv_row["teacher_id"] != user["id"]:
            return jsonify({"error": "会话不存在"}), 404
        # 顺带取该学生的班级，便于教师识别（统一库内直接查 student 表）
        srow = conn.execute(
            "SELECT class FROM student WHERE student_id=?",
            (conv_row["student_id"],)).fetchone()
        student_class = srow["class"] if srow else ""
        msgs = [dict(_msg_dict(msg_row)) for msg_row in conn.execute(
            "SELECT * FROM message WHERE conversation_id=? ORDER BY create_timestamp ASC",
            (cid,))]
    finally:
        conn.close()
    return jsonify({
        "conversation": {
            "id": conv_row["id"],
            "student_id": conv_row["student_id"],
            "student_name": conv_row["student_name"],
            "student_class": student_class,
            "teacher_name": conv_row["teacher_name"],
        },
        "messages": msgs,
    })


# ---------- 发送消息（学生倾诉 / 教师回复） ----------
def _send_message(cid: str, user, sender_role: str, ownership_check):
    """发送消息共用逻辑：校验归属 -> 插入消息 -> 更新时间戳。"""
    data = request.get_json(silent=True) or {}
    content = (data.get("content") or "").strip()
    if not content:
        return jsonify({"error": "消息内容不能为空"}), 400
    if len(content) > 2000:
        return jsonify({"error": "消息内容过长（限 2000 字）"}), 400

    conn = _connect_db()
    try:
        conv_row = _conv_meta(conn, cid)
        if not conv_row or not ownership_check(conv_row):
            return jsonify({"error": "会话不存在"}), 404
        now = _now_ms()
        mid = _make_report_id()
        conn.execute(
            "INSERT INTO message "
            "(id, conversation_id, sender_id, sender_role, content, is_read, create_timestamp) "
            "VALUES (?,?,?,?,?,0,?)",
            (mid, cid, user["id"], sender_role, content, now))
        conn.execute(
            "UPDATE conversation SET updated_timestamp=? WHERE id=?", (now, cid))
        conn.commit()
        row = _conv_meta(conn, cid)
        msg_row = conn.execute("SELECT * FROM message WHERE id=?", (mid,)).fetchone()
    finally:
        conn.close()
    return jsonify({"ok": True, "message": _msg_dict(msg_row),
                    "updated_at": row["updated_timestamp"] // 1000})


@app.post("/api/student/msg/conversation/<cid>/messages")
def api_student_msg_send(cid: str):
    """学生发送倾诉消息。"""
    user, err = _require_student()
    if err:
        return err
    return _send_message(
        cid, user, "student",
        lambda conv: conv["student_id"] == user["id"])


@app.post("/api/teacher/msg/conversation/<cid>/messages")
def api_teacher_msg_send(cid: str):
    """教师回复消息。"""
    user, err = _require_teacher()
    if err:
        return err
    return _send_message(
        cid, user, "teacher",
        lambda conv: conv["teacher_id"] == user["id"])


# ---------- 标记已读（收到对方消息 -> 已读） ----------
def _mark_read(cid: str, user, incoming_role: str, ownership_check):
    """把会话内来自对方的未读消息标记为已读。"""
    conn = _connect_db()
    try:
        conv_row = _conv_meta(conn, cid)
        if not conv_row or not ownership_check(conv_row):
            return jsonify({"error": "会话不存在"}), 404
        cur = conn.execute(
            "UPDATE message SET is_read=1 WHERE conversation_id=? "
            "AND sender_role=? AND is_read=0", (cid, incoming_role))
        conn.commit()
        updated = cur.rowcount
    finally:
        conn.close()
    return jsonify({"ok": True, "updated": updated})


@app.post("/api/student/msg/conversation/<cid>/read")
def api_student_msg_read(cid: str):
    """学生打开会话后，将老师的消息标记为已读。"""
    user, err = _require_student()
    if err:
        return err
    return _mark_read(cid, user, "teacher",
                      lambda conv: conv["student_id"] == user["id"])


@app.post("/api/teacher/msg/conversation/<cid>/read")
def api_teacher_msg_read(cid: str):
    """教师打开会话后，将学生的消息标记为已读。"""
    user, err = _require_teacher()
    if err:
        return err
    return _mark_read(cid, user, "student",
                      lambda conv: conv["teacher_id"] == user["id"])


# ---------- 教师端：学生留言会话列表（新消息高亮 + 班级标识） ----------
@app.get("/api/teacher/msg/conversations")
def api_teacher_msg_conversations():
    """教师收到的所有学生倾诉会话：按最新消息时间倒序，含未读学生消息数 + 最后预览。"""
    user, err = _require_teacher()
    if err:
        return err
    conn = _connect_db()
    try:
        rows = conn.execute(
            "SELECT * FROM conversation WHERE teacher_id=? "
            "ORDER BY updated_timestamp DESC", (user["id"],)).fetchall()
        # 一次性取会话涉及学生的姓名->班级映射（同库，避免逐条查询）
        student_ids = [c["student_id"] for c in rows]
        class_map = _student_class_map(conn, student_ids)
        conversations = []
        for c in rows:
            last = conn.execute(
                "SELECT content, create_timestamp FROM message WHERE conversation_id=? "
                "ORDER BY create_timestamp DESC LIMIT 1", (c["id"],)).fetchone()
            unread = conn.execute(
                "SELECT COUNT(*) AS n FROM message WHERE conversation_id=? "
                "AND sender_role='student' AND is_read=0", (c["id"],)).fetchone()["n"]
            conversations.append({
                "id": c["id"],
                "student_id": c["student_id"],
                "student_name": c["student_name"],
                "student_class": class_map.get(c["student_id"], ""),
                "last_message": last["content"] if last else "",
                # 毫秒 -> 秒（前端 fmtTime 按秒消费）
                "last_time": (last["create_timestamp"] if last else c["create_timestamp"]) // 1000,
                "unread": unread,
            })
    finally:
        conn.close()
    return jsonify({"conversations": conversations})


def _student_class_map(conn, student_ids):
    """按学生 id 批量取班级（统一库内直接查 student 表）。"""
    if not student_ids:
        return {}
    rows = conn.execute(
        "SELECT student_id, class FROM student WHERE student_id IN ({})".format(
            ",".join("?" * len(student_ids))),
        student_ids).fetchall()
    return {r["student_id"]: r["class"] for r in rows}


@app.get("/api/msg/unread")
def api_msg_unread():
    """首页 / 个人中心红点：返回当前用户的角色与未读消息数。
    红点=未读语义：进入留言详情浏览即自动标已读（/read 接口），红点随即消失；
    收到对方新的追加留言（is_read=0）时再次亮起，与列表页红点完全同步。"""
    user, err = _require_login()
    if err:
        return err
    role = user.get("role")
    if role not in ("student", "teacher"):
        return jsonify({"role": role, "total": 0})
    conn = _connect_db()
    try:
        # 老师发来未读算学生、学生发来未读算教师（列名按角色拼接，均为内部白名单值）
        incoming = "teacher" if role == "student" else "student"
        total = conn.execute(
            "SELECT COUNT(*) AS n FROM message m "
            "JOIN conversation c ON c.id=m.conversation_id "
            "WHERE c.{}_id=? AND m.sender_role=? AND m.is_read=0".format(role),
            (user["id"], incoming)).fetchone()["n"]
    finally:
        conn.close()
    return jsonify({"role": role, "total": total})


# ==================== API：教师端心理活动素材库（仅教师，学生 403） ====================
# 统一库 psy.db 的 activity_material 表；文件二进制直接存 file_blob，不落盘本地文件夹。
# 全部接口经 _require_teacher() 校验：未登录 401，学生 403「无权限」。
MATERIAL_CATEGORIES = ("班会方案", "团体活动方案", "心理科普PPT", "其他")
MATERIAL_EXTS = (".pdf", ".docx", ".pptx")


@app.before_request
def _material_upload_unlimited_size():
    """素材上传接口不限制单文件大小：按请求解除全局 50MB 上传上限（仅影响该接口，
    不改动 /api/face/analyze 视频上传等原有业务的 50MB 限制）。
    Werkzeug>=2.3 支持按请求覆盖 max_content_length；旧版本自动降级为全局上限。"""
    if request.path == "/api/teacher/materials/upload":
        try:
            request.max_content_length = None
        except Exception:
            pass  # 旧版 Werkzeug 不支持按请求覆盖，保持全局上限兜底


def _material_row_public(row, name_map):
    """activity_material 行 -> 对外 JSON（不返回 file_blob 与教师 id，只返回教师姓名）"""
    return {
        "material_id": row["material_id"],
        "title": row["title"],
        "category": row["category"],
        "brief": row["brief"] or "",
        "file_name": row["file_name"],
        "file_type": row["file_type"] or "",
        "uploader_name": name_map.get(row["uploader"], "教师"),
        # 库内毫秒 -> 秒后格式化
        "upload_time": datetime.fromtimestamp(row["upload_time"] / 1000).strftime("%Y-%m-%d %H:%M"),
    }


@app.get("/api/teacher/materials")
def api_teacher_materials():
    """素材列表（分页 + 标题关键词搜索 + 分类筛选）：所有教师均可查看全部素材"""
    user, err = _require_teacher()
    if err:
        return err
    keyword = (request.args.get("q") or "").strip()
    category = (request.args.get("category") or "").strip()
    page = max(1, request.args.get("page", 1, type=int))
    page_size = min(50, max(5, request.args.get("page_size", 8, type=int)))

    where, args = [], []
    if keyword:
        where.append("title LIKE ?")
        args.append(f"%{keyword}%")
    if category:
        where.append("category = ?")
        args.append(category)
    where_sql = (" WHERE " + " AND ".join(where)) if where else ""

    conn = _connect_db()
    try:
        total = conn.execute(
            f"SELECT COUNT(*) AS n FROM activity_material{where_sql}", args
        ).fetchone()["n"]
        rows = conn.execute(
            f"SELECT material_id, title, category, brief, file_name, file_type, uploader, upload_time"
            f" FROM activity_material{where_sql} ORDER BY upload_time DESC LIMIT ? OFFSET ?",
            args + [page_size, (page - 1) * page_size]).fetchall()
    finally:
        conn.close()
    name_map = _teacher_name_map([r["uploader"] for r in rows])
    return jsonify({
        "total": total, "page": page, "page_size": page_size,
        "categories": list(MATERIAL_CATEGORIES),
        "materials": [_material_row_public(r, name_map) for r in rows],
    })


@app.get("/api/teacher/materials/<material_id>")
def api_teacher_material_detail(material_id):
    """素材详情（仅元信息；file_size 用 LENGTH() 取字节数，不加载 blob 本体）"""
    user, err = _require_teacher()
    if err:
        return err
    conn = _connect_db()
    try:
        row = conn.execute(
            "SELECT material_id, title, category, brief, file_name, file_type, uploader,"
            " upload_time, LENGTH(file_blob) AS file_size"
            " FROM activity_material WHERE material_id = ?", (material_id,)).fetchone()
    finally:
        conn.close()
    if not row:
        return jsonify({"error": "素材不存在或已被删除"}), 404
    data = _material_row_public(row, _teacher_name_map([row["uploader"]]))
    data["file_size"] = row["file_size"] or 0
    return jsonify(data)


@app.get("/api/teacher/materials/<material_id>/download")
def api_teacher_material_download(material_id):
    """素材下载（流式返回 BLOB 内容，按原始文件名保存；所有教师可下载全部素材）"""
    user, err = _require_teacher()
    if err:
        return err
    conn = _connect_db()
    try:
        row = conn.execute(
            "SELECT file_blob, file_name, file_type FROM activity_material WHERE material_id = ?",
            (material_id,)).fetchone()
    finally:
        conn.close()
    if not row:
        return jsonify({"error": "素材不存在或已被删除"}), 404
    return send_file(
        io.BytesIO(row["file_blob"]),
        mimetype=row["file_type"] or "application/octet-stream",
        as_attachment=True,
        download_name=row["file_name"],  # Flask 自动按 RFC 5987 编码中文文件名
    )


@app.post("/api/teacher/materials/upload")
def api_teacher_material_upload():
    """上传素材（仅教师）：multipart 表单 title/category/brief/file；
    文件二进制直接 INSERT 进 activity_material.file_blob，不保存本地文件；
    允许格式 pdf / docx / pptx，不限制单文件大小（见 _material_upload_unlimited_size）。"""
    user, err = _require_teacher()
    if err:
        return err
    title = (request.form.get("title") or "").strip()
    category = (request.form.get("category") or "").strip()
    brief = (request.form.get("brief") or "").strip()
    if not title:
        return jsonify({"error": "请填写素材标题"}), 400
    if category not in MATERIAL_CATEGORIES:
        return jsonify({"error": "请选择有效的素材分类"}), 400

    file = request.files.get("file")
    if file is None or not file.filename:
        return jsonify({"error": "请选择要上传的文件"}), 400
    fname = os.path.basename(file.filename).strip()
    ext = os.path.splitext(fname)[1].lower()
    if ext not in MATERIAL_EXTS:
        return jsonify({"error": f"仅支持 pdf / docx / pptx 格式，当前文件：{ext or '（无扩展名）'}"}), 400
    blob = file.read()
    if not blob:
        return jsonify({"error": "文件内容为空，请重新选择"}), 400

    mid = _make_report_id()
    conn = _connect_db()
    try:
        conn.execute(
            "INSERT INTO activity_material"
            " (material_id, title, category, brief, file_blob, file_name, file_type, uploader, upload_time)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (mid, title, category, brief, blob, fname,
             file.mimetype or "", user["id"], _now_ms()))
        conn.commit()
    finally:
        conn.close()
    return jsonify({"ok": True, "material_id": mid, "title": title})


# ==================== 启动入口 ====================
if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="心理测试分析网站后端")
    parser.add_argument("--mock", action="store_true",
                        help="本地演示模式：不依赖 vLLM 与 py-feat")
    args = parser.parse_args()

    if args.mock:
        config.MOCK_MODE = True
        print("=" * 50)
        print("[MOCK] 演示模式已开启：LLM 与视频分析返回占位数据")
        print("=" * 50)

    # 启动前数据库结构自愈：补建库 / 表 / 新列（幂等）
    try:
        _ensure_db_schema()
    except Exception as e:
        print(f"[db] ⚠️ 数据库初始化异常（请检查 autodl-fs 挂载）：{e}")

    # 心理科普文章：确保表存在并写入/刷新系统内置权威文章（幂等，只对齐内置 seed 文章）
    try:
        conn = _connect_db()
        try:
            article_seed.seed_articles(conn)
        finally:
            conn.close()
    except Exception as e:
        print(f"[db] ⚠️ 科普文章初始化异常：{e}")

    print(f"心理测试分析网站启动：http://{config.HOST}:{config.PORT}")
    print(f"  首页 /    聊天 /chat    视频分析 /face    心理测试 /test")
    app.run(host=config.HOST, port=config.PORT, debug=False)
