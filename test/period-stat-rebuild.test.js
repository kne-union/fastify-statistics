const { expect } = require('chai');
const { mockPeriodStatService, createRebuildMockFastify } = require('./period-stat-helpers');

describe('@kne/fastify-statistics rebuild API', function () {
  const setup = async () => {
    const ctx = createRebuildMockFastify();
    await mockPeriodStatService(ctx.fastify, { name: 'statistics' });
    return ctx;
  };

  describe('clearAll', () => {
    it('flushes buffer and destroys all default tables', async () => {
      const { fastify, destroyCalls, flushCalls } = await setup();

      const result = await fastify.statistics.services.periodStat.clearAll();

      expect(flushCalls).to.have.length(1);
      expect(result.deleted.dataRecord).to.equal(3);
      expect(result.deleted.periodStat).to.equal(5);
      expect(result.deleted.aggregationWatermark).to.be.a('number');
      expect(result.deleted.channelMeta).to.equal(1);
      expect(destroyCalls.map(item => item.model)).to.include.members([
        'dataRecord',
        'periodStat',
        'aggregationWatermark',
        'channelMeta'
      ]);
      await fastify.close();
    });

    it('can skip flush and limit tables', async () => {
      const { fastify, flushCalls } = await setup();

      const result = await fastify.statistics.services.periodStat.clearAll({
        flushBuffer: false,
        tables: ['periodStat']
      });

      expect(flushCalls).to.have.length(0);
      expect(result.deleted.periodStat).to.equal(5);
      expect(result.deleted.dataRecord).to.be.undefined;
      await fastify.close();
    });
  });

  describe('getWatermark / setWatermark', () => {
    it('creates and reads watermark rows', async () => {
      const { fastify } = await setup();
      const periodStat = fastify.statistics.services.periodStat;
      const nextTime = new Date('2026-05-01T03:00:00.000Z');

      await periodStat.setWatermark('h', nextTime);
      const value = await periodStat.getWatermark('h');

      expect(new Date(value).toISOString()).to.equal(nextTime.toISOString());
      await fastify.close();
    });
  });

  describe('rebuild', () => {
    it('skips aggregation when no data_record exists', async () => {
      const { fastify } = await setup();
      const progress = [];

      const result = await fastify.statistics.services.periodStat.rebuild({
        onProgress: payload => progress.push(payload.stage)
      });

      expect(result.success).to.be.true;
      expect(result.skipped).to.be.true;
      expect(progress).to.include('start');
      expect(progress).to.include('flush');
      await fastify.close();
    });

    it('runs aggregate-only for explicit h window', async () => {
      const { fastify, findAllResults, bulkCreateCalls } = await setup();

      findAllResults.push({
        channel: 'interview:1:2',
        attributeName: 'invite',
        sum: 1,
        avg: 1,
        count: 1,
        min: 1,
        max: 1
      });

      const startTime = new Date('2026-05-01T00:00:00.000Z');
      const endTime = new Date('2026-05-01T01:00:00.000Z');
      const progress = [];

      const result = await fastify.statistics.services.periodStat.rebuild({
        mode: 'aggregate-only',
        startTime,
        endTime,
        periods: ['h'],
        onProgress: payload => progress.push(payload)
      });

      expect(result.success).to.be.true;
      expect(result.windowCounts.h).to.equal(1);
      expect(bulkCreateCalls.length).to.be.at.least(1);
      expect(progress.some(item => item.stage === 'aggregate' && item.detail?.period === 'h')).to.be.true;
      await fastify.close();
    });

    it('reset-and-aggregate clears tables before hooks', async () => {
      const { fastify, destroyCalls } = await setup();
      const order = [];

      const result = await fastify.statistics.services.periodStat.rebuild({
        mode: 'reset-and-aggregate',
        startTime: new Date('2026-05-01T00:00:00.000Z'),
        endTime: new Date('2026-05-01T01:00:00.000Z'),
        periods: ['h'],
        beforeAggregate: async () => {
          order.push('beforeAggregate');
        },
        onProgress: payload => order.push(payload.stage)
      });

      expect(result.success).to.be.true;
      expect(order.indexOf('clear')).to.be.lessThan(order.indexOf('beforeAggregate'));
      expect(destroyCalls.some(item => item.model === 'periodStat')).to.be.true;
      await fastify.close();
    });

    it('calls afterAggregate hook with window counts', async () => {
      const { fastify, findAllResults } = await setup();
      let hookPayload = null;

      findAllResults.push({
        channel: 'sensor',
        attributeName: 'default',
        sum: 10,
        avg: 10,
        count: 1,
        min: 10,
        max: 10
      });

      await fastify.statistics.services.periodStat.rebuild({
        mode: 'aggregate-only',
        startTime: new Date('2026-05-01T00:00:00.000Z'),
        endTime: new Date('2026-05-01T01:00:00.000Z'),
        periods: ['h'],
        afterAggregate: async payload => {
          hookPayload = payload;
        }
      });

      expect(hookPayload).to.not.be.null;
      expect(hookPayload.windowCounts.h).to.equal(1);
      expect(hookPayload.watermarks.h).to.exist;
      await fastify.close();
    });

    it('infers start time from data_record minTime with channelFilter', async () => {
      const { fastify, findAllResults, setDataRecordMinTime } = await setup();

      setDataRecordMinTime(new Date('2026-05-01T02:30:00.000Z'));
      findAllResults.push({
        channel: 'interview:1',
        attributeName: 'invite',
        sum: 2,
        avg: 2,
        count: 1,
        min: 2,
        max: 2
      });

      const result = await fastify.statistics.services.periodStat.rebuild({
        mode: 'aggregate-only',
        channelFilter: 'interview:%',
        endTime: new Date('2026-05-01T04:00:00.000Z'),
        periods: ['h'],
        maxWindows: 1
      });

      expect(result.success).to.be.true;
      expect(result.windowCounts.h).to.equal(1);
      await fastify.close();
    });

    it('throws 409 when rebuild already in progress', async () => {
      const { fastify } = await setup();
      let release;
      const gate = new Promise(resolve => {
        release = resolve;
      });

      const first = fastify.statistics.services.periodStat.rebuild({
        beforeAggregate: async () => {
          await gate;
        },
        startTime: new Date('2026-05-01T00:00:00.000Z'),
        endTime: new Date('2026-05-01T01:00:00.000Z'),
        periods: ['h']
      });

      await new Promise(resolve => setImmediate(resolve));

      try {
        await fastify.statistics.services.periodStat.rebuild();
        expect.fail('should have thrown 409');
      } catch (error) {
        expect(error.statusCode).to.equal(409);
      }

      release();
      await first;
      await fastify.close();
    });

    it('throws for unsupported mode', async () => {
      const { fastify } = await setup();

      try {
        await fastify.statistics.services.periodStat.rebuild({ mode: 'invalid' });
        expect.fail('should have thrown');
      } catch (error) {
        expect(error.message).to.include('Unsupported rebuild mode');
      }

      await fastify.close();
    });

    it('repair mode requires startTime and endTime', async () => {
      const { fastify } = await setup();

      try {
        await fastify.statistics.services.periodStat.rebuild({ mode: 'repair' });
        expect.fail('should have thrown');
      } catch (error) {
        expect(error.message).to.include('repair mode requires startTime and endTime');
      }

      await fastify.close();
    });

    it('sets isRebuilding during execution', async () => {
      const { fastify } = await setup();
      const flags = [];
      let release;
      const gate = new Promise(resolve => {
        release = resolve;
      });

      const task = fastify.statistics.services.periodStat.rebuild({
        beforeAggregate: async () => {
          flags.push(fastify.statistics.services.periodStat.isRebuilding());
          await gate;
        },
        startTime: new Date('2026-05-01T00:00:00.000Z'),
        endTime: new Date('2026-05-01T01:00:00.000Z'),
        periods: ['h']
      });

      await new Promise(resolve => setImmediate(resolve));
      flags.push(fastify.statistics.services.periodStat.isRebuildInProgress());

      release();
      await task;
      flags.push(fastify.statistics.services.periodStat.isRebuilding());

      expect(flags[0]).to.be.true;
      expect(flags[1]).to.be.true;
      expect(flags[2]).to.be.false;
      await fastify.close();
    });
  });
});
