const { expect } = require('chai');
const { mockPeriodStatService, createQueryMockFastify } = require('./period-stat-helpers');

describe('@kne/fastify-statistics helpers', function () {
  describe('queryFlat / queryTotals', () => {
    it('queryFlat returns normalized records', async () => {
      const { fastify, periodStatRows } = createQueryMockFastify();
      await mockPeriodStatService(fastify, { name: 'statistics' });

      const startTime = new Date('2026-05-01T00:00:00.000Z');
      const endTime = new Date('2026-05-01T01:00:00.000Z');

      periodStatRows.push(
        { period: 'h', channel: 'sensor', attributeName: 'temperature', aggregate: 'sum', data: 100, time: startTime },
        { period: 'h', channel: 'sensor', attributeName: 'humidity', aggregate: 'sum', data: 200, time: startTime }
      );

      const result = await fastify.statistics.services.periodStat.queryFlat({
        channels: ['sensor'],
        startTime,
        endTime,
        aggregates: ['sum']
      });

      expect(result.records).to.have.length(2);
      expect(result.records[0].attributeName).to.equal('temperature');
      await fastify.close();
    });

    it('queryTotals rolls up global and per-channel sums', async () => {
      const { fastify, periodStatRows } = createQueryMockFastify();
      await mockPeriodStatService(fastify, { name: 'statistics' });

      const startTime = new Date('2026-05-01T00:00:00.000Z');
      const endTime = new Date('2026-05-01T01:00:00.000Z');

      periodStatRows.push(
        { period: 'h', channel: 'sensor:a', attributeName: 'invite', aggregate: 'sum', data: 2, time: startTime },
        { period: 'h', channel: 'sensor:b', attributeName: 'invite', aggregate: 'sum', data: 3, time: startTime }
      );

      const result = await fastify.statistics.services.periodStat.queryTotals({
        channels: ['sensor:a', 'sensor:b'],
        startTime,
        endTime,
        aggregates: ['sum']
      });

      expect(result.totals.invite).to.equal(5);
      expect(result.totalsByChannel['sensor:a'].invite).to.equal(2);
      expect(result.meta.retentionPolicy.h.retain).to.equal('currentMonth');
      await fastify.close();
    });

    it('queryTotals takes max per channel instead of summing hour max', async () => {
      const { fastify, periodStatRows } = createQueryMockFastify();
      await mockPeriodStatService(fastify, { name: 'statistics' });

      const t1 = new Date('2026-05-01T00:00:00.000Z');
      const t2 = new Date('2026-05-01T01:00:00.000Z');

      periodStatRows.push(
        { period: 'h', channel: 'sensor:a', attributeName: 'score', aggregate: 'max', data: 79, time: t1 },
        { period: 'h', channel: 'sensor:a', attributeName: 'score', aggregate: 'max', data: 65, time: t2 }
      );

      const result = await fastify.statistics.services.periodStat.queryTotals({
        channels: ['sensor:a'],
        startTime: t1,
        endTime: new Date('2026-05-01T02:00:00.000Z'),
        aggregates: ['max']
      });

      expect(result.maxByChannel['sensor:a'].score).to.equal(79);
      expect(result.attrStats.score.max).to.equal(79);
      await fastify.close();
    });

    it('queryTotals can include raw records', async () => {
      const { fastify, periodStatRows } = createQueryMockFastify();
      await mockPeriodStatService(fastify, { name: 'statistics' });

      const startTime = new Date('2026-05-01T00:00:00.000Z');
      const endTime = new Date('2026-05-01T01:00:00.000Z');

      periodStatRows.push(
        { period: 'h', channel: 'sensor', attributeName: 'invite', aggregate: 'sum', data: 1, time: startTime }
      );

      const result = await fastify.statistics.services.periodStat.queryTotals({
        channels: ['sensor'],
        startTime,
        endTime,
        aggregates: ['sum'],
        includeRecords: true
      });

      expect(result.records).to.have.length(1);
      expect(result.records[0].data).to.equal(1);
      await fastify.close();
    });

    it('queryFlat flattens descendantsTree results', async () => {
      const { fastify, periodStatRows } = createQueryMockFastify();
      await mockPeriodStatService(fastify, { name: 'statistics' });

      const startTime = new Date('2026-05-01T00:00:00.000Z');
      const endTime = new Date('2026-05-01T01:00:00.000Z');

      periodStatRows.push(
        { period: 'h', channel: 'sensor', attributeName: 'invite', aggregate: 'sum', data: 1, time: startTime },
        { period: 'h', channel: 'sensor:a', attributeName: 'invite', aggregate: 'sum', data: 2, time: startTime }
      );

      const result = await fastify.statistics.services.periodStat.queryFlat({
        channels: ['sensor'],
        channelScope: 'descendantsTree',
        startTime,
        endTime,
        aggregates: ['sum']
      });

      const channels = result.records.map(item => item.channel).sort();
      expect(channels).to.deep.equal(['sensor', 'sensor:a']);
      await fastify.close();
    });
  });

  describe('descendantsFlat channelScope', () => {
    it('returns only leaf channels in flat list', async () => {
      const { fastify, periodStatRows } = createQueryMockFastify();
      await mockPeriodStatService(fastify, { name: 'statistics' });

      const startTime = new Date('2026-05-01T00:00:00.000Z');
      const endTime = new Date('2026-05-01T01:00:00.000Z');

      periodStatRows.push(
        { period: 'h', channel: 'interview', attributeName: 'invite', aggregate: 'sum', data: 10, time: startTime },
        { period: 'h', channel: 'interview:1', attributeName: 'invite', aggregate: 'sum', data: 5, time: startTime },
        { period: 'h', channel: 'interview:1:2', attributeName: 'invite', aggregate: 'sum', data: 2, time: startTime },
        { period: 'h', channel: 'interview:1:3', attributeName: 'invite', aggregate: 'sum', data: 3, time: startTime }
      );

      const { list } = await fastify.statistics.services.periodStat.query({
        channels: ['interview'],
        channelScope: 'descendantsFlat',
        startTime,
        endTime,
        aggregates: ['sum']
      });

      const channels = list.map(item => item.channel).sort();
      expect(channels).to.deep.equal(['interview:1:2', 'interview:1:3']);
      await fastify.close();
    });

    it('respects maxDepth when filtering leaf channels', async () => {
      const { fastify, periodStatRows } = createQueryMockFastify();
      await mockPeriodStatService(fastify, { name: 'statistics' });

      const startTime = new Date('2026-05-01T00:00:00.000Z');
      const endTime = new Date('2026-05-01T01:00:00.000Z');

      periodStatRows.push(
        { period: 'h', channel: 'interview:1:2', attributeName: 'invite', aggregate: 'sum', data: 2, time: startTime },
        { period: 'h', channel: 'interview:1:2:3', attributeName: 'invite', aggregate: 'sum', data: 4, time: startTime }
      );

      const { list } = await fastify.statistics.services.periodStat.query({
        channels: ['interview:1'],
        channelScope: 'descendantsFlat',
        maxDepth: 3,
        startTime,
        endTime,
        aggregates: ['sum']
      });

      expect(list.map(item => item.channel)).to.deep.equal(['interview:1:2']);
      await fastify.close();
    });

    it('maps includeChildren to descendantsTree', async () => {
      const { fastify, periodStatRows } = createQueryMockFastify();
      await mockPeriodStatService(fastify, { name: 'statistics' });

      const startTime = new Date('2026-05-01T00:00:00.000Z');
      const endTime = new Date('2026-05-01T01:00:00.000Z');

      periodStatRows.push(
        { period: 'h', channel: 'sensor', attributeName: 'invite', aggregate: 'sum', data: 1, time: startTime },
        { period: 'h', channel: 'sensor:a', attributeName: 'invite', aggregate: 'sum', data: 2, time: startTime }
      );

      const { list, meta } = await fastify.statistics.services.periodStat.query({
        channels: ['sensor'],
        includeChildren: true,
        startTime,
        endTime,
        aggregates: ['sum']
      });

      expect(meta.channelScope).to.equal('descendantsTree');
      expect(list[0].children).to.be.an('array');
      await fastify.close();
    });
  });

  describe('getRetentionPolicy', () => {
    it('exposes retention rules', async () => {
      const { fastify } = createQueryMockFastify();
      await mockPeriodStatService(fastify, { name: 'statistics', dataRetentionDays: 7 });

      const policy = fastify.statistics.services.periodStat.getRetentionPolicy();
      expect(policy.dataRecord.days).to.equal(7);
      expect(policy.periodStat.h.retain).to.equal('currentMonth');
      await fastify.close();
    });
  });
});
