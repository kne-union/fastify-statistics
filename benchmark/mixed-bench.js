/**
 * 场景 5：混合负载基准测试
 * - 5a. 读写混合
 * - 5b. 高频写入 + 缓存失效
 */
const dayjs = require('dayjs');
const {
  createRealFastify, seedDataRecords, seedPeriodStats, ensureChannelMetas,
  measureConcurrent, formatStatsHeader, memorySnapshot, formatMemoryDelta,
  createResultCollector, getResultFilePath
} = require('./helpers');

async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function run() {
  const results = createResultCollector();
  console.log(formatStatsHeader('场景 5：混合负载基准测试'));

  // ========== 5a. 读写混合 ==========
  {
    // SQLite 限制：使用交替读写模式（写一次、读一次）
    console.log('\n--- 5a. 读写交替 (50 次写+50 次读, 串行交替) ---');

    const { fastify, cleanup } = await createRealFastify();
    const now = new Date();
    const oneHourAgo = dayjs(now).subtract(1, 'hour').toDate();
    const channels = ['sensor'];
    await ensureChannelMetas(fastify, channels);

    // 预填充一些数据让查询有结果
    await seedDataRecords(fastify, {
      recordCount: 500, channels, attributeNames: ['temp'],
      startTime: oneHourAgo, endTime: now
    });

    const writeDurations = [];
    const readDurations = [];
    let writeErrors = 0;
    let readErrors = 0;

    const memBefore = memorySnapshot();
    const start = process.hrtime.bigint();

    // 交替：先写后读，50 轮
    for (let i = 0; i < 50; i++) {
      // 写入
      try {
        const ws = process.hrtime.bigint();
        await fastify.statistics.services.dataRecord.collect({
          channel: 'sensor',
          data: Math.random() * 100,
          time: new Date()
        });
        writeDurations.push(Number(process.hrtime.bigint() - ws) / 1e6);
      } catch (e) {
        writeErrors++;
      }

      // 查询（缓存命中）
      try {
        const rs = process.hrtime.bigint();
        await fastify.statistics.services.periodStat.query({
          channels, startTime: oneHourAgo, endTime: new Date(), aggregates: ['sum', 'avg']
        });
        readDurations.push(Number(process.hrtime.bigint() - rs) / 1e6);
      } catch (e) {
        readErrors++;
      }
    }

    const wallTime = Number(process.hrtime.bigint() - start) / 1e6;
    const memAfter = memorySnapshot();

    const computeLatency = (durations) => {
      const sorted = durations.sort((a, b) => a - b);
      const avg = sorted.reduce((a, b) => a + b, 0) / sorted.length;
      const p50 = sorted[Math.floor(sorted.length * 0.5)];
      const p95 = sorted[Math.floor(sorted.length * 0.95)];
      const p99 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))];
      return { avg: Math.round(avg * 100) / 100, p50: Math.round(p50 * 100) / 100, p95: Math.round(p95 * 100) / 100, p99: Math.round(p99 * 100) / 100 };
    };

    const writeLat = computeLatency(writeDurations);
    const readLat = computeLatency(readDurations);

    console.log(`  总耗时: ${Math.round(wallTime)} ms`);
    console.log(`  写入: avg=${writeLat.avg} ms, P50=${writeLat.p50} ms, P95=${writeLat.p95} ms, errors=${writeErrors}`);
    console.log(`  读取: avg=${readLat.avg} ms, P50=${readLat.p50} ms, P95=${readLat.p95} ms, errors=${readErrors}`);
    console.log(formatMemoryDelta(memBefore, memAfter));
    results.record('5a. 读写混合-写入', { avgMs: writeLat.avg, p50Ms: writeLat.p50, p95Ms: writeLat.p95, p99Ms: writeLat.p99, opsPerSec: Math.round(1000 / writeLat.avg) });
    results.record('5a. 读写混合-读取', { avgMs: readLat.avg, p50Ms: readLat.p50, p95Ms: readLat.p95, p99Ms: readLat.p99, opsPerSec: Math.round(1000 / readLat.avg) });

    await cleanup();
  }

  // ========== 5b. 写入频率对查询性能的影响 ==========
  {
    console.log('\n--- 5b. 写入频率对查询性能的影响 (串行写入) ---');

    const { fastify, cleanup } = await createRealFastify();
    const now = new Date();
    const oneHourAgo = dayjs(now).subtract(1, 'hour').toDate();
    const channels = ['sensor'];
    await ensureChannelMetas(fastify, channels);

    await seedDataRecords(fastify, {
      recordCount: 500, channels, attributeNames: ['temp'],
      startTime: oneHourAgo, endTime: now
    });

    // 基线：无写入干扰的查询性能
    const baselineDurations = [];
    for (let i = 0; i < 20; i++) {
      fastify.statistics.services.periodStat.invalidateQueryCache(channels);
      const start = process.hrtime.bigint();
      await fastify.statistics.services.periodStat.query({
        channels, startTime: oneHourAgo, endTime: new Date(), aggregates: ['sum']
      });
      baselineDurations.push(Number(process.hrtime.bigint() - start) / 1e6);
    }
    const baselineAvg = baselineDurations.reduce((a, b) => a + b, 0) / baselineDurations.length;

    // 有写入干扰：先写一条，再查
    const interferedDurations = [];
    for (let i = 0; i < 20; i++) {
      await fastify.statistics.services.dataRecord.collect({
        channel: 'sensor',
        data: Math.random() * 100,
        time: new Date()
      });
      fastify.statistics.services.periodStat.invalidateQueryCache(channels);
      const start = process.hrtime.bigint();
      await fastify.statistics.services.periodStat.query({
        channels, startTime: oneHourAgo, endTime: new Date(), aggregates: ['sum']
      });
      interferedDurations.push(Number(process.hrtime.bigint() - start) / 1e6);
    }

    const interferedAvg = interferedDurations.reduce((a, b) => a + b, 0) / interferedDurations.length;
    const degradation = ((interferedAvg / baselineAvg - 1) * 100).toFixed(0);

    console.log(`  基线查询 (无写入): avg=${Math.round(baselineAvg * 100) / 100} ms`);
    console.log(`  干扰查询 (写后查): avg=${Math.round(interferedAvg * 100) / 100} ms`);
    console.log(`  性能退化: ${degradation}%`);
    results.record('5b. 基线查询', { avgMs: Math.round(baselineAvg * 100) / 100, opsPerSec: Math.round(1000 / baselineAvg) });
    results.record('5b. 干扰查询', { avgMs: Math.round(interferedAvg * 100) / 100, opsPerSec: Math.round(1000 / interferedAvg), degradation: `${degradation}%` });

    await cleanup();
  }

  // ========== 5c. 批量写入后聚合全流程 ==========
  {
    console.log('\n--- 5c. 完整流程: 批量写入 → h 聚合 → 查询 ---');

    const { fastify, cleanup } = await createRealFastify();
    const channels = ['sensor'];
    const attributeNames = ['temp'];
    await ensureChannelMetas(fastify, channels);

    // 1. 写入 1000 条数据
    const writeStart = process.hrtime.bigint();
    for (let i = 0; i < 1000; i++) {
      await fastify.statistics.services.dataRecord.collect({
        channel: channels[i % channels.length],
        data: Math.random() * 100,
        attributeName: attributeNames[i % attributeNames.length],
        time: new Date(Date.now() - Math.floor(Math.random() * 3600000))
      });
    }
    const writeEnd = process.hrtime.bigint();
    const writeTime = Number(writeEnd - writeStart) / 1e6;

    // 2. 聚合 h 周期
    const now = dayjs().startOf('hour').toDate();
    const oneHourAgo = dayjs(now).subtract(1, 'hour').toDate();

    const aggStart = process.hrtime.bigint();
    await fastify.statistics.services.periodStat.aggregate('h', { startTime: oneHourAgo, endTime: now });
    const aggEnd = process.hrtime.bigint();
    const aggTime = Number(aggEnd - aggStart) / 1e6;

    // 3. 查询
    const queryStart = process.hrtime.bigint();
    await fastify.statistics.services.periodStat.query({
      channels, startTime: oneHourAgo, endTime: now, aggregates: ['sum', 'avg', 'count', 'min', 'max']
    });
    const queryEnd = process.hrtime.bigint();
    const queryTime = Number(queryEnd - queryStart) / 1e6;

    console.log(`  写入 1000 条: ${Math.round(writeTime)} ms (${Math.round(1000 / (writeTime / 1000))} ops/sec)`);
    console.log(`  h 聚合: ${Math.round(aggTime * 100) / 100} ms`);
    console.log(`  查询: ${Math.round(queryTime * 100) / 100} ms`);
    console.log(`  总流程: ${Math.round(writeTime + aggTime + queryTime)} ms`);
    results.record('5c. 完整流程', { avgMs: Math.round(writeTime + aggTime + queryTime), writeMs: Math.round(writeTime), aggMs: Math.round(aggTime * 100) / 100, queryMs: Math.round(queryTime * 100) / 100 });

    await cleanup();
  }

  results.write(getResultFilePath('mixed'));
}

run().catch(err => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
