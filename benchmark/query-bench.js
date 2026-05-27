/**
 * 场景 2：查询 (Query) 基准测试
 * - 2a. 冷查询（缓存未命中） vs 热查询（缓存命中）
 * - 2b. 不同数据量下的查询性能
 * - 2c. 缓存失效后查询
 * - 2d. includeChildren 查询
 * - 2e. 不同时间跨度查询
 * - 2f. 不同通道数查询
 * - 2g. 并发查询
 */
const dayjs = require('dayjs');
const {
  createRealFastify, seedDataRecords, seedPeriodStats, ensureChannelMetas,
  measure, measureConcurrent, formatStatsHeader, formatStats, memorySnapshot, formatMemoryDelta,
  createResultCollector, getResultFilePath
} = require('./helpers');

async function run() {
  const results = createResultCollector();
  console.log(formatStatsHeader('场景 2：查询 (Query) 基准测试'));

  // ========== 2a. 冷查询 vs 热查询 (使用 periodStat 表数据) ==========
  {
    const { fastify, cleanup } = await createRealFastify({ pluginOptions: { queryCacheEnabled: true } });
    const now = dayjs().startOf('hour').toDate();
    const oneHourAgo = dayjs(now).subtract(1, 'hour').toDate();
    const channels = ['sensor'];
    const attributeNames = ['temp', 'humidity', 'pressure'];

    await ensureChannelMetas(fastify, channels);
    console.log('\n--- 2a. 冷查询 vs 热查询 (1h, 1 channel, 3 attributes, periodStat 有数据) ---');

    // 插入 periodStat 数据
    await seedPeriodStats(fastify, {
      period: 'h', channels, attributeNames,
      startTime: oneHourAgo, endTime: now,
      intervalMs: 3600000,
      aggregates: ['sum', 'avg', 'count', 'min', 'max']
    });

    // 冷查询 - 首次查询无缓存
    const coldStats = await measure(async () => {
      await fastify.statistics.services.periodStat.query({
        channels, startTime: oneHourAgo, endTime: now, aggregates: ['sum', 'avg', 'count', 'min', 'max']
      });
    }, { iterations: 50, warmup: 3 });

    console.log(`  冷查询 (cache miss): ${coldStats.avgMs} ms, P95=${coldStats.p95Ms} ms, ${coldStats.opsPerSec} ops/sec`);
    results.record('2a. 冷查询', coldStats);

    // 热查询 - 缓存已命中
    const hotStats = await measure(async () => {
      await fastify.statistics.services.periodStat.query({
        channels, startTime: oneHourAgo, endTime: now, aggregates: ['sum', 'avg', 'count', 'min', 'max']
      });
    }, { iterations: 200, warmup: 10 });

    console.log(`  热查询 (cache hit) : ${hotStats.avgMs} ms, P95=${hotStats.p95Ms} ms, ${hotStats.opsPerSec} ops/sec`);
    console.log(`  加速比: ${(coldStats.avgMs / hotStats.avgMs).toFixed(1)}x`);
    results.record('2a. 热查询', hotStats);

    await cleanup();
  }

  // ========== 2b. 不同数据量下的查询性能 ==========
  {
    const dataSizes = [
      { label: '1h-1attr', hours: 1, attrs: 1 },
      { label: '6h-1attr', hours: 6, attrs: 1 },
      { label: '24h-1attr', hours: 24, attrs: 1 },
      { label: '24h-5attr', hours: 24, attrs: 5 },
      { label: '168h-5attr', hours: 168, attrs: 5 },
      { label: '720h-5attr', hours: 720, attrs: 5 }
    ];
    console.log('\n--- 2b. 不同数据量查询 (关闭缓存) ---');

    for (const config of dataSizes) {
      const { fastify, cleanup } = await createRealFastify({ pluginOptions: { queryCacheEnabled: false } });
      const now = dayjs().startOf('hour').toDate();
      const startTime = dayjs(now).subtract(config.hours, 'hour').toDate();
      const channels = ['sensor'];
      const attributeNames = Array.from({ length: config.attrs }, (_, i) => `attr${i}`);

      await ensureChannelMetas(fastify, channels);
      await seedPeriodStats(fastify, {
        period: 'h', channels, attributeNames,
        startTime, endTime: now,
        intervalMs: 3600000,
        aggregates: ['sum', 'avg', 'count', 'min', 'max']
      });

      const stats = await measure(async () => {
        await fastify.statistics.services.periodStat.query({
          channels, startTime, endTime: now, aggregates: ['sum', 'avg']
        });
      }, { iterations: 50, warmup: 5 });

      console.log(`  ${config.label}: ${stats.avgMs} ms, P95=${stats.p95Ms} ms, ${stats.opsPerSec} ops/sec`);
      results.record(`2b. 查询(${config.label})`, stats);
      await cleanup();
    }
  }

  // ========== 2c. 缓存失效后查询 ==========
  {
    const { fastify, cleanup } = await createRealFastify();
    const now = dayjs().startOf('hour').toDate();
    const oneHourAgo = dayjs(now).subtract(1, 'hour').toDate();
    const channels = ['sensor'];

    await ensureChannelMetas(fastify, channels);
    await seedPeriodStats(fastify, {
      period: 'h', channels, attributeNames: ['temp'],
      startTime: oneHourAgo, endTime: now,
      intervalMs: 3600000,
      aggregates: ['sum', 'avg', 'count']
    });

    console.log('\n--- 2c. 缓存失效后查询 ---');

    // 先缓存
    await fastify.statistics.services.periodStat.query({
      channels, startTime: oneHourAgo, endTime: now, aggregates: ['sum']
    });

    const stats = await measure(async () => {
      // 失效缓存
      fastify.statistics.services.periodStat.invalidateQueryCache(channels);
      // 重新查询
      await fastify.statistics.services.periodStat.query({
        channels, startTime: oneHourAgo, endTime: now, aggregates: ['sum']
      });
    }, { iterations: 100, warmup: 5 });

    console.log(`  失效+重查: ${stats.avgMs} ms, P95=${stats.p95Ms} ms, ${stats.opsPerSec} ops/sec`);
    results.record('2c. 缓存失效+重查', stats);

    await cleanup();
  }

  // ========== 2d. includeChildren 查询 ==========
  {
    const { fastify, cleanup } = await createRealFastify({ pluginOptions: { queryCacheEnabled: false } });
    const now = dayjs().startOf('hour').toDate();
    const oneHourAgo = dayjs(now).subtract(1, 'hour').toDate();

    const parentChannels = ['device'];
    const childChannels = ['device:sensor1', 'device:sensor2', 'device:sensor3',
                           'device:sensor4', 'device:sensor5', 'device:sensor6',
                           'device:sensor7', 'device:sensor8', 'device:sensor9', 'device:sensor10'];
    await ensureChannelMetas(fastify, [...parentChannels, ...childChannels]);

    // 给子通道插入 periodStat 数据
    await seedPeriodStats(fastify, {
      period: 'h', channels: childChannels, attributeNames: ['temp'],
      startTime: oneHourAgo, endTime: now,
      intervalMs: 3600000,
      aggregates: ['sum', 'avg']
    });

    console.log('\n--- 2d. includeChildren 查询 (10 子通道) ---');

    // 无 includeChildren
    const flatStats = await measure(async () => {
      await fastify.statistics.services.periodStat.query({
        channels: parentChannels, startTime: oneHourAgo, endTime: now, aggregates: ['sum']
      });
    }, { iterations: 100, warmup: 5 });
    console.log(`  无 includeChildren: ${flatStats.avgMs} ms, ${flatStats.opsPerSec} ops/sec`);
    results.record('2d. 无includeChildren', flatStats);

    // 有 includeChildren
    const treeStats = await measure(async () => {
      await fastify.statistics.services.periodStat.query({
        channels: parentChannels, startTime: oneHourAgo, endTime: now, aggregates: ['sum'], includeChildren: true
      });
    }, { iterations: 100, warmup: 5 });
    console.log(`  有 includeChildren: ${treeStats.avgMs} ms, ${treeStats.opsPerSec} ops/sec`);
    results.record('2d. 有includeChildren', treeStats);
    if (flatStats.avgMs > 0 && treeStats.avgMs > 0) {
      console.log(`  开销: +${((treeStats.avgMs / flatStats.avgMs - 1) * 100).toFixed(0)}%`);
    }

    await cleanup();
  }

  // ========== 2e. 不同通道数查询 ==========
  {
    const channelCounts = [1, 5, 10, 20, 50];
    console.log('\n--- 2e. 不同通道数查询 (1h, period_stat, 无缓存) ---');

    for (const count of channelCounts) {
      const channels = Array.from({ length: count }, (_, i) => `ch${i}`);
      const { fastify, cleanup } = await createRealFastify({ pluginOptions: { queryCacheEnabled: false } });
      const now = dayjs().startOf('hour').toDate();
      const oneHourAgo = dayjs(now).subtract(1, 'hour').toDate();

      await ensureChannelMetas(fastify, channels);
      await seedPeriodStats(fastify, {
        period: 'h', channels, attributeNames: ['temp'],
        startTime: oneHourAgo, endTime: now,
        intervalMs: 3600000,
        aggregates: ['sum', 'avg']
      });

      const stats = await measure(async () => {
        await fastify.statistics.services.periodStat.query({
          channels, startTime: oneHourAgo, endTime: now, aggregates: ['sum', 'avg']
        });
      }, { iterations: 50, warmup: 5 });

      console.log(`  ${count} channels: ${stats.avgMs} ms, P95=${stats.p95Ms} ms, ${stats.opsPerSec} ops/sec`);
      results.record(`2e. ${count}通道查询`, stats);
      await cleanup();
    }
  }

  // ========== 2f. 并发查询 ==========
  {
    const concurrencies = [1, 5, 10, 20];
    console.log('\n--- 2f. 并发查询 (缓存命中, 50 requests) ---');

    for (const c of concurrencies) {
      const { fastify, cleanup } = await createRealFastify({ pluginOptions: { queryCacheEnabled: true } });
      const now = dayjs().startOf('hour').toDate();
      const oneHourAgo = dayjs(now).subtract(1, 'hour').toDate();
      const channels = ['sensor'];

      await ensureChannelMetas(fastify, channels);
      await seedPeriodStats(fastify, {
        period: 'h', channels, attributeNames: ['temp'],
        startTime: oneHourAgo, endTime: now,
        intervalMs: 3600000,
        aggregates: ['sum', 'avg']
      });

      // 预热缓存
      await fastify.statistics.services.periodStat.query({
        channels, startTime: oneHourAgo, endTime: now, aggregates: ['sum', 'avg']
      });

      const stats = await measureConcurrent(async () => {
        await fastify.statistics.services.periodStat.query({
          channels, startTime: oneHourAgo, endTime: now, aggregates: ['sum', 'avg']
        });
      }, { concurrency: c, totalRequests: 50, warmup: 3 });

      console.log(`  concurrency=${c}: ${stats.opsPerSec} ops/sec, P50=${stats.p50Ms} ms, P99=${stats.p99Ms} ms`);
      results.record(`2f. 并发查询(c=${c})`, stats);
      await cleanup();
    }
  }

  results.write(getResultFilePath('query'));
}

run().catch(err => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
