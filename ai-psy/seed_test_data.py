# -*- coding: utf-8 -*-
"""全量测试数据填充脚本（可重复执行，不改动任何表结构与业务代码）。

运行方式（项目根目录）：
    runtime\\venv\\Scripts\\python.exe app\\seed_test_data.py

说明：
  1. 项目实际数据库为 PostgreSQL（不是 SQLite），连接串取自 server.config.Config；
  2. 每次执行先按依赖逆序清空教师、班级关联、学生、文本报告、视频报告、AI 综合报告、
     咨询时段与预约、倾诉会话与消息，并用 TRUNCATE ... RESTART IDENTITY 重置自增主键，保证脚本幂等；
  3. 账号密码统一走项目原有 build_password_hash()，可用「手机号 + 手机号」直接登录；
  4. 文本报告分值一律用项目 scoring.compute_scores() 计算，保证与线上计分口径一致；
  5. 预约/倾诉数据基于同一批 20 名学生生成：19 人各 1 条预约、王一 4 条覆盖全部状态，
     每人与王老师有会话，部分 11/22 班学生额外与李老师有会话。
"""
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent
if str(APP_DIR) not in sys.path:
    sys.path.insert(0, str(APP_DIR))

from flask import Flask  # noqa: E402
from sqlalchemy import text  # noqa: E402

from server.config import Config  # noqa: E402
from server.extensions import db  # noqa: E402
from server.models import (  # noqa: E402
    AiAnalysisReport, Appointment, Conversation, CounselingSlot, Message,
    Scl90TextReport, Student, Teacher, TeacherClass, VideoFaceReport,
)
from server.scoring import CRISIS_QUESTIONS, FACTOR_MAP, compute_scores, factor_averages  # noqa: E402
from server.security import build_password_hash, verify_password  # noqa: E402

CST = timezone(timedelta(hours=8))
# 报告基准时间：取执行当天 10:00。
# 原因：教师端班级列表默认按「近 7 天」筛选，固定历史日期会让其他学生被过滤掉，
# 误以为"只有王一有数据"；按执行日生成可保证每次填充后班级列表都能看到全部学生。
BASE_DAY = datetime.now(CST).replace(hour=10, minute=0, second=0, microsecond=0)
# 教师/学生登录备用账号前缀（与手机号区分，仍可手机号登录）
BACKUP_ACCOUNT_PREFIX = "88"

# 四档状态的因子目标均分（顺序与 FACTOR_MAP 完全一致）
SEVERITY_FACTOR_AVGS = {
    "normal": [1.2, 1.5, 1.4, 1.3, 1.2, 1.1, 1.1, 1.2, 1.1, 1.3],
    "mild": [1.7, 2.1, 1.9, 1.9, 1.7, 1.5, 1.4, 1.6, 1.4, 1.7],
    "moderate": [2.2, 2.7, 2.5, 2.6, 2.3, 2.0, 1.9, 2.1, 1.8, 2.2],
    "crisis": [2.9, 3.3, 3.2, 3.5, 3.2, 2.6, 2.5, 2.8, 2.4, 3.0],
}

# 视频情绪分布（6 类基本情绪，合计约等于 1）
SEVERITY_EMOTIONS = {
    "normal": {"happiness": 0.62, "surprise": 0.21, "sadness": 0.08,
               "fear": 0.04, "anger": 0.03, "disgust": 0.02},
    "mild": {"happiness": 0.45, "surprise": 0.17, "sadness": 0.18,
             "fear": 0.09, "anger": 0.07, "disgust": 0.04},
    "moderate": {"happiness": 0.25, "surprise": 0.12, "sadness": 0.32,
                 "fear": 0.15, "anger": 0.10, "disgust": 0.06},
    "crisis": {"happiness": 0.12, "surprise": 0.07, "sadness": 0.45,
               "fear": 0.18, "anger": 0.12, "disgust": 0.06},
}

SEVERITY_DOMINANT = {
    "normal": "happiness", "mild": "happiness",
    "moderate": "sadness", "crisis": "sadness",
}

EMOTION_CN = {
    "happiness": "愉悦", "sadness": "低落", "fear": "紧张",
    "anger": "烦躁", "disgust": "排斥", "surprise": "惊讶",
}

# 8 项 AU：内眉上扬 / 外眉上扬 / 眉毛压低 / 脸颊提起 / 眼睑收紧 / 嘴角提起 / 酒窝 / 眨眼
AU_KEYS = ["AU01", "AU02", "AU04", "AU06", "AU07", "AU12", "AU14", "AU45"]
# 各 AU 在不同状态下的基础激活度（0-1）
SEVERITY_AU = {
    "normal": [0.12, 0.10, 0.05, 0.55, 0.18, 0.72, 0.48, 0.22],
    "mild": [0.20, 0.18, 0.16, 0.42, 0.24, 0.55, 0.35, 0.28],
    "moderate": [0.34, 0.30, 0.38, 0.28, 0.33, 0.30, 0.20, 0.35],
    "crisis": [0.46, 0.42, 0.50, 0.20, 0.40, 0.18, 0.12, 0.42],
}

SEVERITY_STUDENT_HEADLINE = {
    "normal": "你最近的整体状态比较平稳，情绪与生活节奏都在一个相对舒服的区间。",
    "mild": "你最近有一点点状态起伏，多数时候还能自我调节，但有几处值得稍微留意。",
    "moderate": "你最近承受的压力比较明显，情绪和身体感受都在提醒你需要放慢一点节奏。",
    "crisis": "你最近这段时间过得比较辛苦，情绪负担偏重，很需要被认真看见和陪伴。",
}

# ---------- 预约（counseling_slots / appointments） ----------
# 每个教师排 5 个时段：负数偏移为历史时段（承载已完成/已驳回），正数偏移为未来可约时段。
# 学生端只展示 date >= 今天的时段，因此必须保留正数偏移，否则「可预约时段」会为空。
SLOT_DAY_OFFSETS = (-6, -2, 2, 4, 7)
SLOT_TIME_RANGES = (
    ("09:00", "09:30"),
    ("10:00", "10:30"),
    ("14:00", "14:30"),
    ("15:00", "15:30"),
    ("16:00", "16:30"),
)
# 单个时段名额：略高于种子预约密度，保证每个未来时段都还有余量可供学生现场演示预约
SLOT_MAX_CAPACITY = 4
SLOT_OPEN_NOTE = "心理中心一对一咨询"
SLOT_PAST_NOTE = "历史排班"

# 预约状态轮转：20 名学生覆盖待审核/已通过/已完成/已驳回/学生取消五种状态
APPOINTMENT_STATUS_CYCLE = ("pending", "confirmed", "done", "rejected", "cancelled")
# 占用名额的状态与接口层 _ACTIVE_STATUSES 对齐（库内 accepted，响应层映射 confirmed）
APPOINTMENT_ACTIVE_STATUSES = ("pending", "accepted")
# 响应层契约状态 -> 库内状态（与 appointment_api 的映射方向相反）
APPOINTMENT_STATUS_TO_DB = {"confirmed": "accepted", "cancelled": "canceled"}

APPOINTMENT_REASONS = (
    "最近晚上总是睡不着，想找老师聊聊怎么调整作息。",
    "和室友相处有些别扭，不太敢表达自己的想法，心里挺闷的。",
    "最近情绪起伏比较大，有时候会突然很难过，想找人说说。",
    "马上要考试了，总觉得自己准备得不够，越想越焦虑。",
    "最近做什么都提不起劲，想请老师帮忙看看该怎么调整。",
    "和家里人沟通不太顺利，感觉他们不理解我，有点委屈。",
)

APPOINTMENT_REPLIES = {
    "confirmed": "已收到你的预约，请提前 5 分钟到心理中心，我们会在一对一空间里慢慢聊。",
    "rejected": "这个时段已有班级活动安排，建议改约本周其他时段，我已为你保留名额。",
    "done": "今天的沟通很有意义，记得按我们约定的小目标试一试，有变化随时来倾诉。",
    "pending": None,
    "cancelled": None,
}

# ---------- 倾诉（conversation / message） ----------
CONFIDE_OPENERS = (
    "老师您好，我最近学习压力有点大，晚上总是想很多事情，睡不太好。",
    "老师，我最近和室友相处得有点别扭，不太敢表达自己的想法，心里挺闷的。",
    "老师您好，我最近情绪起伏比较大，有时候会突然很难过，不知道该怎么调整。",
    "老师，我马上要考试了，总觉得自己准备得不够，越想越焦虑。",
    "老师您好，我最近总提不起劲，做什么都没兴趣，想找个人说说话。",
    "老师，我和家里人沟通不太顺利，感觉他们不理解我，有点委屈。",
)

CONFIDE_TEACHER_REPLIES = (
    "谢谢你愿意说出来，这本身就很不容易。先别急着解决所有问题，可以跟我说说最近哪一天最难熬吗？",
    "听起来你一直在努力照顾别人的感受。你的感受同样重要，我们可以一起练习怎么温和地表达需求。",
    "情绪有起伏是很正常的信号，不是你不够好。你可以先记录一周的情绪变化，我们下次一起看看规律。",
    "焦虑往往来自对结果的担心。我们先把复习任务拆小，今天只完成一件，做完就允许自己休息。",
    "没兴趣、提不起劲确实会让人更自责。先从小事开始，比如每天出门走 15 分钟，我们保持联系。",
    "被家人误解会很难受。我们可以先练习一段想对家人说的话，找一个相对平静的时机表达。",
)

CONFIDE_STUDENT_FOLLOWUPS = (
    "嗯，主要是这几天晚上躺下以后脑子停不下来。",
    "我试着说过一次，但没说完就退缩了。",
    "好，我先按您说的记录一下，谢谢老师。",
    "我怕自己做得不够好，让家里失望。",
    "谢谢老师愿意听我说这些。",
    "那我今晚先试试早点放下手机。",
)

CONFIDE_TEACHER_FOLLOWUPS = (
    "能具体说说让你停不下来的通常是哪些事吗？写下来会比在脑子里打转更清晰。",
    "没关系，表达是可以慢慢练习的。下次我们可以先从一个很小的请求开始。",
    "不客气，你愿意行动就是很好的开始。有任何变化都可以在这里留言。",
    "你对家人的在意说明你很重视这段关系，但也不必把所有期待都压在自己身上。",
    "我会一直在。下次可以告诉我这周有没有哪一个时刻稍微轻松一点。",
    "好的，我们下次就从睡眠和白天状态聊起，你不用一个人扛着。",
)

CONFIDE_STUDENT_ENDINGS = (
    "好的老师，我这周先按您说的试试，有变化再跟您说。",
    "谢谢老师，我感觉说出来之后轻松了一点。",
    "我明白了，那我先从小事开始做起。",
)

CONFIDE_TEACHER_ENDINGS = (
    "不客气，记得不用一次做到完美，能做到一点点就很好。",
    "随时可以来找我，我们慢慢来。",
    "我看到了你的努力，下周我们再一起看看进展。",
)


def to_ms(moment: datetime) -> int:
    return int(moment.timestamp() * 1000)


# 阳性作答分值（>=3 计入阳性项目数）与其余题目的平均作答水平
POSITIVE_SCORE = {"normal": 0, "mild": 3, "moderate": 3, "crisis": 4}
LOW_AVG = {"normal": 1.0, "mild": 1.3, "moderate": 1.6, "crisis": 2.2}


def _build_answers(severity: str) -> dict[int, int]:
    """按目标均分生成 90 题作答：既命中因子均分，也让阳性项目数贴近真实分布。"""
    targets = SEVERITY_FACTOR_AVGS[severity]
    answers: dict[int, int] = {}
    for (_, items), target in zip(FACTOR_MAP.items(), targets):
        count = len(items)
        if severity == "normal":
            # 正常区间只有 1/2 分，阳性项目数为 0
            twos = max(0, min(count, round((target - 1) * count)))
            for index, qid in enumerate(items):
                answers[qid] = 2 if index < twos else 1
            continue
        positive_score = POSITIVE_SCORE[severity]
        low_avg = LOW_AVG[severity]
        positive_items = round((target - low_avg) * count / (positive_score - low_avg))
        positive_items = max(0, min(count, positive_items))
        rest_avg = (target * count - positive_items * positive_score) / max(1, count - positive_items)
        rest_base = int(rest_avg)
        rest_high = round((rest_avg - rest_base) * (count - positive_items))
        for index, qid in enumerate(items):
            if index < positive_items:
                answers[qid] = positive_score
            else:
                answers[qid] = rest_base + 1 if index - positive_items < rest_high else rest_base
    if severity == "crisis":
        # 危机题项至少 4 分，触发风险信号
        for offset, qid in enumerate(CRISIS_QUESTIONS):
            answers[qid] = 4 if offset % 2 == 0 else 5
    return answers


def _build_video(severity: str, moment: datetime) -> dict:
    """生成与文本风险等级匹配的视频指标。"""
    emotions = dict(SEVERITY_EMOTIONS[severity])
    dominant = SEVERITY_DOMINANT[severity]
    activity = {"normal": 0.92, "mild": 0.80, "moderate": 0.63, "crisis": 0.45}[severity]
    au_means = SEVERITY_AU[severity]
    au = {
        key: {"mean": round(value, 3), "max": round(min(1.0, value * 1.35), 3)}
        for key, value in zip(AU_KEYS, au_means)
    }
    total_frames = 450
    face_frames = {"normal": 442, "mild": 436, "moderate": 428, "crisis": 418}[severity]
    au_json = json.dumps({
        "au": au,
        "total_frames": total_frames,
        "face_frames": face_frames,
        "face_activity": activity,
        "physiology": {
            "heart_rate": {"normal": 72, "mild": 78, "moderate": 86, "crisis": 94}[severity],
            "hrv_ms": {"normal": 58, "mild": 49, "moderate": 40, "crisis": 31}[severity],
            "spo2": {"normal": 98, "mild": 97, "moderate": 97, "crisis": 96}[severity],
            "stress_index": {"normal": 32, "mild": 48, "moderate": 66, "crisis": 82}[severity],
        },
    }, ensure_ascii=False)
    trend = [
        {"second": step, "dominant": dominant, "confidence": round(emotions[dominant] - step * 0.01, 3)}
        for step in range(6)
    ]
    emotion_json = json.dumps({
        "emotions": emotions,
        "dominant_emotion": dominant,
        "dominant_emotion_source": "model",
        "smile_detected": severity == "normal",
        "trend": trend,
    }, ensure_ascii=False)
    landmark_json = json.dumps({"points": 468, "sample_frames": 12}, ensure_ascii=False)
    return {
        "au_json": au_json,
        "emotion_json": emotion_json,
        "landmark_json": landmark_json,
        "prominent_dimension": dominant,
    }


def _top_factors(result: dict, limit: int = 3) -> list[tuple[str, float]]:
    factors = result.get("因子分") or {}
    rows = [(name, item["均分"]) for name, item in factors.items()]
    rows.sort(key=lambda pair: pair[1], reverse=True)
    return rows[:limit]


def _build_composite_content(name: str, severity: str, result: dict,
                             dominant: str) -> str:
    """生成综合报告正文：学生版（通俗）+ 教师版（专业），双端同一份数据。"""
    total = result["总分"]
    gsi = result["总均分"]
    positive = result["阳性项目数"]
    tops = _top_factors(result)
    top_text = "、".join(f"{factor}（{score}分）" for factor, score in tops)
    top_names = "、".join(factor for factor, _ in tops)
    dominant_cn = EMOTION_CN.get(dominant, "平静")
    headline = SEVERITY_STUDENT_HEADLINE[severity]
    consistency = {
        "normal": "文字自评与视频表情都指向较为轻松的状态，两份数据彼此印证。",
        "mild": "文字自评与视频表情都出现了轻微波动，方向一致，属于可以自我调节的范围。",
        "moderate": "文字自评反映的压力与视频中偏低的愉悦表情基本一致，说明近期负担比较真实。",
        "crisis": "文字自评与视频表情同时出现明显低落信号，两份数据高度一致，需要优先关注。",
    }[severity]

    student_part = f"""### 整体状态结论
{headline}

### 双模态交叉验证
{consistency}视频中你的主导情绪是「{dominant_cn}」，这只是拍摄当下的一个片段，
可以和最近几天的真实感受放在一起看，不必因为一次结果给自己下结论。

### 核心关注方向
1. 最近是否常常觉得累、提不起劲，或者睡眠不太安稳。
2. 面对学习与人际时，是否比平时更容易烦躁或想回避。
3. 有没有一些情绪一直压在心里，没有找到合适的人说。

### 分层调适建议
1. 情绪表达：每天睡前用三句话写下今天最强烈的感受，写完合上本子，不评判对错。
2. 压力调节：把当前最困扰的事情拆成三个小步骤，每天只完成一步，完成即停。
3. 人际互动：本周主动找一个信任的同学或家人聊 10 分钟，只说感受，不必给建议。
4. 日常习惯：固定一个入睡时间，睡前一小时放下手机，用热水洗漱代替刷屏。
5. 身体放松：课间做 3 轮「吸气 4 秒、屏住 2 秒、呼气 6 秒」的呼吸练习。
6. 求助准备：如果低落持续两周以上或影响吃饭睡觉，请主动联系心理老师或拨打心理援助热线。

本报告为AI辅助生成，仅供参考，不能替代专业心理诊断与治疗。"""

    teacher_part = f"""### 专业指标结论
本次 SCL-90 总分 {total}，总均分 {gsi}，阳性项目数 {positive}（阳性判定为单项≥3分），
最高因子为 {top_text}。视频端主导情绪为{dominant_cn}，面部活跃度与情绪分布同文本结果方向一致。
以上仅为量表与表情指标的客观汇总，不作为临床诊断依据。

### 双模态交叉验证
{consistency}两类数据的一致性较高，可作为后续沟通的参考；若个别维度存在差异，
建议结合学生近期作息、考试安排与家庭事件进一步核实。

### 核心关注维度
1. {tops[0][0]}：均分 {tops[0][1]}，为当前最突出维度，建议优先关注。
2. {tops[1][0]}：均分 {tops[1][1]}，与视频中的负面情绪占比相互印证。
3. {tops[2][0]}：均分 {tops[2][1]}，建议在日常沟通中持续观察。

### 分层干预建议
1. 班级层面：两周内开展一次压力管理主题班会，弱化排名比较，强调睡眠与运动。
2. 个别沟通：一周内与该生进行一次 15 分钟一对一谈话，先倾听再给建议，避免追问细节。
3. 家校协同：与家长沟通作息与情绪变化，建议减少额外课外负担，保持稳定作息。
4. 跟踪记录：每两周复测一次 SCL-90，对比 {top_names} 的变化趋势。
5. 转介预案：若持续两周无改善或出现自伤意念，及时联系学校心理中心并告知家长。
6. 资源支持：向学生提供心理援助热线与校心理中心预约方式，降低求助门槛。

本报告为AI辅助生成，仅供参考，不能替代专业心理诊断与治疗。"""

    return f"## 学生版\n{student_part}\n\n## 教师版\n{teacher_part}"


def _seed_teachers() -> list[dict]:
    """2 名教师 + 班级绑定关系。"""
    teacher_rows = [
        {
            "name": "王老师",
            "phone": "19911111111",
            "job_number": "100001",
            "classes": ["11班", "22班", "33班", "44班"],
        },
        {
            "name": "李老师",
            "phone": "19922222222",
            "job_number": "100002",
            "classes": ["11班", "22班"],
        },
    ]
    records = []
    for index, row in enumerate(teacher_rows):
        teacher_id = f"20260101{row['job_number']}"
        teacher = Teacher(
            teacher_id=teacher_id,
            name=row["name"],
            class_="、".join(row["classes"]),
            job_number=row["job_number"],
            account=f"{BACKUP_ACCOUNT_PREFIX}{row['job_number']}",
            password=build_password_hash(row["phone"]),
            phone=row["phone"],
            login_timestamp=to_ms(BASE_DAY - timedelta(days=3, minutes=index * 7)),
            account_status="active",
        )
        db.session.add(teacher)
        for class_index, class_name in enumerate(row["classes"]):
            db.session.add(TeacherClass(
                teacher_id=teacher_id,
                class_id=class_name,
                create_timestamp=to_ms(BASE_DAY - timedelta(days=200, minutes=class_index)),
            ))
        records.append({**row, "teacher_id": teacher_id})
    return records


def _seed_students() -> list[dict]:
    """20 名学生：王一一组 10 人、李一一组 10 人，四班各 5 人。"""
    cn_numbers = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十"]
    class_plan = ["11班"] * 5 + ["22班"] * 5 + ["33班"] * 5 + ["44班"] * 5
    records = []
    for index in range(20):
        surname = "王" if index < 10 else "李"
        name = f"{surname}{cn_numbers[index % 10]}"
        student_no = str(20260001 + index)
        phone = str(19900000001 + index)
        student_id = f"20260101{student_no}"
        student = Student(
            student_id=student_id,
            name=name,
            class_=class_plan[index],
            student_no=student_no,
            account=f"{BACKUP_ACCOUNT_PREFIX}{student_no}",
            password=build_password_hash(phone),
            phone=phone,
            register_timestamp=to_ms(datetime(2026, 2, 20, 9, 0, tzinfo=CST) + timedelta(minutes=index * 3)),
            account_status="active",
        )
        db.session.add(student)
        records.append({
            "student_id": student_id,
            "name": name,
            "class": class_plan[index],
            "student_no": student_no,
            "phone": phone,
        })
    return records


def _session_plan(student_index: int) -> list[tuple[datetime, str]]:
    """每个学生的测评批次：王一 6 批（正常→危机），其余 1 批。"""
    if student_index == 0:
        severities = ["crisis", "moderate", "moderate", "mild", "mild", "normal"]
        return [(BASE_DAY - timedelta(days=15 * offset), severity)
                for offset, severity in enumerate(severities)]
    day = BASE_DAY - timedelta(days=1 + student_index % 5)
    return [(day.replace(hour=14, minute=student_index % 50), "normal" if student_index % 2 == 0 else "mild")]


def _seed_reports(student: dict, student_index: int, teacher_id: str) -> dict:
    """按批次生成文本 / 视频 / AI 综合报告，并回写最新报告指针。"""
    latest_text_id, latest_video_id = "", ""
    for session_index, (moment, severity) in enumerate(_session_plan(student_index)):
        session_no = session_index + 1
        text_id = f"R{student['student_no']}{session_no:02d}T"
        video_id = f"R{student['student_no']}{session_no:02d}V"

        answers = _build_answers(severity)
        result = compute_scores(answers)
        factor_cols = factor_averages(result)
        max_factor = max((v for v in factor_cols.values() if v is not None), default=None)

        text_row = Scl90TextReport(
            report_id=text_id,
            student_id=student["student_id"],
            student_name=student["name"],
            student_class=student["class"],
            crowd_tag="大学生",
            total_score=result["总分"],
            pos_item_count=result["阳性项目数"],
            neg_item_count=90 - result["阳性项目数"],
            risk_signal=1 if result["危机信号"] else 0,
            max_factor_score=max_factor,
            gsi=result["总均分"],
            psdi=result["阳性症状均分"],
            submit_timestamp=to_ms(moment),
            item_answers=json.dumps({str(k): v for k, v in answers.items()}, ensure_ascii=False),
            status="completed",
            error_message=None,
            request_key=f"seed-text-{student['student_no']}-{session_no}",
            finished_at=to_ms(moment + timedelta(seconds=30)),
            **factor_cols,
        )
        db.session.add(text_row)

        video = _build_video(severity, moment)
        video_moment = moment + timedelta(minutes=5)
        video_row = VideoFaceReport(
            video_report_id=video_id,
            student_id=student["student_id"],
            au_json=video["au_json"],
            emotion_json=video["emotion_json"],
            landmark_json=video["landmark_json"],
            prominent_dimension=video["prominent_dimension"],
            create_timestamp=to_ms(video_moment),
            status="completed",
            error_message=None,
            request_key=f"seed-video-{student['student_no']}-{session_no}",
            finished_at=to_ms(video_moment + timedelta(seconds=180)),
        )
        db.session.add(video_row)

        db.session.add(AiAnalysisReport(
            student_name=student["name"],
            student_class=student["class"],
            student_no=student["student_no"],
            phone=student["phone"],
            student_id=student["student_id"],
            teacher_id=teacher_id,
            text_report_id=text_id,
            video_report_id=video_id,
            ai_content=_build_composite_content(
                student["name"], severity, result, video["prominent_dimension"]),
            create_timestamp=to_ms(video_moment + timedelta(seconds=200)),
            status="completed",
            error_message=None,
            request_key=f"seed-composite-{student['student_no']}-{session_no}",
            finished_at=to_ms(video_moment + timedelta(seconds=290)),
            teacher_read=0 if session_no == 1 else 1,
        ))

        latest_text_id, latest_video_id = text_id, video_id

    db.session.execute(
        text("UPDATE student SET latest_text_report_id = :t, latest_video_report_id = :v "
             "WHERE student_id = :sid"),
        {"t": latest_text_id, "v": latest_video_id, "sid": student["student_id"]},
    )
    return {"text": latest_text_id, "video": latest_video_id}


def _seed_counseling_slots(teachers: list[dict]) -> dict[str, list[CounselingSlot]]:
    """每名教师排 5 个时段：2 个历史时段 + 3 个未来可约时段。"""
    slots_by_teacher: dict[str, list[CounselingSlot]] = {}
    for teacher_index, teacher in enumerate(teachers):
        rows: list[CounselingSlot] = []
        for slot_index, offset in enumerate(SLOT_DAY_OFFSETS):
            day = (BASE_DAY + timedelta(days=offset)).strftime("%Y-%m-%d")
            start_time, end_time = SLOT_TIME_RANGES[
                (slot_index + teacher_index) % len(SLOT_TIME_RANGES)
            ]
            slot = CounselingSlot(
                id=f"SL{teacher_index + 1:02d}{slot_index + 1:02d}",
                teacher_id=teacher["teacher_id"],
                teacher_name=teacher["name"],
                date=day,
                time_slot=f"{start_time}-{end_time}",
                start_time=start_time,
                end_time=end_time,
                max_capacity=SLOT_MAX_CAPACITY,
                current_count=0,
                note=SLOT_OPEN_NOTE if offset > 0 else SLOT_PAST_NOTE,
                status="open",
                created_at=to_ms(BASE_DAY - timedelta(days=10)),
            )
            db.session.add(slot)
            rows.append(slot)
        slots_by_teacher[teacher["teacher_id"]] = rows
    return slots_by_teacher


def _appointment_teacher(teachers: list[dict], student: dict, student_index: int) -> dict:
    """11/22 班部分学生分给李老师，其余归王老师，保证两名教师都有预约数据。"""
    if student["class"] in ("11班", "22班") and student_index % 2 == 1:
        return teachers[1]
    return teachers[0]


def _pick_slot(slots: list[CounselingSlot], status: str, cursor: int) -> CounselingSlot:
    """按状态选时段：未来状态用未来时段、历史状态用历史时段，并优先未满员时段。"""
    today = BASE_DAY.strftime("%Y-%m-%d")
    need_future = status in ("pending", "confirmed", "cancelled")
    pool = [slot for slot in slots if (slot.date >= today) == need_future] or slots
    offset = cursor % len(pool)
    ordered = pool[offset:] + pool[:offset]
    for slot in ordered:
        if slot.current_count < slot.max_capacity:
            return slot
    return ordered[0]


def _appointment_created_day(slot_date: str) -> datetime:
    """预约创建时间：未来时段取前天傍晚，历史时段取时段前三天下午。"""
    slot_day = datetime.strptime(slot_date, "%Y-%m-%d").replace(tzinfo=CST)
    if slot_day.date() >= BASE_DAY.date():
        return (BASE_DAY - timedelta(days=2)).replace(hour=19, minute=20)
    return (slot_day - timedelta(days=3)).replace(hour=16, minute=10)


def _add_appointment(student: dict, teacher: dict, slot: CounselingSlot,
                     status: str, sequence: int, student_index: int) -> None:
    """写一条预约；名额只统计 pending/accepted，与接口层 _ACTIVE_STATUSES 一致。"""
    db_status = APPOINTMENT_STATUS_TO_DB.get(status, status)
    if db_status in APPOINTMENT_ACTIVE_STATUSES:
        slot.current_count += 1
    created_day = _appointment_created_day(slot.date)
    teacher_time = None
    if status in ("confirmed", "rejected", "done"):
        teacher_time = to_ms(created_day + timedelta(days=1, hours=2))
    db.session.add(Appointment(
        id=f"AP{student['student_no']}{sequence:02d}",
        slot_id=slot.id,
        teacher_id=teacher["teacher_id"],
        teacher_name=teacher["name"],
        student_id=student["student_id"],
        student_name=student["name"],
        student_class=student["class"],
        date=slot.date,
        time_slot=slot.time_slot,
        reason=APPOINTMENT_REASONS[(student_index + sequence) % len(APPOINTMENT_REASONS)],
        status=db_status,
        reply=APPOINTMENT_REPLIES.get(status),
        teacher_time=teacher_time,
        created_at=to_ms(created_day),
    ))


def _seed_appointments(teachers: list[dict], students: list[dict],
                       slots_by_teacher: dict[str, list[CounselingSlot]]) -> int:
    """20 名学生各 1 条预约，王一额外 3 条覆盖多种状态。"""
    count = 0
    for index, student in enumerate(students):
        teacher = _appointment_teacher(teachers, student, index)
        status = APPOINTMENT_STATUS_CYCLE[index % len(APPOINTMENT_STATUS_CYCLE)]
        slot = _pick_slot(slots_by_teacher[teacher["teacher_id"]], status, index // 5)
        _add_appointment(student, teacher, slot, status, 1, index)
        count += 1

    # 王一追加：已通过 / 已完成 / 已取消，让学生端预约列表状态更完整
    wang, teacher = students[0], teachers[0]
    slots = slots_by_teacher[teacher["teacher_id"]]
    for sequence, status in enumerate(("confirmed", "done", "cancelled"), start=2):
        slot = _pick_slot(slots, status, sequence)
        _add_appointment(wang, teacher, slot, status, sequence, 0)
        count += 1
    return count


def _confide_partners(teachers: list[dict], student: dict, student_index: int) -> list[dict]:
    """每人与王老师有会话；11/22 班部分学生额外与李老师有会话。"""
    partners = [teachers[0]]
    if student["class"] in ("11班", "22班") and student_index % 2 == 0:
        partners.append(teachers[1])
    return partners


def _build_confide_messages(student_index: int) -> list[tuple[str, str, int]]:
    """生成一段完整对话：学生开场 -> 老师回应 -> 学生补充 -> 老师建议 (+ 未读收尾)。"""
    offset = student_index % len(CONFIDE_OPENERS)
    rows = [
        ("student", CONFIDE_OPENERS[offset], 1),
        ("teacher", CONFIDE_TEACHER_REPLIES[offset], 1),
        ("student", CONFIDE_STUDENT_FOLLOWUPS[offset], 1),
        ("teacher", CONFIDE_TEACHER_FOLLOWUPS[offset], 1),
    ]
    tail = student_index % 3
    student_ending = CONFIDE_STUDENT_ENDINGS[offset % len(CONFIDE_STUDENT_ENDINGS)]
    teacher_ending = CONFIDE_TEACHER_ENDINGS[offset % len(CONFIDE_TEACHER_ENDINGS)]
    if tail == 0:
        # 最后一条来自老师且未读：学生端出现红点
        rows.append(("teacher", teacher_ending, 0))
    elif tail == 1:
        # 最后一条来自学生且未读：教师端出现红点
        rows.append(("student", student_ending, 0))
    else:
        rows.append(("student", student_ending, 1))
        rows.append(("teacher", teacher_ending, 1))
    return rows


def _seed_conversations(teachers: list[dict], students: list[dict]) -> tuple[int, int]:
    """为每名学生生成一对一倾诉会话与消息，返回（会话数, 消息数）。"""
    conversation_count = message_count = 0
    for index, student in enumerate(students):
        partners = _confide_partners(teachers, student, index)
        for partner_index, teacher in enumerate(partners, start=1):
            conversation_id = f"CV{student['student_no']}{partner_index}"
            created = BASE_DAY - timedelta(days=1 + index % 6, minutes=index * 7)
            last_moment = created
            for position, (role, content, is_read) in enumerate(
                    _build_confide_messages(index + partner_index - 1), start=1):
                last_moment = created + timedelta(minutes=9 * (position - 1))
                db.session.add(Message(
                    id=f"MG{student['student_no']}{partner_index}{position:02d}",
                    conversation_id=conversation_id,
                    sender_id=(
                        student["student_id"] if role == "student" else teacher["teacher_id"]
                    ),
                    sender_role=role,
                    content=content,
                    is_read=is_read,
                    create_timestamp=to_ms(last_moment),
                ))
                message_count += 1
            db.session.add(Conversation(
                id=conversation_id,
                student_id=student["student_id"],
                teacher_id=teacher["teacher_id"],
                student_name=student["name"],
                teacher_name=teacher["name"],
                updated_timestamp=to_ms(last_moment),
                create_timestamp=to_ms(created),
            ))
            conversation_count += 1
    return conversation_count, message_count


def main() -> None:
    app = Flask(__name__)
    app.config.from_object(Config)
    db.init_app(app)

    with app.app_context():
        # 建表兜底（已存在则跳过），不修改任何现有列
        db.create_all()
        # 逆序清空 + 重置自增（无物理外键，一条语句即可保证原子性）
        db.session.execute(text(
            "TRUNCATE TABLE ai_analysis_report, video_face_report, scl90_text_report, "
            "appointments, counseling_slots, message, conversation, "
            "teacher_class, student, teacher RESTART IDENTITY"
        ))
        db.session.commit()

        teachers = _seed_teachers()
        db.session.flush()
        students = _seed_students()
        db.session.flush()

        primary_teacher_id = teachers[0]["teacher_id"]
        sessions = {}
        for index, student in enumerate(students):
            sessions[student["student_no"]] = _seed_reports(student, index, primary_teacher_id)

        slots_by_teacher = _seed_counseling_slots(teachers)
        appointment_count = _seed_appointments(teachers, students, slots_by_teacher)
        conversation_count, message_count = _seed_conversations(teachers, students)
        db.session.commit()

        # 输出校验摘要
        counts = db.session.execute(text(
            "SELECT (SELECT count(*) FROM teacher), (SELECT count(*) FROM teacher_class), "
            "(SELECT count(*) FROM student), (SELECT count(*) FROM scl90_text_report), "
            "(SELECT count(*) FROM video_face_report), (SELECT count(*) FROM ai_analysis_report), "
            "(SELECT count(*) FROM counseling_slots), (SELECT count(*) FROM appointments), "
            "(SELECT count(*) FROM conversation), (SELECT count(*) FROM message)"
        )).first()
        (teacher_count, class_count, student_count, text_count, video_count, ai_count,
         slot_count, appointment_total, conversation_total, message_total) = counts
        print("TEACHER=%s TEACHER_CLASS=%s STUDENT=%s TEXT=%s VIDEO=%s AI=%s "
              "SLOT=%s APPOINTMENT=%s CONVERSATION=%s MESSAGE=%s" % (
                  teacher_count, class_count, student_count, text_count, video_count, ai_count,
                  slot_count, appointment_total, conversation_total, message_total))
        print("王一的报告：", sessions["20260001"])

        # 分学生校验（王一 6 套、其余各 1 套）
        per_student = db.session.execute(text(
            "SELECT s.student_no, count(DISTINCT t.seq_id), count(DISTINCT v.seq_id), "
            "count(DISTINCT a.seq_id) FROM student s "
            "LEFT JOIN scl90_text_report t ON t.student_id = s.student_id "
            "LEFT JOIN video_face_report v ON v.student_id = s.student_id "
            "LEFT JOIN ai_analysis_report a ON a.student_id = s.student_id "
            "GROUP BY s.student_no ORDER BY s.student_no"
        )).all()
        print("分学生报告数（学号/文本/视频/AI）：", [tuple(row) for row in per_student[:3]], "...")
        class_rows = db.session.execute(text(
            "SELECT class, count(*) FROM student GROUP BY class ORDER BY class"
        )).all()
        print("班级分布：", [tuple(row) for row in class_rows])
        bind_rows = db.session.execute(text(
            "SELECT teacher_id, count(*) FROM teacher_class GROUP BY teacher_id ORDER BY teacher_id"
        )).all()
        print("教师班级绑定数：", [tuple(row) for row in bind_rows])

        teacher = db.session.get(Teacher, teachers[0]["teacher_id"])
        student = db.session.get(Student, students[0]["student_id"])
        print("王老师密码校验：", verify_password("19911111111", teacher.password))
        print("王一密码校验：", verify_password("19900000001", student.password))

        # 预约 / 倾诉分布校验
        appt_rows = db.session.execute(text(
            "SELECT teacher_name, status, date, time_slot FROM appointments "
            "WHERE student_id = :sid ORDER BY created_at DESC"
        ), {"sid": students[0]["student_id"]}).all()
        print("王一的预约（教师/状态/日期/时段）：", [tuple(row) for row in appt_rows])
        status_rows = db.session.execute(text(
            "SELECT status, count(*) FROM appointments GROUP BY status ORDER BY status"
        )).all()
        print("预约状态分布：", [tuple(row) for row in status_rows])
        conv_rows = db.session.execute(text(
            "SELECT teacher_name, count(*) FROM conversation GROUP BY teacher_name "
            "ORDER BY teacher_name"
        )).all()
        print("教师倾诉会话数：", [tuple(row) for row in conv_rows])


if __name__ == "__main__":
    main()
