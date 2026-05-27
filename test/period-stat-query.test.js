const { expect } = require('chai');
const {
  mockPeriodStatService, createQueryMockFastify, createCacheTestMockFastify,
  createExternalCacheMockFastify, createFullMockFastify
} = require('./period-stat-helpers');

describe('@kne/fastify-statistics', function () {
  describe('query 查询测试', () => {
    describe('query 方法', () => {
      const { createQueryMockFastify: localCreateQueryMockFastify } = { createQueryMockFastify };

      it('should return attribute-keyed object when single aggregate and single default attribute with no filter', async () => {
        const { fastify, periodStatRows } = localCreateQueryMockFastify();
        await mockPeriodStatService(fastify, { name: 'statistics' });

        const startTime = new Date('2026-05-01T00:00:00.000Z');
        const endTime = new Date('2026-05-01T01:00:00.000Z');

        periodStatRows.push({
          period: 'h', channel: 'sensor', attributeName: 'default',
          aggregate: 'sum', data: 100, time: startTime
        });

        const { list: results, channelMetas } = await fastify.statistics.services.periodStat.query({
          channels: ['sensor'], startTime, endTime, aggregates: ['sum']
        });

        expect(results.length).to.equal(1);
        expect(results[0].channel).to.equal('sensor');
        expect(results[0].period).to.equal('h');
        expect(results[0].data).to.deep.equal({ default: 100 });

        await fastify.close();
      });

      it('should return attribute-keyed object when single aggregate and multiple attributes', async () => {
        const { fastify, periodStatRows } = localCreateQueryMockFastify();
        await mockPeriodStatService(fastify, { name: 'statistics' });

        const startTime = new Date('2026-05-01T00:00:00.000Z');
        const endTime = new Date('2026-05-01T01:00:00.000Z');

        periodStatRows.push(
          { period: 'h', channel: 'sensor', attributeName: 'temperature', aggregate: 'sum', data: 100, time: startTime },
          { period: 'h', channel: 'sensor', attributeName: 'humidity', aggregate: 'sum', data: 200, time: startTime }
        );

        const { list: results, channelMetas } = await fastify.statistics.services.periodStat.query({
          channels: ['sensor'], startTime, endTime, aggregates: ['sum']
        });

        expect(results.length).to.equal(1);
        expect(results[0].data).to.deep.equal({ temperature: 100, humidity: 200 });

        await fastify.close();
      });

      it('should return nested object when multiple aggregates and single default attribute', async () => {
        const { fastify, periodStatRows } = localCreateQueryMockFastify();
        await mockPeriodStatService(fastify, { name: 'statistics' });

        const startTime = new Date('2026-05-01T00:00:00.000Z');
        const endTime = new Date('2026-05-01T01:00:00.000Z');

        periodStatRows.push(
          { period: 'h', channel: 'sensor', attributeName: 'default', aggregate: 'sum', data: 100, time: startTime },
          { period: 'h', channel: 'sensor', attributeName: 'default', aggregate: 'avg', data: 25, time: startTime }
        );

        const { list: results, channelMetas } = await fastify.statistics.services.periodStat.query({
          channels: ['sensor'], startTime, endTime, aggregates: ['sum', 'avg']
        });

        expect(results.length).to.equal(1);
        expect(results[0].data).to.deep.equal({ sum: { default: 100 }, avg: { default: 25 } });

        await fastify.close();
      });

      it('should return nested object when multiple aggregates and multiple attributes', async () => {
        const { fastify, periodStatRows } = localCreateQueryMockFastify();
        await mockPeriodStatService(fastify, { name: 'statistics' });

        const startTime = new Date('2026-05-01T00:00:00.000Z');
        const endTime = new Date('2026-05-01T01:00:00.000Z');

        periodStatRows.push(
          { period: 'h', channel: 'sensor', attributeName: 'temperature', aggregate: 'sum', data: 100, time: startTime },
          { period: 'h', channel: 'sensor', attributeName: 'humidity', aggregate: 'sum', data: 200, time: startTime },
          { period: 'h', channel: 'sensor', attributeName: 'temperature', aggregate: 'avg', data: 25, time: startTime },
          { period: 'h', channel: 'sensor', attributeName: 'humidity', aggregate: 'avg', data: 50, time: startTime }
        );

        const { list: results, channelMetas } = await fastify.statistics.services.periodStat.query({
          channels: ['sensor'], startTime, endTime, aggregates: ['sum', 'avg']
        });

        expect(results.length).to.equal(1);
        expect(results[0].data).to.deep.equal({
          sum: { temperature: 100, humidity: 200 },
          avg: { temperature: 25, humidity: 50 }
        });

        await fastify.close();
      });

      it('should not flatten default attribute when attributeNames filter is provided', async () => {
        const { fastify, periodStatRows } = localCreateQueryMockFastify();
        await mockPeriodStatService(fastify, { name: 'statistics' });

        const startTime = new Date('2026-05-01T00:00:00.000Z');
        const endTime = new Date('2026-05-01T01:00:00.000Z');

        periodStatRows.push(
          { period: 'h', channel: 'sensor', attributeName: 'default', aggregate: 'sum', data: 100, time: startTime }
        );

        const { list: results, channelMetas } = await fastify.statistics.services.periodStat.query({
          channels: ['sensor'], startTime, endTime, attributeNames: ['default'], aggregates: ['sum']
        });

        expect(results[0].data).to.deep.equal({ default: 100 });

        await fastify.close();
      });

      it('should query all child channels', async () => {
        const { fastify, periodStatRows, channelMetaRows } = localCreateQueryMockFastify();
        await mockPeriodStatService(fastify, { name: 'statistics' });

        const startTime = new Date('2026-05-01T00:00:00.000Z');
        const endTime = new Date('2026-05-01T01:00:00.000Z');

        periodStatRows.push(
          { period: 'h', channel: 'sensor', attributeName: 'default', aggregate: 'sum', data: 100, time: startTime },
          { period: 'h', channel: 'sensor:room1', attributeName: 'default', aggregate: 'sum', data: 50, time: startTime },
          { period: 'h', channel: 'sensor:room2', attributeName: 'default', aggregate: 'sum', data: 30, time: startTime }
        );
        channelMetaRows.push({ channel: 'sensor', title: '传感器', description: '温度' });

        const { list: results, channelMetas } = await fastify.statistics.services.periodStat.query({
          channels: ['sensor'], startTime, endTime, aggregates: ['sum'], includeChildren: true
        });

        expect(results.length).to.equal(1);
        const root = results[0];
        expect(root.channel).to.equal('sensor');
        expect(root.items[0].data).to.deep.equal({ default: 100 });
        expect(root.children.length).to.equal(2);
        const childChannels = root.children.map(c => c.channel);
        expect(childChannels).to.include('sensor:room1');
        expect(childChannels).to.include('sensor:room2');
        const room1 = root.children.find(c => c.channel === 'sensor:room1');
        expect(room1.items[0].data).to.deep.equal({ default: 50 });

        expect(channelMetas).to.have.property('sensor');
        expect(channelMetas.sensor.title).to.equal('传感器');
        expect(Object.keys(channelMetas).length).to.equal(1);

        await fastify.close();
      });

      it('should query data from all period types in single query', async () => {
        const { fastify, periodStatRows, findAllCalls } = localCreateQueryMockFastify();
        await mockPeriodStatService(fastify, { name: 'statistics' });

        const startTime = new Date('2026-05-01T00:00:00.000Z');
        const endTime = new Date('2026-05-01T01:00:00.000Z');

        periodStatRows.push(
          { period: 'h', channel: 'sensor', attributeName: 'default', aggregate: 'sum', data: 10, time: startTime },
          { period: 'd', channel: 'sensor', attributeName: 'default', aggregate: 'sum', data: 240, time: startTime }
        );

        const { list: results, channelMetas } = await fastify.statistics.services.periodStat.query({
          channels: ['sensor'], startTime, endTime, aggregates: ['sum']
        });

        const periodTypes = results.map(r => r.period);
        expect(periodTypes).to.include('h');
        expect(periodTypes).to.include('d');

        const psCalls = findAllCalls.filter(c => c.model === 'periodStat');
        expect(psCalls.length).to.equal(1);
        expect(psCalls[0].opts.where.period).to.deep.equal({ in: ['h', 'd', 'w', 'm', 'q', 'y'] });

        await fastify.close();
      });

      it('should return empty array when no data found', async () => {
        const { fastify, periodStatRows } = localCreateQueryMockFastify();
        await mockPeriodStatService(fastify, { name: 'statistics' });

        const startTime = new Date('2026-05-01T00:00:00.000Z');
        const endTime = new Date('2026-05-01T01:00:00.000Z');

        const { list: results, channelMetas } = await fastify.statistics.services.periodStat.query({
          channels: ['nonexistent'], startTime, endTime, aggregates: ['sum']
        });

        expect(results).to.deep.equal([]);
        expect(channelMetas).to.deep.equal({});

        await fastify.close();
      });

      it('should filter by attributeNames when provided', async () => {
        const { fastify, periodStatRows } = localCreateQueryMockFastify();
        await mockPeriodStatService(fastify, { name: 'statistics' });

        const startTime = new Date('2026-05-01T00:00:00.000Z');
        const endTime = new Date('2026-05-01T01:00:00.000Z');

        periodStatRows.push(
          { period: 'h', channel: 'sensor', attributeName: 'temperature', aggregate: 'sum', data: 100, time: startTime }
        );

        const { list: results, channelMetas } = await fastify.statistics.services.periodStat.query({
          channels: ['sensor'], startTime, endTime, attributeNames: ['temperature'], aggregates: ['sum']
        });

        expect(results.length).to.equal(1);
        expect(results[0].data).to.deep.equal({ temperature: 100 });

        await fastify.close();
      });

      it('should query data-record for current hour and format correctly', async () => {
        const { fastify, periodStatRows, dataRecordFindAllResult, findAllCalls } = localCreateQueryMockFastify();
        await mockPeriodStatService(fastify, { name: 'statistics' });

        const now = new Date();
        const startTime = new Date(now.getTime() - 3600000);
        const endTime = new Date(now.getTime() + 3600000);

        dataRecordFindAllResult.push({
          channel: 'sensor', attributeName: 'temperature',
          sum: 50, avg: 25, count: 2, min: 10, max: 40
        });

        const { list: results, channelMetas } = await fastify.statistics.services.periodStat.query({
          channels: ['sensor'], startTime, endTime, aggregates: ['sum']
        });

        const drCalls = findAllCalls.filter(c => c.model === 'dataRecord');
        expect(drCalls.length).to.be.greaterThan(0);

        const hourResult = results.find(r => r.period === 'h' && r.channel === 'sensor');
        if (hourResult) {
          expect(hourResult.data).to.deep.equal({ temperature: 50 });
        }

        await fastify.close();
      });

      it('should return all aggregates when aggregates not specified', async () => {
        const { fastify, periodStatRows } = localCreateQueryMockFastify();
        await mockPeriodStatService(fastify, { name: 'statistics' });

        const startTime = new Date('2026-05-01T00:00:00.000Z');
        const endTime = new Date('2026-05-01T01:00:00.000Z');

        periodStatRows.push(
          { period: 'h', channel: 'sensor', attributeName: 'default', aggregate: 'sum', data: 100, time: startTime },
          { period: 'h', channel: 'sensor', attributeName: 'default', aggregate: 'avg', data: 25, time: startTime },
          { period: 'h', channel: 'sensor', attributeName: 'default', aggregate: 'count', data: 4, time: startTime },
          { period: 'h', channel: 'sensor', attributeName: 'default', aggregate: 'min', data: 10, time: startTime },
          { period: 'h', channel: 'sensor', attributeName: 'default', aggregate: 'max', data: 40, time: startTime }
        );

        const { list: results, channelMetas } = await fastify.statistics.services.periodStat.query({
          channels: ['sensor'], startTime, endTime
        });

        expect(results.length).to.equal(1);
        expect(results[0].data).to.deep.equal({ sum: { default: 100 }, avg: { default: 25 }, count: { default: 4 }, min: { default: 10 }, max: { default: 40 } });

        await fastify.close();
      });

      it('should sort results by time', async () => {
        const { fastify, periodStatRows } = localCreateQueryMockFastify();
        await mockPeriodStatService(fastify, { name: 'statistics' });

        const startTime = new Date('2026-05-01T00:00:00.000Z');
        const endTime = new Date('2026-05-01T03:00:00.000Z');

        const time2 = new Date('2026-05-01T02:00:00.000Z');
        const time0 = new Date('2026-05-01T00:00:00.000Z');
        const time1 = new Date('2026-05-01T01:00:00.000Z');

        periodStatRows.push(
          { period: 'h', channel: 'sensor', attributeName: 'default', aggregate: 'sum', data: 30, time: time2 },
          { period: 'h', channel: 'sensor', attributeName: 'default', aggregate: 'sum', data: 10, time: time0 },
          { period: 'h', channel: 'sensor', attributeName: 'default', aggregate: 'sum', data: 20, time: time1 }
        );

        const { list: results, channelMetas } = await fastify.statistics.services.periodStat.query({
          channels: ['sensor'], startTime, endTime, aggregates: ['sum']
        });

        expect(results[0].data).to.deep.equal({ default: 10 });
        expect(results[1].data).to.deep.equal({ default: 20 });
        expect(results[2].data).to.deep.equal({ default: 30 });

        await fastify.close();
      });

      it('should use client timezone to determine current hour when timezone is provided', async () => {
        const { fastify, periodStatRows, dataRecordFindAllResult, findAllCalls } = localCreateQueryMockFastify();
        await mockPeriodStatService(fastify, { name: 'statistics' });

        const now = new Date();
        const startTime = new Date(now.getTime() - 3600000);
        const endTime = new Date(now.getTime() + 3600000);

        dataRecordFindAllResult.push({
          channel: 'sensor', attributeName: 'temperature',
          sum: 50, avg: null, count: null, min: null, max: null
        });

        const resultsNoTz = await fastify.statistics.services.periodStat.query({
          channels: ['sensor'], startTime, endTime, aggregates: ['sum']
        });

        const resultsWithTz = await fastify.statistics.services.periodStat.query({
          channels: ['sensor'], startTime, endTime, aggregates: ['sum'], timezone: 'Asia/Shanghai'
        });

        const drCallsNoTz = findAllCalls.filter(c => c.model === 'dataRecord');
        expect(drCallsNoTz.length).to.be.greaterThan(0);

        await fastify.close();
      });

      it('should calculate different current hour boundaries for different timezones', async () => {
        const { fastify, periodStatRows, dataRecordFindAllResult, findAllCalls } = localCreateQueryMockFastify();
        await mockPeriodStatService(fastify, { name: 'statistics' });

        const now = new Date();
        const startTime = new Date(now.getTime() - 7200000);
        const endTime = new Date(now.getTime() + 3600000);

        dataRecordFindAllResult.push({
          channel: 'sensor', attributeName: 'default',
          sum: 100, avg: null, count: null, min: null, max: null
        });

        await fastify.statistics.services.periodStat.query({
          channels: ['sensor'], startTime, endTime, aggregates: ['sum'], timezone: 'America/New_York'
        });

        const drCalls = findAllCalls.filter(c => c.model === 'dataRecord');
        expect(drCalls.length).to.be.greaterThan(0);

        await fastify.close();
      });

      it('should throw error for invalid timezone', async () => {
        const { fastify } = localCreateQueryMockFastify();
        await mockPeriodStatService(fastify, { name: 'statistics' });

        const startTime = new Date('2026-05-01T00:00:00.000Z');
        const endTime = new Date('2026-05-01T01:00:00.000Z');

        try {
          await fastify.statistics.services.periodStat.query({
            channels: ['sensor'], startTime, endTime, aggregates: ['sum'], timezone: 'Invalid/Timezone'
          });
          expect.fail('should have thrown');
        } catch (e) {
          expect(e.message).to.include('Invalid timezone');
        }

        await fastify.close();
      });

      it('should query without channel filter and return channelMetas', async () => {
        const { fastify, periodStatRows, channelMetaRows } = localCreateQueryMockFastify();
        await mockPeriodStatService(fastify, { name: 'statistics' });

        const startTime = new Date('2026-05-01T00:00:00.000Z');
        const endTime = new Date('2026-05-01T01:00:00.000Z');

        periodStatRows.push(
          { period: 'h', channel: 'sensor1', attributeName: 'default', aggregate: 'sum', data: 100, time: startTime },
          { period: 'h', channel: 'sensor2', attributeName: 'default', aggregate: 'sum', data: 200, time: startTime }
        );
        channelMetaRows.push(
          { channel: 'sensor1', title: '传感器1', description: null },
          { channel: 'sensor2', title: '传感器2', description: '温度' }
        );

        const { list: results, channelMetas } = await fastify.statistics.services.periodStat.query({
          startTime, endTime, aggregates: ['sum']
        });

        expect(results.length).to.equal(2);
        expect(Object.keys(channelMetas).length).to.equal(2);
        expect(channelMetas.sensor1.title).to.equal('传感器1');
        expect(channelMetas.sensor2.title).to.equal('传感器2');

        await fastify.close();
      });

      it('should handle null attributeName with single aggregate and no filter', async () => {
        const { fastify, periodStatRows } = localCreateQueryMockFastify();
        await mockPeriodStatService(fastify, { name: 'statistics' });

        const startTime = new Date('2026-05-01T00:00:00.000Z');
        const endTime = new Date('2026-05-01T01:00:00.000Z');

        periodStatRows.push(
          { period: 'h', channel: 'sensor', attributeName: null, aggregate: 'sum', data: 100, time: startTime }
        );

        const { list: results, channelMetas } = await fastify.statistics.services.periodStat.query({
          channels: ['sensor'], startTime, endTime, aggregates: ['sum']
        });

        expect(results.length).to.equal(1);
        expect(results[0].data).to.deep.equal({ default: 100 });

        await fastify.close();
      });

      it('should handle null attributeName with single aggregate and attributeNames filter', async () => {
        const { fastify, periodStatRows } = localCreateQueryMockFastify();
        await mockPeriodStatService(fastify, { name: 'statistics' });

        const startTime = new Date('2026-05-01T00:00:00.000Z');
        const endTime = new Date('2026-05-01T01:00:00.000Z');

        periodStatRows.push(
          { period: 'h', channel: 'sensor', attributeName: null, aggregate: 'sum', data: 100, time: startTime }
        );

        const { list: results, channelMetas } = await fastify.statistics.services.periodStat.query({
          channels: ['sensor'], startTime, endTime, attributeNames: ['value'], aggregates: ['sum']
        });

        expect(results.length).to.equal(1);
        expect(results[0].data).to.deep.equal({ default: 100 });

        await fastify.close();
      });

      it('should handle null attributeName with multiple aggregates and attributeNames filter', async () => {
        const { fastify, periodStatRows } = localCreateQueryMockFastify();
        await mockPeriodStatService(fastify, { name: 'statistics' });

        const startTime = new Date('2026-05-01T00:00:00.000Z');
        const endTime = new Date('2026-05-01T01:00:00.000Z');

        periodStatRows.push(
          { period: 'h', channel: 'sensor', attributeName: null, aggregate: 'sum', data: 100, time: startTime },
          { period: 'h', channel: 'sensor', attributeName: null, aggregate: 'avg', data: 25, time: startTime }
        );

        const { list: results, channelMetas } = await fastify.statistics.services.periodStat.query({
          channels: ['sensor'], startTime, endTime, attributeNames: ['value'], aggregates: ['sum', 'avg']
        });

        expect(results.length).to.equal(1);
        expect(results[0].data).to.deep.equal({
          sum: { default: 100 },
          avg: { default: 25 }
        });

        await fastify.close();
      });

      it('should skip undefined aggregate values from data-record in query', async () => {
        const { fastify, dataRecordFindAllResult } = localCreateQueryMockFastify();
        await mockPeriodStatService(fastify, { name: 'statistics' });

        const now = new Date();
        const startTime = new Date(now.getTime() - 3600000);
        const endTime = new Date(now.getTime() + 3600000);

        dataRecordFindAllResult.push({
          channel: 'sensor', attributeName: 'temperature',
          sum: 50, avg: undefined, count: undefined, min: undefined, max: undefined
        });

        const { list: results, channelMetas } = await fastify.statistics.services.periodStat.query({
          channels: ['sensor'], startTime, endTime, aggregates: ['sum', 'avg']
        });

        const hourResult = results.find(r => r.period === 'h');
        if (hourResult) {
          expect(hourResult.data).to.deep.equal({ temperature: 50 });
        }

        await fastify.close();
      });

      it('should use startTime as drStartTime when startTime is after currentHourStart', async () => {
        const { fastify, periodStatRows, dataRecordFindAllResult, findAllCalls } = localCreateQueryMockFastify();
        await mockPeriodStatService(fastify, { name: 'statistics' });

        const now = new Date();
        const currentHourStart = new Date(now);
        currentHourStart.setMinutes(0, 0, 0);
        const startTime = new Date(currentHourStart.getTime() + 30 * 60 * 1000);
        const endTime = new Date(currentHourStart.getTime() + 60 * 60 * 1000);

        dataRecordFindAllResult.push({
          channel: 'sensor', attributeName: 'default',
          sum: 100, avg: null, count: null, min: null, max: null
        });

        const { list: results, channelMetas } = await fastify.statistics.services.periodStat.query({
          channels: ['sensor'], startTime, endTime, aggregates: ['sum']
        });

        expect(results.length).to.be.greaterThan(0);

        await fastify.close();
      });

      it('should handle null attributeName in data-record query results', async () => {
        const { fastify, periodStatRows, dataRecordFindAllResult, findAllCalls } = localCreateQueryMockFastify();
        await mockPeriodStatService(fastify, { name: 'statistics' });

        const now = new Date();
        const startTime = new Date(now.getTime() - 3600000);
        const endTime = new Date(now.getTime() + 3600000);

        dataRecordFindAllResult.push({
          channel: 'sensor', attributeName: null,
          sum: 100, avg: null, count: null, min: null, max: null
        });

        const { list: results, channelMetas } = await fastify.statistics.services.periodStat.query({
          channels: ['sensor'], startTime, endTime, aggregates: ['sum']
        });

        const drCalls = findAllCalls.filter(c => c.model === 'dataRecord');
        expect(drCalls.length).to.be.greaterThan(0);

        await fastify.close();
      });
    });

    describe('查询缓存测试（内存模式）', () => {
      it('should cache query result and return from cache on second call', async () => {
        const { fastify, periodStatRows, findAllCalls } = createCacheTestMockFastify();
        await mockPeriodStatService(fastify, { name: 'statistics', compensationEnabled: false });

        const startTime = new Date('2026-05-01T00:00:00.000Z');
        const endTime = new Date('2026-05-01T01:00:00.000Z');

        periodStatRows.push(
          { period: 'h', channel: 'sensor', attributeName: 'default', aggregate: 'sum', data: 100, time: startTime }
        );

        const result1 = await fastify.statistics.services.periodStat.query({
          channels: ['sensor'], startTime, endTime, aggregates: ['sum']
        });
        expect(result1.list.length).to.be.greaterThan(0);

        const callsAfterFirst = findAllCalls.filter(c => c.model === 'periodStat').length;

        const result2 = await fastify.statistics.services.periodStat.query({
          channels: ['sensor'], startTime, endTime, aggregates: ['sum']
        });

        const callsAfterSecond = findAllCalls.filter(c => c.model === 'periodStat').length;
        expect(callsAfterSecond).to.equal(callsAfterFirst);
        expect(result2).to.deep.equal(result1);

        await fastify.close();
      });

      it('should invalidate cache when invalidateQueryCache is called', async () => {
        const { fastify, periodStatRows, findAllCalls } = createCacheTestMockFastify();
        await mockPeriodStatService(fastify, { name: 'statistics' });

        const startTime = new Date('2026-05-01T00:00:00.000Z');
        const endTime = new Date('2026-05-01T01:00:00.000Z');

        periodStatRows.push(
          { period: 'h', channel: 'sensor', attributeName: 'default', aggregate: 'sum', data: 100, time: startTime }
        );

        await fastify.statistics.services.periodStat.query({
          channels: ['sensor'], startTime, endTime, aggregates: ['sum']
        });

        const callsAfterFirst = findAllCalls.length;

        fastify.statistics.services.periodStat.invalidateQueryCache(['sensor']);

        periodStatRows.push(
          { period: 'h', channel: 'sensor', attributeName: 'default', aggregate: 'avg', data: 50, time: startTime }
        );

        const result = await fastify.statistics.services.periodStat.query({
          channels: ['sensor'], startTime, endTime, aggregates: ['sum', 'avg']
        });
        expect(findAllCalls.length).to.be.greaterThan(callsAfterFirst);

        await fastify.close();
      });

      it('should not cache when queryCacheEnabled is false', async () => {
        const { fastify, periodStatRows, findAllCalls } = createCacheTestMockFastify();
        await mockPeriodStatService(fastify, { name: 'statistics', queryCacheEnabled: false });

        const startTime = new Date('2026-05-01T00:00:00.000Z');
        const endTime = new Date('2026-05-01T01:00:00.000Z');

        periodStatRows.push(
          { period: 'h', channel: 'sensor', attributeName: 'default', aggregate: 'sum', data: 100, time: startTime }
        );

        await fastify.statistics.services.periodStat.query({
          channels: ['sensor'], startTime, endTime, aggregates: ['sum']
        });

        const callsAfterFirst = findAllCalls.length;

        await fastify.statistics.services.periodStat.query({
          channels: ['sensor'], startTime, endTime, aggregates: ['sum']
        });

        expect(findAllCalls.length).to.be.greaterThan(callsAfterFirst);

        await fastify.close();
      });

      it('should evict oldest entry when memory cache exceeds maxEntries', async () => {
        const { fastify, periodStatRows } = createCacheTestMockFastify();
        await mockPeriodStatService(fastify, { name: 'statistics', queryCacheMaxEntries: 2 });

        const startTime = new Date('2026-05-01T00:00:00.000Z');
        const endTime = new Date('2026-05-01T01:00:00.000Z');

        periodStatRows.push(
          { period: 'h', channel: 'ch1', attributeName: 'default', aggregate: 'sum', data: 10, time: startTime },
          { period: 'h', channel: 'ch2', attributeName: 'default', aggregate: 'sum', data: 20, time: startTime },
          { period: 'h', channel: 'ch3', attributeName: 'default', aggregate: 'sum', data: 30, time: startTime }
        );

        await fastify.statistics.services.periodStat.query({ channels: ['ch1'], startTime, endTime, aggregates: ['sum'] });
        await fastify.statistics.services.periodStat.query({ channels: ['ch2'], startTime, endTime, aggregates: ['sum'] });
        await fastify.statistics.services.periodStat.query({ channels: ['ch3'], startTime, endTime, aggregates: ['sum'] });

        periodStatRows.push(
          { period: 'h', channel: 'ch1', attributeName: 'default', aggregate: 'sum', data: 11, time: startTime }
        );

        const result = await fastify.statistics.services.periodStat.query({ channels: ['ch1'], startTime, endTime, aggregates: ['sum'] });
        expect(result.list[0].data.default).to.equal(11);

        await fastify.close();
      });

      it('should use historyTTL for non-realtime queries', async () => {
        const { fastify, periodStatRows } = createCacheTestMockFastify();
        await mockPeriodStatService(fastify, { name: 'statistics', queryCacheTTL: 1, queryCacheHistoryTTL: 3600 });

        const startTime = new Date('2020-05-01T00:00:00.000Z');
        const endTime = new Date('2020-05-01T01:00:00.000Z');

        periodStatRows.push(
          { period: 'h', channel: 'sensor', attributeName: 'default', aggregate: 'sum', data: 100, time: startTime }
        );

        await fastify.statistics.services.periodStat.query({
          channels: ['sensor'], startTime, endTime, aggregates: ['sum']
        });

        await new Promise(resolve => setTimeout(resolve, 1100));

        const result = await fastify.statistics.services.periodStat.query({
          channels: ['sensor'], startTime, endTime, aggregates: ['sum']
        });
        expect(result.list[0].data.default).to.equal(100);

        await fastify.close();
      });

      it('should not cache when isCompensating is true', async () => {
        const { fastify, periodStatRows } = createCacheTestMockFastify();
        await mockPeriodStatService(fastify, { name: 'statistics', compensationEnabled: false });

        const startTime = new Date('2026-05-01T00:00:00.000Z');
        const endTime = new Date('2026-05-01T01:00:00.000Z');

        periodStatRows.push(
          { period: 'h', channel: 'sensor', attributeName: 'default', aggregate: 'sum', data: 100, time: startTime }
        );

        await fastify.statistics.services.periodStat.query({
          channels: ['sensor'], startTime, endTime, aggregates: ['sum']
        });

        expect(fastify.statistics.services.periodStat.isCompensating()).to.be.false;

        await fastify.close();
      });
    });

    describe('查询缓存测试（外部缓存模式）', () => {
      it('should cache query result in external cache and return from cache on second call', async () => {
        const { fastify, periodStatRows, externalCache } = createExternalCacheMockFastify();
        await mockPeriodStatService(fastify, { name: 'statistics', cache: externalCache, compensationEnabled: false });

        const startTime = new Date('2026-05-01T00:00:00.000Z');
        const endTime = new Date('2026-05-01T01:00:00.000Z');

        periodStatRows.push(
          { period: 'h', channel: 'sensor', attributeName: 'default', aggregate: 'sum', data: 100, time: startTime }
        );

        const result1 = await fastify.statistics.services.periodStat.query({
          channels: ['sensor'], startTime, endTime, aggregates: ['sum']
        });
        expect(result1.list.length).to.be.greaterThan(0);

        fastify.statistics.models.periodStat.findAll = async () => [];

        const result2 = await fastify.statistics.services.periodStat.query({
          channels: ['sensor'], startTime, endTime, aggregates: ['sum']
        });

        expect(result2.list.length).to.be.greaterThan(0);

        await fastify.close();
      });

      it('should return null from external cache when payload is invalid', async () => {
        const cacheStore = {};
        const externalCache = {
          get: async (key) => cacheStore[key] || null,
          set: async (key, value, ttl) => { cacheStore[key] = value; }
        };

        const periodStatRows = [];
        const findAllCalls = [];
        const mockTransaction = { commit: async () => {}, rollback: async () => {} };
        const mockModel = {
          dataRecord: { findAll: async (opts) => { findAllCalls.push({ model: 'dataRecord', opts }); return []; }, findOne: async () => null, destroy: async () => {} },
          periodStat: { bulkCreate: async () => {}, findAll: async (opts) => { findAllCalls.push({ model: 'periodStat', opts }); return periodStatRows.splice(0); }, findOne: async () => null },
          channelMeta: { findAll: async () => [] },
          aggregationWatermark: { findOne: async () => null, upsert: async () => {}, create: async (d) => d }
        };

        const fastify = require('fastify')();
        fastify.decorate('sequelize', {
          Sequelize: { Op: { between: 'between', like: 'like', or: 'or', in: 'in' }, fn: (n, c) => `${n}(${c})`, col: n => n },
          instance: { transaction: async () => mockTransaction }
        });
        fastify.decorate('statistics', { models: mockModel, services: {} });

        await mockPeriodStatService(fastify, { name: 'statistics', cache: externalCache });

        const startTime = new Date('2026-05-01T00:00:00.000Z');
        const endTime = new Date('2026-05-01T01:00:00.000Z');

        const cacheKey = 'statistics:query:' + JSON.stringify({ channels: ['sensor'], startTime: startTime.toISOString(), endTime: endTime.toISOString(), attributeNames: [], aggregates: ['sum'], timezone: '', includeChildren: false });
        cacheStore[cacheKey] = 'not-an-object';

        periodStatRows.push(
          { period: 'h', channel: 'sensor', attributeName: 'default', aggregate: 'sum', data: 100, time: startTime }
        );

        const result = await fastify.statistics.services.periodStat.query({
          channels: ['sensor'], startTime, endTime, aggregates: ['sum']
        });

        expect(findAllCalls.length).to.be.greaterThan(0);

        await fastify.close();
      });

      it('should invalidate external cache when channel version changes', async () => {
        const { fastify, periodStatRows, cacheStore, externalCache } = createExternalCacheMockFastify();
        await mockPeriodStatService(fastify, { name: 'statistics', cache: externalCache });

        const startTime = new Date('2026-05-01T00:00:00.000Z');
        const endTime = new Date('2026-05-01T01:00:00.000Z');

        periodStatRows.push(
          { period: 'h', channel: 'sensor', attributeName: 'default', aggregate: 'sum', data: 100, time: startTime }
        );

        await fastify.statistics.services.periodStat.query({
          channels: ['sensor'], startTime, endTime, aggregates: ['sum']
        });

        fastify.statistics.services.periodStat.invalidateQueryCache(['sensor']);

        periodStatRows.push(
          { period: 'h', channel: 'sensor', attributeName: 'default', aggregate: 'sum', data: 200, time: startTime }
        );

        const result = await fastify.statistics.services.periodStat.query({
          channels: ['sensor'], startTime, endTime, aggregates: ['sum']
        });
        expect(result.list[0].data.default).to.equal(200);

        await fastify.close();
      });

      it('should handle external cache with 3-argument set (TTL support)', async () => {
        const cacheStore = {};
        const setCalls = [];
        const externalCache = {
          get: async (key) => cacheStore[key] || null,
          set: async (key, value, ttl) => {
            setCalls.push({ key, value, ttl });
            cacheStore[key] = value;
          }
        };

        const periodStatRows = [];
        const mockTransaction = { commit: async () => {}, rollback: async () => {} };
        const mockModel = {
          dataRecord: { findAll: async () => [], findOne: async () => null, destroy: async () => {} },
          periodStat: { bulkCreate: async () => {}, findAll: async () => periodStatRows.splice(0), findOne: async () => null },
          channelMeta: { findAll: async () => [] },
          aggregationWatermark: { findOne: async () => null, upsert: async () => {}, create: async (d) => d }
        };

        const fastify = require('fastify')();
        fastify.decorate('sequelize', {
          Sequelize: { Op: { between: 'between', like: 'like', or: 'or', in: 'in' }, fn: (n, c) => `${n}(${c})`, col: n => n },
          instance: { transaction: async () => mockTransaction }
        });
        fastify.decorate('statistics', { models: mockModel, services: {} });

        await mockPeriodStatService(fastify, { name: 'statistics', cache: externalCache, compensationEnabled: false });

        const startTime = new Date('2026-05-01T00:00:00.000Z');
        const endTime = new Date('2026-05-01T01:00:00.000Z');

        periodStatRows.push(
          { period: 'h', channel: 'sensor', attributeName: 'default', aggregate: 'sum', data: 100, time: startTime }
        );

        await fastify.statistics.services.periodStat.query({
          channels: ['sensor'], startTime, endTime, aggregates: ['sum']
        });

        expect(setCalls.length).to.be.greaterThan(0);
        const queryCacheSet = setCalls.find(c => c.key.includes('statistics:query:'));
        expect(queryCacheSet).to.exist;
        expect(queryCacheSet.ttl).to.exist;

        await fastify.close();
      });
    });

    describe('queryCache 版本失效测试（内存模式）', () => {
      it('should invalidate memory cache when globalVersion changes', async () => {
        const { fastify, periodStatRows, findAllCalls } = createFullMockFastify();
        await mockPeriodStatService(fastify, { name: 'statistics', compensationEnabled: false });

        const now = new Date();
        const startTime = new Date(now.getTime() - 3600000);
        const endTime = new Date(now.getTime() + 3600000);

        periodStatRows.push(
          { period: 'h', channel: 'sensor', attributeName: 'default', aggregate: 'sum', data: 100, time: startTime }
        );

        await fastify.statistics.services.periodStat.query({
          startTime, endTime, aggregates: ['sum']
        });

        const callsAfterFirst = findAllCalls.filter(c => c.model === 'periodStat').length;

        fastify.statistics.services.periodStat.invalidateQueryCache([]);

        periodStatRows.push(
          { period: 'h', channel: 'sensor', attributeName: 'default', aggregate: 'sum', data: 200, time: startTime }
        );

        await fastify.statistics.services.periodStat.query({
          startTime, endTime, aggregates: ['sum']
        });

        expect(findAllCalls.filter(c => c.model === 'periodStat').length).to.be.greaterThan(callsAfterFirst);

        await fastify.close();
      });

      it('should invalidate memory cache when channelVersion changes', async () => {
        const { fastify, periodStatRows, findAllCalls } = createFullMockFastify();
        await mockPeriodStatService(fastify, { name: 'statistics', compensationEnabled: false });

        const now = new Date();
        const startTime = new Date(now.getTime() - 3600000);
        const endTime = new Date(now.getTime() + 3600000);

        periodStatRows.push(
          { period: 'h', channel: 'sensor', attributeName: 'default', aggregate: 'sum', data: 100, time: startTime }
        );

        await fastify.statistics.services.periodStat.query({
          channels: ['sensor'], startTime, endTime, aggregates: ['sum']
        });

        const callsAfterFirst = findAllCalls.filter(c => c.model === 'periodStat').length;

        fastify.statistics.services.periodStat.invalidateQueryCache(['sensor']);

        periodStatRows.push(
          { period: 'h', channel: 'sensor', attributeName: 'default', aggregate: 'sum', data: 200, time: startTime }
        );

        await fastify.statistics.services.periodStat.query({
          channels: ['sensor'], startTime, endTime, aggregates: ['sum']
        });

        expect(findAllCalls.filter(c => c.model === 'periodStat').length).to.be.greaterThan(callsAfterFirst);

        await fastify.close();
      });

      it('should not return expired memory cache entries', async () => {
        const { fastify, periodStatRows, findAllCalls } = createFullMockFastify();
        await mockPeriodStatService(fastify, { name: 'statistics', compensationEnabled: false, queryCacheTTL: 1 });

        const now = new Date();
        const rtStart = new Date(now.getTime() - 3600000);
        const rtEnd = new Date(now.getTime() + 3600000);

        periodStatRows.push(
          { period: 'h', channel: 'sensor', attributeName: 'default', aggregate: 'sum', data: 100, time: rtStart }
        );

        await fastify.statistics.services.periodStat.query({
          channels: ['sensor'], startTime: rtStart, endTime: rtEnd, aggregates: ['sum']
        });

        const callsAfterFirst = findAllCalls.filter(c => c.model === 'periodStat').length;

        await new Promise(resolve => setTimeout(resolve, 1100));

        periodStatRows.push(
          { period: 'h', channel: 'sensor', attributeName: 'default', aggregate: 'sum', data: 200, time: rtStart }
        );

        await fastify.statistics.services.periodStat.query({
          channels: ['sensor'], startTime: rtStart, endTime: rtEnd, aggregates: ['sum']
        });

        expect(findAllCalls.filter(c => c.model === 'periodStat').length).to.be.greaterThan(callsAfterFirst);

        await fastify.close();
      });

      it('should set globalVersion in memory cache for realtime query with no channels', async () => {
        const { fastify, periodStatRows, findAllCalls } = createFullMockFastify();
        await mockPeriodStatService(fastify, { name: 'statistics', compensationEnabled: false });

        const now = new Date();
        const startTime = new Date(now.getTime() - 3600000);
        const endTime = new Date(now.getTime() + 3600000);

        periodStatRows.push(
          { period: 'h', channel: 'sensor', attributeName: 'default', aggregate: 'sum', data: 100, time: startTime }
        );

        await fastify.statistics.services.periodStat.query({
          startTime, endTime, aggregates: ['sum']
        });

        const callsAfterFirst = findAllCalls.filter(c => c.model === 'periodStat').length;

        fastify.statistics.services.periodStat.invalidateQueryCache([]);

        periodStatRows.push(
          { period: 'h', channel: 'sensor', attributeName: 'default', aggregate: 'sum', data: 200, time: startTime }
        );

        await fastify.statistics.services.periodStat.query({
          startTime, endTime, aggregates: ['sum']
        });

        expect(findAllCalls.filter(c => c.model === 'periodStat').length).to.be.greaterThan(callsAfterFirst);

        await fastify.close();
      });

      it('should hit memory cache for realtime query with matching channelVersions', async () => {
        const { fastify, periodStatRows, findAllCalls } = createFullMockFastify();
        await mockPeriodStatService(fastify, { name: 'statistics', compensationEnabled: false });

        const now = new Date();
        const startTime = new Date(now.getTime() - 3600000);
        const endTime = new Date(now.getTime() + 3600000);

        periodStatRows.push(
          { period: 'h', channel: 'sensor', attributeName: 'default', aggregate: 'sum', data: 100, time: startTime }
        );

        await fastify.statistics.services.periodStat.query({
          channels: ['sensor'], startTime, endTime, aggregates: ['sum']
        });

        const callsAfterFirst = findAllCalls.filter(c => c.model === 'periodStat').length;

        const result2 = await fastify.statistics.services.periodStat.query({
          channels: ['sensor'], startTime, endTime, aggregates: ['sum']
        });

        expect(findAllCalls.filter(c => c.model === 'periodStat').length).to.equal(callsAfterFirst);
        expect(result2.list[0].data.default).to.equal(100);

        await fastify.close();
      });
    });

    describe('queryCache 版本失效测试（外部缓存模式）', () => {
      it('should invalidate external cache when globalVersion changes', async () => {
        const cacheStore = {};
        const externalCache = {
          get: async (key) => cacheStore[key] || null,
          set: async (key, value, ttl) => { cacheStore[key] = value; }
        };

        const { fastify, periodStatRows } = createFullMockFastify();
        await mockPeriodStatService(fastify, { name: 'statistics', cache: externalCache, compensationEnabled: false });

        const now = new Date();
        const startTime = new Date(now.getTime() - 3600000);
        const endTime = new Date(now.getTime() + 3600000);

        periodStatRows.push(
          { period: 'h', channel: 'sensor', attributeName: 'default', aggregate: 'sum', data: 100, time: startTime }
        );

        await fastify.statistics.services.periodStat.query({
          startTime, endTime, aggregates: ['sum']
        });

        fastify.statistics.services.periodStat.invalidateQueryCache([]);

        fastify.statistics.models.periodStat.findAll = async () => [];

        const result = await fastify.statistics.services.periodStat.query({
          startTime, endTime, aggregates: ['sum']
        });

        expect(result.list.length).to.equal(0);

        await fastify.close();
      });

      it('should invalidate external cache when channelVersion changes for specific channel', async () => {
        const cacheStore = {};
        const externalCache = {
          get: async (key) => cacheStore[key] || null,
          set: async (key, value, ttl) => { cacheStore[key] = value; }
        };

        const { fastify, periodStatRows } = createFullMockFastify();
        await mockPeriodStatService(fastify, { name: 'statistics', cache: externalCache, compensationEnabled: false });

        const now = new Date();
        const startTime = new Date(now.getTime() - 3600000);
        const endTime = new Date(now.getTime() + 3600000);

        periodStatRows.push(
          { period: 'h', channel: 'sensor', attributeName: 'default', aggregate: 'sum', data: 100, time: startTime }
        );

        const result1 = await fastify.statistics.services.periodStat.query({
          channels: ['sensor'], startTime, endTime, aggregates: ['sum']
        });
        expect(result1.list.length).to.be.greaterThan(0);

        fastify.statistics.services.periodStat.invalidateQueryCache(['sensor']);

        fastify.statistics.models.periodStat.findAll = async () => [];

        const result2 = await fastify.statistics.services.periodStat.query({
          channels: ['sensor'], startTime, endTime, aggregates: ['sum']
        });
        expect(result2.list.length).to.equal(0);

        await fastify.close();
      });

      it('should set globalVersion in external cache for realtime query with no channels', async () => {
        const cacheStore = {};
        const externalCache = {
          get: async (key) => cacheStore[key] || null,
          set: async (key, value, ttl) => { cacheStore[key] = value; }
        };

        const { fastify, periodStatRows } = createFullMockFastify();
        await mockPeriodStatService(fastify, { name: 'statistics', cache: externalCache, compensationEnabled: false });

        const now = new Date();
        const startTime = new Date(now.getTime() - 3600000);
        const endTime = new Date(now.getTime() + 3600000);

        periodStatRows.push(
          { period: 'h', channel: 'sensor', attributeName: 'default', aggregate: 'sum', data: 100, time: startTime }
        );

        await fastify.statistics.services.periodStat.query({
          startTime, endTime, aggregates: ['sum']
        });

        const cacheKeys = Object.keys(cacheStore).filter(k => k.includes('query'));
        expect(cacheKeys.length).to.be.greaterThan(0);
        expect(cacheStore[cacheKeys[0]].globalVersion).to.exist;

        await fastify.close();
      });

      it('should handle external cache set without TTL support', async () => {
        const cacheStore = {};
        const setCalls = [];
        const externalCache = {
          get: async (key) => cacheStore[key] || null,
          set: async (key, value) => {
            setCalls.push({ key, value });
            cacheStore[key] = value;
          }
        };

        const { fastify, periodStatRows } = createFullMockFastify();
        await mockPeriodStatService(fastify, { name: 'statistics', cache: externalCache, compensationEnabled: false });

        const startTime = new Date('2026-05-01T00:00:00.000Z');
        const endTime = new Date('2026-05-01T01:00:00.000Z');

        periodStatRows.push(
          { period: 'h', channel: 'sensor', attributeName: 'default', aggregate: 'sum', data: 100, time: startTime }
        );

        await fastify.statistics.services.periodStat.query({
          channels: ['sensor'], startTime, endTime, aggregates: ['sum']
        });

        expect(setCalls.length).to.be.greaterThan(0);

        await fastify.close();
      });

      it('should return null from external cache when payload has no value property', async () => {
        const cacheStore = {};
        const externalCache = {
          get: async (key) => cacheStore[key] || null,
          set: async (key, value, ttl) => { cacheStore[key] = value; }
        };

        const { fastify, periodStatRows, findAllCalls } = createFullMockFastify();
        await mockPeriodStatService(fastify, { name: 'statistics', cache: externalCache, compensationEnabled: false });

        const startTime = new Date('2026-05-01T00:00:00.000Z');
        const endTime = new Date('2026-05-01T01:00:00.000Z');

        const cacheKey = 'statistics:query:' + JSON.stringify({
          aggregates: ['sum'], attributeNames: [], channels: ['sensor'],
          endTime: endTime.toISOString(), includeChildren: false,
          startTime: startTime.toISOString(), timezone: ''
        });
        cacheStore[cacheKey] = { notValue: true };

        periodStatRows.push(
          { period: 'h', channel: 'sensor', attributeName: 'default', aggregate: 'sum', data: 100, time: startTime }
        );

        await fastify.statistics.services.periodStat.query({
          channels: ['sensor'], startTime, endTime, aggregates: ['sum']
        });

        expect(findAllCalls.filter(c => c.model === 'periodStat').length).to.be.greaterThan(0);

        await fastify.close();
      });
    });

    describe('formatGroupData 边界测试', () => {
      it('should not include unit when all items have null or undefined unit', async () => {
        const { fastify, periodStatRows } = createFullMockFastify();
        await mockPeriodStatService(fastify, { name: 'statistics', compensationEnabled: false });

        const startTime = new Date('2026-05-01T00:00:00.000Z');
        const endTime = new Date('2026-05-01T01:00:00.000Z');

        periodStatRows.push(
          { period: 'h', channel: 'sensor', attributeName: 'temp', aggregate: 'sum', data: 100, time: startTime, unit: null },
          { period: 'h', channel: 'sensor', attributeName: 'humidity', aggregate: 'sum', data: 200, time: startTime, unit: undefined }
        );

        const { list: results } = await fastify.statistics.services.periodStat.query({
          channels: ['sensor'], startTime, endTime, aggregates: ['sum']
        });

        expect(results.length).to.equal(1);
        expect(results[0].unit).to.be.undefined;

        await fastify.close();
      });

      it('should include unit only for attributes with non-null unit', async () => {
        const { fastify, periodStatRows } = createFullMockFastify();
        await mockPeriodStatService(fastify, { name: 'statistics', compensationEnabled: false });

        const startTime = new Date('2026-05-01T00:00:00.000Z');
        const endTime = new Date('2026-05-01T01:00:00.000Z');

        periodStatRows.push(
          { period: 'h', channel: 'sensor', attributeName: 'temp', aggregate: 'sum', data: 100, time: startTime, unit: '°C' },
          { period: 'h', channel: 'sensor', attributeName: 'humidity', aggregate: 'sum', data: 200, time: startTime, unit: null }
        );

        const { list: results } = await fastify.statistics.services.periodStat.query({
          channels: ['sensor'], startTime, endTime, aggregates: ['sum']
        });

        expect(results.length).to.equal(1);
        expect(results[0].unit).to.deep.equal({ temp: '°C' });

        await fastify.close();
      });
    });

    describe('query 边界测试', () => {
      it('should handle channels as a string instead of array', async () => {
        const { fastify, periodStatRows } = createFullMockFastify();
        await mockPeriodStatService(fastify, { name: 'statistics', compensationEnabled: false });

        const startTime = new Date('2026-05-01T00:00:00.000Z');
        const endTime = new Date('2026-05-01T01:00:00.000Z');

        periodStatRows.push(
          { period: 'h', channel: 'sensor', attributeName: 'default', aggregate: 'sum', data: 100, time: startTime }
        );

        const { list: results } = await fastify.statistics.services.periodStat.query({
          channels: 'sensor', startTime, endTime, aggregates: ['sum']
        });

        expect(results.length).to.equal(1);
        expect(results[0].channel).to.equal('sensor');

        await fastify.close();
      });

      it('should escape special characters in channel names for includeChildren query', async () => {
        const { fastify, periodStatRows } = createFullMockFastify();
        await mockPeriodStatService(fastify, { name: 'statistics', compensationEnabled: false });

        const startTime = new Date('2026-05-01T00:00:00.000Z');
        const endTime = new Date('2026-05-01T01:00:00.000Z');

        periodStatRows.push(
          { period: 'h', channel: 'sensor%test', attributeName: 'default', aggregate: 'sum', data: 100, time: startTime }
        );

        const { list: results } = await fastify.statistics.services.periodStat.query({
          channels: ['sensor%test'], startTime, endTime, aggregates: ['sum'], includeChildren: true
        });

        expect(results.length).to.be.greaterThan(0);

        await fastify.close();
      });

      it('should build channel tree with parent having no items but children having items', async () => {
        const { fastify, periodStatRows } = createFullMockFastify();
        await mockPeriodStatService(fastify, { name: 'statistics', compensationEnabled: false });

        const startTime = new Date('2026-05-01T00:00:00.000Z');
        const endTime = new Date('2026-05-01T01:00:00.000Z');

        periodStatRows.push(
          { period: 'h', channel: 'sensor:room1', attributeName: 'default', aggregate: 'sum', data: 100, time: startTime }
        );

        const { list: results } = await fastify.statistics.services.periodStat.query({
          channels: ['sensor'], startTime, endTime, aggregates: ['sum'], includeChildren: true
        });

        expect(results.length).to.equal(1);
        expect(results[0].channel).to.equal('sensor');
        expect(results[0].children.length).to.be.greaterThan(0);
        expect(results[0].children[0].channel).to.equal('sensor:room1');

        await fastify.close();
      });

      it('should skip unit assignment when attributeName already in unitMap', async () => {
        const { fastify, periodStatRows } = createFullMockFastify();
        await mockPeriodStatService(fastify, { name: 'statistics', compensationEnabled: false });

        const startTime = new Date('2026-05-01T00:00:00.000Z');
        const endTime = new Date('2026-05-01T01:00:00.000Z');

        periodStatRows.push(
          { period: 'h', channel: 'sensor', attributeName: 'temp', aggregate: 'sum', data: 100, time: startTime, unit: '°C' },
          { period: 'h', channel: 'sensor', attributeName: 'temp', aggregate: 'avg', data: 50, time: startTime, unit: '°F' }
        );

        const { list: results } = await fastify.statistics.services.periodStat.query({
          channels: ['sensor'], startTime, endTime, aggregates: ['sum', 'avg']
        });

        expect(results.length).to.equal(1);
        expect(results[0].unit.temp).to.equal('°C');

        await fastify.close();
      });

      it('should not include unit in item entries when unit is undefined', async () => {
        const { fastify, periodStatRows } = createFullMockFastify();
        await mockPeriodStatService(fastify, { name: 'statistics', compensationEnabled: false });

        const startTime = new Date('2026-05-01T00:00:00.000Z');
        const endTime = new Date('2026-05-01T02:00:00.000Z');

        periodStatRows.push(
          { period: 'h', channel: 'sensor', attributeName: 'temp', aggregate: 'sum', data: 100, time: startTime }
        );

        const { list: results } = await fastify.statistics.services.periodStat.query({
          channels: ['sensor'], startTime, endTime, aggregates: ['sum'], includeChildren: true
        });

        expect(results.length).to.equal(1);
        if (results[0].items) {
          expect(results[0].items[0].unit).to.be.undefined;
        }

        await fastify.close();
      });

      it('should return null node when channel has no items and no children in tree', async () => {
        const { fastify, periodStatRows } = createFullMockFastify();
        await mockPeriodStatService(fastify, { name: 'statistics', compensationEnabled: false });

        const startTime = new Date('2026-05-01T00:00:00.000Z');
        const endTime = new Date('2026-05-01T01:00:00.000Z');

        const { list: results } = await fastify.statistics.services.periodStat.query({
          channels: ['nonexistent'], startTime, endTime, aggregates: ['sum'], includeChildren: true
        });

        expect(results.length).to.equal(0);

        await fastify.close();
      });

      it('should handle multiple items for same channel in channelGroups', async () => {
        const { fastify, periodStatRows } = createFullMockFastify();
        await mockPeriodStatService(fastify, { name: 'statistics', compensationEnabled: false });

        const startTime = new Date('2026-05-01T00:00:00.000Z');
        const endTime = new Date('2026-05-01T02:00:00.000Z');

        const secondHour = new Date('2026-05-01T01:00:00.000Z');
        periodStatRows.push(
          { period: 'h', channel: 'sensor', attributeName: 'temp', aggregate: 'sum', data: 100, time: startTime },
          { period: 'h', channel: 'sensor', attributeName: 'temp', aggregate: 'sum', data: 200, time: secondHour }
        );

        const { list: results } = await fastify.statistics.services.periodStat.query({
          channels: ['sensor'], startTime, endTime, aggregates: ['sum'], includeChildren: true
        });

        expect(results.length).to.equal(1);
        expect(results[0].items.length).to.equal(2);

        await fastify.close();
      });

      it('should use default prefix when name option is not provided', async () => {
        const { fastify, periodStatRows, findAllCalls } = createFullMockFastify();
        await mockPeriodStatService(fastify, { name: 'statistics', compensationEnabled: false });

        const now = new Date();
        const oneHourAgo = new Date(now.getTime() - 3600000);

        periodStatRows.push(
          { period: 'h', channel: 'ch1', attributeName: 'temp', aggregate: 'sum', data: 100, time: oneHourAgo }
        );

        const { list: results } = await fastify.statistics.services.periodStat.query({
          channels: ['ch1'], startTime: oneHourAgo, endTime: now, aggregates: ['sum']
        });

        expect(results.length).to.equal(1);
        await fastify.close();
      });

      it('should hit external cache when channelVersions all match', async () => {
        const { fastify, periodStatRows, findAllCalls } = createFullMockFastify();

        const cachedList = [{ channel: 'ch1', data: { temp: 42 } }];
        const cachedValue = { channelMetas: {}, list: cachedList };

        const externalCache = {
          get: async (key) => {
            if (key.includes('query:')) {
              return {
                value: cachedValue,
                channelVersions: { ch1: 1 }
              };
            }
            return null;
          },
          set: async (key, value, ttl) => {}
        };

        await mockPeriodStatService(fastify, { name: 'statistics', cache: externalCache, compensationEnabled: false });

        const now = new Date();
        const oneHourAgo = new Date(now.getTime() - 3600000);

        fastify.statistics.services.periodStat.invalidateQueryCache(['ch1']);

        const { list: results } = await fastify.statistics.services.periodStat.query({
          channels: ['ch1'], startTime: oneHourAgo, endTime: now, aggregates: ['sum']
        });

        const dbCalls = findAllCalls.filter(c => c.model === 'periodStat');
        expect(dbCalls.length).to.equal(0);
        expect(results).to.deep.equal(cachedList);

        await fastify.close();
      });
    });
  });
});
