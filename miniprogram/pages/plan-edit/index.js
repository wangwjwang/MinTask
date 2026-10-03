/**
 * pages/plan-edit —— 看一份计划；是自己的（或管理员）才给改
 * ---------------------------------------------------------------------------
 * 带 ?id= 进来，两个入口：pages/plans 的「管理我的计划」，以及**任务看板**
 * 的「周期性计划」那一栏（看板上点开的多半不是自己建的）。
 *
 * ★ 一页两态，判据只有 canEdit（perm.canManageTemplate，与云函数同一个函数）：
 *     能管 → 表单 + 危险区 + 保存按钮；
 *     不能管 → 只读摘要，页面上**不存在**输入控件与按钮。
 *   ★ 只读不是"把表单灰掉"：field-picker / plan-schedule 都没有 disabled
 *     属性，灰掉只会做出一个"看着能点、点了也变"的假象（本地改得动、
 *     提交才被挡）。只读分支里干脆不摆控件。
 *   ★ 前端的 canEdit 只是体验（不显示点了会被拒的东西）；真正的边界是
 *     云函数 update / toggle / delete 里的 assertCanManage。
 *
 * ★ 只提交**改动过的**字段，不做"整份覆盖写回"。
 *   两个理由：
 *   1. 云函数 update 在收到任一排期字段时会把期内偏移整体重算并落库。
 *      整份写回意味着"只改了个说明"也会把偏移写进去 ——
 *      对 2026-10-03 之前建的、只有 deadlineRule 字符串规则的老模板来说，
 *      这等于用默认偏移（1 号—31 号）覆盖掉它原本配好的截止日。
 *   2. patch 越窄，越不容易把界面上没展示的字段（priority / taskType）
 *      悄悄改掉。
 *   因此这里拿"打开时界面显示的样子"当基线，跟当前值逐项比。
 *
 * ★ 基线取的是**界面显示值**而不是数据库里的原始值：
 *   老模板没有 startDay 字段，界面显示的是缺省值 1 号；若拿 undefined 当基线，
 *   光是打开再保存就会判定"排期变了"。基线 = 用户看到的初始状态，才不会有幽灵改动。
 *
 * ★ 权限判据复用 shared/perm.canManageTemplate —— 与云函数同一个函数。
 *   前端拦一道只是别让人白填一屏，真正的闸门在云函数（assertCanManage）。
 * ---------------------------------------------------------------------------
 */

const api = require('../../utils/api');
const auth = require('../../utils/auth');
const fmt = require('../../utils/format');
const toast = require('../../utils/toast');
const C = require('../../shared/constants');
const periodic = require('../../shared/periodic');
const perm = require('../../shared/perm');

const PERIOD_TYPE_VALUES = ['monthly', 'quarterly', 'yearly'];

/** 台账：一份计划摊平成一串可比较的值，用来判断"排期有没有被动过" */
function scheduleKey(type, s) {
  return [type, s.startMonthIdx, s.startDay, s.endMonthIdx, s.endDay].join('|');
}

Page({
  data: {
    loading: true,
    /** 计划不存在（或已被删） */
    notFound: false,
    /** 当前用户能否管这份计划 */
    canEdit: false,

    /**
     * 装饰过的计划（只读分支渲染它）。
     * ★ 排期/本期/任务名这些派生字段由 utils/format.decoratePlan 算 ——
     *   与计划列表页、任务看板是同一份实现，三处显示口径不会各走各的。
     */
    plan: null,
    /** 协办人名单，只读分支用。空/未选都显示「无」 */
    collaboratorText: '',

    categoryOptions: C.CATEGORY,
    sourceOptions: C.SOURCE,

    form: { name: '', detail: '', category: '', source: '' },

    // 排期，结构与 components/plan-schedule 的 properties 对齐
    periodTypeIdx: 0,
    startMonthIdx: 1,
    startDay: 1,
    endMonthIdx: 1,
    endDay: 31,

    /** 启用态。停用后不再自动生成任务，已生成的不动 */
    enabled: true,

    /** 协办人 */
    collaboratorIds: [],
    allMembers: [],
    memberPanelOpen: false,

    /** 主办人姓名，只读展示 */
    ownerName: '',

    submitting: false,
  },

  onLoad(options) {
    this.templateId = (options && options.id) || '';
    // 打开时的界面快照，作为"改了没有"的基线
    this.original = null;
    this.refresh();
  },

  onPullDownRefresh() {
    this.refresh().finally(() => wx.stopPullDownRefresh());
  },

  async refresh() {
    try {
      const session = await auth.requireClaimed();
      const isAdmin = !!(session.member && session.member.role === '管理员');
      this.setData({ loading: true });

      /*
       * 单条读取，不再从列表里翻。
       * ★ 看板上点开的那份计划多半不是自己建的，而 list 对非管理员只返回
       *   自己建的 —— 用 list 当数据源，去看别人的计划会被判成"已被删除"。
       * ★ get 对不存在的 id 返回 null（不抛错）：看板上的名单是几秒前拉的，
       *   点开时刚被别人删掉是正常竞态，不该和"加载失败"混成一句话。
       */
      const res = await api.templateApi.get(this.templateId);
      const t = res.template;

      if (!t) {
        this.setData({ loading: false, notFound: true });
        toast.error('计划不存在或已被删除');
        setTimeout(() => wx.navigateBack(), 1200);
        return;
      }

      const type = periodic.normalizePeriodType(t.periodType) || 'monthly';
      const span = periodic.MONTHS_PER_PERIOD[type];

      // 老模板缺偏移字段：界面显示缺省值，基线也取同一组缺省值（见文件头）
      const shown = {
        periodType: type,
        startMonthIdx: t.startMonthIdx === undefined ? 1 : t.startMonthIdx,
        startDay: t.startDay === undefined ? 1 : t.startDay,
        endMonthIdx: t.endMonthIdx === undefined ? span : t.endMonthIdx,
        endDay: t.endDay === undefined ? 31 : t.endDay,
      };

      const memberRes = await api.memberApi.listMembers();
      // 与新建计划同一口径：管理者（只读）不能被选进来，自己也不当自己的协办
      const claimed = (memberRes.list || []).filter(
        (m) => m.openid && m.role !== C.ROLE.VIEWER
      );
      const collaboratorIds = (t.collaboratorIds || []).slice();

      // 能管才叫「修改计划」；只是来看的，标题别许诺一个改不了的东西
      const canEdit = perm.canManageTemplate(t, session.openid, isAdmin);
      wx.setNavigationBarTitle({ title: canEdit ? '修改计划' : '计划详情' });

      this.setData({
        loading: false,
        notFound: false,
        canEdit,
        plan: fmt.decoratePlan(t),
        // 只读分支要的是"都有谁"，不是"%d 人已选" —— 看的人又不打算改它
        collaboratorText: fmt.collaboratorText((t.collaboratorNames || []).join(';')),
        form: {
          name: t.name || '',
          detail: t.detail || '',
          category: t.category || '',
          source: t.source || '',
        },
        periodTypeIdx: Math.max(0, PERIOD_TYPE_VALUES.indexOf(type)),
        startMonthIdx: shown.startMonthIdx,
        startDay: shown.startDay,
        endMonthIdx: shown.endMonthIdx,
        endDay: shown.endDay,
        enabled: t.enabled !== false,
        ownerName: t.ownerName || '',
        collaboratorIds,
        allMembers: claimed.filter((m) => m.openid !== t.ownerId),
      });

      this.original = {
        name: t.name || '',
        detail: t.detail || '',
        category: t.category || '',
        source: t.source || '',
        schedule: scheduleKey(shown.periodType, shown),
        collaboratorIds: collaboratorIds.slice().sort().join('|'),
      };
    } catch (e) {
      if (e.code !== 'NEED_CLAIM') {
        this.setData({ loading: false });
        // ★ 不能只是 loading:false 收场 —— 界面会显示一份空表单，
        //   用户以为计划被清空了。同页群的 plans / leave / update 遇错都是这句。
        toast.error('加载失败，请下拉重试');
      }
    }
  },

  // ── 表单 ────────────────────────────────────────────────────────────

  onInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ [`form.${field}`]: e.detail.value });
  },

  onEnumChange(e) {
    const { field, value } = e.detail;
    this.setData({ [`form.${field}`]: value });
  },

  /** 排期组件是受控的，把它的载荷原样收下 */
  onPlanScheduleChange(e) {
    this.setData(e.detail);
  },

  /**
   * 展开/收起协办人名单。
   * ★ 只读时必须拦住：面板里是能勾选的，勾完却存不了 ——
   *   让人点了一通再告诉他"你无权保存"，不如一开始就打不开。
   *   WXML 那边这个分支根本不渲染，这里是防脏数据/误调用的一道兜底。
   */
  onToggleMemberPanel() {
    if (!this.data.canEdit) return;
    this.setData({ memberPanelOpen: !this.data.memberPanelOpen });
  },

  onToggleMember(e) {
    const openid = e.currentTarget.dataset.openid;
    const list = this.data.collaboratorIds.slice();
    const i = list.indexOf(openid);
    if (i === -1) list.push(openid);
    else list.splice(i, 1);
    this.setData({ collaboratorIds: list });
  },

  // ── 保存 ────────────────────────────────────────────────────────────

  /**
   * 算出要提交的 patch。没有改动的字段一律不进 patch ——
   * 空 patch 意味着"没有需要更新的字段"，那就干脆别发请求。
   */
  toPatch() {
    const d = this.data;
    const o = this.original;
    const patch = {};

    const name = d.form.name.trim();
    if (name !== o.name) patch.name = name;

    const detail = d.form.detail.trim();
    if (detail !== o.detail) patch.detail = detail;

    if (d.form.category !== o.category) patch.category = d.form.category;
    if (d.form.source !== o.source) patch.source = d.form.source;

    const type = PERIOD_TYPE_VALUES[d.periodTypeIdx] || 'monthly';
    const schedule = { startMonthIdx: d.startMonthIdx, startDay: d.startDay, endMonthIdx: d.endMonthIdx, endDay: d.endDay };
    if (scheduleKey(type, schedule) !== o.schedule) {
      patch.periodType = type;
      patch.startMonthIdx = schedule.startMonthIdx;
      patch.startDay = schedule.startDay;
      patch.endMonthIdx = schedule.endMonthIdx;
      patch.endDay = schedule.endDay;
    }

    if (d.collaboratorIds.slice().sort().join('|') !== o.collaboratorIds) {
      patch.collaboratorIds = d.collaboratorIds;
    }

    return patch;
  },

  async onSave() {
    if (this.data.submitting || !this.data.canEdit) return;

    if (!this.data.form.name.trim()) {
      toast.toast('请填写计划名称');
      return;
    }
    if (!this.data.form.category) {
      toast.toast('请选择任务分类');
      return;
    }
    if (!this.data.form.source) {
      toast.toast('请选择任务来源');
      return;
    }
    // 与云函数同一口径：比期内偏移，不比被"当月没有 31 号"收敛过的绝对日期
    if (
      this.data.startMonthIdx > this.data.endMonthIdx ||
      (this.data.startMonthIdx === this.data.endMonthIdx && this.data.startDay > this.data.endDay)
    ) {
      toast.toast('开始日不能晚于截止日');
      return;
    }

    const patch = this.toPatch();
    if (!Object.keys(patch).length) {
      toast.toast('没有改动');
      return;
    }

    this.setData({ submitting: true });
    try {
      await api.templateApi.update(this.templateId, patch);
      toast.success('已保存');
      setTimeout(() => wx.navigateBack(), 900);
    } catch (e) {
      // 失败保留页面，让人改完再试。错误提示由 api.handleError 统一弹。
      this.setData({ submitting: false });
    }
  },

  // ── 停用 / 启用 ─────────────────────────────────────────────────────

  async onToggle() {
    if (this.data.submitting) return;
    const next = !this.data.enabled;
    try {
      await api.templateApi.toggle(this.templateId);
      /*
       * 本地直接翻转，不重拉列表：toggle 的结果只由服务端决定"翻一下"，
       * 而翻过之后的态我们本来就知道。重拉一次列表会让整页闪一下。
       */
      this.setData({ enabled: next });
      toast.success(next ? '计划已启用' : '计划已停用');
    } catch (e) {
      // 由 api.handleError 统一提示；本地态不动，界面与库里保持一致
    }
  },

  // ── 删除 ────────────────────────────────────────────────────────────

  onDelete() {
    if (this.data.submitting) return;

    wx.showModal({
      title: '删除计划',
      content: `删除「${this.data.form.name}」后不再生成新任务。已经生成的任务会保留。`,
      confirmText: '删除',
      confirmColor: '#DC2626',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await api.templateApi.remove(this.templateId);
          toast.success('计划已删除');
          setTimeout(() => wx.navigateBack(), 900);
        } catch (e) {
          // 同上，提示由 api.handleError 统一弹
        }
      },
    });
  },
});
