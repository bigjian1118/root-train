'use client';

import { useEffect, useRef, useState } from 'react';

import { AppShell } from '@/components/business/app-shell';
import { AuthGuard } from '@/components/business/auth-guard';
import { MarkdownText } from '@/components/business/markdown-text';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { ShieldCheck } from 'lucide-react';
import { useToast } from '@/components/ui/toast';
import { ApiError, postJson } from '@/lib/api';
import type { VideoMetrics } from '@/lib/types';

// 1:1 复刻旧版 static/face.html + face.css：居中标题 + 左窄栏操作 + 右深色取景框与结果玻璃卡；
// 固定 10 秒录制、单次提交 webm、py-feat 轮询逻辑为已确认新增逻辑，保持不变。

const RECORD_SECONDS = 10;
const EMOTION_CN: Record<string, string> = {
  anger: '愤怒',
  disgust: '厌恶',
  fear: '恐惧',
  happiness: '快乐',
  sadness: '悲伤',
  surprise: '惊讶',
};
const FACE_ERROR_HINT = '摄像头不可用，请确认已在 https 或 localhost 环境下授权。';

/** 后端返回体；metrics 可能带 mock 标记，属页面局部契约，不扩展 lib/types。 */
interface FaceAnalyzeResult {
  metrics?: VideoMetrics & { mock?: boolean };
  report?: string;
}

function percentText(value: number): string {
  return `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%`;
}

function sortedEntries(values?: Record<string, number>): [string, number][] {
  if (!values) {
    return [];
  }
  return Object.entries(values)
    .filter((entry): entry is [string, number] => typeof entry[1] === 'number')
    .sort((a, b) => b[1] - a[1]);
}

// 旧版倒计时格式 00:00:SS
function countdownText(seconds: number): string {
  const safe = Math.max(0, seconds);
  return `00:00:${String(safe).padStart(2, '0')}`;
}

function MetricsPanel({
  metrics,
  report,
}: {
  metrics?: VideoMetrics & { mock?: boolean };
  report?: string;
}) {
  const emotions = sortedEntries(metrics?.emotions);
  const auEntries = metrics?.au
    ? Object.entries(metrics.au).sort((a, b) => (b[1].mean ?? 0) - (a[1].mean ?? 0))
    : [];

  return (
    <>
      {report ? <div className="aic-report-text"><MarkdownText content={report} /></div> : null}

      <h3>
        主导情绪：
        <span className="aic-dominant">
          {EMOTION_CN[metrics?.dominant_emotion ?? ''] ?? metrics?.dominant_emotion ?? '-'}
        </span>
      </h3>

      {emotions.length > 0 ? (
        <div className="aic-bars">
          <h4>基本情绪概率</h4>
          {emotions.map(([key, value]) => (
            <div key={key} className="aic-bar-row">
              <span className="aic-bar-name">{EMOTION_CN[key] ?? key}</span>
              <div className="aic-bar-track">
                <div className="aic-bar-fill" style={{ width: percentText(value) }} />
              </div>
              <span className="aic-bar-val">{percentText(value)}</span>
            </div>
          ))}
        </div>
      ) : null}

      {auEntries.length > 0 ? (
        <div className="aic-bars">
          <h4>面部动作单元（AU）强度</h4>
          {auEntries.slice(0, 8).map(([key, item]) => (
            <div key={key} className="aic-bar-row">
              <span className="aic-bar-name">
                {key} {item.label ? `· ${item.label}` : ''}
              </span>
              <div className="aic-bar-track">
                <div className="aic-bar-fill" style={{ width: percentText(item.mean ?? 0) }} />
              </div>
              <span className="aic-bar-val">{percentText(item.mean ?? 0)}</span>
            </div>
          ))}
        </div>
      ) : null}

      <div className="aic-meta-line">
        面部活跃度 {percentText(metrics?.face_activity ?? 0)} · 检出人脸帧{' '}
        {metrics?.face_frames ?? 0} / {metrics?.total_frames ?? 0}
        {metrics?.mock ? ' · MOCK 演示数据' : ''}
      </div>
      <p className="aic-est-tip">
        以上指标由表情概率与面部活跃度估算，仅供参考，不构成医学诊断。
      </p>
    </>
  );
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
  const [videoBlob, setVideoBlob] = useState<Blob | null>(null);
  const [videoUrl, setVideoUrl] = useState('');
  const [analyzing, setAnalyzing] = useState(false);
  const [result, setResult] = useState<FaceAnalyzeResult | null>(null);
  const [error, setError] = useState('');

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
    setResult(null);
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
    if (!videoBlob) {
      return;
    }
    setAnalyzing(true);
    setError('');
    try {
      const form = new FormData();
      // 字段名与扩展名必须匹配后端白名单（video + webm）。
      form.append('video', videoBlob, 'face.webm');
      const data = await postJson<FaceAnalyzeResult>('/api/face/analyze', form);
      setResult(data);
      toast({ title: '分析完成', description: '已生成面部状态解读', variant: 'success' });
    } catch (caught) {
      const message =
        caught instanceof ApiError ? caught.message : '上传失败，请检查网络后重试。';
      setError(message);
      toast({ title: '分析失败', description: message, variant: 'destructive' });
    } finally {
      setAnalyzing(false);
    }
  };

  const handleReset = () => {
    releaseVideoUrl();
    setVideoBlob(null);
    setResult(null);
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

          {analyzing ? (
            <button type="button" className="aic-btn aic-btn-open" disabled>
              正在逐帧分析（约 1-3 分钟）
            </button>
          ) : null}

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
            {videoBlob && !analyzing ? (
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

          {analyzing ? (
            <section className="aic-glass aic-loading-panel">
              <div className="aic-spinner" style={{ margin: '0 auto 20px' }} />
              <p>
                正在用 py-feat 逐帧分析你的面部表情…
                <br />
                <small>CPU 分析约需 1-3 分钟，请耐心等待</small>
              </p>
            </section>
          ) : null}

          {result ? (
            <section className="aic-glass aic-result-panel">
              <h2>分析报告</h2>
              <MetricsPanel metrics={result.metrics} report={result.report} />
              <button
                type="button"
                className="aic-btn aic-btn-open"
                style={{ marginTop: 22, display: 'block', marginLeft: 'auto', marginRight: 'auto' }}
                onClick={handleReset}
              >
                重新录制
              </button>
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
