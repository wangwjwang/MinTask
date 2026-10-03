/**
 * scripts/make-collab-each-fix-import.js
 * ---------------------------------------------------------------------------
 * 一次性数据修复：把 collaboratorIds 里被写坏的「指令对象」还原成 openid 字符串。
 *
 * 用法：
 *   node scripts/make-collab-each-fix-import.js            只扫描，不改任何文件
 *   node scripts/make-collab-each-fix-import.js --write    生成导入文件
 *   node scripts/make-collab-each-fix-import.js --verify   拿新导出核对是否已清干净
 *
 * 产出：scripts/tasks.colleachfix.import.json（JSON Lines，整份文档，带 _id）
 *
 * ---------------------------------------------------------------------------
 * ★ 为什么会写坏（2026-10-03 的真实故障）
 *   taskService 的 join 写的是：
 *       collaboratorIds: _.addToSet({ each: [openid] })
 *   但 SDK 只帮 push 把 each 翻成 $each，addToSet / pull 是**原样透传**的。
 *   少一个 $ 号，MongoDB 就不认这是「逐元素添加」，而是把整个对象当成
 *   **一个元素**塞进数组，于是库里变成：
 *       collaboratorIds: [{ each: ["otw1P3..."] }]
 *   云函数不报错、前端还弹「已加入」，但协办名单里永远没有这个人 ——
 *   「我参与的协办」查的是 _.in([openid])，永远匹配不上。
 *
 *   写入侧的修法见 cloudfunctions/taskService/index.js 的 join / leave
 *   （改为 { $each: [...] } 与 pull(标量)），本脚本负责把**已经写坏的**改回来。
 *
 * ★ 为什么把 each 里的 openid 保留下来，而不是清空
 *   那一次点击本来就是「我要加入协办」，只是没写进去。修复要把这次意图落实，
 *   而不是顺手撤销它 —— 撤销的话本人还得出乎意料地再点一次。
 *   这个判断在预演里逐条打印出来，导之前你可以逐条看。
 *
 * ★ 不认识的结构一律不猜
 *   只认 { each: [...] } 这一种已知形态（且里面必须全是字符串）。
 *   出现别的形状就停下来报错，交给人去看 —— 猜错会静默改掉别人的协办关系。
 * ---------------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');

const { mergeCollaboratorSnapshot, splitNames } = require('../shared/taskRepo');

const DIR = __dirname;
const TASKS_EXPORT = path.join(DIR, 'database_export-tasks');
const MEMBERS_EXPORT = path.join(DIR, 'database_export-members');
const OUT = path.join(DIR, 'tasks.colleachfix.import.json');

/** 云开发控制台导出的格式：每行一个独立文档，无外层数组 */
function readJsonLines(file) {
  if (!fs.existsSync(file)) {
    console.error(`✗ 找不到 ${path.basename(file)}`);
    console.error('  请先在云开发控制台把对应集合导出为 JSON Lines，放到 scripts/ 下。');
    process.exit(1);
  }
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

const WRITE = process.argv.includes('--write');
const VERIFY = process.argv.includes('--verify');

const members = readJsonLines(MEMBERS_EXPORT);
/** 库里「已认领」的姓名集合 —— 用来区分"未认领所以查不到"和"已被移除" */
const claimedNames = members.filter((m) => m.openid).map((m) => m.name);
/** openid → 姓名，用来把 ids 还原成显示姓名 */
const nameByOpenid = {};
members.forEach((m) => { if (m.openid) nameByOpenid[m.openid] = m.name; });

const tasks = readJsonLines(TASKS_EXPORT);

/**
 * 从一条任务的 collaboratorIds 里挑出脏数据。
 * 返回 { good, recovered, unknown }：
 *   good      —— 本来就是字符串的 openid，原样保留
 *   recovered —— 从 { each: [...] } 里还原出来的 openid
 *   unknown   —— 认不出来的元素，原样列出，交给人判断
 */
function inspect(ids) {
  const good = [];
  const recovered = [];
  const unknown = [];
  (ids || []).forEach((el) => {
    if (typeof el === 'string') { good.push(el); return; }
    if (el && typeof el === 'object' && Array.isArray(el.each) && el.each.every((x) => typeof x === 'string')) {
      recovered.push(...el.each);
      return;
    }
    unknown.push(el);
  });
  return { good, recovered, unknown };
}

const dirty = tasks
  .map((t) => ({ task: t, ...inspect(t.collaboratorIds) }))
  .filter((r) => r.recovered.length || r.unknown.length);

// ── 核对模式：拿一份新导出确认已经清干净 ──────────────────────────────────
if (VERIFY) {
  console.log(`核对：collaboratorIds 里是否还有非字符串元素（共扫 ${tasks.length} 条任务）\n`);
  if (!dirty.length) {
    console.log('✓ 已清干净 —— 没有任何一条任务的 collaboratorIds 含非字符串元素。');
    process.exit(0);
  }
  console.error(`✗ 还剩 ${dirty.length} 条：`);
  dirty.forEach((r) => {
    console.error(`   ${r.task._id}  ${r.task.task_name}`);
    console.error(`      ${JSON.stringify(r.task.collaboratorIds)}`);
  });
  process.exit(1);
}

if (!dirty.length) {
  console.log(`✓ 没有需要改的任务 —— 扫了 ${tasks.length} 条，collaboratorIds 里没有非字符串元素。`);
  console.log('  （若你刚要了一份新导出，说明这次故障只影响了别处，或已经修过。）');
  process.exit(0);
}

// ── 认不出来的形状：不猜，直接停 ────────────────────────────────────────
const unknownHits = dirty.filter((r) => r.unknown.length);
if (unknownHits.length) {
  console.error(`✗ 有 ${unknownHits.length} 条任务的 collaboratorIds 里出现了本脚本认不出的元素：`);
  unknownHits.forEach((r) => {
    console.error(`   ${r.task._id}  ${r.task.task_name}`);
    console.error(`      ${JSON.stringify(r.unknown)}`);
  });
  console.error('\n本脚本只认 { each: [...] } 这一种已知形态，其余形状不敢猜 ——');
  console.error('猜错会静默改掉别人的协办关系。请先看一眼这些数据，确认后再改本脚本。');
  process.exit(1);
}

console.log(`扫了 ${tasks.length} 条任务，${dirty.length} 条的 collaboratorIds 里混着指令对象\n`);

const fixed = dirty.map((r) => {
  const before = r.task.collaborator || '';
  // 还原后的名单：原有字符串 + 从 each 里捞回来的，按出现顺序去重
  const idsAfter = [];
  r.good.concat(r.recovered).forEach((id) => { if (idsAfter.indexOf(id) === -1) idsAfter.push(id); });

  const linkedAfter = idsAfter.map((id) => nameByOpenid[id]).filter(Boolean);
  const after = mergeCollaboratorSnapshot(before, linkedAfter, claimedNames);

  console.log(`${r.task._id}  ${r.task.task_name}`);
  console.log(`   坏在哪    : ${JSON.stringify(r.task.collaboratorIds)}`);
  console.log(`   捞回的 id : ${JSON.stringify(r.recovered)}${r.recovered.map((id) => ` → ${nameByOpenid[id] || '（不在成员表里）'}`).join('')}`);
  console.log(`   ids  改成 : ${JSON.stringify(idsAfter)}`);
  console.log(`   协办串改成: ${JSON.stringify(before)} → ${JSON.stringify(after)}`);
  console.log('');

  return Object.assign({}, r.task, { collaboratorIds: idsAfter, collaborator: after });
});

console.log('─'.repeat(60));
console.log(`共 ${fixed.length} 条。`);

if (!WRITE) {
  console.log('\n这是预演，没有写任何文件。确认上面每一条都对，再加 --write 生成导入文件。');
  process.exit(0);
}

// JSON Lines：每行一个独立文档
fs.writeFileSync(OUT, fixed.map((d) => JSON.stringify(d)).join('\n') + '\n', 'utf8');

console.log(`\n✓ ${path.relative(process.cwd(), OUT)} —— ${fixed.length} 条`);
console.log('');
console.log('下一步');
console.log('─'.repeat(60));
console.log('1) 先把修好的 taskService 重新部署上去，否则导完还会被写坏。');
console.log('2) 云开发控制台 → 数据库 → tasks 集合 → 导入');
console.log(`   选 ${path.basename(OUT)}`);
console.log('   冲突处理方式：选**会覆盖已有记录**的那一项（Upsert / 更新已有记录）。');
console.log('   ★ 选成 Insert 的话已存在的文档会原样跳过，导完等于什么都没做。');
console.log('3) 导完重新导出一次 tasks，跑：');
console.log('   node scripts/make-collab-each-fix-import.js --verify');
console.log('   看到「✓ 已清干净」才算完成。');
console.log('');
console.log('★ 文件里是整份文档（含 _id），导入会整体覆盖这几条记录。');
console.log('  导出时间之后若有人改过这几条任务，那部分改动会被这份文件覆盖掉 ——');
console.log('  所以导之前建议先重新导出一次，覆盖到 scripts/database_export-tasks 后重跑本脚本。');
console.log('★ 成员表用的是 scripts/database_export-members；若导出之后有人新认领了，');
console.log('  协办串的重算结果会和服务端不一致，请一并重新导出。');
