const { expect } = require('chai');
const { mockPeriodStatService, createMockFastify, createFullMockFastify } = require('./period-stat-helpers');

describe('@kne/fastify-statistics', function () {
  describe('aggregate 聚合测试', () => {
    describe('aggregate 方法 - 从 data-record 聚合 (period=h)', () => {
      it('should throw error for unsupported period', async () => {
        const { fastify } = createMockFastify();
        await mockPeriodStatService(fastify, { name: 'statistics' });

        try {
          await fastify.statistics.services.periodStat.aggregate('x');
          expect.fail('should have thrown');
        } catch (e) {
          expect(e.message).to.include('Unsupported period: x');
        }

        await fastify.close();
      });

      it('should generate records for all aggregate types from data-record when period=h', async () => {
        const { fastify, findAllResults, bulkCreateCalls } = createMockFastify();
        await mockPeriodStatService(fastify, { name: 'statistics' });

        const startTime = new Date('2026-05-01T00:00:00.000Z');
        const endTime = new Date('2026-05-01T01:00:00.000Z');

        findAllResults.push({
          channel: 'temperature',
          attributeName: 'value',
          sum: 100,
          avg: 25,
          count: 4,
          min: 10,
          max: 40
        });

        const records = await fastify.statistics.services.periodStat.aggregate('h', { startTime, endTime });

        expect(records.length).to.equal(5);
        expect(bulkCreateCalls.length).to.equal(1);
        expect(bulkCreateCalls[0].records.length).to.equal(5);
        expect(bulkCreateCalls[0].opts.updateOnDuplicate).to.deep.equal(['data', 'unit']);

        const aggregates = records.map(r => r.aggregate);
        expect(aggregates).to.have.members(['sum', 'avg', 'count', 'min', 'max']);

        const sumRecord = records.find(r => r.aggregate === 'sum');
        expect(sumRecord.period).to.equal('h');
        expect(sumRecord.channel).to.equal('temperature');
        expect(sumRecord.attributeName).to.equal('value');
        expect(sumRecord.data).to.equal(100);
        expect(sumRecord.title).to.be.undefined;
        expect(sumRecord.description).to.be.undefined;
        expect(sumRecord.unit).to.be.undefined;

        await fastify.close();
      });

      it('should delete data-record after successful h aggregation', async () => {
        const { fastify, findAllResults, destroyCalls } = createMockFastify();
        await mockPeriodStatService(fastify, { name: 'statistics' });

        const startTime = new Date('2026-05-01T00:00:00.000Z');
        const endTime = new Date('2026-05-01T01:00:00.000Z');

        findAllResults.push({
          channel: 'ch1', attributeName: 'val',
          sum: 10, avg: null, count: null, min: null, max: null
        });

        await fastify.statistics.services.periodStat.aggregate('h', { startTime, endTime });

        expect(destroyCalls.length).to.equal(1);
        expect(destroyCalls[0].where.time.gte).to.deep.equal(startTime);
        expect(destroyCalls[0].where.time.lt).to.deep.equal(endTime);

        await fastify.close();
      });

      it('should delete data-record even when no records to aggregate', async () => {
        const { fastify, destroyCalls } = createMockFastify();
        await mockPeriodStatService(fastify, { name: 'statistics' });

        const startTime = new Date('2026-05-01T00:00:00.000Z');
        const endTime = new Date('2026-05-01T01:00:00.000Z');

        await fastify.statistics.services.periodStat.aggregate('h', { startTime, endTime });

        expect(destroyCalls.length).to.equal(1);

        await fastify.close();
      });

      it('should skip null aggregate values from data-record', async () => {
        const { fastify, findAllResults } = createMockFastify();
        await mockPeriodStatService(fastify, { name: 'statistics' });

        const startTime = new Date('2026-05-01T00:00:00.000Z');
        const endTime = new Date('2026-05-01T01:00:00.000Z');

        findAllResults.push({
          channel: 'ch1', attributeName: 'val',
          sum: 100, avg: null, count: 5, min: null, max: 50
        });

        const records = await fastify.statistics.services.periodStat.aggregate('h', { startTime, endTime });

        expect(records.length).to.equal(3);
        const aggregates = records.map(r => r.aggregate);
        expect(aggregates).to.have.members(['sum', 'count', 'max']);

        await fastify.close();
      });
    });

    describe('aggregate 方法 - 从 period-stat 聚合 (period>d/w/m/q/y)', () => {
      it('should aggregate from period-stat(h) when period=d', async () => {
        const { fastify, periodStatRows, bulkCreateCalls, destroyCalls } = createMockFastify();
        await mockPeriodStatService(fastify, { name: 'statistics' });

        const startTime = new Date('2026-05-01T00:00:00.000Z');
        const endTime = new Date('2026-05-02T00:00:00.000Z');

        periodStatRows.push(
          { period: 'h', channel: 'temperature', attributeName: 'value', aggregate: 'sum', data: 30, time: new Date('2026-05-01T00:00:00.000Z') },
          { period: 'h', channel: 'temperature', attributeName: 'value', aggregate: 'sum', data: 20, time: new Date('2026-05-01T01:00:00.000Z') },
          { period: 'h', channel: 'temperature', attributeName: 'value', aggregate: 'count', data: 3, time: new Date('2026-05-01T00:00:00.000Z') },
          { period: 'h', channel: 'temperature', attributeName: 'value', aggregate: 'count', data: 2, time: new Date('2026-05-01T01:00:00.000Z') },
          { period: 'h', channel: 'temperature', attributeName: 'value', aggregate: 'min', data: 8, time: new Date('2026-05-01T00:00:00.000Z') },
          { period: 'h', channel: 'temperature', attributeName: 'value', aggregate: 'min', data: 12, time: new Date('2026-05-01T01:00:00.000Z') },
          { period: 'h', channel: 'temperature', attributeName: 'value', aggregate: 'max', data: 22, time: new Date('2026-05-01T00:00:00.000Z') },
          { period: 'h', channel: 'temperature', attributeName: 'value', aggregate: 'max', data: 28, time: new Date('2026-05-01T01:00:00.000Z') }
        );

        const records = await fastify.statistics.services.periodStat.aggregate('d', { startTime, endTime });

        expect(records.length).to.equal(5);

        const sumRecord = records.find(r => r.aggregate === 'sum');
        expect(sumRecord.data).to.equal(50);

        const countRecord = records.find(r => r.aggregate === 'count');
        expect(countRecord.data).to.equal(5);

        const avgRecord = records.find(r => r.aggregate === 'avg');
        expect(avgRecord.data).to.equal(50 / 5);

        const minRecord = records.find(r => r.aggregate === 'min');
        expect(minRecord.data).to.equal(8);

        const maxRecord = records.find(r => r.aggregate === 'max');
        expect(maxRecord.data).to.equal(28);

        expect(destroyCalls.length).to.equal(0);

        // Verify bulkCreate used updateOnDuplicate for idempotency
        expect(bulkCreateCalls.length).to.equal(1);
        expect(bulkCreateCalls[0].opts.updateOnDuplicate).to.deep.equal(['data', 'unit']);

        await fastify.close();
      });

      it('should aggregate multiple channels separately from period-stat', async () => {
        const { fastify, periodStatRows } = createMockFastify();
        await mockPeriodStatService(fastify, { name: 'statistics' });

        const startTime = new Date('2026-05-01T00:00:00.000Z');
        const endTime = new Date('2026-05-02T00:00:00.000Z');

        periodStatRows.push(
          { period: 'h', channel: 'temperature', attributeName: 'value', aggregate: 'sum', data: 50, time: startTime },
          { period: 'h', channel: 'humidity', attributeName: 'value', aggregate: 'sum', data: 200, time: startTime }
        );

        const records = await fastify.statistics.services.periodStat.aggregate('d', { startTime, endTime });

        expect(records.filter(r => r.channel === 'temperature').length).to.equal(1);
        expect(records.filter(r => r.channel === 'humidity').length).to.equal(1);

        await fastify.close();
      });

      it('should compute avg from sum and count of lower period', async () => {
        const { fastify, periodStatRows } = createMockFastify();
        await mockPeriodStatService(fastify, { name: 'statistics' });

        const startTime = new Date('2026-05-01T00:00:00.000Z');
        const endTime = new Date('2026-05-02T00:00:00.000Z');

        periodStatRows.push(
          { period: 'h', channel: 'ch1', attributeName: 'val', aggregate: 'sum', data: 120, time: startTime },
          { period: 'h', channel: 'ch1', attributeName: 'val', aggregate: 'count', data: 3, time: startTime }
        );

        const records = await fastify.statistics.services.periodStat.aggregate('d', { startTime, endTime });

        const avgRecord = records.find(r => r.aggregate === 'avg');
        expect(avgRecord.data).to.equal(40);

        await fastify.close();
      });

      it('should not call bulkCreate when no period-stat rows to aggregate', async () => {
        const { fastify, bulkCreateCalls } = createMockFastify();
        await mockPeriodStatService(fastify, { name: 'statistics' });

        const startTime = new Date('2026-05-01T00:00:00.000Z');
        const endTime = new Date('2026-05-02T00:00:00.000Z');

        const records = await fastify.statistics.services.periodStat.aggregate('d', { startTime, endTime });

        expect(records.length).to.equal(0);
        expect(bulkCreateCalls.length).to.equal(0);

        await fastify.close();
      });

      it('should group by channel and attributeName', async () => {
        const { fastify, periodStatRows } = createMockFastify();
        await mockPeriodStatService(fastify, { name: 'statistics' });

        const startTime = new Date('2026-05-01T00:00:00.000Z');
        const endTime = new Date('2026-05-02T00:00:00.000Z');

        periodStatRows.push(
          { period: 'd', channel: 'temperature', attributeName: 'high', aggregate: 'sum', data: 50, time: startTime },
          { period: 'd', channel: 'temperature', attributeName: 'low', aggregate: 'sum', data: 30, time: startTime }
        );

        const records = await fastify.statistics.services.periodStat.aggregate('m', { startTime, endTime });

        expect(records.length).to.equal(2);
        const highRecord = records.find(r => r.attributeName === 'high');
        const lowRecord = records.find(r => r.attributeName === 'low');
        expect(highRecord.data).to.equal(50);
        expect(lowRecord.data).to.equal(30);

        await fastify.close();
      });

      it('should handle null attributeName in aggregateFromPeriodStat', async () => {
        const { fastify, periodStatRows } = createMockFastify();
        await mockPeriodStatService(fastify, { name: 'statistics' });

        const startTime = new Date('2026-05-01T00:00:00.000Z');
        const endTime = new Date('2026-05-02T00:00:00.000Z');

        periodStatRows.push(
          { period: 'h', channel: 'ch1', attributeName: null, aggregate: 'sum', data: 50, time: startTime }
        );

        const records = await fastify.statistics.services.periodStat.aggregate('d', { startTime, endTime });
        expect(records.length).to.equal(1);
        expect(records[0].attributeName).to.equal(null);

        await fastify.close();
      });

      it('should handle only count aggregate without sum in aggregateFromPeriodStat', async () => {
        const { fastify, periodStatRows } = createMockFastify();
        await mockPeriodStatService(fastify, { name: 'statistics' });

        const startTime = new Date('2026-05-01T00:00:00.000Z');
        const endTime = new Date('2026-05-02T00:00:00.000Z');

        periodStatRows.push(
          { period: 'h', channel: 'ch1', attributeName: 'val', aggregate: 'count', data: 5, time: startTime },
          { period: 'h', channel: 'ch1', attributeName: 'val', aggregate: 'min', data: 1, time: startTime },
          { period: 'h', channel: 'ch1', attributeName: 'val', aggregate: 'max', data: 10, time: startTime }
        );

        const records = await fastify.statistics.services.periodStat.aggregate('d', { startTime, endTime });
        const aggregates = records.map(r => r.aggregate);
        expect(aggregates).to.include('count');
        expect(aggregates).to.include('min');
        expect(aggregates).to.include('max');
        expect(aggregates).to.not.include('sum');
        expect(aggregates).to.not.include('avg');

        await fastify.close();
      });
    });

    describe('事务回滚测试', () => {
      it('should rollback transaction when bulkCreate fails in aggregateFromDataRecord', async () => {
        const { fastify, findAllResults, mockModel } = createMockFastify();
        let rollbackCalled = false;
        const mockTransaction = {
          commit: async () => {},
          rollback: async () => { rollbackCalled = true; }
        };
        fastify.sequelize.instance.transaction = async () => mockTransaction;

        mockModel.periodStat.bulkCreate = async () => {
          throw new Error('bulkCreate error');
        };

        await mockPeriodStatService(fastify, { name: 'statistics' });

        const startTime = new Date('2026-05-01T00:00:00.000Z');
        const endTime = new Date('2026-05-01T01:00:00.000Z');

        findAllResults.push({
          channel: 'ch1', attributeName: 'val',
          sum: 10, avg: null, count: null, min: null, max: null
        });

        try {
          await fastify.statistics.services.periodStat.aggregate('h', { startTime, endTime });
          expect.fail('should have thrown');
        } catch (e) {
          expect(e.message).to.equal('bulkCreate error');
          expect(rollbackCalled).to.be.true;
        }

        await fastify.close();
      });

      it('should rollback transaction when bulkCreate fails in aggregateFromPeriodStat', async () => {
        const { fastify, periodStatRows, mockModel } = createMockFastify();
        let rollbackCalled = false;
        const mockTransaction = {
          commit: async () => {},
          rollback: async () => { rollbackCalled = true; }
        };
        fastify.sequelize.instance.transaction = async () => mockTransaction;

        mockModel.periodStat.bulkCreate = async () => {
          throw new Error('bulkCreate error');
        };

        await mockPeriodStatService(fastify, { name: 'statistics' });

        const startTime = new Date('2026-05-01T00:00:00.000Z');
        const endTime = new Date('2026-05-02T00:00:00.000Z');

        periodStatRows.push(
          { period: 'h', channel: 'ch1', attributeName: 'val', aggregate: 'sum', data: 10, time: startTime }
        );

        try {
          await fastify.statistics.services.periodStat.aggregate('d', { startTime, endTime });
          expect.fail('should have thrown');
        } catch (e) {
          expect(e.message).to.equal('bulkCreate error');
          expect(rollbackCalled).to.be.true;
        }

        await fastify.close();
      });
    });

    describe('aggregate 自动时间计算', () => {
      it('should auto-calculate startTime and endTime when not provided', async () => {
        const { fastify, findAllResults } = createMockFastify();
        await mockPeriodStatService(fastify, { name: 'statistics' });

        findAllResults.push({
          channel: 'ch1', attributeName: 'val',
          sum: 10, avg: null, count: null, min: null, max: null
        });

        const records = await fastify.statistics.services.periodStat.aggregate('h');

        expect(records.length).to.equal(1);
        expect(records[0].aggregate).to.equal('sum');
        expect(records[0].data).to.equal(10);

        await fastify.close();
      });

      it('should auto-calculate time for all period types', async () => {
        const periods = ['h', 'd', 'w', 'm', 'q', 'y'];
        for (const period of periods) {
          const { fastify, findAllResults, periodStatRows } = createMockFastify();
          await mockPeriodStatService(fastify, { name: 'statistics' });

          if (period === 'h') {
            findAllResults.push({
              channel: 'ch1', attributeName: 'val',
              sum: 10, avg: null, count: null, min: null, max: null
            });
          } else {
            periodStatRows.push(
              { period: period === 'd' ? 'h' : period === 'w' || period === 'm' ? 'd' : period === 'q' ? 'm' : 'q',
                channel: 'ch1', attributeName: 'val',
                aggregate: 'sum', data: 10, time: new Date() }
            );
          }

          const records = await fastify.statistics.services.periodStat.aggregate(period);
          // Should not throw, auto time calculation works for all periods
          expect(records).to.be.an('array');

          await fastify.close();
        }
      });
    });

    describe('aggregateFromPeriodStat unit 继承测试', () => {
      it('should set unit to null when items have no unit field', async () => {
        const { fastify, periodStatRows } = createFullMockFastify();
        await mockPeriodStatService(fastify, { name: 'statistics', compensationEnabled: false });

        const startTime = new Date('2026-05-01T00:00:00.000Z');
        const endTime = new Date('2026-05-02T00:00:00.000Z');

        periodStatRows.push(
          { period: 'h', channel: 'ch1', attributeName: 'val', aggregate: 'sum', data: 50, time: startTime }
        );

        const records = await fastify.statistics.services.periodStat.aggregate('d', { startTime, endTime });

        expect(records.length).to.equal(1);
        expect(records[0].unit).to.equal(null);

        await fastify.close();
      });
    });
  });
});
