/**
 * pages/demand-edit —— 新建需求 / 看一条需求（是自己的才给改）
 * ---------------------------------------------------------------------------
 * 两个入口：
 *   不带 ?id=  → 新建需求（所有非只读成员都能建，含「管理者」）
 *   带 ?id=xxx → 看改一体，照 pages/plan-edit 的先例
 *
 * ★ 一页两态，判据只有 canEdit（perm.canEditDemand，与云函数同一个函数）：
 *     能改 → 表单 + 危险区（关闭 / 重新打开）+ 保存按钮；
 *     不能改 → 只读摘要，页面上**不存在**输入控件与按钮。
 *   ★ 只读不是"把表单灰掉"：input / picker 灰掉只会做出一个"看着能点、
 *     点了也变"的假象。只读分支里干脆不摆控件。
 *   ★ 前端的 canEdit 只是体验（不显示点了会被拒的东西）；真正的边界是
 *     云函数 update / close / reopen 里的 assertCanEdit。
 *
 * ★ 管理者能进这一页的"能改"分支，这是本次唯一放开的地方：他作为提出人时
 *   canEditDemand 的 proposerId 那一项已经为真，perm.js 里没有任何角色特判。
 *
 * ★ 只提交**改动过的**字段，不做整份覆盖写回。patch 越窄，越不容易把界面上
 *   没展示的字段（status / claimedBy* / closedBy*）悄悄改掉。
 *   基线取的是**界面显示值**（不是库里的原始值），打开再保存不会判定成"改过了"。
 * ---------------------------------------------------------------------------
 */

const api = require('../../utils/api');
const auth = require('../../utils/auth');
const fmt = require('../../utils/format');
const toast = require('../../utils/toast');
const dates = require('../../shared/dates');
const C = require('../../shared/constants');
const perm = require('../../shared/perm');

Page({
  data: {
    loading: true,
    /** 不带 id 进来 = 新建 */
    isNew: true,
    /** 需求不存在（或已被删） */
    notFound: false,
    /** 当前用户能否处置这条需求 */
    canEdit: true,
    /** 当前状态（危险区按它切换「关闭」/「重新打开」） */
    status: '',

    form: {
      title: '',
      detail: '',
      contactDept: '',
      contactName: '',
      expectDate: '',
    },
    /** 关闭原因，危险区那个输入框 */
    closeReason: '',
    /** 已关闭时的关闭信息（只读展示用） */
    closedText: '',

    /** 只读分支要用的装饰字段（与需求卡同一口径，来自 fmt.decorateDemand） */
    _statusTone: 'idle',
    _statusText: '',
    _contactText: '',
    _expectText: '',
    proposerName: '',

    /** 关联任务（只读，两个分支都渲染） */
    tasks: [],

    /** 日期选择器的上限（10 年） */
    maxDate: '',
    minDate: '',

    submitting: false,
  },

  onLoad(options) {
    this.demandId = (options && options.id) || '';
    this.original = null;

    const tenYears = new Date();
    tenYears.setFullYear(tenYears.getFullYear() + 10);
    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
    this.setData({
      isNew: !this.demandId,
      // 日期格式化走 shared/dates.js（format.js 不管日期），与 task-edit 同款
      maxDate: dates.formatDate(tenYears),
      minDate: dates.formatDate(oneYearAgo),
    });
    wx.setNavigationBarTitle({ title: this.demandId ? '需求' : '新建需求' });

    this.refresh();
  },

  onPullDownRefresh() {
    this.refresh().finally(() => wx.stopPullDownRefresh());
  },

  async refresh() {
    try {
      const session = await auth.requireClaimed();
      const isAdmin = !!(session.member && session.member.role === C.ROLE.ADMIN);

      if (!this.demandId) {
        // 新建：不拉数据，canEdit 恒为真（所有非只读成员都能建需求）
        this.setData({ loading: false });
        return;
      }

      this.setData({ loading: true });
      const res = await api.demandApi.get(this.demandId);
      const d = res.demand;

      /*
       * get 对不存在的 id 返回 null（不抛错）：列表是几秒前拉的，
       * 点开时刚被别人删掉是正常竞态，不该和"加载失败"混成一句话。
       */
      if (!d) {
        this.setData({ loading: false, notFound: true });
        toast.error('需求不存在或已被删除');
        setTimeout(() => wx.navigateBack(), 1200);
        return;
      }

      const form = {
        title: d.title || '',
        detail: d.detail || '',
        contactDept: d.contactDept || '',
        contactName: d.contactName || '',
        expectDate: d.expectDate || '',
      };
      // 权限判据复用 perm.canEditDemand —— 与云函数同一个函数
      const canEdit = perm.canEditDemand(d, session.openid, isAdmin);
      const decorated = fmt.decorateDemand(d);

      this.setData({
        loading: false,
        notFound: false,
        canEdit,
        status: d.status || '',
        form,
        closeReason: '',
        closedText: d.status === '已关闭'
          ? `${d.closedByName || '有人'} 关闭${d.closeReason ? ` · ${d.closeReason}` : ''}`
          : '',
        // 只读分支与需求卡共用同一份装饰结果，两处口径不会漂
        _statusTone: decorated._statusTone,
        _statusText: decorated._statusText,
        _contactText: decorated._contactText,
        _expectText: decorated._expectText,
        proposerName: d.proposerName || '',
        // 关联任务是只读信息，两个分支都渲染 —— 提出人恰恰是最想知道
        // "我提的后来怎么样了"的人，只读分支才有就等于把他排除在外了
        tasks: fmt.decorateTasks(res.tasks || []),
      });

      /*
       * ★ 基线必须是 form 的**副本**。
       *   setData 是按引用把对象挂进 this.data 的（点号路径 setData 会就地改它），
       *   直接 `this.original = form` 会让基线跟着表单一起变 ——
       *   改一个字段后再 toPatch()，比出来是"没改过"，用户点什么都不会被保存。
       */
      this.original = Object.assign({}, form);
    } catch (e) {
      if (e.code !== 'NEED_CLAIM') {
        this.setData({ loading: false });
        // 不能只是 loading:false 收场 —— 界面会显示一份空表单，用户以为需求被清空了
        toast.error('加载失败，请下拉重试');
      }
    }
  },

  // ── 表单 ────────────────────────────────────────────────────────────

  onInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ [`form.${field}`]: e.detail.value });
  },

  onExpectDateChange(e) {
    this.setData({ 'form.expectDate': e.detail.value });
  },

  onCloseReasonInput(e) {
    this.setData({ closeReason: e.detail.value });
  },

  /** 只提交改动过的字段；没有改动就返回空对象 */
  toPatch() {
    const o = this.original || {};
    const patch = {};
    Object.keys(this.data.form).forEach((k) => {
      const next = String(this.data.form[k] || '').trim();
      if (next !== String(o[k] || '')) patch[k] = next;
    });
    return patch;
  },

  // ── 保存 / 新建 ─────────────────────────────────────────────────────

  async onSave() {
    if (this.data.submitting || !this.data.canEdit) return;

    const title = String(this.data.form.title || '').trim();
    if (!title) {
      toast.toast('请填写需求标题');
      return;
    }

    this.setData({ submitting: true });

    try {
      if (this.data.isNew) {
        await api.demandApi.create(Object.assign({}, this.data.form, { title }));
        toast.success('需求已提交，等着有人认领');
        setTimeout(() => wx.navigateBack(), 900);
        return;
      }

      const patch = this.toPatch();
      if (!Object.keys(patch).length) {
        toast.toast('没有改动');
        this.setData({ submitting: false });
        return;
      }
      await api.demandApi.update(this.demandId, patch);
      toast.success('已保存');
      setTimeout(() => wx.navigateBack(), 900);
    } catch (e) {
      // 失败保留页面，让人改完再试。提示由 api.handleError 统一弹。
      this.setData({ submitting: false });
    }
  },

  // ── 关闭 / 重新打开 ─────────────────────────────────────────────────

  onClose() {
    if (this.data.submitting) return;
    wx.showModal({
      title: '关闭需求',
      content: `关闭「${this.data.form.title}」表示这件事不做了。关闭后仍可以重新打开。`,
      confirmText: '关闭',
      confirmColor: '#DC2626',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await api.demandApi.close(this.demandId, this.data.closeReason);
          toast.success('需求已关闭');
          setTimeout(() => wx.navigateBack(), 900);
        } catch (e) {
          // 提示由 api.handleError 统一弹
        }
      },
    });
  },

  /**
   * 重新打开。★ 不把本地状态猜成「待认领」——
   * 服务端会按关联任务重算（有未完成任务的回「已领走」），
   * 用它的返回值更新界面，两边才不会各说各话。
   */
  onReopen() {
    if (this.data.submitting) return;
    this.setData({ submitting: true });
    api.demandApi
      .reopen(this.demandId)
      .then((r) => {
        toast.success('需求已重新打开');
        this.setData({ submitting: false, status: r.status });
        setTimeout(() => wx.navigateBack(), 900);
      })
      .catch(() => {
        this.setData({ submitting: false });
      });
  },

  // ── 关联任务 ────────────────────────────────────────────────────────

  onTaskTap(e) {
    const task = e.detail.task;
    if (!task || !task._id) return;
    wx.navigateTo({ url: `/pages/task-detail/index?taskId=${task._id}` });
  },
});
