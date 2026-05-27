/**
 * 场景 1：数据写入 (Collect) 基准测试
 * - 1a. 单条 immediate 写入
 * - 1b. 批量 immediate 写入（通过 API）
 * - 1c. 并发写入
 */
const {
  createRealFastify, ensureChannelMetas, measure, measureConcurrent,
  formatStatsHeader, formatStats, memorySnapshot, formatMemoryDelta,
  createResultCollector, getResultFilePath
} = require('./helpers');

async function run() {
  const results = createResultCollector();
  console.log(formatStatsHeader('场景 1：数据写入 (Collect) 基准测试'));

  // ========== 1a. 单条 immediate 写入 ==========
  {
    const { fastify, cleanup } = await createRealFastify();
    await ensureChannelMetas(fastify, ['sensor']);

    console.log('\n--- 1a. 单条 immediate 写入 (无 cache) ---');
    const memBefore = memorySnapshot();

    const stats = await measure(async () => {
      await fastify.statistics.services.dataRecord.collect({
        channel: 'sensor',
        data: Math.random() * 100,
        time: new Date()
      });
    }, { iterations: 200, warmup: 10 });

    const memAfter = memorySnapshot();
    console.log(formatStats(stats));
    console.log(formatMemoryDelta(memBefore, memAfter));
    results.record('1a. 单条写入', stats);
    await cleanup();
  }

  // ========== 1a-2. 单条写入 - 多属性对象 ==========
  {
    const { fastify, cleanup } = await createRealFastify();
    await ensureChannelMetas(fastify, ['sensor']);

    console.log('\n--- 1a-2. 单条写入 - 多属性对象 data: {temp, humidity, pressure} ---');
    const stats = await measure(async () => {
      await fastify.statistics.services.dataRecord.collect({
        channel: 'sensor',
        data: { temp: Math.random() * 40, humidity: Math.random() * 100, pressure: Math.random() * 1000 },
        unit: { temp: '°C', humidity: '%', pressure: 'hPa' },
        time: new Date()
      });
    }, { iterations: 200, warmup: 10 });

    console.log(formatStats(stats));
    results.record('1a-2. 多属性写入', stats);
    await cleanup();
  }

  // ========== 1a-3. 多级通道写入 ==========
  {
    const { fastify, cleanup } = await createRealFastify();
    await ensureChannelMetas(fastify, ['device']);

    console.log('\n--- 1a-3. 多级通道写入 channel=device:sensor:temp ---');
    const stats = await measure(async () => {
      await fastify.statistics.services.dataRecord.collect({
        channel: 'device:sensor:temp',
        data: Math.random() * 100,
        time: new Date()
      });
    }, { iterations: 200, warmup: 10 });

    console.log(formatStats(stats));
    results.record('1a-3. 多级通道写入', stats);
    await cleanup();
  }

  // ========== 1b. 不同通道数写入 ==========
  {
    const channelCounts = [1, 10, 50, 100];
    console.log('\n--- 1b. 不同通道数写入 ---');

    for (const count of channelCounts) {
      const channels = Array.from({ length: count }, (_, i) => `ch${i}`);
      const { fastify, cleanup } = await createRealFastify();
      await ensureChannelMetas(fastify, channels);

      let idx = 0;
      const stats = await measure(async () => {
        await fastify.statistics.services.dataRecord.collect({
          channel: channels[idx++ % count],
          data: Math.random() * 100,
          time: new Date()
        });
      }, { iterations: 200, warmup: 10 });

      console.log(`  ${count} channels: ${stats.avgMs} ms/op, ${stats.opsPerSec} ops/sec (P95: ${stats.p95Ms} ms)`);
      results.record(`1b. ${count}通道写入`, stats);
      await cleanup();
    }
  }

  // ========== 1c. 批量写入吞吐量 ==========
  {
    const batchSizes = [1, 10, 50, 100];
    console.log('\n--- 1c. 批量写入吞吐量 (API 批量 collect, 1~100 条/批) ---');

    for (const batchSize of batchSizes) {
      const { fastify, cleanup } = await createRealFastify();
      await ensureChannelMetas(fastify, ['sensor']);

      const stats = await measure(async () => {
        const items = Array.from({ length: batchSize }, (_, i) => ({
          channel: 'sensor',
          data: Math.random() * 100,
          attributeName: `attr${i % 3}`,
          time: new Date()
        }));
        for (const item of items) {
          await fastify.statistics.services.dataRecord.collect(item);
        }
      }, { iterations: 20, warmup: 3 });

      const perItem = Math.round(stats.avgMs / batchSize * 100) / 100;
      console.log(`  batch=${batchSize}: total=${stats.avgMs} ms, per-item=${perItem} ms, ${Math.round(batchSize / (stats.avgMs / 1000))} items/sec`);
      results.record(`1c. 批量写入(batch=${batchSize})`, { ...stats, perItemMs: perItem });
      await cleanup();
    }
  }

  results.write(getResultFilePath('collect'));
}

run().catch(err => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
