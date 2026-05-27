/**
 * 场景 3 & 4：聚合 (Aggregate) + 补偿 (Compensate) 基准测试
 * - 3a. 从 dataRecord 聚合 (h 周期)
 * - 3b. 从 periodStat 聚合 (d/w/m 周期)
 * - 3c. 不同数据量下的聚合性能
 * - 4a. 小窗口补偿
 * - 4b. 大批量补偿
 * - 4c. 级联补偿
 */
const dayjs = require('dayjs');
const {
  createRealFastify, createCronFastify, setWatermark,
  seedDataRecords, seedPeriodStats, ensureChannelMetas,
  measure, formatStatsHeader, formatStats, memorySnapshot, formatMemoryDelta,
  createResultCollector, getResultFilePath
} = require('./helpers');

async function run() {
  const results = createResultCollector();
  console.log(formatStatsHeader('场景 3：聚合 (Aggregate) 基准测试'));

  // ========== 3a. 从 dataRecord 聚合 (h 周期) ==========
  {
    const recordCounts = [100, 1000, 5000, 10000];
    console.log('\n--- 3a. 从 dataRecord 聚合 (h 周期) ---');

    for (const count of recordCounts) {
      const { fastify, cleanup } = await createRealFastify();
      const now = dayjs().startOf('hour').toDate();
      const oneHourAgo = dayjs(now).subtract(1, 'hour').toDate();
      const channels = ['sensor'];
      const attributeNames = ['temp'];

      await ensureChannelMetas(fastify, channels);
      await seedDataRecords(fastify, {
        recordCount: count, channels, attributeNames,
        startTime: oneHourAgo, endTime: now
      });

      const stats = await measure(async () => {
        await fastify.statistics.services.periodStat.aggregate('h', { startTime: oneHourAgo, endTime: now });
      }, { iterations: 20, warmup: 3 });

      console.log(`  ${count} records: ${stats.avgMs} ms, P95=${stats.p95Ms} ms, ${stats.opsPerSec} ops/sec`);
      results.record(`3a. 聚合(${count}条)`, stats);
      await cleanup();
    }
  }

  // ========== 3b. 从 periodStat 聚合 (d/w/m 周期) ==========
  {
    const periods = [
      { period: 'd', fromPeriod: 'h', label: '日(h→d)', hours: 24 },
      { period: 'w', fromPeriod: 'd', label: '周(d→w)', days: 7 },
      { period: 'm', fromPeriod: 'd', label: '月(d→m)', days: 30 }
    ];

    console.log('\n--- 3b. 从 periodStat 聚合 (不同周期) ---');

    for (const { period, fromPeriod, label, hours, days } of periods) {
      const { fastify, cleanup } = await createRealFastify();
      const now = dayjs().startOf('day').toDate();
      const channels = ['sensor'];
      const attributeNames = ['temp'];

      await ensureChannelMetas(fastify, channels);

      const spanHours = hours || days * 24;
      const startTime = dayjs(now).subtract(spanHours, 'hour').toDate();

      // 先插入源周期数据
      const intervalMs = fromPeriod === 'h' ? 3600000 : 86400000;
      await seedPeriodStats(fastify, {
        period: fromPeriod, channels, attributeNames,
        startTime, endTime: now, intervalMs,
        aggregates: ['sum', 'avg', 'count', 'min', 'max']
      });

      const stats = await measure(async () => {
        await fastify.statistics.services.periodStat.aggregate(period, { startTime, endTime: now });
      }, { iterations: 20, warmup: 3 });

      console.log(`  ${label}: ${stats.avgMs} ms, P95=${stats.p95Ms} ms, ${stats.opsPerSec} ops/sec`);
      results.record(`3b. 聚合(${label})`, stats);
      await cleanup();
    }
  }

  // ========== 3c. 多通道多属性聚合 ==========
  {
    const configs = [
      { channels: 1, attrs: 1, label: '1ch×1attr' },
      { channels: 5, attrs: 3, label: '5ch×3attr' },
      { channels: 10, attrs: 5, label: '10ch×5attr' },
      { channels: 20, attrs: 5, label: '20ch×5attr' }
    ];

    console.log('\n--- 3c. 多通道多属性聚合 (h 周期, 1000 条 data_record) ---');

    for (const config of configs) {
      const { fastify, cleanup } = await createRealFastify();
      const now = dayjs().startOf('hour').toDate();
      const oneHourAgo = dayjs(now).subtract(1, 'hour').toDate();
      const channels = Array.from({ length: config.channels }, (_, i) => `ch${i}`);
      const attributeNames = Array.from({ length: config.attrs }, (_, i) => `attr${i}`);

      await ensureChannelMetas(fastify, channels);
      await seedDataRecords(fastify, {
        recordCount: 1000, channels, attributeNames,
        startTime: oneHourAgo, endTime: now
      });

      const stats = await measure(async () => {
        await fastify.statistics.services.periodStat.aggregate('h', { startTime: oneHourAgo, endTime: now });
      }, { iterations: 20, warmup: 3 });

      console.log(`  ${config.label}: ${stats.avgMs} ms, P95=${stats.p95Ms} ms, ${stats.opsPerSec} ops/sec`);
      results.record(`3c. 多通道聚合(${config.label})`, stats);
      await cleanup();
    }
  }

  // ========== 场景 4：补偿聚合 ==========
  console.log(formatStatsHeader('场景 4：补偿聚合 (Compensate) 基准测试'));

  // ========== 4a. 小窗口补偿 (h 周期) ==========
  {
    const windowCounts = [1, 3, 5, 10];
    console.log('\n--- 4a. 小窗口补偿 (h 周期, 从 dataRecord) ---');

    for (const windowCount of windowCounts) {
      const { fastify, cleanup, createdJobs } = await createCronFastify({ pluginOptions: { compensationBatchSize: 100 } });
      const now = dayjs().startOf('hour').toDate();
      const pastStart = dayjs(now).subtract(windowCount, 'hour').toDate();
      const channels = ['sensor'];
      const attributeNames = ['temp'];

      await ensureChannelMetas(fastify, channels);

      // 插入每个窗口的 data_record
      await seedDataRecords(fastify, {
        recordCount: windowCount * 10, channels, attributeNames,
        startTime: pastStart, endTime: now
      });

      // 设置 watermark 到 pastStart（需要补偿 windowCount 个窗口）
      await setWatermark(fastify, 'h', pastStart);

      const hJob = createdJobs.find(j => j.name === 'statistics-period-stat-h');

      const stats = await measure(async () => {
        // 重置 watermark
        await setWatermark(fastify, 'h', pastStart);
        await hJob.onTick();
      }, { iterations: 10, warmup: 2 });

      console.log(`  ${windowCount} windows: ${stats.avgMs} ms, P95=${stats.p95Ms} ms, per-window: ${Math.round(stats.avgMs / windowCount * 100) / 100} ms`);
      results.record(`4a. 补偿(${windowCount}窗口)`, stats);
      await cleanup();
    }
  }

  // ========== 4b. 大批量补偿 (24h, 72h) ==========
  {
    const batchSizes = [12, 24, 48, 96];
    console.log('\n--- 4b. 大批量补偿 (h 周期, compensationBatchSize 变化) ---');

    for (const batchSize of batchSizes) {
      const { fastify, cleanup, createdJobs } = await createCronFastify({ pluginOptions: { compensationBatchSize: batchSize } });
      const now = dayjs().startOf('hour').toDate();
      const dayAgo = dayjs(now).subtract(24, 'hour').toDate();
      const channels = ['sensor'];
      const attributeNames = ['temp'];

      await ensureChannelMetas(fastify, channels);
      await seedDataRecords(fastify, {
        recordCount: 240, channels, attributeNames,
        startTime: dayAgo, endTime: now
      });

      await setWatermark(fastify, 'h', dayAgo);

      const hJob = createdJobs.find(j => j.name === 'statistics-period-stat-h');

      const start = process.hrtime.bigint();
      await hJob.onTick();
      const end = process.hrtime.bigint();
      const duration = Number(end - start) / 1e6;

      console.log(`  batchSize=${batchSize}: ${Math.round(duration * 100) / 100} ms total`);
      results.record(`4b. 大批量补偿(batch=${batchSize})`, { avgMs: Math.round(duration * 100) / 100, opsPerSec: Math.round(1000 / (duration / 1000)) });
      await cleanup();
    }
  }

  // ========== 4c. 级联补偿 (d → h) ==========
  {
    console.log('\n--- 4c. 级联补偿 (d → h) ---');

    const { fastify, cleanup, createdJobs } = await createCronFastify({ pluginOptions: { compensationBatchSize: 100 } });
    const now = dayjs().startOf('day').toDate();
    const dayAgo = dayjs(now).subtract(1, 'day').toDate();
    const channels = ['sensor'];
    const attributeNames = ['temp'];

    await ensureChannelMetas(fastify, channels);
    await seedDataRecords(fastify, {
      recordCount: 240, channels, attributeNames,
      startTime: dayAgo, endTime: now
    });

    // d 和 h 的 watermark 都在过去
    await setWatermark(fastify, 'd', dayAgo);
    await setWatermark(fastify, 'h', dayAgo);

    const dJob = createdJobs.find(j => j.name === 'statistics-period-stat-d');

    const start = process.hrtime.bigint();
    await dJob.onTick();
    const end = process.hrtime.bigint();
    const duration = Number(end - start) / 1e6;

    console.log(`  d→h 级联补偿: ${Math.round(duration * 100) / 100} ms (含 h 补偿 + d 聚合)`);
    results.record('4c. 级联补偿(d→h)', { avgMs: Math.round(duration * 100) / 100 });

    await cleanup();
  }

  results.write(getResultFilePath('aggregate'));
}

run().catch(err => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
