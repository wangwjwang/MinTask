/**
 * miniprogram/utils/toast.js
 * ---------------------------------------------------------------------------
 * 统一的提示与 loading 管理。
 *
 * ★ 为什么要做 loading 计数：
 *   微信的 wx.showLoading / wx.hideLoading 是全局单例。页面里如果同时发起
 *   两个请求，各自 show 一次、hide 一次，先返回的那个会把后一个的 loading
 *   关掉，用户看到转圈闪一下就没了但请求还没完。
 *   用计数器管理，最后一个结束才真正 hide。
 * ---------------------------------------------------------------------------
 */

let loadingCount = 0;

/** 显示 loading（可重入） */
function showLoading(title = '处理中') {
  loadingCount += 1;
  if (loadingCount === 1) {
    wx.showLoading({ title, mask: true });
  }
}

/** 隐藏 loading。只有计数归零时才真正隐藏。 */
function hideLoading() {
  loadingCount = Math.max(0, loadingCount - 1);
  if (loadingCount === 0) {
    wx.hideLoading();
  }
}

/** 强制清零（页面 onUnload 时用，防止异常路径导致计数泄漏） */
function resetLoading() {
  loadingCount = 0;
  wx.hideLoading();
}

/**
 * 包裹一个异步操作，自动管理 loading。
 * @param {Function} fn 异步函数
 * @param {string} [title]
 */
async function withLoading(fn, title = '处理中') {
  showLoading(title);
  try {
    return await fn();
  } finally {
    hideLoading();
  }
}

/**
 * toast 能完整显示的文案上限（中文按两行计，约 26 字）。
 * 超过这个长度 wx.showToast 会直接截断，且不会滚动或翻页。
 */
const TOAST_MAX = 26;

/** 轻提示 */
function toast(title, icon = 'none', duration = 1800) {
  wx.showToast({ title: String(title || ''), icon, duration });
}

/** 成功提示 */
function success(title = '操作成功') {
  wx.showToast({ title, icon: 'success', duration: 1500 });
}

/**
 * 失败提示。长文案自动降级为弹窗。
 *
 * ★ 为什么不一律用 toast：
 *   业务短提示（"该成员已被他人认领，请刷新后重试"）用 toast 是对的 ——
 *   不打断操作。但部署类提示动辄几十字，而它的**结论在最后**
 *   （"…详见 README 3.4"），被截掉就等于没说；何况 toast 2.2 秒就消失，
 *   用户来不及照着做。这类提示必须停下来读完。
 */
function error(title = '操作失败') {
  const msg = String(title || '操作失败');
  if (msg.length > TOAST_MAX) {
    wx.showModal({
      title: '操作失败',
      content: msg,
      showCancel: false,
      confirmText: '知道了',
    });
    return;
  }
  wx.showToast({ title: msg, icon: 'none', duration: 2200 });
}

/**
 * 确认弹窗，Promise 化。
 * @returns {Promise<boolean>} 用户是否确认
 */
function confirm(content, title = '确认操作', confirmText = '确定') {
  return new Promise((resolve) => {
    wx.showModal({
      title,
      content,
      confirmText,
      success: (res) => resolve(!!res.confirm),
      fail: () => resolve(false),
    });
  });
}

module.exports = {
  showLoading,
  hideLoading,
  resetLoading,
  withLoading,
  toast,
  success,
  error,
  confirm,
};
