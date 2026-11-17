// 与 Flask 后端 JSON 契约一一对应。
// 注意：后端部分列表接口按“秒”返回时间、详情接口按“毫秒”返回，
// 因此同时保留了 created_at / submit_timestamp 等别名字段，页面统一用 utils 做量级兼容。

export type Role = 'student' | 'teacher';

/** 登录态用户；/api/auth/me 不下发 id，AuthProvider 会补空串以保持类型稳定。 */
export interface User {
  id: string;
  role: Role;
  name: string;
  account: string;
  /** 学生为单班级；教师为第一个班级（兼容旧接口） */
  class?: string;
  /** 教师多班级绑定 */
  classes?: string[];
}

export interface MeResponse {
  logged_in: boolean;
  user: User | null;
}

export type ScenarioKey = 'primary_student' | 'junior_student' | 'college_student';

export interface Scenario {
  key: string;
  name: string;
  desc: string;
}

/** /api/config 的全量配置；mock 仅用于本地演示提示。 */
export interface AppConfig {
  scenarios: Scenario[];
  mock?: boolean;
}

/** 后端固定返回中文字段名，不能改成驼峰，否则计分与归档规则会错位。 */
export interface Scl90FactorScore {
  均分: number;
  常模均值: number;
  常模标准差: number;
  标准差倍数: number;
  严重程度: string;
  严重程度代码: number;
  严重程度来源: string;
}

export interface Scl90Scores {
  总分: number;
  总均分: number;
  阳性项目数: number;
  阳性症状均分: number;
  因子分: Record<string, Scl90FactorScore>;
  危机信号?: Record<string, number>;
}

/** 题库中的单题；factor 由题库提供，缺失时用题号反查因子。 */
export interface Scl90Question {
  id: number;
  factor: string;
  question: string;
}

/** 90 题答案：题号 -> 1~5 分。 */
export type Scl90Answers = Record<number, number>;

/** scl90_text_report 的 10 个因子英文列（部分旧接口会直接平铺到列表项）。 */
export interface Scl90FactorColumns {
  somatization?: number | null;
  ocd?: number | null;
  interpersonal_sensitivity?: number | null;
  depression?: number | null;
  anxiety?: number | null;
  hostility?: number | null;
  phobic_anxiety?: number | null;
  paranoid_ideation?: number | null;
  psychoticism?: number | null;
  additional?: number | null;
}

/** 报告异步生成状态：processing 生成中 / completed 已完成 / failed 生成失败。 */
export type ReportStatus = 'processing' | 'completed' | 'failed';

/** GET /api/report/status?report_id=xxx 的单项返回（轻量字段，供前端轮询）。 */
export interface ReportStatusItem {
  report_id: string;
  kind: 'text' | 'video';
  status: ReportStatus;
  /** 毫秒时间戳 */
  submitted_at: number | null;
  /** 生成中的粗略剩余秒数，仅用于文案提示 */
  eta_seconds: number | null;
  /** 仅 status=failed 时返回的失败原因 */
  error: string | null;
  /** status=completed 时的报告页跳转标识 */
  redirect: string;
}

/** 文字测评列表项：兼容新版 id/class 与旧版 report_id/student_class 字段。 */
export interface TextReportSummary extends Scl90FactorColumns {
  report_id?: string;
  id?: string;
  student_id: string;
  student_name: string;
  student_class?: string;
  class?: string;
  crowd_tag?: string;
  scenario?: string;
  total_score: number | null;
  pos_item_count?: number | null;
  positive_count?: number | null;
  risk_signal?: number;
  crisis?: number;
  top_factor?: string;
  factor_avgs?: Record<string, number | null>;
  submit_timestamp?: number;
  created_at?: number | null;
  scores?: Scl90Scores;
  status?: ReportStatus;
  error_message?: string | null;
}

/** 文字测评详情：详情接口始终返回重算后的完整 scores。 */
export interface TextReportDetail {
  report_id?: string;
  id?: string;
  student_id?: string;
  student_name?: string;
  student_class?: string;
  class?: string;
  crowd_tag?: string;
  scenario?: string;
  scenario_name: string;
  scores: Scl90Scores;
  report?: string;
  ai_content?: string;
  submit_timestamp?: number;
  submitted_at?: number;
  created_at?: number | null;
}

/** 视频 AU 指标（均值/最大值由 py-feat 输出）。 */
export interface VideoAuMetric {
  label?: string;
  mean?: number;
  max?: number;
}

export interface FactorHistoryPoint {
  submit_time: number;
  total_score: number | null;
  factors: Record<string, number | null>;
}

export interface VideoMetrics {
  au?: Record<string, VideoAuMetric>;
  emotions?: Record<string, number>;
  dominant_emotion?: string;
  dominant_emotion_source?: string;
  smile_detected?: boolean;
  face_activity?: number;
  total_frames?: number;
  face_frames?: number;
  emotion_max?: Record<string, number>;
}

/** 视频状态列表项：新版 id/created_at 与旧版 video_report_id/create_timestamp 同时兼容。 */
export interface FaceReportSummary {
  video_report_id?: string;
  id?: string;
  student_id: string;
  user_name?: string | null;
  create_timestamp?: number;
  created_at?: number | null;
  prominent_dimension?: string;
  top_factor?: string;
  emotions?: Record<string, number>;
  au?: Record<string, VideoAuMetric>;
  dominant_emotion?: string;
  report?: string | null;
  status?: ReportStatus;
  error_message?: string | null;
}

export interface FaceReportDetail extends FaceReportSummary {
  metrics?: VideoMetrics;
  report?: string;
  submitted_at?: number;
}

/** AI 综合报告状态：pending 待生成（预留）/ processing 生成中 / completed 已完成 / failed 生成失败。 */
export type AnalysisStatus = 'pending' | 'processing' | 'completed' | 'failed';

/** AI 综合归档：教师列表用 id/class，旧契约用 seq_id/student_class。 */
export interface AiAnalysis {
  seq_id?: number;
  id?: number;
  student_id?: string;
  student_name: string;
  student_class?: string;
  class?: string;
  student_no?: string | null;
  phone?: string | null;
  text_report_id?: string | null;
  video_report_id?: string | null;
  /** 学生端只含「学生版」正文，教师端为完整正文 */
  ai_content: string;
  status?: AnalysisStatus;
  error_message?: string | null;
  create_timestamp?: number;
  created_at?: number | null;
  finished_at?: number | null;
  teacher_read?: number;
}

/** GET /api/ai/status 的轻量单项：不含正文，供列表轮询。 */
export interface AiAnalysisStatusItem {
  id: number;
  student_id: string;
  student_name: string;
  class: string;
  text_report_id: string;
  video_report_id: string;
  status: AnalysisStatus;
  error_message: string;
  created_at: number | null;
  finished_at: number | null;
  teacher_read: number;
  /** 生成中的粗略剩余秒数，仅用于文案提示 */
  eta_seconds: number;
}

export interface AiAnalysisStatusResponse {
  items: AiAnalysisStatusItem[];
}

/** 教师端综合报告列表项：附带该生文本报告的危机标记。 */
export interface TeacherCompositeItem extends AiAnalysisStatusItem {
  risk?: boolean;
}

export interface TeacherCompositesResponse {
  reports: TeacherCompositeItem[];
  unread: number;
}

export interface AiAnalysisDetailResponse {
  analysis: AiAnalysis;
}

export interface AiAnalysisRetryResponse {
  ok: boolean;
  status: AnalysisStatus;
  id: number;
}

export interface Article {
  id: string;
  title: string;
  summary: string;
  /** 学生端为后端转好的 HTML，教师端为原始编辑文本。 */
  content: string;
  cover?: string;
  source?: string;
  author?: string;
  is_active?: number;
  created_at: number | null;
  updated_at?: number | null;
}

/** 通用分页壳；后端字段名固定为 page/page_size。 */
export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
}

export interface Slot {
  id: string;
  teacher_id: string;
  teacher_name: string;
  date: string;
  time_slot: string;
  start_time?: string | null;
  end_time?: string | null;
  max_capacity: number;
  current_count: number;
  remaining?: number;
  note?: string | null;
  status?: string;
  created_at?: number | null;
}

export interface Appointment {
  id: string;
  teacher_id?: string;
  teacher_name?: string;
  student_id?: string;
  student_name?: string;
  student_class?: string;
  slot_id?: string;
  date: string;
  time_slot: string;
  reason?: string | null;
  /** 响应层映射为 pending/confirmed/rejected/cancelled/done */
  status: string;
  reply?: string | null;
  created_at?: number | null;
  teacher_time?: number | null;
}

export interface Conversation {
  id: string;
  student_id?: string;
  teacher_id?: string;
  student_name?: string;
  teacher_name?: string;
  student_class?: string;
  last_message?: string;
  last_time?: number;
  unread?: number;
  unread_count?: number;
  updated_timestamp?: number;
  create_timestamp?: number;
}

export interface Citation {
  title: string;
  source_id: string;
  source_type?: string;
}

export interface ChatMessage {
  id?: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  citations?: Citation[];
}

/** 素材库条目；upload_time 后端已格式化为本地时间字符串。 */
export interface MaterialItem {
  material_id: string;
  title: string;
  category: string;
  brief?: string;
  file_name: string;
  file_type?: string;
  uploader?: string;
  uploader_name?: string;
  /** 后端列表接口返回格式化字符串，原始表为毫秒时间戳 */
  upload_time?: number | string;
  file_size?: number;
  /** AI 方案生成产物标识：upload=教师上传 / ai=AI 生成 */
  source?: string;
  tags?: string;
}

/** 学生发起倾诉时可选的教师及其所带班级。 */
export interface TeacherClassOption {
  id: string;
  name: string;
  class: string;
  classes: string[];
  class_count: number;
}

/** 后端错误体统一为 { error: string }；ApiError 在 lib/api.ts 中抛给页面。 */
export interface ApiErrorPayload {
  error?: string;
}

export interface TestSubmitResponse {
  /** 提交即建档返回的报告 ID（异步模式下由报告页轮询状态） */
  report_id?: string;
  /** 提交后的报告状态：异步模式下固定为 processing */
  status?: ReportStatus;
  scores: Scl90Scores;
  has_crisis: boolean;
  crisis_message: string;
  /** 旧版同步接口的 AI 正文；异步模式下不再返回，保留字段做兼容。 */
  report?: string;
  /** 兼容旧版直接返回 AI 正文的字段名。 */
  ai_content?: string;
}

/** 测评结果写入 sessionStorage 的结构，供 /test/report 离线渲染。 */
export interface StoredScl90Report extends TestSubmitResponse {
  report_id?: string;
  scenario_name: string;
  submitted_at: number;
  viewer_role: Role;
}

export interface LoginResponse {
  ok: boolean;
  user: User;
}

// ==================== AI 方案生成（素材库 Agent） ====================

export interface MaterialAiParams {
  plan_type: string;
  audience: string;
  styles: string[];
  keywords: string;
  description: string;
  length_preset: 'brief' | 'standard' | 'detailed';
}

export interface RecallPreviewResponse {
  count: number;
  low_match: boolean;
  samples: { title: string; score: number }[];
}

export type MaterialAiTaskStatus =
  | 'queued' | 'recalling' | 'generating' | 'saving'
  | 'completed' | 'failed' | 'cancelled' | 'timeout';

export interface MaterialAiTaskState {
  task_id: string;
  status: MaterialAiTaskStatus;
  progress: number;
  error_message: string | null;
  content: string | null;
  referenced_materials: { material_id: string; title: string; score: number; via: string }[];
  recall_count: number;
  plan_type: string;
  saved_material_id: string | null;
}

export interface RegisterResponse {
  ok: boolean;
  /** 系统自动分配的登录账号（注册规则变更后不再由用户自设）。 */
  account?: string;
  /** 注册手机号：登录凭据。 */
  phone?: string;
  user_id?: string;
  user?: User;
}

export interface ReportsResponse {
  reports: TextReportSummary[];
}

export interface FaceReportsResponse {
  reports: FaceReportSummary[];
}

export interface AnalysesResponse {
  analyses: AiAnalysis[];
}

export interface SlotsResponse {
  slots: Slot[];
}

export interface AppointmentsResponse {
  appointments: Appointment[];
}

export interface ConversationsResponse {
  conversations: Conversation[];
}

export interface ArticlesResponse extends Paged<Article> {
  articles: Article[];
}

/** 请求错误类型由 lib/api.ts 实现，这里仅导出类型供页面按需引用。 */
export type { ApiError } from './api';
