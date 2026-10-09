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

export function statusTone(s) {
  return { 正常: 'ok', 有风险: 'warn', 受阻: 'danger', 已完成: 'done' }[s] || 'idle';
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
