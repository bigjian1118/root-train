# -*- coding: utf-8 -*-
"""通用 PostgreSQL 数据库操作工具（基于 psycopg 3，适配本项目 psy 库）。

与项目环境对齐：
  - 数据库：PostgreSQL 16 + pgvector（AutoDL 上由 start_all.sh 启动，端口 5432）
  - 驱动：psycopg 3（requirements.txt 已含，装在 API_ENV 对应 conda 环境）
  - 连接配置：优先读环境变量 DATABASE_URL（与 server/config.py 同源），
    未设置时回退项目默认 postgresql+psycopg://psy:psy@127.0.0.1:5432/psy

设计目标：日常更新数据库开箱即用，主打安全与省心。
  1. 所有值一律走 %s 参数化占位符（psycopg 客户端参数绑定），杜绝 SQL 注入；
     表名/列名无法参数化，用白名单正则校验，非法标识符直接拒绝。
  2. 连接惰性创建、自动重连，close() 释放资源；支持 with 上下文保证不泄漏。
  3. 事务控制：begin/commit/rollback 手动三件套 + transaction() 上下文管理器
     （异常自动回滚，正常退出自动提交）。
  4. 查询结果统一返回 dict / list[dict]，字段名直接取值。

命令行用法（无需写代码，日常改库直接用）：
    python postgres_db_tool.py demo
    python postgres_db_tool.py query "SELECT * FROM student WHERE class = %s" 计算机2101
    python postgres_db_tool.py exec "UPDATE student SET phone = %s WHERE student_id = %s" 13800000000 S001

一键脚本入口（AutoDL，服务启动后可用）：
    bash start_all.sh db query "SELECT count(*) AS n FROM student"
    bash start_all.sh db exec "UPDATE student SET phone = %s WHERE student_id = %s" 13800000000 S001

兼容 Python 3.8+。
"""

import json
import os
import re
import sys
from urllib.parse import unquote, urlparse

from psycopg import connect, errors
from psycopg.rows import dict_row

# 合法标识符白名单：字母/下划线开头，后接字母数字下划线（PostgreSQL 双引号标识符）。
# 表名、列名不能进参数占位符，必须靠校验防注入（如动态传入的列名）。
_IDENTIFIER_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")

# 与 server/config.py 完全一致的回退默认值
_DEFAULT_DATABASE_URL = "postgresql+psycopg://psy:psy@127.0.0.1:5432/psy"


class PostgresDBError(Exception):
    """统一对外抛出的数据库错误，携带清晰的中文描述，屏蔽底层异常细节。"""


def _parse_database_url(url=None):
    """解析 DATABASE_URL（兼容 SQLAlchemy 的 postgresql+psycopg:// 前缀）为连接参数。"""
    url = url or os.environ.get("DATABASE_URL") or _DEFAULT_DATABASE_URL
    parsed = urlparse(url)
    if parsed.scheme not in ("postgresql", "postgresql+psycopg", "postgres"):
        raise PostgresDBError(f"DATABASE_URL 协议头无法识别：{url}")
    return {
        "host": parsed.hostname or "127.0.0.1",
        "port": parsed.port or 5432,
        "user": unquote(parsed.username or "psy"),
        "password": unquote(parsed.password or "psy"),
        "database": (parsed.path or "/psy").lstrip("/") or "psy",
    }


class PostgresDB:
    """PostgreSQL 通用操作工具类。

    用法一（显式传参）：
        db = PostgresDB(host="127.0.0.1", port=5432, user="psy",
                        password="psy", database="psy")
    用法二（零参数，自动读 DATABASE_URL / 项目默认）：
        db = PostgresDB()
    """

    def __init__(self, host=None, port=None, user=None,
                 password=None, database=None, connect_timeout=10):
        """保存配置，不立即连接（惰性连接，避免实例化即要求数据库可达）。"""
        cfg = _parse_database_url()
        self._config = {
            "host": host or cfg["host"],
            "port": port or cfg["port"],
            "user": user or cfg["user"],
            "password": password or cfg["password"],
            "dbname": database or cfg["database"],
            "connect_timeout": connect_timeout,
            # 字典行工厂：查询结果按字段名读取
            "row_factory": dict_row,
        }
        self._conn = None

    # ------------------------------------------------------------------
    # 连接管理
    # ------------------------------------------------------------------

    def _get_connection(self):
        """获取可用连接：不存在或已断开时自动重连。"""
        if self._conn is None or self._conn.closed:
            try:
                self._conn = connect(**self._config)
            except errors.OperationalError as exc:
                raise PostgresDBError(
                    f"数据库连接失败（{self._config['host']}:{self._config['port']}"
                    f"/{self._config['dbname']}）：{exc}"
                ) from exc
        return self._conn

    def close(self):
        """释放连接。建议放在 finally 或 with 中使用，避免连接泄漏。"""
        if self._conn is not None and not self._conn.closed:
            self._conn.close()
        self._conn = None

    def __enter__(self):
        self._get_connection()
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        # 退出作用域一律关闭连接，异常场景同样保证资源释放
        self.close()
        return False

    # ------------------------------------------------------------------
    # 内部工具
    # ------------------------------------------------------------------

    @staticmethod
    def _check_identifier(name, desc="标识符"):
        """校验表名/列名，非法直接抛错——这是标识符注入的唯一防线。"""
        if not isinstance(name, str) or not _IDENTIFIER_RE.match(name):
            raise PostgresDBError(f"非法{desc}：{name!r}（只允许字母、数字、下划线）")
        return name

    def _run(self, sql, params=None, many=False, seq_params=None):
        """执行写操作的统一入口：出错回滚并抛清晰错误，成功返回受影响行数。"""
        conn = self._get_connection()
        try:
            with conn.cursor() as cursor:
                if many:
                    cursor.executemany(sql, seq_params)
                else:
                    cursor.execute(sql, params)
                affected = cursor.rowcount
            conn.commit()
            return affected
        except errors.Error as exc:
            conn.rollback()
            raise PostgresDBError(f"SQL 执行失败：{exc}｜SQL：{sql}") from exc

    # ------------------------------------------------------------------
    # 查询（只读）
    # ------------------------------------------------------------------

    def query_one(self, sql, params=None):
        """查询单行，返回 dict；无结果返回 None。

        示例（本项目表结构）：
            row = db.query_one(
                "SELECT name, class FROM student WHERE student_id = %s", ("S123",))
        """
        conn = self._get_connection()
        try:
            with conn.cursor() as cursor:
                cursor.execute(sql, params)
                row = cursor.fetchone()
                return dict(row) if row else None
        except errors.Error as exc:
            raise PostgresDBError(f"查询失败：{exc}｜SQL：{sql}") from exc

    def query_many(self, sql, params=None):
        """查询多行，返回 list[dict]。

        示例：
            rows = db.query_many(
                "SELECT report_id, student_name FROM scl90_text_report "
                "WHERE student_class = %s ORDER BY submit_timestamp DESC LIMIT %s",
                ("计算机2101", 20))
        """
        conn = self._get_connection()
        try:
            with conn.cursor() as cursor:
                cursor.execute(sql, params)
                return [dict(row) for row in cursor.fetchall()]
        except errors.Error as exc:
            raise PostgresDBError(f"查询失败：{exc}｜SQL：{sql}") from exc

    # ------------------------------------------------------------------
    # 写操作（单条 / 批量 / 条件更新 / 原生 SQL）
    # ------------------------------------------------------------------

    def execute_sql(self, sql, params=None):
        """执行任意原生 SQL（INSERT/UPDATE/DELETE/DDL），自动提交，返回受影响行数。

        值一律通过 params 元组传入 %s 占位符，禁止字符串拼接。
        """
        return self._run(sql, params=params)

    def update_by_id(self, table, primary_key, pk_value, data):
        """按主键单条更新。

        示例（更新学生手机号）：
            db.update_by_id("student", "student_id", "S123", {"phone": "13800000000"})
        """
        self._check_identifier(table, "表名")
        self._check_identifier(primary_key, "主键列名")
        if not data:
            raise PostgresDBError("更新内容不能为空")
        set_clause = ", ".join(
            f'"{self._check_identifier(col, "列名")}" = %s' for col in data
        )
        sql = f'UPDATE "{table}" SET {set_clause} WHERE "{primary_key}" = %s'
        params = list(data.values()) + [pk_value]
        return self._run(sql, params=params)

    def update_by_condition(self, table, data, where_sql, where_params=None):
        """按自定义条件更新（条件部分仍要求用 %s 占位符传值）。

        示例（批量归档某班高危报告）：
            db.update_by_condition(
                "scl90_text_report",
                {"crowd_tag": "archived"},
                "student_class = %s AND risk_signal >= %s",
                ("计算机2101", 1))
        """
        self._check_identifier(table, "表名")
        if not data:
            raise PostgresDBError("更新内容不能为空")
        if not where_sql:
            raise PostgresDBError("条件更新必须提供 WHERE 片段，防止误伤全表")
        set_clause = ", ".join(
            f'"{self._check_identifier(col, "列名")}" = %s' for col in data
        )
        sql = f'UPDATE "{table}" SET {set_clause} WHERE {where_sql}'
        return self._run(sql, params=list(data.values()) + list(where_params or ()))

    def batch_update(self, sql, seq_params):
        """批量更新：executemany + 单事务，要么全部成功要么全部回滚。

        示例：
            db.batch_update(
                "UPDATE student SET phone = %s WHERE student_id = %s",
                [("13800000001", "S001"), ("13800000002", "S002")])
        """
        if not seq_params:
            return 0
        return self._run(sql, many=True, seq_params=seq_params)

    # ------------------------------------------------------------------
    # 事务控制
    # ------------------------------------------------------------------

    def begin(self):
        """手动开启事务（psycopg3 通过 begin() 显式进入事务块）。"""
        self._get_connection().begin()

    def commit(self):
        """手动提交事务。"""
        try:
            self._get_connection().commit()
        except errors.Error as exc:
            raise PostgresDBError(f"事务提交失败：{exc}") from exc

    def rollback(self):
        """手动回滚事务。"""
        try:
            self._get_connection().rollback()
        except errors.Error as exc:
            raise PostgresDBError(f"事务回滚失败：{exc}") from exc

    def transaction(self):
        """事务上下文管理器：块内全部成功自动提交，抛异常自动回滚。

        示例（跨表修改，两表同事务）：
            with db.transaction() as cursor:
                cursor.execute("UPDATE student SET class = %s WHERE student_id = %s",
                               ("新班级", "S123"))
                cursor.execute("UPDATE teacher_class SET class_id = %s "
                               "WHERE class_id = %s", ("新班级", "旧班级"))
        """
        return _Transaction(self)

    def vector_upsert(self, table, id_col, id_value, embedding_col, embedding):
        """pgvector 向量写入（本项目 rag_chunk 知识库表专用）。

        示例：
            db.vector_upsert("rag_chunk", "id", 1,
                             "embedding", [0.1, 0.2, ...])  # BGE-M3 1024 维
        """
        self._check_identifier(table, "表名")
        self._check_identifier(id_col, "主键列名")
        self._check_identifier(embedding_col, "向量列名")
        sql = (
            f'INSERT INTO "{table}" ("{id_col}", "{embedding_col}") '
            "VALUES (%s, %s::vector) "
            f'ON CONFLICT ("{id_col}") DO UPDATE SET "{embedding_col}" = EXCLUDED."{embedding_col}"'
        )
        # pgvector 以 '[1,2,3]' 文本形式接收向量
        vec_text = "[" + ",".join(str(float(v)) for v in embedding) + "]"
        return self._run(sql, params=(id_value, vec_text))


class _Transaction:
    """transaction() 返回的上下文对象：进入即 begin，正常退出 commit，异常回滚。"""

    def __init__(self, db):
        self._db = db

    def __enter__(self):
        self._conn = self._db._get_connection()
        self._conn.begin()
        self._cursor = self._conn.cursor()
        return self._cursor

    def __exit__(self, exc_type, exc_val, exc_tb):
        self._cursor.close()
        try:
            if exc_type is None:
                self._conn.commit()
            else:
                self._conn.rollback()
                if issubclass(exc_type, errors.Error):
                    raise PostgresDBError(f"事务执行失败，已回滚：{exc_val}") from exc_val
        except errors.Error as exc:
            self._conn.rollback()
            raise PostgresDBError(f"事务收尾失败，已回滚：{exc}") from exc
        return False


# ======================================================================
# 命令行入口：日常改库无需写代码
#   demo   —— 四大场景演示（单条/批量/查询/事务）
#   query  —— 只读查询，结果按 JSON 打印
#   exec   —— 执行写 SQL，打印受影响行数
# 参数值一律以字符串传入，由 psycopg 适配类型；SQL 内用 %s 占位符
# ======================================================================

_USAGE = """用法：
  python postgres_db_tool.py demo
  python postgres_db_tool.py query "SELECT ... WHERE x = %s" 参数1 [参数2 ...]
  python postgres_db_tool.py exec   "UPDATE ... SET a = %s WHERE id = %s" 参数1 [参数2 ...]
"""


def _cli(argv):
    if argv and argv[0] == "demo":
        demo()
        return 0

    if not argv or argv[0] not in ("query", "exec") or len(argv) < 2:
        print(_USAGE, file=sys.stderr)
        return 1

    mode, sql = argv[0], argv[1]
    params = tuple(argv[2:]) or None
    try:
        with PostgresDB() as db:
            if mode == "query":
                rows = db.query_many(sql, params)
                print(json.dumps(rows, ensure_ascii=False, indent=2, default=str))
                print(f"—— 共 {len(rows)} 行")
            else:
                affected = db.execute_sql(sql, params)
                print(f"执行成功，受影响行数：{affected}")
        return 0
    except PostgresDBError as exc:
        print(f"[错误] {exc}", file=sys.stderr)
        return 2


# ======================================================================
# 使用示例（需先确保 PostgreSQL 已启动：bash start_all.sh start）
# ======================================================================


def demo():
    with PostgresDB() as db:
        # ---------- 场景 1：单条数据更新（按主键） ----------
        affected = db.update_by_id(
            "student", "student_id", "S001", {"phone": "13800000000"}
        )
        print(f"单条更新影响行数：{affected}")

        # ---------- 场景 2：批量更新（单事务，全成功或全回滚） ----------
        affected = db.batch_update(
            "UPDATE student SET phone = %s WHERE student_id = %s",
            [("13800000001", "S001"), ("13800000002", "S002")],
        )
        print(f"批量更新影响行数：{affected}")

        # ---------- 场景 3：条件查询（结果字典格式） ----------
        rows = db.query_many(
            "SELECT report_id, student_name, total_score FROM scl90_text_report "
            "WHERE student_class = %s ORDER BY submit_timestamp DESC LIMIT %s",
            ("计算机2101", 10),
        )
        for row in rows:
            print(f"报告：{row['report_id']}｜{row['student_name']}｜总分 {row['total_score']}")

        one = db.query_one("SELECT name, account FROM teacher WHERE account = %s", ("10000001",))
        print(f"单行查询：{one}")  # None 或 {'name': '李老师', 'account': '10000001'}

        # ---------- 场景 4：事务执行更新（跨表修改，异常自动回滚） ----------
        try:
            with db.transaction() as cursor:
                cursor.execute(
                    "UPDATE student SET class = %s WHERE student_id = %s",
                    ("软件工程2201", "S001"),
                )
                cursor.execute(
                    "UPDATE teacher_class SET class_id = %s WHERE class_id = %s",
                    ("软件工程2201", "计算机2101"),
                )
            print("跨表事务提交成功")
        except PostgresDBError as exc:
            print(f"事务失败已回滚：{exc}")


if __name__ == "__main__":
    sys.exit(_cli(sys.argv[1:]))
