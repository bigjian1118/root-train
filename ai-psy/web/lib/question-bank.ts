// 题库加载与兜底：题库 JSON 只负责“场景化题干”，计分仍走 scoring.ts 的标准因子映射。
// 网络失败或场景缺失时回退到标准 90 题，保证测评流程不被数据问题阻断。

import { FACTOR_MAP } from './scoring';
import type { Scenario, Scl90Question } from './types';

export interface QuestionBankScenario {
  name: string;
  questions: Scl90Question[];
}

export type QuestionBank = Record<string, QuestionBankScenario>;

/** /api/config 不可用时的内置场景（名称/描述与后端 prompt.py 对齐）。 */
export const DEFAULT_SCENARIOS: Scenario[] = [
  { key: 'primary_student', name: '小学生', desc: '适合 6-12 岁在读小学生，语言简单亲切' },
  { key: 'junior_student', name: '中学生', desc: '适合 12-18 岁在读中学生，关注学业、友谊与青春期困扰' },
  { key: 'college_student', name: '大学生', desc: '适合高校在读学生，关注学业、人际与未来压力' },
];

const QUESTION_TEXT: Record<number, string> = {
  1: '头痛',
  2: '神经过敏，心中不踏实',
  3: '头脑中有不必要的想法或字句盘旋',
  4: '头昏或昏倒',
  5: '对异性的兴趣减退',
  6: '对旁人责备求全',
  7: '感到别人能控制您的思想',
  8: '责怪别人制造麻烦',
  9: '忘性大',
  10: '担心自己的衣饰整齐及仪态的端正',
  11: '容易烦恼和激动',
  12: '胸痛',
  13: '害怕空旷的场所或街道',
  14: '感到自己的精力下降，活动减慢',
  15: '想结束自己的生命',
  16: '听到旁人听不到的声音',
  17: '发抖',
  18: '感到大多数人都不可信任',
  19: '胃口不好',
  20: '容易哭泣',
  21: '同异性相处时感到害羞不自在',
  22: '感到受骗、中了圈套或有人想抓住您',
  23: '无缘无故地突然感到害怕',
  24: '自己不能控制地大发脾气',
  25: '怕单独出门',
  26: '经常责怪自己',
  27: '腰痛',
  28: '感到难以完成任务',
  29: '感到孤独',
  30: '感到苦闷',
  31: '过分担忧',
  32: '对事物不感兴趣',
  33: '感到害怕',
  34: '您的感情容易受到伤害',
  35: '旁人能知道您的私下想法',
  36: '感到别人不理解您、不同情您',
  37: '感到人们对您不友好、不喜欢您',
  38: '做事必须做得很慢以保证做得正确',
  39: '心跳得很厉害',
  40: '恶心或胃部不舒服',
  41: '感到比不上他人',
  42: '肌肉酸痛',
  43: '感到有人在监视您、谈论您',
  44: '难以入睡',
  45: '做事必须反复检查',
  46: '难以做出决定',
  47: '怕乘电车、公共汽车、地铁或火车',
  48: '呼吸有困难',
  49: '一阵阵发冷或发热',
  50: '因为感到害怕而避开某些东西、场合或活动',
  51: '脑子变空了',
  52: '身体发麻或刺痛',
  53: '喉咙有梗塞感',
  54: '感到前途没有希望',
  55: '不能集中注意力',
  56: '感到身体的某一部分软弱无力',
  57: '感到紧张或容易紧张',
  58: '感到手或脚发重',
  59: '想到死亡的事',
  60: '吃得太多',
  61: '当别人看着您或谈论您时感到不自在',
  62: '有一些不属于您自己的想法',
  63: '有想打人或伤害他人的冲动',
  64: '醒得太早',
  65: '必须反复洗手、点数目或触摸某些东西',
  66: '睡得不稳不深',
  67: '有想摔坏或破坏东西的冲动',
  68: '有一些别人没有的想法或念头',
  69: '感到对别人神经过敏',
  70: '在商店或电影院等人多的地方感到不自在',
  71: '感到任何事情都很困难',
  72: '一阵阵恐惧或惊恐',
  73: '感到在公共场合吃东西很不舒服',
  74: '经常与人争论',
  75: '单独一人时神经很紧张',
  76: '别人对您的成绩没有做出恰当的评价',
  77: '即使和别人在一起也感到孤单',
  78: '感到坐立不安心神不定',
  79: '感到自己没有什么价值',
  80: '感到熟悉的东西变成陌生或不像是真的',
  81: '大叫或摔东西',
  82: '害怕会在公共场合晕倒',
  83: '感到别人想占您的便宜',
  84: '为一些有关「性」的想法而很苦恼',
  85: '您认为应该因为自己的过错而受到惩罚',
  86: '感到要赶快把事情做完',
  87: '感到自己的身体有严重问题',
  88: '从未感到和其他人很亲近',
  89: '感到自己有罪',
  90: '感到自己的脑子有毛病',
};

const QUESTION_FACTOR: Record<number, string> = {};
Object.entries(FACTOR_MAP).forEach(([factor, ids]) => {
  ids.forEach((id) => {
    QUESTION_FACTOR[id] = factor;
  });
});

/** 标准 90 题兜底题库；题号顺序固定。 */
export const STANDARD_QUESTIONS: Scl90Question[] = Object.entries(QUESTION_TEXT)
  .map(([key, question]) => ({
    id: Number(key),
    factor: QUESTION_FACTOR[Number(key)] ?? '其他',
    question,
  }))
  .sort((a, b) => a.id - b.id);

export async function loadQuestionBank(): Promise<QuestionBank> {
  const response = await fetch('/data/question_bank.json', { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`题库加载失败（${response.status}）`);
  }
  return (await response.json()) as QuestionBank;
}

/** 取场景题目；题目数量不足 90 时视为脏数据并回退标准题。 */
export function resolveScenarioQuestions(
  bank: QuestionBank | undefined,
  scenarioKey: string,
): { name: string; questions: Scl90Question[] } {
  const scene = bank?.[scenarioKey];
  if (scene && Array.isArray(scene.questions) && scene.questions.length >= 90) {
    return {
      name: scene.name || DEFAULT_SCENARIOS.find((item) => item.key === scenarioKey)?.name || '心理测评',
      questions: scene.questions.slice(0, 90),
    };
  }
  return {
    name: DEFAULT_SCENARIOS.find((item) => item.key === scenarioKey)?.name || '心理测评',
    questions: STANDARD_QUESTIONS,
  };
}
