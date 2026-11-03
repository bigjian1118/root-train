# -*- coding: utf-8 -*-
"""
一键创建统一业务数据库（autodl-fs 文件存储盘，单库 12 表，按 表格.md 规范）：

  <AUTODL_FS>/psydb/psy.db

MySQL 语法 -> SQLite 方言映射：
  BIGINT AUTO_INCREMENT -> INTEGER PRIMARY KEY AUTOINCREMENT
  VARCHAR(n)/TEXT/MEDIUMTEXT -> TEXT；MEDIUMBLOB -> BLOB
  TINYINT/INT/BIGINT -> INTEGER；FLOAT -> REAL
  时间戳统一 INTEGER 毫秒（int(time.time() * 1000)）

12 张表：
  1. teacher            教师表（teacher_id PK, job_number/account UNIQUE,
                        class 逗号分隔多班冗余, login_timestamp 最近登录毫秒）
  2. teacher_class      教师班级关联表（seq_id 自增 PK, UNIQUE(teacher_id, class_id)）
  3. student            学生表（student_id PK, student_no/account UNIQUE,
                        latest_text_report_id / latest_video_report_id,
                        register_timestamp 注册毫秒）
  4. scl90_text_report  SCL-90 问卷报告表（seq_id 自增 PK, report_id UNIQUE,
                        crowd_tag 中文人群标签, 10 个因子分独立列 +
                        gsi/psdi/max_factor_score, neg_item_count,
                        risk_signal 0/1, submit_timestamp 毫秒,
                        item_answers 90 题原始分 JSON（RF 推理特征，旧行 NULL））
  5. video_face_report  视频面部测评报告表（seq_id 自增 PK, video_report_id UNIQUE,
                        au_json / emotion_json / landmark_json,
                        prominent_dimension, create_timestamp 毫秒）
  6. ai_analysis_report AI 综合分析报告表（seq_id 自增 PK, 冗余学生四件套,
                        text_report_id / video_report_id 关联, ai_content,
                        create_timestamp 毫秒）
  7. counseling_slots   教师预约时段表（id PK, max_capacity/current_count,
                        status open|full|closed, created_at 毫秒）
  8. appointments       学生预约单表（id PK, slot_id 关联,
                        status pending|accepted|rejected|canceled, created_at 毫秒）
  9. articles           心理科普文章表（id PK, is_active 1/0, created_at 毫秒）
  10. activity_material 心理活动素材库表（material_id PK, file_blob BLOB 直存,
                        upload_time 毫秒）
  11. conversation      师生一对一私信会话表（表格.md 未列，功能保留并入新库；
                        UNIQUE(student_id, teacher_id), 毫秒时间戳）
  12. message           会话内消息表（is_read 0/1, create_timestamp 毫秒）

用法：
  python create_db.py            # 建库（表已存在则跳过，幂等）
  python create_db.py --wipe     # 删除新库 + 旧 8 个分库文件/目录，重建全新库！
"""
import argparse
import os
import shutil
import sqlite3

import config

# 旧版分库目录（--wipe 时一并删除）
_LEGACY_DB_DIRS = [
    os.path.join(config.AUTODL_FS, "students"),
    os.path.join(config.AUTODL_FS, "teachers"),
    os.path.join(config.AUTODL_FS, "teacher_classes"),
    os.path.join(config.AUTODL_FS, "face_reports"),
    os.path.join(config.AUTODL_FS, "video_reports"),
    os.path.join(config.AUTODL_FS, "appointments"),
    os.path.join(config.AUTODL_FS, "articles"),
    os.path.join(config.AUTODL_FS, "messages"),
    os.path.join(config.AUTODL_FS, "materials"),
]

DDL = """
-- 1. 教师表
CREATE TABLE IF NOT EXISTS teacher (
    teacher_id      TEXT PRIMARY KEY,               -- 主键，注册唯一 ID
    name            TEXT NOT NULL,                  -- 教师姓名
    class           TEXT,                           -- 负责班级，多班级逗号分隔（冗余展示）
    job_number      TEXT UNIQUE,                    -- 工号
    account         TEXT NOT NULL UNIQUE,           -- 登录账号
    password        TEXT NOT NULL,                  -- 加密密码（PBKDF2 加盐哈希）
    phone           TEXT,                           -- 手机号
    login_timestamp INTEGER                         -- 最近登录毫秒时间戳
);

-- 2. 教师班级关联表（多对多）
CREATE TABLE IF NOT EXISTS teacher_class (
    seq_id           INTEGER PRIMARY KEY AUTOINCREMENT,  -- 自增主键
    teacher_id       TEXT NOT NULL,                      -- 关联 teacher.teacher_id
    class_id         TEXT NOT NULL,                      -- 班级唯一 ID（班级名）
    create_timestamp INTEGER NOT NULL                    -- 创建毫秒时间戳
);
CREATE INDEX IF NOT EXISTS idx_tc_teacher ON teacher_class(teacher_id);
CREATE INDEX IF NOT EXISTS idx_tc_class   ON teacher_class(class_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tc_unique ON teacher_class(teacher_id, class_id);

-- 3. 学生表
CREATE TABLE IF NOT EXISTS student (
    student_id            TEXT PRIMARY KEY,          -- 主键，注册唯一 ID
    name                  TEXT NOT NULL,             -- 学生姓名
    class                 TEXT NOT NULL,             -- 所属班级
    student_no            TEXT UNIQUE,               -- 学号
    account               TEXT NOT NULL UNIQUE,      -- 登录账号
    password              TEXT NOT NULL,             -- 加密密码（PBKDF2 加盐哈希）
    latest_text_report_id  TEXT,                     -- 最新 SCL-90 报告业务 ID
    latest_video_report_id TEXT,                     -- 最新视频测评报告业务 ID
    phone                 TEXT,                      -- 手机号
    register_timestamp    INTEGER NOT NULL           -- 注册毫秒时间戳
);

-- 4. SCL-90 问卷报告表（10 个因子分独立列，读取时由后端按常模重算 Z 分数/严重程度）
CREATE TABLE IF NOT EXISTS scl90_text_report (
    seq_id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    report_id                 TEXT NOT NULL UNIQUE,  -- 业务唯一报告 ID
    student_id                TEXT NOT NULL,         -- 关联 student.student_id
    student_name              TEXT NOT NULL,         -- 学生姓名（冗余存储）
    student_class             TEXT NOT NULL,         -- 学生班级（冗余存储）
    crowd_tag                 TEXT NOT NULL,         -- 测评人群标签：小学生/中学生/大学生
    total_score               INTEGER,               -- SCL-90 总分
    pos_item_count            INTEGER,               -- 阳性项目数
    neg_item_count            INTEGER,               -- 阴性项目数
    risk_signal               INTEGER DEFAULT 0,     -- 风险标记：0 无风险，1 筛查阳性风险
    somatization              REAL,                  -- 躯体化因子分
    ocd                       REAL,                  -- 强迫症状因子分
    interpersonal_sensitivity REAL,                  -- 人际关系敏感因子分
    depression                REAL,                  -- 抑郁因子分
    anxiety                   REAL,                  -- 焦虑因子分
    hostility                 REAL,                  -- 敌对因子分
    phobic_anxiety            REAL,                  -- 恐怖因子分
    paranoid_ideation         REAL,                  -- 偏执因子分
    psychoticism              REAL,                  -- 精神病性因子分
    additional                REAL,                  -- 其他（睡眠饮食）因子分
    max_factor_score          REAL,                  -- 最大因子得分
    gsi                       REAL,                  -- 总体严重指数 GSI（总均分）
    psdi                      REAL,                  -- 阳性症状痛苦均分 PSDI
    submit_timestamp          INTEGER NOT NULL,      -- 提交测评毫秒时间戳
    item_answers              TEXT                   -- 90 题原始分 JSON {题号:1-5}（随机森林推理特征；旧行为 NULL 走规则）
);
CREATE INDEX IF NOT EXISTS idx_scl90_class   ON scl90_text_report(student_class);
CREATE INDEX IF NOT EXISTS idx_scl90_student ON scl90_text_report(student_id);

-- 5. 视频面部测评报告表
CREATE TABLE IF NOT EXISTS video_face_report (
    seq_id              INTEGER PRIMARY KEY AUTOINCREMENT,
    video_report_id     TEXT NOT NULL UNIQUE,        -- 业务唯一视频报告 ID
    student_id          TEXT NOT NULL,               -- 关联 student.student_id
    au_json             TEXT,                        -- AU 动作单元 + 帧统计 JSON
    emotion_json        TEXT,                        -- 情绪分数 + 主导情绪 JSON
    landmark_json       TEXT,                        -- 68 点人脸关键点坐标 JSON
    prominent_dimension TEXT,                        -- 最突出因子 / 维度（主导情绪）
    create_timestamp    INTEGER NOT NULL             -- 报告生成毫秒时间戳
);
CREATE INDEX IF NOT EXISTS idx_vfr_student ON video_face_report(student_id);

-- 6. AI 综合分析报告表（SCL-90 + 视频报告联合解读，独立功能生成）
CREATE TABLE IF NOT EXISTS ai_analysis_report (
    seq_id           INTEGER PRIMARY KEY AUTOINCREMENT,
    student_name     TEXT NOT NULL,                  -- 学生姓名
    student_class    TEXT,                            -- 班级
    student_no       TEXT,                            -- 学号
    phone            TEXT,                            -- 手机号
    text_report_id   TEXT,                            -- 关联 SCL-90 报告 ID
    video_report_id  TEXT,                            -- 关联视频报告 ID
    ai_content       TEXT,                            -- AI 分析文本内容
    create_timestamp INTEGER NOT NULL                 -- 报告生成毫秒时间戳
);
CREATE INDEX IF NOT EXISTS idx_aiar_text  ON ai_analysis_report(text_report_id);
CREATE INDEX IF NOT EXISTS idx_aiar_no    ON ai_analysis_report(student_no);

-- 7. 教师预约时段表
CREATE TABLE IF NOT EXISTS counseling_slots (
    id            TEXT PRIMARY KEY,                   -- 主键，时段 ID
    teacher_id    TEXT NOT NULL,                      -- 发布教师 ID
    teacher_name  TEXT NOT NULL,                      -- 发布教师姓名
    date          TEXT NOT NULL,                      -- 日期，例：2026-10-09
    time_slot     TEXT NOT NULL,                      -- 时间段文字，例：14:00-15:00
    start_time    TEXT,                               -- 起始时间
    end_time      TEXT,                               -- 结束时间
    max_capacity  INTEGER NOT NULL DEFAULT 1,         -- 该时段最大预约人数
    current_count INTEGER NOT NULL DEFAULT 0,         -- 已预约人数
    note          TEXT,                               -- 时段备注（表格.md 未列，排班功能必需，扩展列）
    status        TEXT NOT NULL DEFAULT 'open',       -- open 开放 / full 已满 / closed 关闭
    created_at    INTEGER NOT NULL                    -- 发布毫秒时间戳
);
CREATE INDEX IF NOT EXISTS idx_slots_teacher ON counseling_slots(teacher_id);
CREATE INDEX IF NOT EXISTS idx_slots_status  ON counseling_slots(status);

-- 8. 学生预约单表
CREATE TABLE IF NOT EXISTS appointments (
    id            TEXT PRIMARY KEY,                   -- 主键，预约单 ID
    slot_id       TEXT NOT NULL,                      -- 关联 counseling_slots.id
    teacher_id    TEXT NOT NULL,                      -- 被预约教师 ID
    teacher_name  TEXT NOT NULL,                      -- 被预约教师姓名
    student_id    TEXT NOT NULL,                      -- 预约学生 ID
    student_name  TEXT NOT NULL,                      -- 预约学生姓名
    student_class TEXT NOT NULL,                      -- 预约学生班级
    date          TEXT NOT NULL,                      -- 预约日期
    time_slot     TEXT NOT NULL,                      -- 预约时间段
    reason        TEXT,                               -- 学生填写咨询事由
    status        TEXT NOT NULL DEFAULT 'pending',    -- pending/accepted/rejected/canceled + done（完成标记，扩展值）
    reply         TEXT,                               -- 教师回复备注
    teacher_time  INTEGER,                            -- 教师处理时刻毫秒时间戳（响应层转秒）
    created_at    INTEGER NOT NULL                    -- 提交毫秒时间戳
);
CREATE INDEX IF NOT EXISTS idx_appt_student ON appointments(student_id);
CREATE INDEX IF NOT EXISTS idx_appt_teacher ON appointments(teacher_id);
CREATE INDEX IF NOT EXISTS idx_appt_status   ON appointments(status);

-- 9. 心理科普文章表
CREATE TABLE IF NOT EXISTS articles (
    id         TEXT PRIMARY KEY,                      -- 主键，文章 ID
    cover      TEXT,                                  -- 封面图 URL / 标识
    title      TEXT NOT NULL,                         -- 文章标题
    summary    TEXT,                                  -- 摘要，列表页展示
    content    TEXT NOT NULL,                         -- 正文内容
    source     TEXT,                                  -- 文章来源（教师发布可自定义；内置文章用默认来源）
    author     TEXT,                                  -- 发布者（教师姓名；内置 seed 文章为空）
    is_active  INTEGER NOT NULL DEFAULT 1,            -- 1 上架，0 下架
    created_at INTEGER NOT NULL,                      -- 创建毫秒时间戳
    updated_at INTEGER                                -- 更新毫秒时间戳
);
CREATE INDEX IF NOT EXISTS idx_articles_active ON articles(is_active);

-- 10. 心理活动素材库表（文件二进制 BLOB 直存，不落盘）
CREATE TABLE IF NOT EXISTS activity_material (
    material_id TEXT PRIMARY KEY,                     -- 主键，素材 ID，时间戳+随机数
    title       TEXT NOT NULL,                        -- 素材标题
    category    TEXT NOT NULL,                        -- 班会方案/团体活动方案/心理科普PPT/其他
    brief       TEXT,                                 -- 素材简介
    file_blob   BLOB NOT NULL,                        -- 文件二进制，pdf/docx/pptx
    file_name   TEXT NOT NULL,                        -- 原始文件名，下载还原使用
    file_type   TEXT,                                 -- 文件 MIME 类型
    uploader    TEXT NOT NULL,                        -- 上传教师 ID
    upload_time INTEGER NOT NULL                      -- 上传毫秒时间戳
);
CREATE INDEX IF NOT EXISTS idx_material_time ON activity_material(upload_time DESC);

-- 11. 师生一对一私信会话表（表格.md 未列，功能保留并入新库，风格同规范）
CREATE TABLE IF NOT EXISTS conversation (
    id               TEXT PRIMARY KEY,                -- 会话 ID
    student_id       TEXT NOT NULL,                   -- 学生（倾诉者）ID
    teacher_id       TEXT NOT NULL,                   -- 教师（回应者）ID
    student_name     TEXT NOT NULL,                   -- 学生姓名（冗余）
    teacher_name     TEXT NOT NULL,                   -- 教师姓名（冗余）
    updated_timestamp INTEGER NOT NULL,               -- 最新消息毫秒时间戳
    create_timestamp INTEGER NOT NULL                 -- 会话建立毫秒时间戳
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_conv_pair    ON conversation(student_id, teacher_id);
CREATE INDEX IF NOT EXISTS idx_conv_student        ON conversation(student_id);
CREATE INDEX IF NOT EXISTS idx_conv_teacher        ON conversation(teacher_id);

-- 12. 会话内消息表
CREATE TABLE IF NOT EXISTS message (
    id              TEXT PRIMARY KEY,                 -- 消息 ID
    conversation_id TEXT NOT NULL,                    -- 所属 conversation.id
    sender_id       TEXT NOT NULL,                    -- 发送者 ID
    sender_role     TEXT NOT NULL,                    -- student | teacher
    content         TEXT NOT NULL,                    -- 消息正文
    is_read         INTEGER NOT NULL DEFAULT 0,       -- 0 未读 / 1 已读
    create_timestamp INTEGER NOT NULL                 -- 发送毫秒时间戳
);
CREATE INDEX IF NOT EXISTS idx_msg_conversation ON message(conversation_id);
CREATE INDEX IF NOT EXISTS idx_msg_unread       ON message(conversation_id, is_read);
"""


def migrate_articles_columns(conn):
    """为已存在的 articles 表补齐新增列（source / author / updated_at）。

    CREATE TABLE IF NOT EXISTS 不会给旧表加列，因此老库首次启动时在此幂等补列，
    保证教师文章管理功能在既有 psy.db 上可直接使用，无需 --wipe 重建。
    """
    existing = {r["name"] for r in conn.execute("PRAGMA table_info(articles)").fetchall()}
    for col, decl in (("source", "TEXT"), ("author", "TEXT"), ("updated_at", "INTEGER")):
        if col not in existing:
            conn.execute(f"ALTER TABLE articles ADD COLUMN {col} {decl}")
            print(f"[migrate] articles 表补列：{col}")
    conn.commit()


def migrate_scl90_columns(conn):
    """为已存在的 scl90_text_report 表补齐新增列（item_answers）。

    同 migrate_articles_columns：CREATE TABLE IF NOT EXISTS 不给旧表加列，
    老库首次启动时幂等补列，文本随机森林混合模式在既有 psy.db 上直接可用。
    """
    existing = {r["name"] for r in conn.execute("PRAGMA table_info(scl90_text_report)").fetchall()}
    if "item_answers" not in existing:
        conn.execute("ALTER TABLE scl90_text_report ADD COLUMN item_answers TEXT")
        print("[migrate] scl90_text_report 表补列：item_answers")
    conn.commit()


def wipe_legacy():
    """删除旧版 8 个分库文件/目录（数据不迁移，用户要求全新重建）"""
    for d in _LEGACY_DB_DIRS:
        if os.path.isdir(d):
            shutil.rmtree(d, ignore_errors=True)
            print(f"[wipe] 已删除旧库目录：{d}")
        elif os.path.exists(d):
            os.remove(d)
            print(f"[wipe] 已删除旧库文件：{d}")


def main():
    parser = argparse.ArgumentParser(description="创建统一业务数据库 psy.db（12 表）")
    parser.add_argument("--wipe", action="store_true",
                        help="删除 psy.db 与旧 8 个分库后重建（清空所有数据！）")
    args = parser.parse_args()

    if args.wipe:
        if os.path.exists(config.PSY_DB):
            os.remove(config.PSY_DB)
            print(f"[wipe] 已删除旧 psy.db：{config.PSY_DB}")
        wipe_legacy()

    os.makedirs(config.PSY_DB_DIR, exist_ok=True)
    conn = sqlite3.connect(config.PSY_DB)
    conn.row_factory = sqlite3.Row
    try:
        conn.executescript(DDL)
        migrate_articles_columns(conn)
        migrate_scl90_columns(conn)
        conn.commit()
    finally:
        conn.close()
    print(f"[OK] 统一业务数据库就绪（12 表）：{config.PSY_DB}")


if __name__ == "__main__":
    main()
