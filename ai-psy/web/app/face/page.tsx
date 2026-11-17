'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';

import { AppShell } from '@/components/business/app-shell';
import { AuthGuard } from '@/components/business/auth-guard';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { ShieldCheck } from 'lucide-react';
import { useToast } from '@/components/ui/toast';
import { ApiError, getJson, postJson } from '@/lib/api';
import { markReportUnread } from '@/lib/report-notice';
import type { ReportStatusItem } from '@/lib/types';

// 1:1 复刻旧版 static/face.html + face.css：居中标题 + 左窄栏操作 + 右深色取景框与结果玻璃卡；
// 固定录制、单次提交 webm、py-feat 轮询逻辑为已确认新增逻辑，保持不变。

// 录制时长（秒）：按需求固定为 5 秒；文案、倒计时、自动停止都取自该常量
const RECORD_SECONDS = 5;

// 报告状态轮询间隔：与报告页保持一致，3s 足够感知完成
const STATUS_POLL_MS = 3000;
// 上传超时：视频仅 5 秒（约 1-3MB），正常 2s 内完成；
// 超时后按"响应可能丢失"处理，回查后端是否已建档，避免代理抖动时误报失败
const UPLOAD_TIMEOUT_MS = 30000;
// 回查接管的时间窗口：只接管近期提交的报告，避免误认历史记录
const RECENT_REPORT_WINDOW_MS = 10 * 60 * 1000;

// 侧边栏“录制设置”选项：仅静态展示与本地选中态，不参与录制、上传与请求参数
const DURATION_OPTIONS = ['5 秒', '10 秒', '15 秒'];
const LIGHT_OPTIONS = ['自然光', '室内白光', '暖光'];
const SHOT_OPTIONS = ['1 次', '2 次', '3 次'];

type SetupRowProps = {
  label: string;
  options: string[];
  value: string;
  onChange: (value: string) => void;
};

/** 侧边栏设置行：纯展示，选中态只存本地 state，不进入后端契约。 */
function SetupRow({ label, options, value, onChange }: SetupRowProps) {
  return (
    <div className="aic-setup-row">
      <span className="aic-setup-label">{label}</span>
      <div className="aic-setup-options">
        {options.map((option) => (
          <button
            key={option}
            type="button"
            className={`aic-setup-option${option === value ? ' is-active' : ''}`}
            onClick={() => onChange(option)}
          >
            {option}
          </button>
        ))}
      </div>
    </div>
  );
}
const FACE_ERROR_HINT = '摄像头不可用，请确认已在 https 或 localhost 环境下授权。';

// 旧版倒计时格式 00:00:SS
function countdownText(seconds: number): string {
  const safe = Math.max(0, seconds);
  return `00:00:${String(safe).padStart(2, '0')}`;
}

/**
 * 上传失败后回查一次最新视频报告：
 * 后端可能已建档并入队，但响应在代理链路上被重置（历史上 web.log 的 ECONNRESET），
 * 此时直接接管该报告，避免用户看到"假失败"后又重复提交。
 */
async function probeLatestVideoReport(): Promise<string | null> {
  try {
    const latest = await getJson<{ video?: ReportStatusItem | null }>('/api/report/status');
    const video = latest?.video;
    if (!video?.report_id || !video.submitted_at) {
      return null;
    }
    if (Date.now() - video.submitted_at > RECENT_REPORT_WINDOW_MS) {
      return null;
    }
    return video.report_id;
  } catch {
    return null;
  }
}


function FaceContent() {
  const { toast } = useToast();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const timerRef = useRef<number | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const objectUrlRef = useRef<string | null>(null);

  const [cameraOn, setCameraOn] = useState(false);
  const [recording, setRecording] = useState(false);
  const [countdown, setCountdown] = useState(RECORD_SECONDS);
  // 录制设置仅做静态展示：默认与真实录制口径保持一致（5 秒 / 自然光 / 1 次）
  const [durationOption, setDurationOption] = useState(DURATION_OPTIONS[0]);
  const [lightOption, setLightOption] = useState(LIGHT_OPTIONS[0]);
  const [shotOption, setShotOption] = useState(SHOT_OPTIONS[0]);
  const [videoBlob, setVideoBlob] = useState<Blob | null>(null);
  const [videoUrl, setVideoUrl] = useState('');
  // 上传中 / 后台生成中 / 已完成 / 失败 四态都由这两个值推导
  const [uploading, setUploading] = useState(false);
  const [reportId, setReportId] = useState('');
  const [error, setError] = useState('');

  // 报告在后端异步生成：本页只轮询状态，关闭页面或切换功能不会中断任务
  const statusQuery = useQuery({
    queryKey: ['student', 'face-report-status', reportId],
    queryFn: () => getJson<ReportStatusItem>(
      `/api/report/status?report_id=${encodeURIComponent(reportId)}`,
    ),
    enabled: Boolean(reportId),
    refetchInterval: (query) => (
      query.state.data?.status === 'processing' ? STATUS_POLL_MS : false
    ),
    refetchOnMount: 'always',
  });
  // 只有后端明确失败或报告已不存在才算失败；网络抖动继续按生成中轮询
  const statusNotFound = statusQuery.error instanceof ApiError && statusQuery.error.status === 404;
  const statusFailed = Boolean(reportId)
    && (statusQuery.data?.status === 'failed' || statusNotFound);
  const statusCompleted = Boolean(reportId) && statusQuery.data?.status === 'completed';
  const statusProcessing = Boolean(reportId) && !statusFailed && !statusCompleted;
  const failureReason = statusQuery.data?.error
    || (statusQuery.error instanceof ApiError ? statusQuery.error.message : '')
    || '视频分析未能完成，请重新录制一段。';

  // 生成完成时点亮侧边栏「我的心理测试报告」红点
  useEffect(() => {
    if (statusCompleted) {
      markReportUnread();
    }
  }, [statusCompleted]);

  const stopTimer = () => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  const releaseStream = () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setCameraOn(false);
  };

  const releaseVideoUrl = () => {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
    setVideoUrl('');
  };

  // 页面卸载时释放摄像头与定时器，避免后台持续占用设备。
  useEffect(() => {
    return () => {
      stopTimer();
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== 'inactive') {
        recorder.onstop = null;
        recorder.stop();
      }
      recorderRef.current = null;
      releaseStream();
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
    };
  }, []);

  const openCamera = async () => {
    setError('');
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('当前环境不支持摄像头，请使用 https 或 localhost 访问。');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      streamRef.current = stream;
      setCameraOn(true);
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => undefined);
      }
    } catch {
      setError(FACE_ERROR_HINT);
    }
  };

  const stopRecording = () => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state === 'recording') {
      recorder.stop();
    }
    stopTimer();
  };

  const startRecording = () => {
    if (!streamRef.current || recording) {
      return;
    }
    if (typeof MediaRecorder === 'undefined') {
      setError('当前浏览器不支持 MediaRecorder，请更换 Chrome/Edge 后重试。');
      return;
    }
    const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
      ? 'video/webm;codecs=vp9'
      : 'video/webm';

    chunksRef.current = [];
    setReportId('');
    releaseVideoUrl();

    const recorder = new MediaRecorder(streamRef.current, { mimeType });
    recorderRef.current = recorder;
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        chunksRef.current.push(event.data);
      }
    };
    recorder.onstop = () => {
      stopTimer();
      setRecording(false);

      const blob = new Blob(chunksRef.current, { type: 'video/webm' });
      chunksRef.current = [];
      if (blob.size === 0) {
        setError('未采集到视频数据，请重新录制。');
        return;
      }

      // 录制完成后立即释放摄像头，预览与上传都只使用本地 Blob。
      releaseStream();
      const url = URL.createObjectURL(blob);
      objectUrlRef.current = url;
      setVideoUrl(url);
      setVideoBlob(blob);
    };

    recorder.start();
    setRecording(true);
    let remaining = RECORD_SECONDS;
    setCountdown(remaining);
    timerRef.current = window.setInterval(() => {
      remaining -= 1;
      setCountdown(Math.max(0, remaining));
      if (remaining <= 0) {
        stopTimer();
        stopRecording();
      }
    }, 1000);
  };

  const handleAnalyze = async () => {
    if (!videoBlob || uploading) {
      return;
    }
    setUploading(true);
    setError('');
    // 上传兜底超时：卡死的连接必须尽早断开，否则会一直停在"正在上传视频…"
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
    try {
      const form = new FormData();
      // 字段名与扩展名必须匹配后端白名单（video + webm）。
      form.append('video', videoBlob, 'face.webm');
      // 上传即返回 {report_id, status: 'processing'}，分析与出报告在后台继续
      const data = await postJson<{ report_id?: string; status?: string }>(
        '/api/face/analyze',
        form,
        { signal: controller.signal },
      );
      if (!data.report_id) {
        throw new Error('未获取到报告编号，请重新提交');
      }
      setReportId(data.report_id);
      toast({ title: '已提交', description: '报告正在后台生成，可先离开此页面', variant: 'success' });
    } catch (caught) {
      // 响应可能已丢失但后端已受理：接管最新报告，而不是直接报失败
      const recoveredId = await probeLatestVideoReport();
      if (recoveredId) {
        setReportId(recoveredId);
        toast({ title: '已提交', description: '报告正在后台生成，可先离开此页面', variant: 'success' });
        return;
      }
      const message =
        caught instanceof ApiError ? caught.message : '上传失败，请检查网络后重试。';
      setError(message);
      toast({ title: '提交失败', description: message, variant: 'destructive' });
    } finally {
      window.clearTimeout(timeoutId);
      setUploading(false);
    }
  };

  const handleReset = () => {
    releaseVideoUrl();
    setVideoBlob(null);
    setReportId('');
    setError('');
    setCountdown(RECORD_SECONDS);
  };

  return (
    <AppShell
      role="student"
      pageClassName="mx-auto min-h-screen px-[24px] pb-[60px] pt-[20px]"
      headNavClassName="mb-[14px] flex flex-wrap items-center gap-[10px]"
    >
      <div className="aic-face-head">
        <h1 className="aic-page-title">📷 面部情绪视频分析</h1>
        <p className="aic-face-sub">录制正对摄像头的自然表情视频，AI 解析你的面部情绪状态</p>
      </div>

      {/* 新增功能保持：隐私与使用说明 */}
      <Alert variant="warning" className="mb-4">
        <ShieldCheck className="h-4 w-4" />
        <AlertTitle>隐私与使用说明</AlertTitle>
        <AlertDescription>
          1. 需在 https 或 localhost 下授权摄像头；2. 录制时长固定 {RECORD_SECONDS} 秒，
          请保持面部在画面内；3. 分析结果仅供参考，不能替代专业评估。
        </AlertDescription>
      </Alert>

      <div className="aic-face-stage">
        <aside className="aic-glass aic-face-side">
          {!cameraOn && !videoUrl ? (
            <button
              type="button"
              className="aic-btn aic-btn-open"
              onClick={() => void openCamera()}
              disabled={recording}
            >
              1️⃣ 开启摄像头
            </button>
          ) : null}

          {cameraOn && !recording && !videoUrl ? (
            <button type="button" className="aic-btn aic-btn-rec" onClick={startRecording}>
              2️⃣ 开始录制
            </button>
          ) : null}

          {recording ? (
            <button
              type="button"
              className="aic-btn aic-btn-rec"
              onClick={stopRecording}
            >
              提前结束（{countdown}s）
            </button>
          ) : null}

          {uploading ? (
            <button type="button" className="aic-btn aic-btn-open" disabled>
              正在上传视频…
            </button>
          ) : null}

          {statusProcessing ? (
            <button type="button" className="aic-btn aic-btn-open" disabled>
              正在逐帧分析（约 1-3 分钟）
            </button>
          ) : null}

          <hr className="aic-grad-divider" />

          {/* 录制设置：静态展示，选择不改变录制参数与上传内容 */}
          <div className="aic-setup">
            <p className="aic-setup-title">录制设置</p>
            <SetupRow
              label="录制时长"
              options={DURATION_OPTIONS}
              value={durationOption}
              onChange={setDurationOption}
            />
            <SetupRow
              label="光线类型"
              options={LIGHT_OPTIONS}
              value={lightOption}
              onChange={setLightOption}
            />
            <SetupRow
              label="录制次数"
              options={SHOT_OPTIONS}
              value={shotOption}
              onChange={setShotOption}
            />
          </div>

          <hr className="aic-grad-divider" />

          <p className="aic-face-tip">
            提示：需在 https 或 localhost 环境下授权摄像头；录制时长固定 {RECORD_SECONDS} 秒，请保持面部在画面内。
          </p>
        </aside>

        <section className="aic-face-col">
          <div className="aic-glass aic-capture">
            <div className="aic-capture-top">
              {recording ? (
                <span className="aic-rec-lamp">
                  <i />
                  REC
                </span>
              ) : (
                <span />
              )}
              {recording ? <span className="aic-countdown">{countdownText(countdown)}</span> : <span />}
            </div>
            <div className="aic-video-box">
              {videoUrl ? (
                // 回放录制结果时展示 controls，与旧版 face.js 行为一致。
                <video src={videoUrl} controls autoPlay playsInline muted />
              ) : (
                <video
                  ref={videoRef}
                  autoPlay
                  playsInline
                  muted
                  className={cameraOn ? 'aic-mirror' : 'hidden'}
                />
              )}
              {!cameraOn && !videoUrl ? (
                <div className="aic-video-placeholder">
                  {/* 旧版占位图原样复用（web/public/static/picture/face.png） */}
                  <img className="aic-placeholder-img" src="/static/picture/face.png" alt="摄像头未开启" />
                </div>
              ) : null}
            </div>
            {videoBlob && !uploading && !statusProcessing ? (
              <div style={{ display: 'flex', gap: 12, marginTop: 14, justifyContent: 'center' }}>
                <button type="button" className="aic-btn aic-btn-open" onClick={handleReset}>
                  再录一段
                </button>
                <button
                  type="button"
                  className="aic-btn aic-btn-submit"
                  onClick={() => void handleAnalyze()}
                >
                  提交分析
                </button>
              </div>
            ) : null}
          </div>

          {/* 上传/生成中：只展示加载态与提示文案，不阻塞用户离开页面 */}
          {uploading || statusProcessing ? (
            <section className="aic-glass aic-loading-panel">
              <div className="aic-spinner" style={{ margin: '0 auto 20px' }} />
              <p>
                {uploading ? '正在上传视频…' : '正在用 py-feat 逐帧分析你的面部表情…'}
                <br />
                <small>
                  后台正在生成报告，您可关闭页面或切换其他功能，
                  <br />
                  生成完成后可在「我的心理测试报告」中查看。
                  <br />
                  文本与视频报告都完成后，AI 综合报告会自动在后台生成。
                </small>
              </p>
            </section>
          ) : null}

          {statusCompleted ? (
            <section className="aic-glass aic-result-panel">
              <h2>✅ 报告已生成完成</h2>
              <p className="aic-gen-text">
                视频报告已生成完成，前往「我的心理测试报告」查看详情。
                <br />
                文本与视频报告都完成后，AI 综合报告会自动在后台生成，
                完成后可在报告中心的「AI 综合分析」中查看。
              </p>
              <div className="aic-gen-actions">
                <Link href="/test/report" className="aic-btn aic-btn-primary">
                  查看报告 →
                </Link>
                <button type="button" className="aic-btn aic-btn-ghost" onClick={handleReset}>
                  再录一段
                </button>
              </div>
            </section>
          ) : null}

          {statusFailed ? (
            <section className="aic-glass aic-result-panel">
              <h2>⚠️ 报告生成失败</h2>
              <p className="aic-gen-text">
                视频分析未完成，视频文件已按隐私要求删除，请重新录制一段再提交。
              </p>
              <div className="aic-gen-error">{failureReason}</div>
              <div className="aic-gen-actions">
                <button type="button" className="aic-btn aic-btn-primary" onClick={handleReset}>
                  重新录制
                </button>
              </div>
            </section>
          ) : null}
        </section>
      </div>

      {error ? <div className="aic-toast">{error}</div> : null}
    </AppShell>
  );
}

export default function FacePage() {
  return (
    <AuthGuard role="student">
      <FaceContent />
    </AuthGuard>
  );
}
