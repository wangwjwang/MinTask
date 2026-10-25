/**
 * utils.js — 展示层辅助（与小程序 format.js 同口径：diff<=3 临期，diff<0 逾期）
 */

export function daysFromToday(dueDate) {
  if (!dueDate) return null;
  const d = new Date(String(dueDate).replace(/-/g, '/'));
  if (Number.isNaN(d.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  d.setHours(0, 0, 0, 0);
  return Math.round((d - today) / 86400000);
}

export function dueInfo(dueDate, stage) {
  if (!dueDate) return { text: '未设置', tone: 'idle', overdue: false };
  if (stage === '已完成') return { text: dueDate, tone: 'done', overdue: false };
  const diff = daysFromToday(dueDate);
  if (diff === null) return { text: dueDate, tone: 'idle', overdue: false };
  if (diff < 0) return { text: `逾期 ${Math.abs(diff)} 天`, tone: 'danger', overdue: true };
  if (diff === 0) return { text: '今天到期', tone: 'danger', overdue: false };
  if (diff <= 3) return { text: `${diff} 天后到期`, tone: 'warn', overdue: false };
  return { text: dueDate, tone: 'idle', overdue: false };
}

const PALETTE = ['#2563EB', '#dc2626', '#d97706', '#12a150', '#7c3aed', '#0891b2', '#db2777', '#ca8a04', '#0d9488', '#9333ea'];
export function avatarColor(name) {
  let h = 0;
  for (const c of name || '?') h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

/**
 * 任务状态四态（互斥，四者之和 = 任务总数）：
 *   卡壳 > 已完成 > 逾期 > 正常
 * ★ 判据与小程序看板对齐：卡壳 = 有未解决阻碍项（hasOpenBlocker）；
 *   逾期 = 截止日已过且未完成（dueInfo.overdue，已完成的任务不算逾期）。
 * ★ 为什么不看 status 字段：库里 status 只有 正常/已完成 两种实值
 *   （"受阻/有风险"两条枚举全库 0 条使用），按它分会漏掉真正的卡壳任务
 *   —— 2026-10-19 用户实测"主页卡壳显示 0、实际 2 条"就是这么来的。
 * ★ 优先级：卡壳盖过逾期（既卡壳又逾期只算卡壳，与"风险与临期"列表同序），
 *   已完成盖过逾期（dueInfo 对已完成本就返回不逾期，这里显式再挡一道）。
 * ★ "有风险"不再作为展示态：全库 0 条使用，用户明确"状态只有逾期/卡壳这种类型"。
 */
export function statusBucket(t) {
  if (!t) return '正常';
  if (t.hasOpenBlocker) return '卡壳';
  if (t.stage === '已完成') return '已完成';
  if (dueInfo(t.dueDate, t.stage).overdue) return '逾期';
  return '正常';
}

export function statusTone(s) {
  // 卡壳与逾期同为红色——沿用小程序的设计语言（红＝受阻/逾期，见 theme.js 注释）
  return { 正常: 'ok', 逾期: 'danger', 卡壳: 'danger', 已完成: 'done' }[s] || 'idle';
}
export function stageTone(s) {
  return { 未开始: 'idle', 进行中: 'active', 已完成: 'done' }[s] || 'idle';
}
export function priorityTone(p) {
  return { P0: 'danger', P1: 'warn', P2: 'active', P3: 'idle' }[p] || 'idle';
}
export function splitCollaborators(str) {
  return String(str || '').split(';').map((s) => s.trim()).filter(Boolean);
}
export function fmtDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
