/**
 * pages/task-edit —— 改任务编辑页（子页面）
 * ---------------------------------------------------------------------------
 * 两种能力、两条判据（都取自 shared/perm.js，与云函数同源）：
 *   编辑 —— 仅主办人。可调整任务状态、整体进度%、计划开始/截止时间、
 *           实际完成时间、优先级、任务名称等（需求第 5 节 Tab2 下钻页）。
 *   删除 —— 主办人或管理员。本页底部的独立危险区。
 *
 * ★ 三条前端守则：
 *   1. 进页面先判权限。编辑与删除**分开判**，两者都不满足才挡回去 ——
 *      管理员即使不是主办人也要能进来删（理由见 load() 里的长注释），
 *      但他看不到编辑表单。这只是体验优化，真正的拦截在云函数
 *      taskService.update 的 requireLeaderOf 与 delete 的权限校验。
 *   2. 只提交改动过的字段（dirty 追踪）。云函数虽然有白名单，
 *      但把所有字段无脑提交会覆盖掉期间别处发生的变更（比如别人加了协办人）。
 *   3. 删除有确认框，且在有未保存改动时额外说明改动会一并丢失。
 * ---------------------------------------------------------------------------
 */

const api = require('../../utils/api');
const auth = require('../../utils/auth');
const db = require('../../utils/db');
const fmt = require('../../utils/format');
const theme = require('../../utils/theme');
const toast = require('../../utils/toast');
const C = require('../../shared/constants');
const dates = require('../../shared/dates');
const perm = require('../../shared/perm');

Page({
  data: {
    taskId: '',
    loading: true,
    saving: false,

    /** 原始任务，用于计算 dirty 字段 */
    origin: {},
    form: {},
    /** 被修改过的字段名集合 */
    dirty: {},

    /** 枚举选项 */
    categoryOptions: C.CATEGORY,
    sourceOptions: C.SOURCE,
    taskTypeOptions: C.TASK_TYPE,
    recurFreqOptions: C.RECUR_FREQ,
    statusOptions: C.STATUS,
    stageOptions: C.STAGE,

    /** 协办人 */
    allMembers: [],
    collaboratorIds: [],
    /** 加载时的协办人快照，供「还原」使用 */
    originCollaboratorIds: [],
    memberPanelOpen: false,

    /** 日期选择器范围 */
    minDate: '',
    maxDate: '',

    /**
     * 进度条主色。
     * ★ <slider activeColor> 只吃十六进制字面量，写 var(--primary) 不生效，
     *   所以主色在 utils/theme.js 里另有一份 JS 常量。
     *   改主色时 theme.js 与 app.wxss 必须同改（两处都有注明）。
     */
    primaryColor: theme.PRIMARY,

    /** 语音播报式的变更摘要，保存成功后展示 */
    dirtyCount: 0,

    /**
     * 能否编辑本任务（仅主办人）/ 能否删除本任务（主办人或管理员）。
     * 两个判据都取自 shared/perm.js 与云函数同源，前端不另写规则 ——
     * 理由同本文件顶部的两条守则。canEdit 还用来给管理员分区：
     * 只满足删除的管理员看不到编辑表单。
     */
    canEdit: false,
    canDelete: false,
  },

  onLoad(query) {
    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
    const fiveYears = new Date();
    fiveYears.setFullYear(fiveYears.getFullYear() + 5);

    this.setData({
      taskId: query.taskId || '',
      minDate: dates.formatDate(oneYearAgo),
      maxDate: dates.formatDate(fiveYears),
    });

    this.load();
  },

  async load() {
    try {
      const session = await auth.requireClaimed();

      const task = await db.getDoc(C.COLLECTIONS.TASKS, this.data.taskId);
      if (!task) {
        toast.error('任务不存在或已被删除');
        setTimeout(() => wx.navigateBack(), 1200);
        return;
      }

      /*
       * 本页现在承载两种能力，判据分开算，**不要合成一条**：
       *   编辑 → 仅主办人（canEditTask，云函数 taskService.update 同款）
       *   删除 → 主办人或管理员（canDeleteTask）
       * ★ 为什么必须给管理员留门：perm.canDeleteTask 的注释点名了——历史导入
       *   的任务里 leaderId 为空，没人能"认领"成主办人，管理员是它们唯一的
       *   删除出口。若这里仍按"仅主办人"挡回，那些任务就只能去云控制台手工删，
       *   连带清理进展记录。迁移前这条路径存在于 task-detail（那里没有守则），
       *   搬过来时必须一起搬。
       * ★ 只满足删除的管理员进得来，但看不到编辑表单（WXML 按 canEdit 分区），
       *   否则他会填完一屏再被云函数的 FORBIDDEN_NOT_LEADER 弹回来。
       */
      const canEdit = perm.canEditTask(task, session.openid);
      const canDelete = perm.canDeleteTask(task, session.openid, auth.isAdmin());

      if (!canEdit && !canDelete) {
        toast.error('只有主办人可以修改任务');
        setTimeout(() => wx.navigateBack(), 1200);
        return;
      }

      const res = await api.memberApi.listMembers();
      const claimed = (res.list || []).filter((m) => m.openid && m.openid !== task.leaderId);

      const form = {
        task_name: task.task_name || '',
        detail: task.detail || '',
        category: task.category || '',
        source: task.source || '',
        task_type: task.task_type || '计划性',
        recur_freq: task.recur_freq || '不适用',
        recur_rule: task.recur_rule || '',
        status: task.status || '正常',
        stage: task.stage || '未开始',
        progress: typeof task.progress === 'number' ? task.progress : 0,
        start_date: task.start_date || '',
        due_date: task.due_date || '',
        actualCompleteTime: task.actualCompleteTime || '',
      };

      this.setData({
        loading: false,
        origin: Object.assign({}, form),
        // 单独存一份协办人原始值，供「还原」使用
        originCollaboratorIds: (task.collaboratorIds || []).slice(),
        form,
        collaboratorIds: (task.collaboratorIds || []).slice(),
        allMembers: claimed,
        task: fmt.decorateTask(task),
        // ★ 传入 task 原文档（不是 decorateTask 的产物）—— 判据函数要看
        //   leaderId 与 collaboratorIds，装饰后的对象虽然也带着，但保持
        //   与云函数拿到的是同一个形状更不容易出错。
        canEdit,
        canDelete,
      });
    } catch (e) {
      if (e.code !== 'NEED_CLAIM') {
        this.setData({ loading: false });
      }
    }
  },

  // ── 输入 ────────────────────────────────────────────────────────────

  onInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setField(field, e.detail.value);
  },

  onEnumChange(e) {
    const { field, value } = e.detail;
    const patch = { [`form.${field}`]: value };
    // 切回「不适用」时清空周期规则，避免留下无意义的残留
    if (field === 'recur_freq' && value === '不适用') {
      patch['form.recur_rule'] = '';
    }
    this.setData(patch);
    this.markDirty(field);
    if (field === 'recur_freq') this.markDirty('recur_rule');
  },

  onProgressChange(e) {
    this.setField('progress', Number(e.detail.value));
  },

  onDateChange(e) {
    const field = e.currentTarget.dataset.field;
    this.setField(field, e.detail.value);
  },

  /** 写入表单值并标记为已修改 */
  setField(field, value) {
    this.setData({ [`form.${field}`]: value });
    this.markDirty(field);
  },

  markDirty(field) {
    const dirty = Object.assign({}, this.data.dirty, { [field]: true });
    let count = 0;
    for (const k in dirty) if (dirty[k]) count += 1;
    this.setData({ dirty, dirtyCount: count });
  },

  // ── 协办人 ──────────────────────────────────────────────────────────

  onToggleMemberPanel() {
    this.setData({ memberPanelOpen: !this.data.memberPanelOpen });
  },

  onToggleMember(e) {
    const openid = e.currentTarget.dataset.openid;
    const list = this.data.collaboratorIds.slice();
    const i = list.indexOf(openid);
    if (i === -1) list.push(openid);
    else list.splice(i, 1);
    this.setData({ collaboratorIds: list });
    this.markDirty('collaboratorIds');
  },

  // ── 保存 ────────────────────────────────────────────────────────────

  async onSubmit() {
    const { form, origin, dirty, taskId, collaboratorIds } = this.data;

    if (!form.task_name.trim()) {
      toast.toast('任务名称不能为空');
      return;
    }
    if (form.start_date && form.due_date && dates.compareDateStr(form.start_date, form.due_date) > 0) {
      toast.toast('开始时间不能晚于截止时间');
      return;
    }

    // ★ 只提交改动过的字段。
    //   如果无脑提交全部字段，会覆盖掉编辑期间别处发生的变更
    //   （比如协办人刚在另一台设备上加入了任务，这里一保存就把他抹掉）。
    const patch = {};
    for (const field of Object.keys(dirty)) {
      if (!dirty[field]) continue;
      if (field === 'collaboratorIds') {
        patch.collaboratorIds = collaboratorIds;
      } else {
        patch[field] = form[field];
      }
    }

    if (!Object.keys(patch).length) {
      toast.toast('没有需要保存的修改');
      return;
    }

    this.setData({ saving: true });
    try {
      await api.taskApi.update(taskId, patch);
      toast.success('已保存');
      setTimeout(() => wx.navigateBack(), 800);
    } catch (e) {
      this.setData({ saving: false });
      // FORBIDDEN_NOT_LEADER 等权限错误已由 api.js 统一提示
    }
  },

  onReset() {
    this.setData({
      form: Object.assign({}, this.data.origin),
      collaboratorIds: (this.data.originCollaboratorIds || []).slice(),
      dirty: {},
      dirtyCount: 0,
    });
    toast.toast('已还原为上次保存的内容');
  },

  /**
   * 删除任务（主办人或管理员）。级联删除进展由云函数处理。
   *
   * ★ 从 pages/task-detail 搬来的：那里现在是纯只读页，不该有写操作入口。
   * ★ 本页有「改了还没保存」的状态，删除会把它一起丢掉，所以确认文案要
   *   在那种情况下多说一句 —— 否则用户会以为自己改的东西还在。
   */
  onDelete() {
    const { task, taskId, dirtyCount } = this.data;
    if (!task) return;

    const base = `将永久删除「${task.task_name}」及其全部进展记录，不可恢复。`;
    const extra = dirtyCount ? `\n\n你有 ${dirtyCount} 项改动尚未保存，也会一并丢失。` : '';

    toast
      .confirm(base + extra, '删除任务', '删除')
      .then(async (ok) => {
        if (!ok) return;
        try {
          await toast.withLoading(() => api.taskApi.remove(taskId), '删除中');
          toast.success('已删除');
          setTimeout(() => wx.navigateBack(), 800);
        } catch (e) {
          /* api 层已提示 */
        }
      });
  },
});
