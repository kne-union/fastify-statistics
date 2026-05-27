#!/usr/bin/env node
/**
 * fastify-statistics Benchmark 入口
 * 用法:
 *   node benchmark/index.js              # 运行全部
 *   node benchmark/index.js collect      # 仅写入测试
 *   node benchmark/index.js query        # 仅查询测试
 *   node benchmark/index.js aggregate    # 仅聚合测试
 *   node benchmark/index.js mixed        # 仅混合负载测试
 */

const path = require('node:path');

const scenarios = {
  collect: { name: '场景 1：数据写入', file: path.resolve(__dirname, 'collect-bench.js') },
  query: { name: '场景 2：查询', file: path.resolve(__dirname, 'query-bench.js') },
  aggregate: { name: '场景 3&4：聚合+补偿', file: path.resolve(__dirname, 'aggregate-bench.js') },
  mixed: { name: '场景 5：混合负载', file: path.resolve(__dirname, 'mixed-bench.js') }
};

const arg = process.argv[2];

function printUsage() {
  console.log('用法: node benchmark/index.js [scenario]');
  console.log('可用场景: ' + Object.keys(scenarios).join(', '));
  console.log('不传参则运行全部');
}

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════════╗');
  console.log('║           fastify-statistics Benchmark Suite                    ║');
  console.log('╚══════════════════════════════════════════════════════════════════╝');
  console.log(`  Node.js: ${process.version}`);
  console.log(`  Date: ${new Date().toISOString()}`);
  console.log(`  Database: SQLite (WAL mode, no external cache)`);
  console.log('');

  const mem = process.memoryUsage();
  console.log(`  Initial Memory: RSS=${Math.round(mem.rss / 1024 / 1024)} MB, Heap=${Math.round(mem.heapUsed / 1024 / 1024)} MB`);
  console.log('');

  if (arg === '--help' || arg === '-h') {
    printUsage();
    return;
  }

  const toRun = arg ? [arg] : Object.keys(scenarios);
  const scenarioTimings = [];

  for (const key of toRun) {
    const scenario = scenarios[key];
    if (!scenario) {
      console.error(`Unknown scenario: ${key}. Available: ${Object.keys(scenarios).join(', ')}`);
      process.exit(1);
    }
    console.log(`>>> Running: ${scenario.name}...`);
    const startMs = Date.now();

    // 子进程方式运行，隔离内存
    const { execSync } = require('child_process');
    try {
      execSync(`node "${scenario.file}"`, {
        cwd: path.resolve(__dirname, '..'),
        stdio: 'inherit',
        timeout: 300000 // 5 min timeout per scenario
      });
    } catch (e) {
      if (e.status !== 1) {
        console.error(`  Scenario ${key} failed with exit code ${e.status}`);
      }
    }

    const elapsed = Date.now() - startMs;
    scenarioTimings.push({ key, name: scenario.name, elapsed });
    console.log(`<<< ${scenario.name} completed in ${Math.round(elapsed / 1000)}s\n`);
  }

  // 打印场景耗时汇总
  console.log('╔══════════════════════════════════════════════════════════════════╗');
  console.log('║              Scenario Wall-clock Summary                       ║');
  console.log('╠══════════════════════════════════════════════════════════════════╣');
  let totalTime = 0;
  for (const t of scenarioTimings) {
    const sec = Math.round(t.elapsed / 1000);
    console.log(`  ${t.name.padEnd(30)} ${String(sec).padStart(4)}s`);
    totalTime += t.elapsed;
  }
  console.log('╟──────────────────────────────────────────────────────────────────╢');
  console.log(`  ${'Total'.padEnd(30)} ${String(Math.round(totalTime / 1000)).padStart(4)}s`);
  console.log('╚══════════════════════════════════════════════════════════════════╝');

  // 读取子进程结果文件，打印总结报告
  const { printSummaryReport } = require('./helpers');
  printSummaryReport(toRun);

  console.log('\nAll benchmarks completed.');
}

main().catch(err => {
  console.error('Benchmark runner failed:', err);
  process.exit(1);
});
