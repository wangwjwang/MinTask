#!/usr/bin/env node
/**
 * scripts/make-source-rename-import.js
 * ---------------------------------------------------------------------------
 * 一次性迁移：把 14 条 source === '业务部门提报' 的任务改成 '需求池'。
 * （2026-10-09 SOURCE 枚举改名，见 docs/superpowers/specs/2026-10-09-demand-pool-design.md §7）
 *
 * 为什么必须迁移：shared/validate.js 的 assertEnum 会拒掉不在枚举里的来源，
 * 改名而不迁移，那 14 条任务一保存就报「任务来源取值不合法」。
 *
 * 【用法】
 *   node scripts/make-source-rename-import.js <控制台导出的任务快照.jsonl>
 *   → 生成 scripts/tasks.sourcerename.import.json
 *   → 在云开发控制台「覆盖导入」该文件（按 _id 覆盖，只动被改的那几条）
 *
 * ★ 不要走 tasks.source.csv 那条路。那份 CSV 是历史任务表的一次性导入源，
 *   字段值是 2026-08 的初始状态；重跑 make-task-import.js 再覆盖导入，
 *   会用三个月前的数据盖掉这 14 条任务的全部现值
 *   （进度、状态、已完成时间、姓名快照……）。CSV 只用来同步改名，
 *   保持源文件与库一致，不参与本次迁移。
 *
 * ⚠ 注意：本仓库的 scripts/make-*.js 在 require 时裸调 main()，
 *   执行它是有意的，不是误触。
 * ---------------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');

const OLD = '业务部门提报';
const NEW = '需求池';
const OUT = path.join(__dirname, 'tasks.sourcerename.import.json');

function main() {
  const src = process.argv[2];
  if (!src) {
    console.error('用法：node scripts/make-source-rename-import.js <任务快照.jsonl>');
    process.exit(1);
  }
  if (!fs.existsSync(src)) {
    console.error(`快照文件不存在：${src}`);
    process.exit(1);
  }

  const lines = fs.readFileSync(src, 'utf8').split('\n').filter((l) => l.trim());
  const changed = [];

  for (const line of lines) {
    let row;
    try {
      row = JSON.parse(line);
    } catch (e) {
      console.error(`跳过无法解析的一行：${line.slice(0, 80)}`);
      continue;
    }
    if (row.source !== OLD) continue;

    // ★ 只改 source 这一个字段，其余**原样保留**（含 _id、含所有现值）。
    //   重建对象（只挑几个字段）会静默丢掉没列出来的字段 —— 那是数据损坏，
    //   不是迁移。所以这里是赋值而不是重建。
    row.source = NEW;
    changed.push(row);
  }

  fs.writeFileSync(OUT, changed.map((r) => JSON.stringify(r)).join('\n'), 'utf8');

  console.log(`扫描 ${lines.length} 行，命中 ${changed.length} 条「${OLD}」→「${NEW}」\n`);
  console.log('改动清单（请人工核对条数）：');
  changed.forEach((r, i) => {
    console.log(`  ${String(i + 1).padStart(2)}. ${r.task_name}  —— 主办 ${r.leader || '（空）'}`);
  });
  console.log(`\n✓ 已生成 ${path.relative(process.cwd(), OUT)}（${changed.length} 条，覆盖导入用）`);
  if (changed.length !== 14) {
    console.warn(
      `\n⚠ 命中 ${changed.length} 条，与预期的 14 条不一致。` +
      `\n  多出或少了都说明快照不是导出时刻的库，先核对再导入，别直接覆盖。`
    );
  }
}

main();
