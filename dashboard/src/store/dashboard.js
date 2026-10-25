import { defineStore } from 'pinia';
import { loadDashboard } from '../api/client';
import { dueInfo, statusBucket, splitCollaborators } from '../utils';

const STAGES = ['未开始', '进行中', '已完成'];
const BUCKETS = ['正常', '逾期', '卡壳', '已完成'];

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
    statusOptions: () => ['全部', ...BUCKETS],
    stageOptions: () => ['全部', ...STAGES],

    filteredTasks() {
      const f = this.filters;
      const q = f.q.trim();
      return this.tasks.filter((t) => {
        if (f.category !== '全部' && t.category !== f.category) return false;
        // 状态筛选按四态互斥口径匹配（与状态分布图、KPI 完全一致）
        if (f.status !== '全部' && statusBucket(t) !== f.status) return false;
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
      // 卡壳/逾期按四态互斥口径数（与状态分布图、状态筛选完全一致）
      const byBucket = (s) => ts.filter((t) => statusBucket(t) === s).length;
      const avg = total ? Math.round(ts.reduce((a, t) => a + (t.progress || 0), 0) / total) : 0;
      return [
        { key: 'total', label: '任务总数', value: total, cls: '' },
        { key: 'doing', label: '进行中', value: byStage('进行中'), cls: 'is-ok' },
        { key: 'done', label: '已完成', value: byStage('已完成'), cls: 'is-ok' },
        { key: 'blocked', label: '卡壳', value: byBucket('卡壳'), cls: 'is-danger' },
        { key: 'overdue', label: '逾期', value: byBucket('逾期'), cls: 'is-danger' },
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

    /**
     * 人员负载聚合：主办 + 协办都算数（与小程序 Tab4 人员看板同口径）。
     * ★ 2026-10-19 修：原来只按 leaderName 聚合，协办任务整段丢失 ——
     *   用户实测"何梦欣只有 3 条已完成，实际 3 主办 + 7 协办、在办 7"。
     * ★ 以 members 名单铺底：全员都上板（没任务显示 0），与小程序一致；
     *   名单外的人名（如"未分配"）作为兜底追加，不会从看板上悄悄消失。
     * ★ 协办人字段是分号分隔的姓名串（task.collaborator），按姓名匹配 ——
     *   与任务列表页的搜索、小程序 person-detail 的展示口径一致。
     */
    peopleAgg() {
      const ts = this.filteredTasks;
      const blank = (name, dept) => ({
        name, dept,
        total: 0, led: 0, joined: 0, doing: 0, done: 0, blocked: 0, overdue: 0, sum: 0,
      });
      const map = new Map();
      this.members.forEach((m) => {
        if (m.name && !map.has(m.name)) map.set(m.name, blank(m.name, m.dept || ''));
      });
      const ensure = (name) => {
        if (!map.has(name)) {
          map.set(name, blank(name, (this.members.find((m) => m.name === name) || {}).dept || ''));
        }
        return map.get(name);
      };
      for (const t of ts) {
        const finished = t.stage === '已完成';
        const bucket = statusBucket(t);
        const leader = t.leaderName || '未分配';
        // 同一任务里身兼主办+协办的只计一次 total（Set 去重），led/joined 各自计数
        const involved = new Set([leader, ...splitCollaborators(t.collaborator)]);
        involved.forEach((name) => {
          if (!name) return;
          const p = ensure(name);
          p.total += 1;
          if (name === leader) p.led += 1; else p.joined += 1;
          if (finished) p.done += 1; else p.doing += 1;
          if (bucket === '卡壳') p.blocked += 1;
          if (bucket === '逾期') p.overdue += 1;
          p.sum += t.progress || 0;
        });
      }
      return Array.from(map.values())
        .map((p) => ({
          ...p,
          open: p.led + p.joined - p.done,
          avg: p.total ? Math.round(p.sum / p.total) : 0,
        }))
        // 在办多的排前面（与小程序人员看板同序：谁最忙一目了然），同量按姓名拼音
        .sort((a, b) => (b.open - a.open) || String(a.name).localeCompare(String(b.name), 'zh'));
    },

    riskList() {
      const ts = this.filteredTasks;
      const out = [];
      for (const t of ts) {
        const di = dueInfo(t.dueDate, t.stage);
        if (t.hasOpenBlocker) out.push({ task: t, reason: `卡壳 ${t.openBlockerCount || 1} 项`, tone: 'danger' });
        else if (di.overdue) out.push({ task: t, reason: di.text, tone: 'danger' });
        else if (di.tone === 'warn') out.push({ task: t, reason: di.text, tone: 'warn' });
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
    // 再次点击当前选中的筛选项 = 取消选择，回到"全部"（分类/状态/阶段/主办各维度通用）
    toggleFilter(key, val) {
      this.filters[key] = this.filters[key] === val ? '全部' : val;
    },
    resetFilters() {
      this.filters = { category: '全部', status: '全部', stage: '全部', leader: '全部', q: '' };
    },
  },
});
