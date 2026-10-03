/**
 * pages/progress-add —— 上报进展（子页面）
 * ---------------------------------------------------------------------------
 * 流程：填写进展 → 提交 → progressService.addRecord 落库 + 重算卡壳。
 *
 * ★ 两条硬性约束（需求第 6.6 节、第 10.3 节）★
 *
 * 1. 「协办人界面与后端均禁止出现进度%和状态编辑入口」
 *    本页用 canEditProgressFields 控制整个"进度与状态"区块的 wx:if。
 *    但这只是体验层 —— 真正的拦截在 progressService.addRecord：
 *    协办人若构造请求携带 progress/status/stage，会收到 FORBIDDEN_FIELD。
 *    前端隐藏不等于安全，两层都要有。
 *
 * 2. 「允许用户直接手动输入并提交，不得因任何外部依赖失败而阻断录入」
 *    本页**完全自包含**：没有语音插件、没有 AI、没有网络以外的依赖。
 *    唯一的输入方式是 textarea，唯一的提交动作是调云函数。
 *    提交失败时保留幂等令牌，重试不会产生重复记录（见 onSubmit）。
 *
 * ★ 语音录入为什么没有了：
 *   需求原方案是接微信同声传译插件，后决定取消 ——
 *   手机自带输入法在 textarea 里就能语音转文字，插件是多余的。
 *   这也顺带免掉了插件授权与麦克风隐私声明两道部署工序。
 *   详见 config.js 末尾的说明。不要重新引入 WechatSI。
 * ---------------------------------------------------------------------------
 */

const api = require('../../utils/api');
const auth = require('../../utils/auth');
const db = require('../../utils/db');
const fmt = require('../../utils/format');
const theme = require('../../utils/theme');
const toast = require('../../utils/toast');
const { clientToken } = require('../../shared/idempotency');
const { STATUS, STAGE, COLLECTIONS } = require('../../shared/constants');
const perm = require('../../shared/perm');
const config = require('../../config');

Page({
  data: {
    taskId: '',
    task: null,
    loading: true,

    /** 当前用户是否该任务的主办人 —— 决定是否渲染进度/状态区块 */
    isLeader: false,

    /** 表单 */
    description: '',
    blocker: '',
    needSupport: '',

    /** 主办人专属字段 */
    progress: 0,
    status: '',
    stage: '',

    /**
     * 进度条主色。
     * ★ <slider activeColor> 只吃十六进制字面量，写 var(--primary) 不生效，
     *   所以主色在 utils/theme.js 里另有一份 JS 常量。
     *   改主色时 theme.js 与 app.wxss 必须同改（两处都有注明）。
     */
    primaryColor: theme.PRIMARY,

    /** 枚举选项（供 picker 使用） */
    statusOptions: STATUS,
    stageOptions: STAGE,
    showAiButton: config.showAiButton,

    /** AI 精简状态 */
    aiBusy: false,

    /**
     * 描述框当前内容是否**已经精简过**。
     *
     * ★ 为什么要有它：一次成功精简要花一次 DeepSeek 调用。用户看到结果后
     *   顺手再点一下（怀疑没生效、或者手快），内容已是精简后的文本，
     *   再送一次纯属白烧 token。
     *
     * 置 true：精简成功时。置 false：用户再改一次描述框时。
     * ★ 失败的**不置 true** —— 失败时输入框内容一个字没变，重试是合理动作；
     *   锁住的话一次网络抖动就要用户先随便改个字才能重试。
     */
    aiLocked: false,

    submitting: false,
    /** 幂等令牌。提交成功后才换新的，防止连点/重试产生重复进展 */
    token: '',
  },

  onLoad(query) {
    const taskId = query.taskId || '';
    this.setData({
      taskId,
      token: clientToken('pr'),
    });
    this.load(taskId);
  },

  onUnload() {
    toast.resetLoading();
  },

  /** 加载任务并判定权限 */
  async load(taskId) {
    try {
      const session = await auth.requireClaimed();

      const task = await db.getDoc(COLLECTIONS.TASKS, taskId);
      if (!task) {
        toast.error('任务不存在或已被删除');
        setTimeout(() => wx.navigateBack(), 1200);
        return;
      }

      // 非参与者直接挡回去。云函数侧也会拦，这里只是避免用户白填一遍。
      if (!perm.isParticipant(task, session.openid)) {
        toast.error('你不是该任务的主办人或协办人');
        setTimeout(() => wx.navigateBack(), 1200);
        return;
      }

      const isLeader = perm.isLeader(task, session.openid);

      this.setData({
        task: fmt.decorateTask(task),
        isLeader,
        // 主办人初始值取任务当前状态，协办人这几个字段根本不渲染
        progress: isLeader ? task.progress || 0 : 0,
        status: isLeader ? task.status : '',
        stage: isLeader ? task.stage : '',
        loading: false,
      });

      wx.setNavigationBarTitle({
        title: isLeader ? '上报进展（主办）' : '上报进展（协办）',
      });
    } catch (e) {
      if (e.code !== 'NEED_CLAIM') {
        this.setData({ loading: false });
      }
    }
  },

  // ── AI 精简 ─────────────────────────────────────────────────────────

  /**
   * AI 精简。默认关闭，callAI 返回 aiApplied:false 时只提示原因，不阻断。
   * ★ callAI 云函数在任何异常下都返回原文，从不抛错，所以这里的内容永远可用。
   * ★ 成功后置 aiLocked，按钮变灰直到用户再改描述 —— 见 data.aiLocked 的说明。
   * ★ 任务一起发过去：AI 看不到页面，不知道在整理哪件事就只能泛泛而谈。
   */
  async onAiRefine() {
    const text = (this.data.description || '').trim();
    if (!text) {
      // 按钮在空内容时本来就是灰的，这里只是兜底（比如输入后又全删）
      toast.toast('请先输入内容');
      return;
    }

    this.setData({ aiBusy: true });
    try {
      const res = await api.aiApi.refine(text, this.data.task);
      if (res.aiApplied) {
        this.setData({ description: res.text, aiLocked: true });
        if (res.fields) {
          // AI 可能从原文里提取出卡壳与需支持，已填的以用户为准，不覆盖
          const patch = {};
          if (res.fields.blocker && !this.data.blocker) patch.blocker = res.fields.blocker;
          if (res.fields.needSupport && !this.data.needSupport) patch.needSupport = res.fields.needSupport;
          this.setData(patch);
        }
        toast.success('已精简');
      } else {
        // 未能精简时明确告知原因，而不是静默无反应
        const reasonText =
          {
            AI_DISABLED: 'AI 精简未启用（联系管理员配置）',
            MISSING_API_KEY: 'AI 未配置密钥',
            AI_ERROR: 'AI 服务暂时不可用',
            TEXT_TOO_LONG: '内容过长，已跳过精简',
            INVALID_JSON: 'AI 返回格式异常',
            EMPTY_RESULT: 'AI 未返回有效内容',
            EMPTY_INPUT: '内容为空',
          }[res.reason] || 'AI 精简未生效';
        toast.toast(`${reasonText}，已保留原文`);
      }
    } catch (e) {
      // 理论上不会走到这里（云函数已吞掉所有异常），兜底以防网络层失败
      toast.toast('AI 精简失败，已保留原文');
    } finally {
      this.setData({ aiBusy: false });
    }
  },

  // ── 表单输入 ────────────────────────────────────────────────────────

  onInput(e) {
    const field = e.currentTarget.dataset.field;
    const patch = { [field]: e.detail.value };

    /**
     * 改动描述 → 解锁「AI 精简」按钮（见 data.aiLocked）。
     *
     * ★ 必须限定 field === 'description'。本方法是三个 textarea 共用的
     *   （描述 / 卡壳原因 / 需要支持），无条件解锁的话，用户改一下"卡壳原因"
     *   就会把描述的锁解开 —— 再点 AI 就是白烧 token，而且没人看得出来。
     */
    if (field === 'description' && this.data.aiLocked) patch.aiLocked = false;

    this.setData(patch);
  },

  onProgressChange(e) {
    this.setData({ progress: Number(e.detail.value) });
  },

  onEnumChange(e) {
    const { field, value } = e.detail;
    this.setData({ [field]: value });
  },

  // ── 提交 ────────────────────────────────────────────────────────────

  async onSubmit() {
    const { description, blocker, needSupport, isLeader, taskId } = this.data;

    if (!description.trim() && !blocker.trim() && !needSupport.trim()) {
      toast.toast('请至少填写进展描述、卡壳原因或需要支持');
      return;
    }

    this.setData({ submitting: true });

    const payload = {
      taskId,
      description: description.trim(),
      blocker: blocker.trim(),
      needSupport: needSupport.trim(),
      clientToken: this.data.token,
    };

    // ★ 只有主办人才附带这三个字段。
    //   协办人不传（而不是传了被忽略）—— 万一后端校验有疏漏，
    //   不传也保证了协办人不可能改动进度与状态。
    if (isLeader) {
      payload.progress = this.data.progress;
      payload.status = this.data.status;
      payload.stage = this.data.stage;
    }

    try {
      await api.progressApi.addRecord(payload, this.data.token);
      toast.success('上报成功');

      setTimeout(() => {
        // 回到上一页。onShow 会重新拉取列表，无需手动通知刷新。
        wx.navigateBack();
      }, 900);
    } catch (e) {
      // ★ 提交失败时**保留**令牌，不要换新的。
      //   最危险的情形是"云函数其实写成功了，只是响应丢在网络上"：
      //   此时用户点重试，若换了新令牌就会写入第二条重复进展。
      //   保留旧令牌的话，重试会撞上确定性 _id 被幂等去重，结果正确。
      //   代价是"失败后修改内容再提交"可能被去重而丢弃修改 ——
      //   但重复数据比丢一次修改更难收拾，所以选前者。
      this.setData({ submitting: false });
      if (e.code === 'NETWORK_ERROR') {
        toast.toast('网络异常，请直接重试（不会产生重复记录）');
      }
    }
  },
});
