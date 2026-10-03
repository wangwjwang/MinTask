/**
 * scripts/make-collab-fix-import.js
 * ---------------------------------------------------------------------------
 * 一次性数据修复：把某个人从若干任务的协办名单里摘干净。
 *
 * 用法：
 *   node scripts/make-collab-fix-import.js 王佳            只打印，不改任何文件
 *   node scripts/make-collab-fix-import.js 王佳 --write    生成导入文件
 *   node scripts/make-collab-fix-import.js 王佳 --verify   拿新导出核对是否已清干净
 *
 * 产出：scripts/tasks.collabfix.import.json（JSON Lines，整份文档，带 _id）
 *
 * ---------------------------------------------------------------------------
 * ★ 为什么需要它
 *   「加入协办」只做 addToSet，而历史导入的任务本来就没有 openid。于是一个人
 *   在界面上点一次加入，这条任务的 collaboratorIds 就只剩他一个 —— 而显示串
 *   （collaborator）里原本是另外几个人。两者说的是两拨人：
 *   权限读 collaboratorIds（有他），界面读 collaborator（是别人）。
 *   用户看到的就是"我明明不在协办里，为什么能上报进展"。
 *
 *   根因（rebuildCollaboratorSnapshot 会抹掉未认领的姓名）已在
 *   shared/taskRepo.js 的 mergeCollaboratorSnapshot 里修掉，本脚本负责把
 *   **已经被写坏的那几条**数据改回来。
 *
 * ★ 两个字段一起改，不能只改一个
 *   只把 openid 摘掉、留着显示串里的姓名，界面上就会继续列着一个没有权限的人
 *   —— 正好是同一个矛盾的反面。所以显示串用**服务端修好后的同一个函数**
 *   重算（mergeCollaboratorSnapshot），保证离线改出来的结果和服务端将来
 *   自己收敛到的结果完全一致，不会出现"导完又变一次"。
 *
 * ★ 为什么按姓名而不是 openid 传参
 *   openid 是个人身份标识，不写进仓库。姓名在这里够用：本脚本只在本地跑，
 *   靠 scripts/database_export-members（同样不进仓库）解析出 openid。
 * ---------------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');

const { mergeCollaboratorSnapshot, splitNames } = require('../shared/taskRepo');

const DIR = __dirname;
const TASKS_EXPORT = path.join(DIR, 'database_export-tasks');
const MEMBERS_EXPORT = path.join(DIR, 'database_export-members');
const OUT = path.join(DIR, 'tasks.collabfix.import.json');

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

const NAME = process.argv[2];
const WRITE = process.argv.includes('--write');
const VERIFY = process.argv.includes('--verify');

if (!NAME || NAME.startsWith('-')) {
  console.error('用法：node scripts/make-collab-fix-import.js <姓名> [--write|--verify]');
  process.exit(1);
}

const members = readJsonLines(MEMBERS_EXPORT);
const hit = members.filter((m) => m.name === NAME);
if (hit.length !== 1 || !hit[0].openid) {
  console.error(`✗ 按姓名「${NAME}」在 members 里找到 ${hit.length} 条${hit[0] && !hit[0].openid ? '（该成员还没认领，没有 openid，本来就不在名单里）' : ''}`);
  console.error('  需要唯一命中且已认领。');
  process.exit(1);
}
const OPENID = hit[0].openid;

/** 库里「已认领」的姓名集合 —— 用来区分"未认领所以查不到"和"已被移除" */
const claimedNames = members.filter((m) => m.openid).map((m) => m.name);

/** openid → 姓名，用来把仍留在 ids 里的协办人还原成显示姓名 */
const nameByOpenid = {};
members.forEach((m) => { if (m.openid) nameByOpenid[m.openid] = m.name; });

const tasks = readJsonLines(TASKS_EXPORT);
const targets = tasks.filter((t) => (t.collaboratorIds || []).includes(OPENID));

// ── 核对模式：拿一份新导出确认已经清干净 ──────────────────────────────────
if (VERIFY) {
  console.log(`核对：${NAME}（${OPENID.slice(0, 8)}…）是否还在任何任务的 collaboratorIds 里\n`);
  if (!targets.length) {
    console.log(`✓ 已清干净 —— 扫描 ${tasks.length} 条任务，没有一条的 collaboratorIds 含该 openid。`);
    process.exit(0);
  }
  console.error(`✗ 还剩 ${targets.length} 条：`);
  targets.forEach((t) => console.error(`   ${t._id}  ${t.task_name}`));
  process.exit(1);
}

if (!targets.length) {
  console.log(`✓ 没有需要改的任务 —— ${tasks.length} 条里没有一条的 collaboratorIds 含该 openid。`);
  process.exit(0);
}

console.log(`${NAME}（${OPENID.slice(0, 8)}…）出现在 ${targets.length} 条任务的 collaboratorIds 里\n`);

const fixed = targets.map((t) => {
  const before = t.collaborator || '';
  const idsAfter = (t.collaboratorIds || []).filter((id) => id !== OPENID);
  // 用服务端修好后的同一函数重算显示串：
  // 该人已认领且不再在 ids 里 → 从串中摘掉；未认领的历史姓名原样保留
  const linkedAfter = idsAfter.map((id) => nameByOpenid[id]).filter(Boolean);
  const after = mergeCollaboratorSnapshot(before, linkedAfter, claimedNames);

  console.log(`${t._id}  ${t.task_name}`);
  console.log(`   collaboratorIds : ${JSON.stringify(t.collaboratorIds)} → ${JSON.stringify(idsAfter)}`);
  console.log(`   collaborator    : ${JSON.stringify(before)} → ${JSON.stringify(after)}`);
  console.log('');

  return Object.assign({}, t, { collaboratorIds: idsAfter, collaborator: after });
});

console.log('─'.repeat(60));
console.log(`共 ${fixed.length} 条。`);

if (!WRITE) {
  console.log('\n这是预演，没有写任何文件。确认无误后加 --write 生成导入文件。');
  process.exit(0);
}

// JSON Lines：每行一个独立文档
fs.writeFileSync(OUT, fixed.map((d) => JSON.stringify(d)).join('\n') + '\n', 'utf8');

console.log(`\n✓ ${path.relative(process.cwd(), OUT)} —— ${fixed.length} 条`);
console.log('');
console.log('下一步');
console.log('─'.repeat(60));
console.log('1) 云开发控制台 → 数据库 → tasks 集合 → 导入');
console.log('   选 tasks.collabfix.import.json');
console.log('   冲突处理方式：选**会覆盖已有记录**的那一项（Upsert / 更新已有记录）。');
console.log('   ★ 选成 Insert 的话已存在的文档会原样跳过，导完等于什么都没做。');
console.log('2) 导完重新导出一次 tasks，跑：');
console.log(`   node scripts/make-collab-fix-import.js ${NAME} --verify`);
console.log('   看到「✓ 已清干净」才算完成。');
console.log('');
console.log('★ 文件里是整份文档（含 _id），导入会整体覆盖这几条记录。');
console.log('  导出时间之后若有人改过这几条任务，那部分改动会被这份文件覆盖掉 ——');
console.log('  所以导之前建议先重新导出一次，再把它覆盖到 scripts/database_export-tasks 后重跑本脚本。');
