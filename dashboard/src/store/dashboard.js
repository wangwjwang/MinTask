import { defineStore } from 'pinia';
import { loadDashboard } from '../api/client';
import { dueInfo } from '../utils';

const STAGES = ['未开始', '进行中', '已完成'];
const STATUSES = ['正常', '有风险', '受阻', '已完成'];

export const useStore = defineStore('dashboard', {
  state: () => ({
    data: null,
    passcode: localStorage.getItem('tp-passcode') || '',
    loading: false,
    error: '',
    lastSync: '',
    filters: {
      category: '全部',
      status: '全部',
      stage: '全部',
      leader: '全部',
      q: '',
    },
  }),

  getters: {
    isAuthed: (s) => !!s.passcode,
    members: (s) => (s.data ? s.data.members : []),
    tasks: (s) => (s.data ? s.data.tasks : []),

    categories() {
      const set = new Set(this.tasks.map((t) => t.category));
      return ['全部', ...Array.from(set)];
    },
    leaders() {
      const set = new Set(this.tasks.map((t) => t.leaderName).filter(Boolean));
      return ['全部', ...Array.from(set).sort()];
    },
    statusOptions: () => ['全部', ...STATUSES],
    stageOptions: () => ['全部', ...STAGES],

    filteredTasks() {
      const f = this.filters;
      const q = f.q.trim();
      return this.tasks.filter((t) => {
        if (f.category !== '全部' && t.category !== f.category) return false;
        if (f.status !== '全部' && t.status !== f.status) return false;
        if (f.stage !== '全部' && t.stage !== f.stage) return false;
        if (f.leader !== '全部' && t.leaderName !== f.leader) return false;
        if (q) {
          const hay = `${t.name} ${t.leaderName} ${t.collaborator} ${t.category}`.toLowerCase();
          if (!hay.includes(q.toLowerCase())) return false;
        }
        return true;
      });
    },

    kpis() {
      const ts = this.filteredTasks;
      const total = ts.length;
      const byStage = (s) => ts.filter((t) => t.stage === s).length;
      const byStatus = (s) => ts.filter((t) => t.status === s).length;
      const overdue = ts.filter((t) => dueInfo(t.dueDate, t.stage).overdue).length;
      const avg = total ? Math.round(ts.reduce((a, t) => a + (t.progress || 0), 0) / total) : 0;
      return [
        { key: 'total', label: '任务总数', value: total, cls: '' },
        { key: 'doing', label: '进行中', value: byStage('进行中'), cls: 'is-ok' },
        { key: 'done', label: '已完成', value: byStage('已完成'), cls: 'is-ok' },
        { key: 'risk', label: '有风险', value: byStatus('有风险'), cls: 'is-warn' },
        { key: 'blocked', label: '受阻', value: byStatus('受阻'), cls: 'is-danger' },
        { key: 'overdue', label: '逾期', value: overdue, cls: 'is-danger' },
        { key: 'rate', label: '整体完成率', value: avg + '%', cls: '' },
      ];
    },

    boardColumns() {
      const ts = this.filteredTasks;
      return STAGES.map((stage) => ({
        stage,
        tasks: ts
          .filter((t) => t.stage === stage)
          .sort((a, b) => (b.hasOpenBlocker ? 1 : 0) - (a.hasOpenBlocker ? 1 : 0)),
        count: ts.filter((t) => t.stage === stage).length,
      }));
    },

    peopleAgg() {
      const ts = this.filteredTasks;
      const map = new Map();
      for (const t of ts) {
        const name = t.leaderName || '未分配';
        if (!map.has(name)) {
          map.set(name, {
            name,
            dept: (this.members.find((m) => m.name === name) || {}).dept || '',
            total: 0, doing: 0, done: 0, risk: 0, blocked: 0, blockers: 0, sum: 0,
          });
        }
        const p = map.get(name);
        p.total += 1;
        if (t.stage === '进行中') p.doing += 1;
        if (t.stage === '已完成') p.done += 1;
        if (t.status === '有风险') p.risk += 1;
        if (t.status === '受阻') p.blocked += 1;
        if (t.hasOpenBlocker) p.blockers += 1;
        p.sum += t.progress || 0;
      }
      return Array.from(map.values()).map((p) => ({
        ...p,
        avg: p.total ? Math.round(p.sum / p.total) : 0,
      }));
    },

    riskList() {
      const ts = this.filteredTasks;
      const out = [];
      for (const t of ts) {
        const di = dueInfo(t.dueDate, t.stage);
        if (t.hasOpenBlocker) out.push({ task: t, reason: `卡壳 ${t.openBlockerCount || 1} 项`, tone: 'danger' });
        else if (di.overdue) out.push({ task: t, reason: di.text, tone: 'danger' });
        else if (di.tone === 'warn') out.push({ task: t, reason: di.text, tone: 'warn' });
        else if (t.status === '有风险') out.push({ task: t, reason: '有风险', tone: 'warn' });
      }
      const rank = { danger: 0, warn: 1 };
      return out.sort((a, b) => rank[a.tone] - rank[b.tone]);
    },
  },

  actions: {
    async login(passcode) {
      this.passcode = passcode;
      localStorage.setItem('tp-passcode', passcode);
      await this.refresh();
    },
    async refresh() {
      this.loading = true;
      this.error = '';
      try {
        this.data = await loadDashboard(this.passcode);
        this.lastSync = new Date().toLocaleString('zh-CN');
      } catch (e) {
        this.error = e.message || '加载失败';
      } finally {
        this.loading = false;
      }
    },
    logout() {
      this.passcode = '';
      localStorage.removeItem('tp-passcode');
    },
    setFilter(key, val) {
      this.filters[key] = val;
    },
    resetFilters() {
      this.filters = { category: '全部', status: '全部', stage: '全部', leader: '全部', q: '' };
    },
  },
});
