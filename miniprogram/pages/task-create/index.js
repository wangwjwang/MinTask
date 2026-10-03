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
 *
 * ★★ 「任务性质」这一项同时是**模式开关**（2026-10-03 起）：
 *   选「周期性」时，本页建的是一份**计划**（periodic_templates），不是任务 ——
 *   按钮文案变成「创建计划」，时间区从"具体某天"换成"每期几号"。
 *   系统之后在本期开始日自动生成当期任务，任务名形如「2026年10月写报告」。
 *
 *   为什么不做成独立的「新建计划」按钮：用户的心智是"我要建一件周期性的
 *   事"，而不是"我要配置一个模板"。让他先选性质再看到字段变化，比让他在
 *   两个按钮之间猜哪个才是自己想要的，少一次试错。
 * ---------------------------------------------------------------------------
 */

const api = require('../../utils/api');
const auth = require('../../utils/auth');
const db = require('../../utils/db');
const toast = require('../../utils/toast');
const { clientToken } = require('../../shared/idempotency');
const C = require('../../shared/constants');
const dates = require('../../shared/dates');

/**
 * 周期类型 → periodType。选择器与选项文案都在 components/plan-schedule 里，
 * 这里只保留「下标 → 值」这一条映射：提交计划时需要把下标翻译回枚举值。
 */
const PERIOD_TYPE_VALUES = ['monthly', 'quarterly', 'yearly'];

/**
 * 建完计划的提示文案。
 *
 * ★ 服务端在**建完当场**会判一次「本期该不该生成」（与每日巡检同一个
 *   evaluate），四种结果对用户的差别很大，不能一律说「计划已创建」：
 *   建完在列表里看不到任务时，用户唯一的解释渠道就是这句提示 ——
 *   「计划已创建」四个字会让他以为没生效。
 *
 * ★ reason / startDate 都是服务端算好的，这里只翻译成中文，不重算一遍
 *   （重算就会和服务端的判定漂开，而那边才是决定生不生成的）。
 *   新增 reason 时这里会落到兜底那句，不会说错话。
 */
function createdToast(res) {
  if (!res) return '计划已创建';
  if (res.created) return '计划已创建，并生成了本期任务';
  if (res.reason === 'not_started' && res.startDate) {
    return `计划已创建，${dates.friendlyDate(res.startDate)} 起生成第一期`;
  }
  if (res.reason === 'period_expired') return '计划已创建，本期已过，下一期开始日会自动生成';
  return '计划已创建';
}

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

    // ── 计划模式（form.task_type === '周期性'）────────────────────────
    /*
     * 排期（多久一次 + 每期从几号到几号）整块交给 components/plan-schedule，
     * 本页只持有它的**结果**。这里不做任何派生：预览文案、选项列表、
     * 换周期类型时的月份序号收敛，全在组件里算 —— 那套规则要和云函数
     * 保持一致，两处各算一份迟早会漂。
     *
     * ★ 因此本页是排期状态的唯一真源，组件是受控的：组件把用户的选择
     *   通过 change 事件抛上来，本页 setData 回去，提交时直接读 this.data。
     */
    /** 当前是否在建计划 */
    isPlan: false,
    /** 选中的周期类型在 plan-schedule 选项里的下标（0/1/2 = 月/季/年） */
    periodTypeIdx: 0,
    /** 期内偏移，全部从 1 起。月度只用 startDay/endDay，季/年才用得上月份序号 */
    startMonthIdx: 1,
    startDay: 1,
    endMonthIdx: 1,
    endDay: 31,

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
      /*
       * 只保留「能写」的已认领成员。
       * ★ 管理者是只读角色，不该被选成主办/协办 —— 选进去了 TA 也报不了进展，
       *   任务会卡在一个不会动的人手里。云函数侧同样会拒（ctx.assertAssignable），
       *   这里过滤是为了别让人白填一屏才被弹回来。
       */
      const claimed = (res.list || []).filter(
        (m) => m.openid && m.role !== C.ROLE.VIEWER
      );

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
    // 计划模式下 name 会经 plan-schedule 的 property 透进去，任务名预览自动跟着变
    this.setData({ [`form.${field}`]: e.detail.value });
  },

  onEnumChange(e) {
    const { field, value } = e.detail;
    const patch = { [`form.${field}`]: value };
    // 切回「不适用」时清空具体规则，避免留下无意义的残留文本
    if (field === 'recur_freq' && value === '不适用') {
      patch['form.recur_rule'] = '';
    }
    // ★ 「任务性质」同时是模式开关：选周期性 → 本页改为创建一份计划
    if (field === 'task_type') {
      patch.isPlan = value === '周期性';
    }
    this.setData(patch);
    if (field === 'task_type') {
      wx.setNavigationBarTitle({ title: this.data.isPlan ? '新建计划' : '新建任务' });
    }
  },

  /**
   * 排期组件改了选择。
   *
   * 组件是受控的：它只把「用户想要什么」整包抛上来（含换周期类型后的
   * 月份序号收敛），本页原样收下即可 —— 在这里再补一遍校正逻辑，
   * 等于把组件的规则抄了第二份。
   */
  onPlanScheduleChange(e) {
    this.setData(e.detail);
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
    if (this.data.isPlan) return this.onSubmitPlan();

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

  /**
   * 提交计划。
   *
   * ★ 只提交裸名字，前缀由服务端按 periodType 拼 —— 前缀是"多久一次"的表达，
   *   让它和周期类型在同一个地方决定，才不会出现"预览写 2026年10月、
   *   存进去却是每年一次"。
   */
  async onSubmitPlan() {
    const { form, leaderId, collaboratorIds, canPickLeader, periodTypeIdx } = this.data;
    const name = form.task_name.trim();

    if (!name) {
      toast.toast('请填写计划名称');
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

    const plan = {
      name,
      periodType: PERIOD_TYPE_VALUES[periodTypeIdx],
      startMonthIdx: this.data.startMonthIdx,
      startDay: this.data.startDay,
      endMonthIdx: this.data.endMonthIdx,
      endDay: this.data.endDay,
      category: form.category,
      source: form.source,
      detail: form.detail.trim(),
      collaboratorIds,
    };

    // 先后校验与云函数同一口径：比**期内偏移**，不比被"当月没有 31 号"
    // 收敛过的绝对日期 —— 后者会把 2 月的 30 号和 31 号都变成 28 号，比不出大小。
    if (
      plan.startMonthIdx > plan.endMonthIdx ||
      (plan.startMonthIdx === plan.endMonthIdx && plan.startDay > plan.endDay)
    ) {
      toast.toast('开始日不能晚于截止日');
      return;
    }

    const myOpenid = auth.currentOpenid();
    if (canPickLeader && leaderId && leaderId !== myOpenid) {
      plan.ownerId = leaderId;
    }

    this.setData({ submitting: true });
    try {
      const res = await api.templateApi.create(plan);
      // 生成了 / 开始日还没到 / 本期已过，三种结果分别说清楚（见 createdToast）
      toast.success(createdToast(res));
      setTimeout(() => wx.navigateBack(), 1200);
    } catch (e) {
      this.setData({ submitting: false });
    }
  },
});
