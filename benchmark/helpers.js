const fp = require('fastify-plugin');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const dayjs = require('dayjs');

/**
 * 创建使用真实 SQLite 数据库的 Fastify 实例
 * 直接注册各 service 插件，绕过 index.js 对 fastify-cron 的依赖
 * @param {object} [options]
 * @param {string} [options.dbPath] - SQLite 文件路径，默认临时文件
 * @param {object} [options.pluginOptions] - 传给 services 的选项
 * @returns {Promise<{fastify, dbPath, cleanup}>}
 */
async function createRealFastify({ dbPath, pluginOptions = {} } = {}) {
  if (!dbPath) {
    dbPath = path.join(os.tmpdir(), `benchmark-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  }

  const fastify = require('fastify')({ logger: false });

  // 注册 sequelize（关闭 SQL 日志，启用 WAL 模式支持并发读写）
  await fastify.register(require('@kne/fastify-sequelize'), {
    db: {
      dialect: 'sqlite',
      storage: dbPath,
      logging: false,
      dialectOptions: {
        mode: require('sqlite3').OPEN_READWRITE | require('sqlite3').OPEN_CREATE
      }
    },
    syncOptions: { alter: true }
  });

  // 加载模型
  const models = await fastify.sequelize.addModels(
    path.resolve(__dirname, '../libs/models'),
    { prefix: 't_', modelPrefix: 'statistics' }
  );

  // 同步数据库（建表）
  await fastify.sequelize.sync();

  // 启用 WAL 模式 + busy timeout，支持并发读写
  const seqInstance = fastify.sequelize.instance;
  await seqInstance.query('PRAGMA journal_mode=WAL');
  await seqInstance.query('PRAGMA busy_timeout=5000');

  // 注册 namespace + services（不经过 index.js，无需 fastify-cron）
  await fastify.register(require('@kne/fastify-namespace'), {
    options: Object.assign({
      prefix: '/api/statistics',
      dbTableNamePrefix: 't_',
      name: 'statistics',
      compensationEnabled: false,
      queryCacheEnabled: true,
      dataRetentionDays: 365
    }, pluginOptions),
    name: 'statistics',
    modules: [
      ['models', models],
      ['services', path.resolve(__dirname, '../libs/services')]
    ]
  });

  // 初始化 periodStat 服务（必须在 ready 之后调用 init）
  await fastify.ready();
  await fastify.statistics.services.periodStat.init();

  const cleanup = async () => {
    await fastify.close();
    try { fs.unlinkSync(dbPath); } catch (e) { /* ignore */ }
  };

  return { fastify, dbPath, cleanup };
}

/**
 * 批量插入 data_record 种子数据
 * @param {object} fastify - 已初始化的 fastify 实例
 * @param {object} options
 * @param {number} options.recordCount - 记录总数
 * @param {string[]} options.channels - 通道列表
 * @param {string[]} options.attributeNames - 属性名列表
 * @param {Date} options.startTime - 起始时间
 * @param {Date} options.endTime - 结束时间
 * @param {number} [options.batchSize=500] - 每批写入量
 */
async function seedDataRecords(fastify, { recordCount, channels, attributeNames, startTime, endTime, batchSize = 500 }) {
  const models = fastify.statistics.models;
  const range = endTime.getTime() - startTime.getTime();
  const records = [];

  for (let i = 0; i < recordCount; i++) {
    const channel = channels[i % channels.length];
    const attributeName = attributeNames[i % attributeNames.length];
    const time = new Date(startTime.getTime() + Math.floor(Math.random() * range));
    records.push({
      channel,
      attributeName,
      data: Math.round(Math.random() * 1000 * 100) / 100,
      time,
      unit: 'unit'
    });

    if (records.length >= batchSize) {
      await models.dataRecord.bulkCreate(records);
      records.length = 0;
    }
  }
  if (records.length > 0) {
    await models.dataRecord.bulkCreate(records);
  }
}

/**
 * 批量插入 period_stat 种子数据
 * @param {object} fastify
 * @param {object} options
 * @param {string} options.period - 周期
 * @param {string[]} options.channels
 * @param {string[]} options.attributeNames
 * @param {Date} options.startTime
 * @param {Date} options.endTime
 * @param {number} options.intervalMs - 每条记录间隔毫秒
 * @param {string[]} [options.aggregates] - 聚合类型列表
 */
async function seedPeriodStats(fastify, { period, channels, attributeNames, startTime, endTime, intervalMs, aggregates = ['sum', 'avg', 'count', 'min', 'max'], batchSize = 500 }) {
  const models = fastify.statistics.models;
  const records = [];

  for (let t = startTime.getTime(); t < endTime.getTime(); t += intervalMs) {
    for (const channel of channels) {
      for (const attributeName of attributeNames) {
        for (const aggregate of aggregates) {
          records.push({
            period,
            time: new Date(t),
            channel,
            attributeName,
            aggregate,
            data: Math.round(Math.random() * 1000 * 100) / 100,
            unit: 'unit'
          });

          if (records.length >= batchSize) {
            await models.periodStat.bulkCreate(records, { updateOnDuplicate: ['data'] });
            records.length = 0;
          }
        }
      }
    }
  }
  if (records.length > 0) {
    await models.periodStat.bulkCreate(records, { updateOnDuplicate: ['data'] });
  }
}

/**
 * 确保所有 channel 的 channelMeta 存在
 */
async function ensureChannelMetas(fastify, channels) {
  const models = fastify.statistics.models;
  for (const channel of channels) {
    await models.channelMeta.findOrCreate({
      where: { channel },
      defaults: { title: channel, description: '' }
    });
  }
}

/**
 * 测量异步函数执行时间
 * @param {Function} fn - 异步函数
 * @param {number} iterations - 执行次数
 * @param {number} warmup - 预热次数
 * @returns {{durations: number[], stats: object}}
 */
async function measure(fn, { iterations = 100, warmup = 5 } = {}) {
  // 预热
  for (let i = 0; i < warmup; i++) {
    await fn();
  }

  const durations = [];
  for (let i = 0; i < iterations; i++) {
    const start = process.hrtime.bigint();
    await fn();
    const end = process.hrtime.bigint();
    durations.push(Number(end - start) / 1e6); // 转为 ms
  }

  return computeStats(durations);
}

/**
 * 并发测量
 * @param {Function} fn - 异步函数
 * @param {number} concurrency - 并发数
 * @param {number} totalRequests - 总请求数
 * @param {number} warmup - 预热次数
 */
async function measureConcurrent(fn, { concurrency = 10, totalRequests = 100, warmup = 5 } = {}) {
  // 预热
  for (let i = 0; i < warmup; i++) {
    await fn();
  }

  const durations = [];
  let completed = 0;
  let errors = 0;

  const runOne = async () => {
    try {
      const start = process.hrtime.bigint();
      await fn();
      const end = process.hrtime.bigint();
      durations.push(Number(end - start) / 1e6);
    } catch (e) {
      errors++;
    }
    completed++;
  };

  const start = process.hrtime.bigint();
  const promises = [];
  for (let i = 0; i < totalRequests; i++) {
    promises.push(runOne());
  }
  await Promise.all(promises);
  const wallTime = Number(process.hrtime.bigint() - start) / 1e6;

  const stats = durations.length > 0 ? computeStats(durations) : { avgMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, minMs: 0, maxMs: 0 };
  stats.opsPerSec = Math.round((totalRequests - errors) / (wallTime / 1000));
  stats.concurrency = concurrency;
  stats.totalRequests = totalRequests;
  stats.wallTimeMs = Math.round(wallTime * 100) / 100;
  stats.errors = errors;

  return stats;
}

function computeStats(durations) {
  const sorted = [...durations].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const avg = sum / sorted.length;

  const percentile = (p) => {
    const idx = Math.ceil(sorted.length * p) - 1;
    return Math.round(sorted[Math.max(0, idx)] * 100) / 100;
  };

  return {
    iterations: sorted.length,
    avgMs: Math.round(avg * 100) / 100,
    minMs: Math.round(sorted[0] * 100) / 100,
    maxMs: Math.round(sorted[sorted.length - 1] * 100) / 100,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    p99Ms: percentile(0.99),
    opsPerSec: Math.round(1000 / avg)
  };
}

function formatStatsHeader(title) {
  const line = '='.repeat(70);
  return `\n${line}\n  ${title}\n${line}`;
}

function formatStats(stats) {
  const lines = [
    `  Iterations    : ${stats.iterations}`,
    `  Avg           : ${stats.avgMs} ms`,
    `  Min           : ${stats.minMs} ms`,
    `  Max           : ${stats.maxMs} ms`,
    `  P50           : ${stats.p50Ms} ms`,
    `  P95           : ${stats.p95Ms} ms`,
    `  P99           : ${stats.p99Ms} ms`,
    `  Ops/sec       : ${stats.opsPerSec}`
  ];
  if (stats.concurrency) {
    lines.push(`  Concurrency   : ${stats.concurrency}`);
    lines.push(`  Total reqs    : ${stats.totalRequests}`);
    lines.push(`  Wall time     : ${stats.wallTimeMs} ms`);
  }
  return lines.join('\n');
}

function memorySnapshot() {
  const mem = process.memoryUsage();
  return {
    rssMB: Math.round(mem.rss / 1024 / 1024 * 100) / 100,
    heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024 * 100) / 100,
    heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024 * 100) / 100,
    externalMB: Math.round(mem.external / 1024 / 1024 * 100) / 100
  };
}

function formatMemoryDelta(before, after) {
  const delta = {
    rssMB: Math.round((after.rssMB - before.rssMB) * 100) / 100,
    heapUsedMB: Math.round((after.heapUsedMB - before.heapUsedMB) * 100) / 100
  };
  return `  Memory Δ RSS: ${delta.rssMB > 0 ? '+' : ''}${delta.rssMB} MB, Heap: ${delta.heapUsedMB > 0 ? '+' : ''}${delta.heapUsedMB} MB`;
}

/**
 * 创建结果收集器，用于在子进程 benchmark 中记录每个测试的结果
 * @returns {{ record: Function, write: Function }}
 */
function createResultCollector() {
  const results = [];
  return {
    record(testName, stats) {
      const entry = { testName };
      if (stats.avgMs !== undefined) entry.avgMs = stats.avgMs;
      if (stats.p50Ms !== undefined) entry.p50Ms = stats.p50Ms;
      if (stats.p95Ms !== undefined) entry.p95Ms = stats.p95Ms;
      if (stats.p99Ms !== undefined) entry.p99Ms = stats.p99Ms;
      if (stats.opsPerSec !== undefined) entry.opsPerSec = stats.opsPerSec;
      if (stats.minMs !== undefined) entry.minMs = stats.minMs;
      if (stats.maxMs !== undefined) entry.maxMs = stats.maxMs;
      if (stats.iterations !== undefined) entry.iterations = stats.iterations;
      if (stats.concurrency !== undefined) entry.concurrency = stats.concurrency;
      if (stats.wallTimeMs !== undefined) entry.wallTimeMs = stats.wallTimeMs;
      // 允许存入自定义字段
      for (const k of Object.keys(stats)) {
        if (!entry.hasOwnProperty(k)) entry[k] = stats[k];
      }
      results.push(entry);
    },
    write(filePath) {
      if (!filePath) {
        filePath = path.join(os.tmpdir(), `benchmark-results-${Date.now()}.json`);
      }
      fs.writeFileSync(filePath, JSON.stringify(results, null, 2));
      return filePath;
    },
    getResults() {
      return results;
    }
  };
}

/**
 * 获取场景结果文件路径（确定性，供主进程读取）
 * @param {string} scenarioKey
 * @returns {string}
 */
function getResultFilePath(scenarioKey) {
  return path.join(os.tmpdir(), `benchmark-results-${scenarioKey}.json`);
}

/**
 * 读取并汇总所有场景结果，打印总结报告
 * @param {string[]} scenarioKeys
 */
function printSummaryReport(scenarioKeys) {
  const allResults = [];
  for (const key of scenarioKeys) {
    const filePath = getResultFilePath(key);
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const results = JSON.parse(content);
      for (const r of results) {
        allResults.push({ scenario: key, ...r });
      }
    } catch (e) {
      // skip missing results
    }
  }

  if (allResults.length === 0) {
    console.log('\nNo results collected for summary.');
    return;
  }

  // 表格列宽
  const col = {
    scenario: 8,
    test: 44,
    avg: 10,
    p50: 10,
    p95: 10,
    p99: 10,
    ops: 12
  };

  const sep = '─'.repeat(col.scenario + col.test + col.avg + col.p50 + col.p95 + col.p99 + col.ops + 7 * 3 - 3);

  const pad = (s, w) => String(s).padEnd(w);

  const totalWidth = col.scenario + col.test + col.avg + col.p50 + col.p95 + col.p99 + col.ops + 7 * 3 - 3;

  console.log('');
  console.log('╔' + '═'.repeat(totalWidth) + '╗');
  console.log('║' + '  Benchmark Summary Report'.padEnd(totalWidth) + '║');
  console.log('╠' + '═'.repeat(totalWidth) + '╣');

  // Header
  const header = `║ ${pad('Scenario', col.scenario)} │ ${pad('Test', col.test)} │ ${pad('Avg(ms)', col.avg)} │ ${pad('P50(ms)', col.p50)} │ ${pad('P95(ms)', col.p95)} │ ${pad('P99(ms)', col.p99)} │ ${pad('Ops/sec', col.ops)} ║`;
  console.log(header);
  console.log('╟' + sep + '╢');

  let currentScenario = '';
  for (const r of allResults) {
    const scenarioLabel = r.scenario !== currentScenario ? r.scenario : '';
    currentScenario = r.scenario;

    const avgMs = r.avgMs !== undefined ? String(r.avgMs) : '-';
    const p50Ms = r.p50Ms !== undefined ? String(r.p50Ms) : '-';
    const p95Ms = r.p95Ms !== undefined ? String(r.p95Ms) : '-';
    const p99Ms = r.p99Ms !== undefined ? String(r.p99Ms) : '-';
    const ops = r.opsPerSec !== undefined ? String(r.opsPerSec) : '-';

    const line = `║ ${pad(scenarioLabel, col.scenario)} │ ${pad(r.testName || '-', col.test)} │ ${pad(avgMs, col.avg)} │ ${pad(p50Ms, col.p50)} │ ${pad(p95Ms, col.p95)} │ ${pad(p99Ms, col.p99)} │ ${pad(ops, col.ops)} ║`;
    console.log(line);
  }

  console.log('╚' + '═'.repeat(totalWidth) + '╝');

  // 清理临时文件
  for (const key of scenarioKeys) {
    try { fs.unlinkSync(getResultFilePath(key)); } catch (e) { /* ignore */ }
  }
}

/**
 * 创建带 cron 支持的 Fastify 实例（用于 compensate 基准测试）
 * cron 任务被收集到 createdJobs 数组，便于手动触发 onTick
 * @param {object} [options]
 * @param {string} [options.dbPath] - SQLite 文件路径
 * @param {object} [options.pluginOptions] - 传给 services 的选项
 * @returns {Promise<{fastify, dbPath, cleanup, createdJobs}>}
 */
async function createCronFastify({ dbPath, pluginOptions = {} } = {}) {
  if (!dbPath) {
    dbPath = path.join(os.tmpdir(), `benchmark-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  }

  const fastify = require('fastify')({ logger: false });

  // 注册 sequelize
  await fastify.register(require('@kne/fastify-sequelize'), {
    db: {
      dialect: 'sqlite',
      storage: dbPath,
      logging: false,
      dialectOptions: {
        mode: require('sqlite3').OPEN_READWRITE | require('sqlite3').OPEN_CREATE
      }
    },
    syncOptions: { alter: true }
  });

  // 加载模型
  const models = await fastify.sequelize.addModels(
    path.resolve(__dirname, '../libs/models'),
    { prefix: 't_', modelPrefix: 'statistics' }
  );

  // 同步数据库
  await fastify.sequelize.sync();

  // 启用 WAL 模式
  const seqInstance = fastify.sequelize.instance;
  await seqInstance.query('PRAGMA journal_mode=WAL');
  await seqInstance.query('PRAGMA busy_timeout=5000');

  // 收集 cron jobs
  const createdJobs = [];

  // 注册 namespace + services（带 cron 收集器）
  await fastify.register(require('@kne/fastify-namespace'), {
    options: Object.assign({
      prefix: '/api/statistics',
      dbTableNamePrefix: 't_',
      name: 'statistics',
      compensationEnabled: false,
      queryCacheEnabled: true,
      dataRetentionDays: 365
    }, pluginOptions),
    name: 'statistics',
    modules: [
      ['models', models],
      ['services', path.resolve(__dirname, '../libs/services')]
    ]
  });

  // 注册 cron 收集器（必须在 namespace 之后，因为 periodStat init() 会检查 fastify.cron）
  fastify.decorate('cron', {
    createJob: (jobConfig) => { createdJobs.push(jobConfig); }
  });

  // 初始化 periodStat 服务
  await fastify.ready();
  await fastify.statistics.services.periodStat.init();

  const cleanup = async () => {
    await fastify.close();
    try { fs.unlinkSync(dbPath); } catch (e) { /* ignore */ }
  };

  return { fastify, dbPath, cleanup, createdJobs };
}

/**
 * 设置指定周期的 watermark（兼容 findOne+update/create 模式）
 * @param {object} fastify
 * @param {string} period
 * @param {Date} nextTime
 */
async function setWatermark(fastify, period, nextTime) {
  const models = fastify.statistics.models;
  const existing = await models.aggregationWatermark.findOne({ where: { period } });
  if (existing) {
    await existing.update({ nextTime });
  } else {
    await models.aggregationWatermark.create({ period, nextTime });
  }
}

module.exports = {
  createRealFastify,
  createCronFastify,
  setWatermark,
  seedDataRecords,
  seedPeriodStats,
  ensureChannelMetas,
  measure,
  measureConcurrent,
  computeStats,
  formatStatsHeader,
  formatStats,
  memorySnapshot,
  formatMemoryDelta,
  createResultCollector,
  getResultFilePath,
  printSummaryReport
};
