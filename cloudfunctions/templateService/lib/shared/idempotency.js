/**
 * shared/idempotency.js
 * ---------------------------------------------------------------------------
 * 幂等工具。双端共用。
 *
 * ★ 设计原则：幂等靠「确定性 _id」，不靠「先查后写」。
 *   "先查后写"存在 TOCTOU 竞态——两个并发实例可能同时查到"不存在"，
 *   然后双双写入，产生重复数据。而 _id 是数据库主键，天然唯一，
 *   重复插入必被数据库拒绝。这是唯一在并发下仍然正确的方案。
 *
 *   先查后写仅作为「快速跳过」的优化层，让正常路径不产生异常日志，
 *   正确性完全由确定性 _id 兜底。
 * ---------------------------------------------------------------------------
 */

/**
 * 生成客户端幂等令牌。前端每次进入表单页生成一个，
 * 网络重试/用户连点/超时重发时复用同一个，从而只产生一条记录。
 *
 * 格式：{prefix}{时间戳36进制}-{随机串}
 * 长度受控，且只含 [a-z0-9-]，符合云数据库自定义 _id 的字符要求。
 */
function clientToken(prefix) {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix || 'c'}${ts}-${rand}`;
}

/**
 * 判断异常是否为「主键重复」。
 * 云开发在不同 SDK 版本/环境下报错文案不一致，故做多模式匹配。
 */
function isDuplicateError(e) {
  if (!e) return false;
  const msg = String(e.errMsg || e.message || e.error || '');
  if (/duplicate key|duplicate_key|E11000|already exists/i.test(msg)) return true;
  // 部分环境下以错误码形式返回
  if (e.errCode === -502001 && /duplicate/i.test(msg)) return true;
  return false;
}

/**
 * 带幂等的写入。若目标 _id 已存在，视为「已成功过」而非错误。
 *
 * @param {object} db         cloud.database() 实例
 * @param {string} collection 集合名
 * @param {object} doc        文档内容，必须含 _id
 * @returns {Promise<{created:boolean, idempotent?:boolean}>}
 */
async function addIdempotent(db, collection, doc) {
  try {
    await db.collection(collection).add({ data: doc });
    return { created: true };
  } catch (e) {
    if (isDuplicateError(e)) {
      // 重复即幂等命中：调用方应将其视为成功（或按业务语义记为 skipped）
      return { created: false, idempotent: true };
    }
    throw e;
  }
}

/** 周期任务生成的确定性 _id：同一模板 + 同一周期永远只有一个文档 */
function periodicTaskId(templateId, periodKey) {
  return `pt-${templateId}-${periodKey}`;
}

/** 手动新建任务的确定性 _id */
function manualTaskId(token) {
  return `tk-${token}`;
}

/** 进展记录的确定性 _id */
function progressRecordId(token) {
  return `pr-${token}`;
}

// ★ 曾经的 jobLogId(runDate, ts) 已删除：审计日志**不需要**确定性 _id。
//   它靠 ms 时间戳生成，两次运行落在同一毫秒就会主键冲突，
//   而写日志的失败是被 try/catch 吞掉的（只打一行日志），
//   结果就是一条审计记录**静默消失** —— 比没有 id 糟糕得多。
//   本文件其余几个 *Id 之所以存在，是因为它们承担幂等：重复触发必须命中同一条。
//   日志恰恰相反：每次运行都该留下一条独立记录。交给数据库自动生成即可。

module.exports = {
  clientToken,
  isDuplicateError,
  addIdempotent,
  periodicTaskId,
  manualTaskId,
  progressRecordId,
};
