/**
 * pages/task-detail —— 任务详情（子页面）
 * ---------------------------------------------------------------------------
 * 三块内容：
 *   1. 任务信息卡（含卡壳高亮、来源、周期标识、截止时间）
 *   2. 进展时间线（最新在前，卡壳条目红色标记 + "标记已解决"）
 *   3. 底部操作栏（按权限显隐：上报进展 / 编辑 / 加入 / 退出 / 删除）
 *
 * ★ 权限显隐一律用 shared/perm.js 的纯函数，与云函数侧同一份代码。
 *   前端隐藏只是体验（不显示点了会被拒的按钮），真正的边界在云函数。
 *   所以这里判断出的 canEdit 为 false 时，按钮不渲染；
 *   即便用户绕过 UI 直接发请求，云函数仍会返回 FORBIDDEN_NOT_LEADER。
 * ---------------------------------------------------------------------------
 */

const api = require('../../utils/api');
const auth = require('../../utils/auth');
const db = require('../../utils/db');
const fmt = require('../../utils/format');
const toast = require('../../utils/toast');
const perm = require('../../shared/perm');
const { COLLECTIONS } = require('../../shared/constants');

Page({
  data: {
    taskId: '',
    task: null,
    loading: true,
    /** 进展记录（已装饰，含 _canResolve / _timeText 等） */
    records: [],
    /** 第一条未解决的卡壳记录 id，用于在顶部提示"去处理" */
    openBlockerCount: 0,

    /** 权限标记，全部由 shared/perm.js 算出 */
    isLeader: false,
    isParticipant: false,
    canEdit: false,
    canJoin: false,
    canLeave: false,
    canReport: false,
    canDelete: false,
    isAdmin: false,

    /** 我自己的 openid —— 判断卡壳记录是否"由我提交" */
    myOpenid: '',
  },

  onLoad(query) {
    api.setClaimHandler(() => auth.gotoClaim(true));
    this.setData({ taskId: query.taskId || '' });
  },

  onShow() {
    // onShow 而非 onLoad：从编辑页/上报页返回时任务与进展都变了，必须重拉
    if (this.data.taskId) this.refresh();
  },

  onPullDownRefresh() {
    this.refresh().finally(() => wx.stopPullDownRefresh());
  },

  // ── 数据 ──────────────────────────────────────────────────────────

  async refresh() {
    try {
      const session = await auth.requireClaimed();
      const { taskId } = this.data;

      const task = await db.getDoc(COLLECTIONS.TASKS, taskId);
      if (!task) {
        toast.error('任务不存在或已被删除');
        setTimeout(() => wx.navigateBack(), 1200);
        return;
      }

      const raw = await db.progressOf(taskId);
      const decorated = fmt.decorateTask(task);
      const records = this.decorateRecords(raw, task, session.openid);

      this.setData({
        myOpenid: session.openid,
        isAdmin: auth.isAdmin(),
        task: decorated,
        records,
        openBlockerCount: records.filter((r) => r.hasBlocker && !r.blockerResolved).length,
        loading: false,
        ...this.computePerms(task, session.openid, auth.isAdmin()),
      });
    } catch (e) {
      if (e.code !== 'NEED_CLAIM') {
        console.error('[task-detail] 加载失败', e);
        this.setData({ loading: false });
        toast.error('加载失败，请下拉重试');
      }
    }
  },

  /**
   * 把权限判定集中到一处，避免散落在 WXML 里写表达式（易与后端口径漂移）。
   * 全部走 shared/perm.js —— 与云函数调用的是同一份函数。
   */
  computePerms(task, openid, isAdmin) {
    return {
      isLeader: perm.isLeader(task, openid),
      isParticipant: perm.isParticipant(task, openid),
      canEdit: perm.canEditTask(task, openid),
      canJoin: perm.canJoin(task, openid),
      canLeave: perm.canLeave(task, openid),
      canReport: perm.canAddProgress(task, openid),
      canDelete: perm.canDeleteTask(task, openid, isAdmin),
    };
  },

  /**
   * 装饰进展记录。
   * ★ 逐条调用 perm.canResolveBlocker —— "主办人 or 本条提交人"是每条记录
   *   各自不同，不能像任务级权限那样算一次就完事。
   */
  decorateRecords(records, task, openid) {
    return (records || []).map((r) => {
      const hasBlocker = !!r.hasBlocker;
      return Object.assign({}, r, {
        _timeText: fmt.timeAgo(r.updatedAt || r.createdAt),
        _fullTime: fmt.fullTime(r.updatedAt || r.createdAt),
        _hasBlocker: hasBlocker,
        _resolved: hasBlocker && r.blockerResolved === true,
        // 未解决的卡壳才显示"标记已解决"按钮
        _canResolve: hasBlocker && r.blockerResolved !== true && perm.canResolveBlocker(task, r, openid),
        _isMine: r.updaterId === openid,
      });
    });
  },

  // ── 操作 ──────────────────────────────────────────────────────────

  onReport() {
    wx.navigateTo({ url: `/pages/progress-add/index?taskId=${this.data.taskId}` });
  },

  onEdit() {
    wx.navigateTo({ url: `/pages/task-edit/index?taskId=${this.data.taskId}` });
  },

  /** 跳转到该主办人的任务列表 */
  onLeaderTap() {
    const task = this.data.task;
    if (!task || !task.leaderId) return;
    wx.navigateTo({
      url: `/pages/person-detail/index?openid=${task.leaderId}&name=${encodeURIComponent(task.leader || '')}`,
    });
  },

  onJoin() {
    toast.confirm('加入后你将成为该任务的协办人，可以上报进展。', '确认加入').then(async (ok) => {
      if (!ok) return;
      try {
        await toast.withLoading(() => api.taskApi.join(this.data.taskId), '加入中');
        toast.success('已加入协办');
        this.refresh();
      } catch (e) {
        /* api 层已提示 */
      }
    });
  },

  onLeave() {
    toast.confirm('退出后将不再出现在协办名单里，历史进展不受影响。', '确认退出', '退出').then(async (ok) => {
      if (!ok) return;
      try {
        await toast.withLoading(() => api.taskApi.leave(this.data.taskId), '处理中');
        toast.success('已退出协办');
        this.refresh();
      } catch (e) {
        /* api 层已提示 */
      }
    });
  },

  /** 标记某条卡壳为已解决 */
  onResolveBlocker(e) {
    const recordId = e.currentTarget.dataset.id;
    if (!recordId) return;

    toast.confirm('确认这个问题已经解决？', '标记卡壳已解决', '已解决').then(async (ok) => {
      if (!ok) return;
      try {
        await toast.withLoading(
          () => api.progressApi.resolveBlocker(recordId),
          '处理中'
        );
        toast.success('已标记解决');
        this.refresh();
      } catch (e) {
        /* api 层已提示 */
      }
    });
  },

  /** 删除任务（主办人或管理员）。级联删除进展由云函数处理。 */
  onDelete() {
    const task = this.data.task;
    toast
      .confirm(
        `将永久删除「${task.task_name}」及其全部进展记录，不可恢复。`,
        '删除任务',
        '删除'
      )
      .then(async (ok) => {
        if (!ok) return;
        try {
          await toast.withLoading(() => api.taskApi.remove(this.data.taskId), '删除中');
          toast.success('已删除');
          setTimeout(() => wx.navigateBack(), 800);
        } catch (e) {
          /* api 层已提示 */
        }
      });
  },

  /** 长按任务名复制，方便在群里同步 */
  onCopyTaskName() {
    const task = this.data.task;
    if (!task) return;
    wx.setClipboardData({
      data: `${task.task_name}（主办：${task.leader || '—'}｜截止：${task.due_date || '未设置'}）`,
    });
  },
});
