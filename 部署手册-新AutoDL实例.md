# 部署操作手册 · 新 AutoDL 实例(全新初始化)

> 适用场景:在一台全新的 AutoDL 有卡实例(RTX 4090 24GB)上从零部署「芯心向荣 AIC」全系统。
> 数据策略:全新初始化——建空库、重训随机森林、仅下载 bf16 基座;不迁移旧 psy.db / .joblib / LoRA 适配器。
> 依据:ai-psy/README.md v3.0 快速开始 + config.py / start_all.sh 实际路径约定。

## 一键部署(可选,替代第 2~4 步)

完成第 1 步上传代码后,把项目根目录的两个环境自包含脚本 `setup_qwen_env.sh` / `setup_pyfeat_env.sh` 传到服务器,按环境分别一键配置:

```powershell
scp -P <端口> "setup_qwen_env.sh" "setup_pyfeat_env.sh" root@<地址>:~/
```

```bash
bash ~/setup_qwen_env.sh       # 推理环境:qwen_env 创建 + vLLM 依赖 + bf16 基座下载(阶段:all|env|model)
bash ~/setup_pyfeat_env.sh     # 后端环境:pyfeat_env 创建 + py-feat 依赖与权重 + 建库/题库/RF(阶段:all|env|feat|init)
```

脚本幂等,中断/重跑自动跳过已完成部分。两脚本互相独立,可只跑其一或分窗口并行(串行更稳,避免 conda 并发锁竞争)。配置完成后按下方第 5 步 `start_all.sh` 启动、第 6 步 curl 验证。若某阶段报错,仍可按下方分步手册手动补救。以下为分步详解。

---

## 第 0 步:开机前检查(AutoDL 控制台)

| 检查项 | 要求 | 说明 |
|---|---|---|
| 显卡 | RTX 4090 24GB(有卡) | bf16 推理 `--gpu-memory-utilization 0.9` 约占 22GB |
| 内存 | ≥ 32GB | py-feat 视频分析 + vLLM 并发需要 |
| 基础镜像 | 任选带 Miniconda 的社区镜像 | 本项目自己 pip 装 torch,不依赖镜像预装版本;`start_all.sh` 固定 `source /root/miniconda3/etc/profile.d/conda.sh`,AutoDL 默认即此路径 |
| 数据盘 autodl-tmp | 剩余 ≥ 30GB | bf16 基座约 15GB;不足时控制台"扩容数据盘" |
| 文件盘 autodl-fs | 可选(不开通也可部署) |  psy.db / RF 模型 / 上传暂存的默认落盘;未开通时代码自动在系统盘创建同名目录,功能不受影响,仅"释放实例后数据不保留"(可存镜像/定期 scp 备份)。决定要开通的话,须在下面第 4 步初始化之前开通,避免挂载遮蔽已有数据 |

记下控制台的 **SSH 登录指令**(形如 `ssh -p <端口> root@connect.nXX.seetacloud.com`),下文 scp/ssh 的 `<端口>`、`<地址>` 均以此为准。

---

## 第 1 步:上传代码(本地 Windows PowerShell)

在项目根目录 `root-train\` 下执行:

```powershell
scp -P <端口> -r "ai-psy" root@<地址>:~/
```

**只上传 `ai-psy/` 一个目录**。本地的 `autodl-fs/`、`autodl-tmp/` 是模拟服务器目录(Windows 开发用),**不要上传**——服务器上真实路径 `/root/autodl-tmp`、`/root/autodl-fs` 存在时,`config.py` 自动优先使用真实路径。

上传后服务器端确认:

```bash
ssh -p <端口> root@<地址>
ls ~/ai-psy        # 应见 app.py config.py create_db.py start_all.sh rf/ Qwen-train/ static/ ...
```

---

## 第 2 步:创建双 conda 环境

### 窗口 1:qwen_env(大模型推理)

```bash
conda create -n qwen_env python=3.12 -y
conda activate qwen_env
pip install torch==2.5.1 torchvision==0.20.1 --index-url https://download.pytorch.org/whl/cu121
pip install vllm==0.7.0 safetensors "transformers==4.51.3"
python -c "import torch; print('cuda可用：', torch.cuda.is_available())"   # 预期 True
```

> 勿手动升级 torch,会破坏 vLLM 0.7.0 二进制兼容(README 版本配套约定)。

### 窗口 2:pyfeat_env(后端 + 视频分析)

```bash
conda create -n pyfeat_env python=3.11 -y
conda activate pyfeat_env
pip install torch==2.4.1 torchvision==0.19.1 --index-url https://download.pytorch.org/whl/cpu
pip install py-feat==0.6.1 scipy==1.10.1 flask scikit-learn joblib
apt update && apt install ffmpeg -y
python -c "import feat; print('py-feat导入成功')"
```

补充 Web 依赖(仍在 pyfeat_env):

```bash
cd ~/ai-psy && pip install -r requirements.txt
```

### py-feat 离线权重预置(必做,否则面部分析报"无法下载权重/缺文件")

py-feat 权重托管在 GitHub Releases,AutoDL 直连不稳。实测可行方案:**3 个大骨干走 hf-mirror**(与基座同源,稳定),**小文件走 gh-proxy 加速前缀**。全部放入 `feat/resources/`(项目 feat_analyzer 按离线权重设计,放好后不再联网):

```bash
conda activate pyfeat_env
RES=$(python -c 'import feat; print(feat.__path__[0])')/resources
mkdir -p "$RES"

# 1) 人脸/特征点/情绪骨干（hf-mirror，约 540MB）
wget -q -P "$RES" https://hf-mirror.com/py-feat/retinaface/resolve/main/mobilenet0.25_Final.pth
wget -q -P "$RES" https://hf-mirror.com/py-feat/mobilefacenet/resolve/main/mobilefacenet_model_best.pth.tar
wget -q -P "$RES" https://hf-mirror.com/py-feat/resmasknet/resolve/main/ResMaskNet_Z_resmasking_dropout1_rot30.pth

# 2) AU-XGB 模型 + 情绪配置 + AU 校准数据（gh-proxy；失效可换 https://ghfast.top/ 前缀）
GH=https://gh-proxy.com/https://github.com/cosanlab/py-feat/releases/download/v0.1
wget -q -P "$RES" $GH/ResMaskNet_fer2013_config.json
for au in 1 2 4 5 6 7 9 10 11 12 14 15 17 20 23 24 25 26 28 43; do wget -q -P "$RES" $GH/July4_AU${au}_XGB.ubj; done
for d in Upperscalar Upperpca Lowerscalar Lowerpca Fullscalar Fullpca; do wget -q -P "$RES" $GH/all_data_${d}_June30.pkl; done

ls "$RES" | wc -l                # 应新增 30 个文件(3 骨干 + 1 配置 + 20 AU 模型 + 6 校准 pkl)
```

> 注意:
> - `all_data_*_June30.pkl` 6 个校准文件缺失时,Detector 初始化报 `No such file or directory: .../all_data_Upperscalar_June30.pkl`,易被误判为"没装 py-feat"
> - ResMaskNet_Z 以 hf-mirror 版为准(约 527MB);gh-proxy 下载大文件可能被截断,校验大小不符时删掉重下
> - ResMaskNet 骨干 resnet50 权重来自 download.pytorch.org(国内 CDN 可达),首次分析时自动缓存,无需预置

---

## 第 3 步:下载 bf16 基座模型

```bash
conda activate qwen_env
export HF_ENDPOINT=https://hf-mirror.com
export HF_HUB_DISABLE_XET=1        # hf-mirror 不支持 Xet 协议，禁用后回退传统 HTTP 下载
cd /root/autodl-tmp
hf download Qwen/Qwen2.5-7B-Instruct --local-dir Qwen2.5-7B-Instruct
```

目录约定(与 `config.MODEL_PATH`、`start_all.sh` 硬编码路径一致,不可乱放):

```
/root/autodl-tmp/Qwen2.5-7B-Instruct          # 基座,必须此名
/root/autodl-tmp/qwen25-7b-lora-ai_chat       # 聊天 LoRA(本次全新初始化不部署,见第 7 步可选项)
```

下载完成后校验:

```bash
ls /root/autodl-tmp/Qwen2.5-7B-Instruct | head   # 应见 config.json、*.safetensors 等
```

---

## 第 4 步:初始化数据库与题库(pyfeat_env)

```bash
conda activate pyfeat_env
cd ~/ai-psy
python create_db.py                        # 建 /root/autodl-fs/psydb/psy.db 12 表(幂等)
cd Qwen-train && python prepare_dataset.py && cd ..   # 生成三人群题库 static/data/question_bank.json + ai_chat 数据集
python -m rf.train_text                    # SCL-90 十因子严重程度 RF(默认 20000 份模拟答卷,CPU 数分钟)
python -m rf.train_video                   # 视频主导情绪/严重程度 RF
```

确认产物:

```bash
ls /root/autodl-fs/psydb/psy.db
ls /root/autodl-fs/models/        # 10 个因子 .joblib + emotion_rf.joblib + meta.json
```

> 全新初始化说明:psy.db 为空库,首个用户需在登录页自行注册;RF 模型质量门控通过后才会落盘上线。

---

## 第 5 步:启动服务

```bash
bash ~/ai-psy/start_all.sh
```

脚本自动:检测 GPU → qwen_env 起 vLLM(8000,bf16 基座)→ pyfeat_env 起 Flask(6006)。首次加载权重约 1~3 分钟,日志在 `~/ai-psy/vllm.log` 与 `app.log`。

> 因未部署 LoRA 适配器目录,`start_all.sh` 自动跳过 `--enable-lora`,`config.LORA_ENABLED=False`,聊天走通用基座 + 三人群 system prompt(设计内回退,非故障)。

vLLM 常驻推荐 tmux(防 SSH 断开被杀):

```bash
tmux new -s vllm -d 'bash /root/ai-psy/start_all.sh'
tmux attach -t vllm    # Ctrl+B D 退出不杀进程
```

---

## 第 6 步:启动验证

```bash
# 1) vLLM 模型列表(预期列出基座路径)
curl -s http://127.0.0.1:8000/v1/models | python3 -m json.tool | grep '"id"'

# 2) 大模型对话连通性
curl http://127.0.0.1:8000/v1/chat/completions -H "Content-Type: application/json" \
  -d '{"model": "/root/autodl-tmp/Qwen2.5-7B-Instruct",
       "messages": [{"role": "user", "content": "你好"}]}'

# 3) Flask 后端存活
curl -s http://127.0.0.1:6006/api/config | python3 -m json.tool
```

浏览器访问:AutoDL 控制台「我的实例 → 自定义服务」中 6006 端口对应的公网地址即登录页。实例重启后映射端口可能变化,以控制台为准。

安全提醒:8000 仅供本机 `127.0.0.1` 调用,**不要在公网映射开放模型接口**。

---

## 第 7 步(可选):恢复 psych-chat 聊天 LoRA

全新初始化默认不带 LoRA(聊天为基座风格)。如需恢复微调风格,在新实例上重训:

```bash
kill $(pgrep -f "vllm serve")        # 训练与推理互斥,先腾显存
conda activate qwen_env
bash ~/ai-psy/Qwen-train/train_all.sh
bash ~/ai-psy/start_all.sh           # 训完必须拉回 vLLM,否则聊天/报告 502
```

产物落 `/root/autodl-tmp/qwen25-7b-lora-ai_chat`,`start_all.sh` 检测到目录即自动挂载注册 `psych-chat`。

---

## 日常运维速查

| 操作 | 命令 |
|---|---|
| 重启 Flask(改了 app.py/config.py/llm_client.py 后) | `pkill -f "python.*app.py"; bash ~/ai-psy/start_all.sh` |
| 重启 vLLM | `kill $(pgrep -f "vllm serve"); bash ~/ai-psy/start_all.sh` |
| 静态资源改动(html/css/js) | 无需重启,浏览器 Ctrl+F5 强刷 |
| 聊天/报告 502 | vLLM 被停未拉起 → `bash start_all.sh` |
| 报告"AI 生成失败" | `curl http://127.0.0.1:8000/v1/models` 确认;核对 MODEL_PATH 与启动路径一致 |
| RF 来源显示"规则" | .joblib 缺失/版本不符 → `python -m rf.train_text && python -m rf.train_video` 后重启 |
| 生产密钥 | 启动前 `export XINQING_SECRET_KEY=<随机长串>`(config.py 支持环境变量覆盖) |

完整故障对照见 `ai-psy/README.md`「常见问题」一节。
