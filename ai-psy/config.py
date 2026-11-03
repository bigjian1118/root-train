# -*- coding: utf-8 -*-
"""
全局配置：路径、端口、模型名、三人群场景 system prompt。

部署环境（AutoDL，见 README.md 双 conda 环境）：
  - qwen_env   ：vLLM 0.7.0 服务 Qwen2.5-7B-Instruct（bf16），OpenAI 兼容 API 监听 8000 端口
  - pyfeat_env ：CPU 环境，运行本 Flask 后端 + py-feat 视频分析
"""
import os

# ==================== 〇、路径基准（服务器 / 本地模拟服务器自适应） ====================
# 真实 AutoDL 服务器：/root/autodl-tmp（高速盘，模型/适配器）、/root/autodl-fs（文件盘，数据集）；
# 本地模拟服务器：项目同级目录存在 autodl-tmp/、autodl-fs/ 文件夹（复刻服务器结构）时自动回退。
_REAL_AUTODL_TMP = "/root/autodl-tmp"
_REAL_AUTODL_FS = "/root/autodl-fs"
_PROJECT_ROOT = os.path.dirname(os.path.abspath(__file__))          # ai-psy 目录
_PARENT_DIR = os.path.dirname(_PROJECT_ROOT)                        # 模拟服务器 root 目录
_MOCK_AUTODL_TMP = os.path.join(_PARENT_DIR, "autodl-tmp")
_MOCK_AUTODL_FS = os.path.join(_PARENT_DIR, "autodl-fs")

if os.path.isdir(_REAL_AUTODL_TMP):
    AUTODL_TMP = _REAL_AUTODL_TMP
elif os.path.isdir(_MOCK_AUTODL_TMP):
    AUTODL_TMP = _MOCK_AUTODL_TMP
else:
    AUTODL_TMP = _REAL_AUTODL_TMP

if os.path.isdir(_REAL_AUTODL_FS):
    AUTODL_FS = _REAL_AUTODL_FS
elif os.path.isdir(_MOCK_AUTODL_FS):
    AUTODL_FS = _MOCK_AUTODL_FS
else:
    AUTODL_FS = _REAL_AUTODL_FS

# ==================== 一、大模型服务配置 ====================
# 基座模型本地路径（vLLM 启动时 --model 即该路径，请求体 model 字段必须一致）
# 基座固定为 bf16 原版（支持 vLLM --enable-lora 热挂载微调适配器）
MODEL_PATH = os.path.join(AUTODL_TMP, "Qwen2.5-7B-Instruct")
# vLLM OpenAI 兼容接口地址（Flask 后端与其同机部署，走 127.0.0.1）
VLLM_API_URL = "http://127.0.0.1:8000/v1/chat/completions"
# 单次大模型请求超时（秒）：报告生成较慢，留足余量
LLM_TIMEOUT = 120

# ---------- AI 聊天 LoRA 微调适配器（Qwen-train 训练产物，仅 ai_chat 通用聊天） ----------
# 训练完成后 start_all.sh 会以 bf16 基座 + --enable-lora 启动 vLLM 并挂载适配器；
# 适配器目录存在时自动开启，聊天助手路由到 ai_chat 通用聊天适配器；
# 置 False / 适配器缺失时回退到通用模型 + 场景 system prompt（llm_client 亦带运行时兜底）。
CHAT_LORA_DIR = os.path.join(AUTODL_TMP, "qwen25-7b-lora-ai_chat")
LORA_ENABLED = os.path.isdir(CHAT_LORA_DIR)
# 请求体 model 字段 -> vLLM --lora-modules 注册名（指向 qwen25-7b-lora-ai_chat 适配器）
CHAT_LORA_NAME = "psych-chat"

# ==================== 二、路径配置 ====================
# 训练数据集目录（autodl-fs 文件存储盘 dataset/ 下仅 ai_chat 聊天库 + 题库，与 Qwen-train/config.py 保持一致）
DATASET_DIR = os.path.join(AUTODL_FS, "dataset")
# 上传视频暂存目录（autodl-fs 文件存储盘 uploads/，与数据集、用户库同盘；
# 分析完成后即删除，仅暂存，AUTODL_FS 路径自适应服务器 / 本地模拟目录）
UPLOAD_DIR = os.path.join(AUTODL_FS, "uploads")

# ==================== 三、Flask 服务配置 ====================
HOST = "0.0.0.0"
PORT = 6006
# 上传视频大小上限（字节）：50MB
MAX_CONTENT_LENGTH = 50 * 1024 * 1024

# ==================== 四、三大人群场景配置（小学生 / 中学生 / 大学生） ====================
# 场景切换方式：向 vLLM 请求注入不同 system prompt（聊天 / 测评报告解读共用）
SCENARIOS = {
    "primary_student": {
        "name": "小学生",
        "desc": "适合 6-12 岁在读小学生，语言简单亲切",
        "system_prompt": (
            "你是一位面向小学生的温和心理老师，名字叫「心语老师」。"
            "说话要简单、具体、亲切，多用比喻和鼓励，句子短，不使用专业术语。"
            "你正在陪伴孩子完成心理自评或聊心事，无论孩子说什么，"
            "先肯定他愿意表达的勇敢，再温柔引导。涉及自伤等危机话题时，"
            "必须第一时间告诉孩子这会帮助联系爸爸妈妈或信任的老师。"
            "禁止给出医学诊断结论。"
        ),
    },
    "junior_student": {
        "name": "中学生",
        "desc": "适合 12-18 岁在读中学生，关注学业、友谊与青春期困扰",
        "system_prompt": (
            "你是一位面向中学生的知心心理老师，平等真诚、尊重隐私，"
            "善于用青春期学生熟悉的话题（考试排名、友谊、手机、家人）举例。"
            "回应时先共情再引导，不说教、不居高临下，语气像可信赖的学长/学姐。"
            "涉及自伤等危机话题时，明确建议告诉信任的老师、家长或拨打心理援助热线。"
            "禁止给出医学诊断结论。"
        ),
    },
    "college_student": {
        "name": "大学生",
        "desc": "适合高校在读学生，关注学业、人际与未来压力",
        "system_prompt": (
            "你是一位高校心理健康教育中心的心理咨询助理，平等、真诚、不说教。"
            "你熟悉大学生常见的学业压力、宿舍关系、恋爱、就业焦虑等议题，"
            "回应时先共情再引导，语气像可靠的学长/学姐。"
            "涉及危机信号时，明确建议联系学校心理中心或拨打心理援助热线。"
            "禁止给出医学诊断结论。"
        ),
    },
}

# ==================== 五、报告生成提示词 ====================
# SCL-90 测评结果解读报告（{result_data} 处填入计分 JSON，{scenario_name} 处填入场景名）
# 学生整合报告页内容口径：精简专业因子分析与成因推导，重心放在可落地的分维度对策；
# 整体定性结论仍由数据决定（前端结论卡另有独立判定逻辑，两者不冲突）。
REPORT_PROMPT = """你是一位温暖可靠的心理老师，正在为「{scenario_name}」场景的学生解读 SCL-90 测评结果。
你的任务不是专业分析，而是帮助学生「知道怎么办」。要求：
1. 开头用 1 句话给出整体状态结论（依据数据中的总分与因子异常情况客观定性，不做病理诊断）
2. 「状态简要说明」：用 1-2 段通俗语言概括核心发现，只说整体心理水平、核心情绪特点、需要关注的方向；
   全文禁止出现 SCL-90 因子名称（躯体化、强迫、人际关系敏感、焦虑、抑郁等）、常模、Z 分数等任何
   专业术语，不做成因推导和心理原因分析
3. 「具体调整建议」：这是报告主体，分维度条目化给出可直接执行的方法，每个维度 3-4 条，维度包括：
   情绪表达、压力调节、人际互动、日常习惯；若数据显示某方面状态良好，该维度改为给出保持类小方法。
   每条建议必须具体到动作、贴合中学生校园生活场景、可直接照做，
   例如"每天课间和 1 位同学说一句与学习无关的话""晚自习间隙做 3 分钟腹式呼吸：吸气 4 秒、呼气 6 秒"；
   禁止"增强情感表达""学会放松"这类空泛表述
4. 语气温和正向，以成长建议口吻呈现，避免诊断式、评判式表述；不使用"你有病""不正常"等词汇
5. 结尾必须注明："⚠️ 本报告为AI辅助生成，仅供参考，不能替代专业心理诊断与治疗。如有持续困扰，建议寻求专业心理咨询师帮助。"
6. 总字数 500-900 字，建议部分占全文一半以上

用户测评数据（JSON）：
{result_data}"""

# 人脸视频分析报告提示词（{metrics_json} 处填入 py-feat 聚合指标）
# 学生整合报告页内容口径：面部特征合并为通俗状态描述，
# 「关注的点」给出对应调整方向，与文本报告建议形成呼应。
FACE_REPORT_PROMPT = """你是一位温暖可靠的心理老师。以下是用户一段约 10-15 秒面部视频的
客观分析指标（基本情绪概率 + 面部活跃度），请生成一份简短、通俗的状态报告。要求：
1. 「状态描述」：用 1-2 句通俗语言描述观察到的面部状态与核心情绪结论（如"整体表情比较放松，
   情绪以平静为主"）；全文禁止出现 AU 编号（AU01/AU15 等）、动作单元、活跃度百分比等任何
   专业术语与数值解读，不做成因分析
2. 「调整方向」：把需要关注的点直接转化为 2-3 条对应的小方法，具体到动作、贴合中学生日常场景，
   与文本测评报告中的建议风格一致、形成呼应；不重复罗列问题
3. 语气温和正向，以成长建议口吻呈现，不做病理判断
4. 结尾注明："⚠️ 本报告基于面部表情的AI分析，仅供参考，不能替代专业心理评估。"
5. 总字数 200-350 字

分析指标（JSON）：
{metrics_json}"""

# AI 综合分析报告提示词：联合 SCL-90 文本测评 + 面部视频测评两份客观数据生成综合解读
# （{scl90_json} / {face_json} 分别填入两类数据；缺一份时该占位填"（无该项数据）"）
ANALYSIS_PROMPT = """你是一位资深心理健康顾问，正在为学生「{student_name}」生成一份
AI 综合心理分析报告。以下是该生两类客观测评数据：

一、SCL-90 心理测评结果（JSON）：
{scl90_json}

二、面部表情视频分析指标（JSON）：
{face_json}

要求：
1. 用"总体来看，您的心理健康状况..."开头，联合两类数据交叉印证给出总体判断
2. 重点解读 SCL-90 得分异常（因子分≥2 或严重程度非"正常"）的维度，并用视频表情指标佐证或补充
3. 若两类数据存在不一致（如自陈正常但表情指标显示负面情绪偏高），需温和指出并建议关注
4. 针对需要关注的方面给出 2-3 条具体可行的日常改善建议
5. 语气温暖、去标签化，不使用"你有病""不正常"等词汇
6. 结尾必须注明："⚠️ 本报告为AI辅助生成，仅供参考，不能替代专业心理诊断与治疗。如有持续困扰，建议寻求专业心理咨询师帮助。"
7. 总字数 500-900 字"""

# 教师端 AI 综合干预建议提示词：面向教师研判视角，精简原因分析、突出可落地方案
# （{student_name} / {scl90_json} / {face_json} 填入学生数据；缺一份时该占位填"（无该项数据）"）
# 输出用【状态分析】【干预方案】固定标记分段，后端按标记拆分后分模块渲染
INTERVENTION_PROMPT = """你是资深学校心理健康教育指导教师，正在为班主任提供针对学生「{student_name}」的综合干预建议。
以下是该生两类客观测评数据：

一、SCL-90 心理测评结果（JSON）：
{scl90_json}

二、面部表情视频分析指标（JSON）：
{face_json}

严格按以下两个部分输出，使用固定标记分段，不要输出其他内容：

【状态分析】
不超过 200 字的核心研判结论：说明该生主要情绪倾向与需要重点关注的方面。
全文禁止出现 SCL-90 因子名称、常模、Z 分数等专业术语，禁止出现 AU 编号、动作单元、
活跃度百分比等面部表情术语，不做深度原因推导；语气客观专业，符合教师视角的研判表述。

【干预方案】
这是建议主体，务必具体可落地。要求：
1. 分 4-5 个维度输出，维度从以下范围中选择（可依据数据增加一个针对性维度）：
   情绪调节、人际互动、学习作息、求助支持
2. 每个维度 2-3 条具体可执行的操作方法，分别做到：
   情绪调节类具体到动作，如"每天课间做 3 分钟 4-7-8 呼吸法：吸气 4 秒、屏息 7 秒、呼气 8 秒"；
   人际互动类具体到场景，如"每周主动和 1 位同学合作完成一次课堂小组任务"；
   学习作息类具体到时间，如"每晚 22:30 前放下电子设备，用 5 分钟纸质阅读过渡到睡眠"；
   求助支持类具体到渠道，如"情绪持续低落时主动找班主任或心理老师预约 15 分钟沟通"
3. 禁止"要放松""多沟通""增强情感表达"这类笼统表述
4. 每条建议贴合中学生校园与生活场景，教师可直接用于与学生会谈时的沟通指导
5. 格式：每个维度以"▶ 维度名"开头单独一行，该维度下每条建议以"· "开头单独一行

结尾不要输出免责声明（页面另有统一展示）。"""

# ==================== 六、Mock 模式开关 ====================
# 本地 Windows 开发（无 vLLM / 无 py-feat）时置 True：
#   命令行 python app.py --mock 启动，LLM 与视频分析返回示例数据
MOCK_MODE = False

# ==================== 七、统一业务数据库（autodl-fs 文件存储盘，单库 12 表） ====================
# 一键建库：python create_db.py（--wipe 先删旧库再建）
# 表清单（字段规范见 表格.md）：teacher / teacher_class / student / scl90_text_report /
# video_face_report / ai_analysis_report / counseling_slots / appointments /
# articles / activity_material + conversation / message（私信）
# 全部表放在同一 db 文件，跨表可直接 JOIN。
# 时间戳约定：全库统一 BIGINT 毫秒时间戳（int(time.time() * 1000)）。
PSY_DB_DIR = os.path.join(AUTODL_FS, "psydb")
PSY_DB = os.path.join(PSY_DB_DIR, "psy.db")
# ==================== 八、随机森林模型产物目录 ====================
# 由 rf/train_text.py、rf/train_video.py 训练生成（.joblib + meta.json），
# 放 autodl-fs 文件存储盘（实例重置不丢失）；缺失时后端自动回退规则判定。
RF_MODEL_DIR = os.path.join(AUTODL_FS, "models")
# Flask session 签名密钥（生产部署可通过环境变量覆盖）
SECRET_KEY = os.environ.get("XINQING_SECRET_KEY", "xinqing-dev-secret-key-change-in-prod")
