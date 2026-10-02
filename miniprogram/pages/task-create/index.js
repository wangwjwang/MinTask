/**
 * pages/task-create —— 新建任务页（子页面）
 * ---------------------------------------------------------------------------
 * 表单字段对应需求第 5 节 Tab1「新建任务」：
 *   任务名称、描述、所属项目、任务类型、主办人、协办人（可多）、截止时间（必填）
 *
 * 映射到数据模型时有两处需要说明：
 *   「所属项目」→ category（任务分类）。按已确认的决策，看板筛选只用
 *     category 单维度，不额外引入 project 字段。
 *   「主办人」→ leaderId。★ 普通用户固定为自己，只有管理员能选他人
 *     （走 taskService.adminCreate）。因为权限模型里只有主办人能改任务，
 *     让普通用户把主办人设成别人等于当场交出控制权，且没有任何补救入口。
 * ---------------------------------------------------------------------------
 */

const api = require('../../utils/api');
const auth = require('../../utils/auth');
const db = require('../../utils/db');
const toast = require('../../utils/toast');
const { clientToken } = require('../../shared/idempotency');
const C = require('../../shared/constants');
const dates = require('../../shared/dates');

Page({
  data: {
    /** 枚举选项 */
    categoryOptions: C.CATEGORY,
    sourceOptions: C.SOURCE,
    taskTypeOptions: C.TASK_TYPE,
    recurFreqOptions: C.RECUR_FREQ,

    form: {
      task_name: '',
      detail: '',
      category: '',
      source: '',
      task_type: '计划性',
      recur_freq: '不适用',
      recur_rule: '',
      start_date: '',
      due_date: '',
    },

    /** 主办人 */
    leaderId: '',
    leaderName: '',
    /** 主办人候选列表（仅管理员可改主办人时非空），索引与 picker 对齐 */
    leaderCandidates: [],
    /** 是否可改主办人（仅管理员） */
    canPickLeader: false,

    /** 协办人 */
    allMembers: [],
    collaboratorIds: [],
    /** 是否展开协办人选择面板 */
    memberPanelOpen: false,

    /** 截止日期选择器的上限（10 年），避免用户选到离谱的日期 */
    maxDate: '',
    /** 开始日期选择器下限（1 年前），允许补录历史任务 */
    minDate: '',

    submitting: false,
    token: '',
  },

  onLoad() {
    const today = dates.todayStr();
    const tenYears = new Date();
    tenYears.setFullYear(tenYears.getFullYear() + 10);
    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);

    this.setData({
      token: clientToken('tk'),
      maxDate: dates.formatDate(tenYears),
      minDate: dates.formatDate(oneYearAgo),
      'form.start_date': today,
    });

    this.init();
  },

  async init() {
    try {
      const session = await auth.requireClaimed();
      const isAdmin = !!(session.member && session.member.role === '管理员');

      const res = await api.memberApi.listMembers();
      const claimed = (res.list || []).filter((m) => m.openid);

      this.setData({
        leaderId: session.openid,
        leaderName: session.member.name,
        canPickLeader: isAdmin,
        // 管理员可把任务派给别人，候选是全部已认领成员，自己排在最前
        leaderCandidates: claimed.slice().sort((a, b) => {
          if (a.openid === session.openid) return -1;
          if (b.openid === session.openid) return 1;
          return 0;
        }),
        // 自己不能作为自己的协办人，从候选里剔除
        allMembers: claimed.filter((m) => m.openid !== session.openid),
      });
    } catch (e) {
      if (e.code !== 'NEED_CLAIM') this.setData({ allMembers: [] });
    }
  },

  // ── 表单输入 ────────────────────────────────────────────────────────

  onInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ [`form.${field}`]: e.detail.value });
  },

  onEnumChange(e) {
    const { field, value } = e.detail;
    const patch = { [`form.${field}`]: value };
    // 切回「不适用」时清空具体规则，避免留下无意义的残留文本
    if (field === 'recur_freq' && value === '不适用') {
      patch['form.recur_rule'] = '';
    }
    this.setData(patch);
  },

  onStartDateChange(e) {
    this.setData({ 'form.start_date': e.detail.value });
  },

  onDueDateChange(e) {
    this.setData({ 'form.due_date': e.detail.value });
  },

  /** 主办人选择。picker 给的是索引，映射回 openid。 */
  onLeaderChange(e) {
    const idx = Number(e.detail.value);
    const member = this.data.leaderCandidates[idx];
    if (!member) return;
    this.setData({ leaderId: member.openid, leaderName: member.name });
  },

  // ── 协办人选择 ──────────────────────────────────────────────────────

  onToggleMemberPanel() {
    this.setData({ memberPanelOpen: !this.data.memberPanelOpen });
  },

  onToggleMember(e) {
    const openid = e.currentTarget.dataset.openid;
    const list = this.data.collaboratorIds.slice();
    const i = list.indexOf(openid);
    if (i === -1) {
      list.push(openid);
    } else {
      list.splice(i, 1);
    }
    this.setData({ collaboratorIds: list });
  },

  // ── 提交 ────────────────────────────────────────────────────────────

  async onSubmit() {
    const { form, leaderId, collaboratorIds, canPickLeader } = this.data;

    // 前端即时校验给出明确提示，避免用户点了提交才看到错误
    if (!form.task_name.trim()) {
      toast.toast('请填写任务名称');
      return;
    }
    if (!form.category) {
      toast.toast('请选择任务分类');
      return;
    }
    if (!form.source) {
      toast.toast('请选择任务来源');
      return;
    }
    if (!form.due_date) {
      // 需求明确要求：截止时间必填
      toast.toast('请选择计划截止时间');
      return;
    }
    if (form.start_date && dates.compareDateStr(form.start_date, form.due_date) > 0) {
      toast.toast('开始时间不能晚于截止时间');
      return;
    }

    this.setData({ submitting: true });

    // 只提交云端白名单内的字段。leaderId / leader 等由服务端决定，这里不传。
    const task = {
      task_name: form.task_name.trim(),
      detail: form.detail.trim(),
      category: form.category,
      source: form.source,
      task_type: form.task_type,
      recur_freq: form.recur_freq,
      recur_rule: form.recur_rule.trim(),
      start_date: form.start_date,
      due_date: form.due_date,
      collaboratorIds,
    };

    try {
      const myOpenid = auth.currentOpenid();

      // 管理员选了他人当主办人时走 adminCreate，否则走普通 create
      if (canPickLeader && leaderId && leaderId !== myOpenid) {
        await api.taskApi.adminCreate(leaderId, task, this.data.token);
      } else {
        await api.taskApi.create(task, this.data.token);
      }

      toast.success('创建成功');
      setTimeout(() => wx.navigateBack(), 900);
    } catch (e) {
      this.setData({ submitting: false });
      // 失败保留令牌：若实际已写入只是响应丢失，重试会被幂等去重
    }
  },
});
