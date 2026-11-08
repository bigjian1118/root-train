# 随机森林模块（rf/）· 统一说明文档

「规则蒸馏」方案：用线上规则（SCL-90 中国常模 Z 分数分级 / 情绪投票+微笑修正）对**合成数据**打伪标签，
训练 scikit-learn RandomForestClassifier；推理时**模型为主、规则兜底**（混合模式）。
运行环境为 **pyfeat_env**（与 Flask 后端同环境），CPU 训练数分钟。

## 目录文件说明

| 文件 | 功能 |
|---|---|
| `predictor.py` | 推理封装 + 共用定义：规则纯函数、特征构造（训练/推理共用防漂移）、模型惰性单例加载与回退 |
| `train_text.py` | SCL-90 十因子严重程度模型训练（5 类分级，10 个分类器） |
| `train_video.py` | 视频主导情绪分类模型训练（7 类 = 6 基本情绪 + unknown，单分类器） |
| `train_rf.sh` | **一键训练脚本**：环境校验 → 参数区（样本量）→ 依次训练文本+视频 → 产物清单与对接指引 |

## 一、环境依赖

- Python 3.11（conda 环境 `pyfeat_env`，CPU 即可，无需 GPU）
- 依赖包：`scikit-learn`、`joblib`、`numpy`（训练必需）

```bash
conda activate pyfeat_env
# 主依赖已随 pyfeat_env 安装（见 ai-psy/README「创建双 conda 环境」：pip install scikit-learn joblib ...）
# train_rf.sh 检测到依赖缺失时也会自动补装，无需手动处理
python -c "import sklearn, joblib, numpy; print('✓', sklearn.__version__)"
```

## 二、数据准备（合成数据，无外部数据集文件）

两个训练任务的数据均在脚本内合成、由规则自动打伪标签，**不读取任何数据集文件**：

**文本任务（train_text.py）**
- 采样：默认 20000 份 90 题模拟答卷（混合分布：50% 均匀 1-5 / 30% 偏低 / 20% 偏高），环境变量 `RF_TEXT_SAMPLES` 覆盖
- 标签：每因子按中国常模 Z 分数规则 `rule_factor_severity` 分级 → 0 正常 / 1 轻度 / 2 中度 / 3 重度 / 4 极重
- 特征（14 维，`predictor.text_feature`）：该因子各题原始分（升序，不足 13 题补 0）+ 因子均分
- 因子映射与常模：`predictor.FACTOR_MAP` / `predictor.CHINA_NORM`（金华等 1986，与前端 scl90_data.js 一致）

**视频任务（train_video.py）**
- 采样：默认 30000 条聚合级 metrics（情绪 Dirichlet + AU Beta 分布，对齐 py-feat 真实输出），环境变量 `RF_VIDEO_SAMPLES` 覆盖
- 标签：`rule_dominant_emotion`（帧级投票 + 微笑修正 AU12≥0.3 且 AU06≥0.2 → happiness）→ 7 类
- 特征（23 维，`predictor.video_feature`）：8 个关注 AU 的 mean + 8 个 max（AU01/04/06/12/15/20/25/45）+ 6 情绪 mean + face_activity

## 三、快速开始（三步启动训练）

```bash
# ① 激活环境（train_rf.sh 内也会自动激活）
conda activate pyfeat_env

# ② 按需修改 train_rf.sh 顶部「参数配置区」（仅样本量两项真实可调）

# ③ 启动训练（脚本自动 cd 到 ai-psy 并以模块方式运行）
bash ai-psy/rf/train_rf.sh
```

等价手动命令（必须在 **ai-psy 目录**下以模块方式运行，否则 `from rf import ...` 失败）：

```bash
cd ~/ai-psy
python -m rf.train_text && python -m rf.train_video
```

## 四、模型参数详解

两个训练脚本的 RandomForestClassifier 显式配置**完全相同**（固化于源码，无 CLI 入口）：

| 参数 | 值 | 说明 |
|---|---|---|
| `n_estimators` | 200 | 决策树数量 |
| `class_weight` | "balanced_subsample" | 按袋采样类别频率自动加权（伪标签类别不均衡） |
| `random_state` | 42 | 随机种子（采样与森林均可复现） |
| `n_jobs` | -1 | 全核并行 |
| `max_depth` / `min_samples_split` / `max_features` | 未显式设置 | sklearn 默认（不限深度 / 2 / 1.0） |

可调项（环境变量，train_rf.sh 参数区已暴露）：

| 变量 | 默认 | 作用 |
|---|---|---|
| `RF_TEXT_SAMPLES` | 20000 | 文本任务采样答卷份数（每因子各 20000 行） |
| `RF_VIDEO_SAMPLES` | 30000 | 视频任务合成样本条数 |

质量门槛（不达标**不写模型文件**，防止劣质模型上线）：

| 任务 | 门槛 | 未达标处理 |
|---|---|---|
| 文本 | 每因子训练准确率 ≥ 99.5% | 打印警告、跳过该因子；全部达标才更新 meta.json |
| 视频 | 整体准确率 ≥ 95% | 打印提示、不写 emotion_rf.joblib |

> 蒸馏目标是复现规则决策面，准确率不达标通常因采样量不足，增大样本量重训即可。

## 五、训练与评估

- 训练评估：控制台输出 accuracy_score + classification_report（逐因子 / 整体）
- 质量门槛不达标不写模型文件（见上表），训练日志即最终评估口径

## 六、模型导出

- 输出目录：`rf.settings.RF_MODEL_DIR` = `{AUTODL_FS}/models`（真实服务器 `/root/autodl-fs/models`，本地回退项目同级 `autodl-fs/models/`；可用环境变量 `RF_MODEL_DIR` 覆盖）
- 持久化：`joblib.dump`（协议兼容 sklearn 版本校验，见下）
- 命名规则（固定文件名，无版本号；重训即覆盖）：

```
{RF_MODEL_DIR}/
├── scl90_躯体化.joblib … scl90_其他.joblib   # 10 个因子分类器（中文因子名）
├── emotion_rf.joblib                          # 视频主导情绪分类器
└── meta.json                                  # sklearn_version / 特征维度 / 类别 / trained_at_*
```

- `meta.json` 版本契约：记录训练时 `sklearn_version`，推理加载校验**主次版本一致**，不一致自动回退规则（防反序列化不兼容）

## 七、业务对接

推理入口全部走 `rf/predictor.py`（惰性单例：首次调用加载、进程内缓存；任一文件缺失/异常 → 置不可用、静默回退规则，不向业务层抛异常）：

| 调用方 | 接口 | 场景 |
|---|---|---|
| `app.py` `api_test_submit`（POST /api/test/submit） | `predictor.text_feature` + `predict_factor_severity` | SCL-90 十因子严重程度：模型为主、Z 分数规则兜底，结果标记 `严重程度来源: rf/规则`；旧报告无原始答题自动走规则 |
| `app.py` 视频链路（POST /api/face/analyze → feat_analyzer 聚合后） | `predictor.video_feature` + `predict_emotion` | 主导情绪 7 类判定，异常回退投票规则 |

输入格式：`text_feature(factor, answers{题号:1-5}, factor_avg)` / `video_feature(metrics)`（metrics 为 `feat_analyzer._aggregate` 输出结构，含 au/emotions/face_activity）。
输出格式：`(中文标签, 代码)` / 情绪字符串；模型不可用时返回 `None`，由调用方回退。
重训后生效：重启 Flask 进程（模型仅首次调用加载）。

## 八、常见问题

| 症状 | 原因 | 处理 |
|---|---|---|
| `ModuleNotFoundError: No module named 'rf'` | 不在 ai-psy 目录运行，或用了 `python rf/train_text.py` 直接路径 | 必须 `cd ai-psy` 后 `python -m rf.train_text`（train_rf.sh 已自动处理） |
| 后端日志「未找到模型文件…使用规则判定」 | 未训练 / autodl-fs 未挂载 / 文件缺失 | `python -m rf.train_text && python -m rf.train_video` 重训后重启 Flask |
| 「sklearn 版本与训练时不一致，回退规则判定」 | 推理环境 sklearn 主次版本 ≠ meta.json 记录 | 对齐版本或重训刷新 meta.json |
| 准确率低于门槛、未写模型 | 样本量不足、伪标签类别覆盖不全 | 调大 `RF_TEXT_SAMPLES` / `RF_VIDEO_SAMPLES` 重训 |
| 报告「严重程度来源」全是「规则」 | 模型未加载成功（看上面两条） | 重训 + 重启 Flask 后重新提交测评验证 |
