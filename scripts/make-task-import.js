/**
 * scripts/make-task-import.js
 * ---------------------------------------------------------------------------
 * 把 scripts/tasks.source.csv（历史任务表）转成云开发数据库能直接导入的文件。
 *
 * 用法：
 *   node scripts/make-task-import.js [源CSV路径]
 *
 * 产出两个文件（分别对应两个集合，需要导入两次 —— 云开发一次只能导一个集合）：
 *   scripts/tasks.import.json             → tasks 集合
 *   scripts/progress_records.import.json  → progress_records 集合
 *
 * ---------------------------------------------------------------------------
 * ★ 关于 leaderId / collaboratorIds / updaterId：
 *
 *   源表里只有**姓名**，而权限判定只认 **openid**（见 shared/perm.js）。
 *   openid 只有在本人认领之后才存在于 members 集合里，脚本在本地无从获取。
 *
 *   所以本脚本**故意**把这三个字段留空/留空数组，由云函数侧的
 *   「重新关联」(memberService.adminRelinkMembers) 在大家认领之后补齐。
 *   这不是偷懒 —— 前端与离线脚本都不应该有能力指定"谁是主办人"，
 *   否则就绕过了「身份只取自 OPENID」这条安全底线。
 *
 *   在补齐之前：任务能在看板上正常显示（展示用的是 leader 姓名快照），
 *   但「我主办的」列表为空，且没人能编辑 —— 这是预期的中间状态。
 *   认领页每有人认领一次，云函数会自动补一次；也可由管理员手动触发全量重跑。
 * ---------------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');

const C = require('../shared/constants');

const DEFAULT_SRC = path.join(__dirname, 'tasks.source.csv');
const OUT_TASKS = path.join(__dirname, 'tasks.import.json');
const OUT_PROGRESS = path.join(__dirname, 'progress_records.import.json');
const MEMBERS = path.join(__dirname, 'members.json');

/** 任务名最大长度，与云函数侧的展示假设一致（源数据最长 19 字） */
const NAME_MAX = 60;

// ---------------------------------------------------------------------------
// CSV 解析
// ---------------------------------------------------------------------------

/**
 * 最小可用的 CSV 解析器。
 * 必须自己写而不能 split(',') —— 表里有 detail / progress_log 两个字段
 * 内含逗号，被引号包裹住，按逗号切会直接切碎。
 */
function parseCSV(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 1; } else { quoted = false; }
      } else {
        cell += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      row.push(cell); cell = '';
    } else if (c === '\n') {
      row.push(cell); rows.push(row); row = []; cell = '';
    } else if (c !== '\r') {
      cell += c;
    }
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function loadCSV(file) {
  // 去 BOM：Excel 导出的 CSV 几乎总是带 BOM，不去掉第一个列名会变成 "﻿task_name"
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  const rows = parseCSV(text);
  if (!rows.length) throw new Error('文件为空');

  const head = rows[0].map((h) => h.trim());
  const data = rows
    .slice(1)
    .filter((r) => r.some((c) => c && c.trim()))
    .map((r) => {
      const o = {};
      head.forEach((k, i) => { o[k] = (r[i] || '').trim(); });
      return o;
    });
  return { head, data };
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/**
 * 由字符串生成稳定的短 id。
 *
 * ★ 为什么不用行号：行号会随源表的增删改而整体位移，
 *   同一个任务两次生成会得到不同 _id，重复导入就变成新增而不是冲突。
 *   用任务名做哈希，行序变化不影响结果。
 *
 * ★ 用 _id 而不是靠字段判重：云开发导入以 _id 为准，
 *   重复导入同一份文件会因 _id 冲突而失败 —— 这正是我们想要的，
 *   它把"手滑导了两遍"从一个数据事故降级成一次报错。
 */
function stableId(prefix, str) {
  let h = 5381;
  for (let i = 0; i < str.length; i += 1) {
    h = ((h * 33) ^ str.charCodeAt(i)) >>> 0;
  }
  return `${prefix}-${h.toString(36)}`;
}

/** 'YYYY-MM-DD' → 云开发导入支持的 ISODate 字面量 */
function isoDate(day) {
  return { $date: `${day}T00:00:00.000Z` };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 校验并返回 'YYYY-MM-DD'，失败返回 '' */
function checkDate(v) {
  if (!DATE_RE.test(v)) return '';
  const d = new Date(`${v}T00:00:00Z`);
  return isNaN(d.getTime()) ? '' : v;
}

/**
 * 由进度推导任务阶段。
 *
 * ★ 这是一条**推导规则**，源表里并没有阶段字段（只有 status 健康度）。
 *   progress=100 → 已完成；progress=0 → 未开始；其余 → 进行中。
 *   本批数据里没有 0，所以结果是「已完成 / 进行中」二分。
 *   若你希望换个口径，改这里即可，别去改生成出来的文件。
 */
function deriveStage(progress) {
  if (progress >= 100) return '已完成';
  if (progress <= 0) return '未开始';
  return '进行中';
}

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

/**
 * 建库。
 *
 * ★ 单行问题**只跳过该行**，不阻断其余行。
 *   历史表里出现一两行填写不全的很正常（往往是最近新加的、还没来得及补），
 *   因为它一个人让另外 69 条也导不进去，代价完全不成比例。
 *   跳过的行会在结尾单独列出，缺什么、在哪一行都写清楚，不会被静默吞掉。
 *   需要"一行都不许错"时用 --strict。
 */
function build(csv, memberNames) {
  const tasks = [];
  const progressDocs = [];
  const skipped = [];
  const warn = [];
  const usedTaskIds = new Map();
  const usedProgressIds = new Set();
  let lastDate = '';

  csv.data.forEach((d, idx) => {
    const at = `第 ${idx + 2} 行`; // +2：表头占 1 行，且行号从 1 起（与编辑器行号一致）
    const label = d.task_name || '（无任务名）';
    /** 本行的所有问题；非空则该行整体跳过 */
    const bad = [];

    // ── 必填（口径与 shared/validate.js 的 assertTaskRequiredForCreate 对齐）──
    if (!d.task_name) bad.push('task_name 为空');
    else if (d.task_name.length > NAME_MAX) bad.push(`task_name 有 ${d.task_name.length} 字，超过 ${NAME_MAX}`);
    else if (usedTaskIds.has(d.task_name)) bad.push(`任务名与第 ${usedTaskIds.get(d.task_name)} 行重复`);

    // ── 枚举 ──
    // recur_freq / status / priority 有服务端默认值，缺失只警告；
    // category / source / task_type 是必填，缺失或越界即跳过。
    const requiredEnums = [['category', C.CATEGORY], ['source', C.SOURCE], ['task_type', C.TASK_TYPE]];
    requiredEnums.forEach(([col, allowed]) => {
      const v = d[col];
      if (v === '') bad.push(`${col} 为空`);
      else if (allowed.indexOf(v) === -1) bad.push(`${col}「${v}」不在允许值内（${allowed.join('/')}）`);
    });
    [['recur_freq', C.RECUR_FREQ], ['status', C.STATUS], ['priority', C.PRIORITY]].forEach(([col, allowed]) => {
      const v = d[col];
      if (v === '') warn.push(`${at}「${label}」${col} 为空，取服务端默认值`);
      else if (allowed.indexOf(v) === -1) bad.push(`${col}「${v}」不在允许值内（${allowed.join('/')}）`);
    });

    // ── 人员 ──
    if (!d.leader) bad.push('leader 为空');
    else if (!memberNames.has(d.leader)) bad.push(`leader「${d.leader}」不在 members 名单里，认领后也无法关联`);

    const collabs = d.collaborator.split(/[;；,，、]/).map((s) => s.trim()).filter(Boolean);
    collabs.forEach((n) => {
      if (!memberNames.has(n)) bad.push(`协办人「${n}」不在 members 名单里`);
      if (n === d.leader) bad.push(`协办人「${n}」与主办人重复`);
    });

    // ── 进度 ──
    const progress = Number(d.progress);
    if (d.progress === '') bad.push('progress 为空');
    else if (!Number.isFinite(progress) || progress < 0 || progress > 100) {
      bad.push(`progress「${d.progress}」不是 0-100 的数字`);
    }

    // ── 日期 ──
    const startDate = checkDate(d.start_date);
    const dueDate = checkDate(d.due_date);
    if (!startDate) bad.push(`start_date「${d.start_date}」不是 YYYY-MM-DD`);
    if (!dueDate) bad.push(`due_date「${d.due_date}」不是 YYYY-MM-DD`);
    if (startDate && dueDate && startDate > dueDate) warn.push(`${at}「${label}」开始日期晚于截止日期`);

    // ── 进展日志 ──
    let log = [];
    if (d.progress_log) {
      try {
        log = JSON.parse(d.progress_log);
      } catch (e) {
        bad.push(`progress_log 不是合法 JSON：${e.message}`);
        log = [];
      }
      if (!Array.isArray(log)) { bad.push('progress_log 不是数组'); log = []; }
    }
    log = log.filter((e) => e && typeof e === 'object');
    log.forEach((e, j) => {
      if (!checkDate(e.date || '')) bad.push(`progress_log 第 ${j + 1} 条的 date「${e.date}」不是 YYYY-MM-DD`);
      if (typeof e.desc !== 'string' || !e.desc.trim()) bad.push(`progress_log 第 ${j + 1} 条的 desc 为空`);
    });

    // 进度与进展记录互相矛盾：记了进展却进度为 0，多半是漏填了进度。
    // 只警告不改数据 —— 改了就说不清是原始值还是我们推的。
    if (log.length && progress === 0) {
      warn.push(`${at}「${label}」progress=0 但已有 ${log.length} 条进展记录，阶段会落在「未开始」，请确认`);
    }

    if (bad.length) {
      skipped.push({ at, label, bad });
      return;
    }

    usedTaskIds.set(d.task_name, idx + 2);

    const logDates = log.map((e) => e.date).filter(Boolean).sort();
    const firstLog = logDates[0] || '';
    const lastLog = logDates[logDates.length - 1] || '';
    if (lastLog > lastDate) lastDate = lastLog;

    // ── 组装任务文档 ──
    // 字段与 shared/taskRepo.js 的 buildTaskDoc 保持一致，
    // 差异只在：leaderId/collaboratorIds/creatorId 留空（理由见文件头）。
    const stage = deriveStage(progress);
    const taskId = stableId('tk', d.task_name);
    if (usedTaskIds.has(taskId)) {
      warn.push(`${at}「${label}」的 _id 与另一任务撞车（${taskId}），请改任务名`);
    }

    const doc = {
      _id: taskId,
      task_name: d.task_name,
      category: d.category,
      source: d.source,

      leader: d.leader,
      leaderId: '',                    // ← 待云函数关联
      collaborator: collabs.join(';'),
      collaboratorIds: [],             // ← 待云函数关联

      task_type: d.task_type,
      recur_freq: d.recur_freq || '不适用',
      recur_rule: d.recur_rule || '',

      status: d.status || '正常',
      stage,
      priority: d.priority || 'P2',
      progress,
      start_date: startDate,
      due_date: dueDate,
      // ★ 已完成才有完成时间，用进展日志最后一条的日期 —— 有据可依。
      //   非已完成的任务一律留空（applyStageSideEffects 在阶段退回时也是清空）。
      actualCompleteTime: stage === '已完成' ? lastLog || '' : '',
      detail: d.detail || '',

      origin: C.ORIGIN.MANUAL,
      creatorId: '',                   // ← 待云函数关联
      hasOpenBlocker: false,
      openBlockerCount: 0,
      latestProgressAt: lastLog ? isoDate(lastLog) : null,
      createdAt: isoDate(firstLog || startDate),
      updatedAt: isoDate(lastLog || startDate),
    };
    tasks.push(doc);

    // ── 组装进展记录 ──
    // 字段与 shared/taskRepo.js 的 buildProgressDoc 一致。
    log.forEach((e, j) => {
      if (!e.desc || !e.desc.trim()) return;
      const pid = stableId('pr', `${d.task_name}#${e.date}#${j}`);
      if (usedProgressIds.has(pid)) {
        warn.push(`${at}「${label}」第 ${j + 1} 条进展的 _id 撞车`);
      }
      usedProgressIds.add(pid);

      progressDocs.push({
        _id: pid,
        taskId,
        task_name: d.task_name,
        updaterId: '',               // ← 待云函数关联
        // ★ 源表没有"谁上报的"这一列，只能按主办人归属。
        //   这与周报的实际情况相符（主办人汇报自己负责的任务），
        //   但如果你希望记在别人名下，导入后需要手工调整。
        updaterName: d.leader,
        description: e.desc.trim(),
        status: '正常',
        needSupport: '',
        blocker: '',
        hasBlocker: false,
        blockerResolved: null,
        appliedChanges: null,
        updatedAt: isoDate(e.date),
      });
    });
  });

  return { tasks, progressDocs, skipped, warn, lastDate };
}

// ---------------------------------------------------------------------------

function main() {
  const src = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_SRC;

  if (!fs.existsSync(src)) {
    console.error(`✗ 找不到源文件：${src}`);
    console.error('  用法：node scripts/make-task-import.js [源CSV路径]');
    process.exit(1);
  }
  if (!fs.existsSync(MEMBERS)) {
    console.error(`✗ 找不到 ${MEMBERS}，无法校验人名`);
    process.exit(1);
  }

  const csv = loadCSV(src);
  const members = JSON.parse(fs.readFileSync(MEMBERS, 'utf8').replace(/^﻿/, ''));
  const memberNames = new Set(members.map((m) => m.name));

  console.log(`源文件：${path.relative(process.cwd(), src)}`);
  console.log(`        ${csv.data.length} 行，${csv.head.length} 列`);
  console.log(`成员表：${memberNames.size} 人\n`);

  const { tasks, progressDocs, skipped, warn, lastDate } = build(csv, memberNames);

  // 跳过的行先报 —— 它比警告重要，被淹在警告里就失去意义了
  if (skipped.length) {
    console.log(`✗ 跳过 ${skipped.length} 行（数据不全，无法生成合法任务）：\n`);
    skipped.forEach((s) => {
      console.log(`   ${s.at}「${s.label}」`);
      s.bad.forEach((b) => console.log(`       · ${b}`));
    });
    console.log();
    console.log('   补全后重跑本脚本即可，其余行不受影响。');
    console.log('   （这几行需要单独再导一次，_id 稳定，不会与已导入的冲突。）');
    console.log();
  }

  if (warn.length) {
    console.log(`⚠ 警告 ${warn.length} 条：`);
    warn.slice(0, 10).forEach((w) => console.log(`   · ${w}`));
    if (warn.length > 10) console.log(`   … 另有 ${warn.length - 10} 条`);
    console.log();
  }

  // --strict：补完数据后用它复验，确保一行都不少
  if (skipped.length && process.argv.includes('--strict')) {
    console.error('✗ --strict：存在被跳过的行，未生成文件。');
    process.exit(1);
  }

  if (!tasks.length) {
    console.error('✗ 没有任何一行能生成任务，未生成文件。');
    process.exit(1);
  }

  // JSON Lines —— 每行一个独立文档，无外层数组、无逗号分隔。
  // （与 members.import.json 同理，云开发不接受标准 JSON 数组。）
  const write = (file, docs) => {
    fs.writeFileSync(file, docs.map((d) => JSON.stringify(d)).join('\n') + '\n', 'utf8');
    return docs.length;
  };

  const nTasks = write(OUT_TASKS, tasks);
  const nProgress = write(OUT_PROGRESS, progressDocs);

  const byStage = {};
  tasks.forEach((t) => { byStage[t.stage] = (byStage[t.stage] || 0) + 1; });
  const byStatus = {};
  tasks.forEach((t) => { byStatus[t.status] = (byStatus[t.status] || 0) + 1; });

  console.log(`✓ ${path.relative(process.cwd(), OUT_TASKS)} —— ${nTasks} 个任务`);
  console.log(`   阶段：${Object.entries(byStage).map(([k, v]) => `${k} ${v}`).join('，')}`);
  console.log(`   健康度：${Object.entries(byStatus).map(([k, v]) => `${k} ${v}`).join('，')}`);
  console.log(`   进展最新日期：${lastDate}`);
  console.log(`   已完成任务的实际完成时间＝各自进展日志的最后一条日期`);
  console.log();
  console.log(`✓ ${path.relative(process.cwd(), OUT_PROGRESS)} —— ${nProgress} 条进展记录`);

  const collabCount = tasks.filter((t) => t.collaboratorIds.length || t.collaborator).length;
  console.log(`   有协办人的任务：${collabCount} 个`);
  console.log();

  console.log('─'.repeat(60));
  console.log('下一步');
  console.log('─'.repeat(60));
  console.log('1) 云开发控制台 → 数据库 → tasks 集合 → 导入 → 选 tasks.import.json');
  console.log('   冲突处理方式选「Insert」');
  console.log('2) 同一个入口 → progress_records 集合 → 导入 → 选 progress_records.import.json');
  console.log();
  console.log('导完后任务的 leaderId / collaboratorIds / updaterId 都还是空的，');
  console.log('「我主办的」列表会是空的、也没人能编辑 —— 这是预期的。');
  console.log();
  console.log('3) 让大家到认领页认领自己（每人认领时云函数会自动补一次他名下的关联）');
  console.log('4) 管理员打开小程序「人员」Tab → 点「把历史任务关联到已认领的同事」收尾');
  console.log('   可反复点，只补空缺不覆盖。');
  console.log();
  console.log('   注：这一步不能从云开发控制台的「云端测试」跑 —— 那里没有微信身份，');
  console.log('   adminRelinkMembers 需要 OPENID 才能判断你是不是管理员。');
}

main();
