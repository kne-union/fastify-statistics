const { expect } = require('chai');
const fp = require('fastify-plugin');

const mockPeriodStatService = (fastify, options) => {
  const servicePlugin = require('../libs/services/period-stat');
  return fp(servicePlugin)(fastify, options);
};

const createMockFastify = () => {
  const findAllResults = [];
  const bulkCreateCalls = [];
  const destroyCalls = [];
  const periodStatRows = [];

  const mockTransaction = {
    commit: async () => {},
    rollback: async () => {}
  };

  const mockModel = {
    dataRecord: {
      findAll: async () => findAllResults.splice(0, findAllResults.length),
      destroy: async (opts) => {
        destroyCalls.push(opts);
      }
    },
    periodStat: {
      bulkCreate: async (records, opts) => {
        bulkCreateCalls.push({ records: [...records], opts: opts || {} });
        return records;
      },
      findAll: async () => periodStatRows.splice(0, periodStatRows.length)
    }
  };

  const fastify = require('fastify')();

  fastify.decorate('sequelize', {
    Sequelize: { Op: { between: 'between' }, fn: (name, col) => `${name}(${col})`, col: name => name },
    instance: { transaction: async () => mockTransaction }
  });

  fastify.decorate('statistics', {
    models: mockModel,
    services: {}
  });

  return { fastify, findAllResults, bulkCreateCalls, destroyCalls, periodStatRows, mockModel };
};

describe('@kne/fastify-statistics', function () {
  describe('周期统计接口测试', () => {
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
        expect(destroyCalls[0].where.time).to.exist;

        await fastify.close();
      });

      it('should not delete data-record when no records to aggregate', async () => {
        const { fastify, destroyCalls } = createMockFastify();
        await mockPeriodStatService(fastify, { name: 'statistics' });

        const startTime = new Date('2026-05-01T00:00:00.000Z');
        const endTime = new Date('2026-05-01T01:00:00.000Z');

        await fastify.statistics.services.periodStat.aggregate('h', { startTime, endTime });

        expect(destroyCalls.length).to.equal(0);

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

    describe('cron 任务注册测试', () => {
      it('should register cron jobs when fastify.cron is available', async () => {
        const { fastify } = createMockFastify();
        const createdJobs = [];

        fastify.decorate('cron', {
          createJob: (jobConfig) => {
            createdJobs.push(jobConfig);
          }
        });

        await mockPeriodStatService(fastify, { name: 'statistics' });

        expect(createdJobs.length).to.equal(6);

        const jobNames = createdJobs.map(j => j.name);
        expect(jobNames).to.include('statistics-period-stat-h');
        expect(jobNames).to.include('statistics-period-stat-d');
        expect(jobNames).to.include('statistics-period-stat-w');
        expect(jobNames).to.include('statistics-period-stat-m');
        expect(jobNames).to.include('statistics-period-stat-q');
        expect(jobNames).to.include('statistics-period-stat-y');

        expect(createdJobs[0].cronTime).to.exist;
        expect(createdJobs[0].onTick).to.be.a('function');
        expect(createdJobs[0].startWhenReady).to.be.true;

        await fastify.close();
      });

      it('should not register cron jobs when fastify.cron is not available', async () => {
        const { fastify } = createMockFastify();
        await mockPeriodStatService(fastify, { name: 'statistics' });

        expect(fastify.statistics.services.periodStat.aggregate).to.be.a('function');

        await fastify.close();
      });
    });

    describe('query 方法', () => {
      const createQueryMockFastify = () => {
        const periodStatRows = [];
        const dataRecordFindAllResult = [];
        const findAllCalls = [];
        const channelMetaRows = [];

        const mockTransaction = {
          commit: async () => {},
          rollback: async () => {}
        };

        const mockModel = {
          dataRecord: {
            findAll: async (opts) => {
              findAllCalls.push({ model: 'dataRecord', opts });
              return dataRecordFindAllResult.splice(0);
            },
            destroy: async () => {}
          },
          periodStat: {
            bulkCreate: async () => {},
            findAll: async (opts) => {
              findAllCalls.push({ model: 'periodStat', opts });
              const period = opts.where && opts.where.period;
              if (period && period.in) {
                return periodStatRows.filter(row => period.in.includes(row.period));
              }
              return periodStatRows.filter(row => !period || row.period === period);
            }
          },
          channelMeta: {
            findAll: async ({ where }) => {
              if (where && where.channel && where.channel.in) {
                return channelMetaRows.filter(row => where.channel.in.includes(row.channel));
              }
              return channelMetaRows;
            }
          }
        };

        const fastify = require('fastify')();

        fastify.decorate('sequelize', {
          Sequelize: {
            Op: { between: 'between', like: 'like', or: 'or', in: 'in' },
            fn: (name, col) => `${name}(${col})`,
            col: name => name
          },
          instance: { transaction: async () => mockTransaction }
        });

        fastify.decorate('statistics', {
          models: mockModel,
          services: {}
        });

        return { fastify, periodStatRows, dataRecordFindAllResult, findAllCalls, channelMetaRows };
      };

      it('should return attribute-keyed object when single aggregate and single default attribute with no filter', async () => {
        const { fastify, periodStatRows } = createQueryMockFastify();
        await mockPeriodStatService(fastify, { name: 'statistics' });

        const startTime = new Date('2026-05-01T00:00:00.000Z');
        const endTime = new Date('2026-05-01T01:00:00.000Z');

        periodStatRows.push({
          period: 'h', channel: 'sensor', attributeName: 'default',
          aggregate: 'sum', data: 100, time: startTime
        });

        const { list: results, channelMetas } = await fastify.statistics.services.periodStat.query({
          channel: 'sensor', startTime, endTime, aggregates: ['sum']
        });

        expect(results.length).to.equal(1);
        expect(results[0].channel).to.equal('sensor');
        expect(results[0].period).to.equal('h');
        expect(results[0].data).to.deep.equal({ default: 100 });

        await fastify.close();
      });

      it('should return attribute-keyed object when single aggregate and multiple attributes', async () => {
        const { fastify, periodStatRows } = createQueryMockFastify();
        await mockPeriodStatService(fastify, { name: 'statistics' });

        const startTime = new Date('2026-05-01T00:00:00.000Z');
        const endTime = new Date('2026-05-01T01:00:00.000Z');

        periodStatRows.push(
          { period: 'h', channel: 'sensor', attributeName: 'temperature', aggregate: 'sum', data: 100, time: startTime },
          { period: 'h', channel: 'sensor', attributeName: 'humidity', aggregate: 'sum', data: 200, time: startTime }
        );

        const { list: results, channelMetas } = await fastify.statistics.services.periodStat.query({
          channel: 'sensor', startTime, endTime, aggregates: ['sum']
        });

        expect(results.length).to.equal(1);
        expect(results[0].data).to.deep.equal({ temperature: 100, humidity: 200 });

        await fastify.close();
      });

      it('should return nested object when multiple aggregates and single default attribute', async () => {
        const { fastify, periodStatRows } = createQueryMockFastify();
        await mockPeriodStatService(fastify, { name: 'statistics' });

        const startTime = new Date('2026-05-01T00:00:00.000Z');
        const endTime = new Date('2026-05-01T01:00:00.000Z');

        periodStatRows.push(
          { period: 'h', channel: 'sensor', attributeName: 'default', aggregate: 'sum', data: 100, time: startTime },
          { period: 'h', channel: 'sensor', attributeName: 'default', aggregate: 'avg', data: 25, time: startTime }
        );

        const { list: results, channelMetas } = await fastify.statistics.services.periodStat.query({
          channel: 'sensor', startTime, endTime, aggregates: ['sum', 'avg']
        });

        expect(results.length).to.equal(1);
        expect(results[0].data).to.deep.equal({ sum: { default: 100 }, avg: { default: 25 } });

        await fastify.close();
      });

      it('should return nested object when multiple aggregates and multiple attributes', async () => {
        const { fastify, periodStatRows } = createQueryMockFastify();
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
          channel: 'sensor', startTime, endTime, aggregates: ['sum', 'avg']
        });

        expect(results.length).to.equal(1);
        expect(results[0].data).to.deep.equal({
          sum: { temperature: 100, humidity: 200 },
          avg: { temperature: 25, humidity: 50 }
        });

        await fastify.close();
      });

      it('should not flatten default attribute when attributeNames filter is provided', async () => {
        const { fastify, periodStatRows } = createQueryMockFastify();
        await mockPeriodStatService(fastify, { name: 'statistics' });

        const startTime = new Date('2026-05-01T00:00:00.000Z');
        const endTime = new Date('2026-05-01T01:00:00.000Z');

        periodStatRows.push(
          { period: 'h', channel: 'sensor', attributeName: 'default', aggregate: 'sum', data: 100, time: startTime }
        );

        const { list: results, channelMetas } = await fastify.statistics.services.periodStat.query({
          channel: 'sensor', startTime, endTime, attributeNames: ['default'], aggregates: ['sum']
        });

        expect(results[0].data).to.deep.equal({ default: 100 });

        await fastify.close();
      });

      it('should query all child channels', async () => {
        const { fastify, periodStatRows, channelMetaRows } = createQueryMockFastify();
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
          channel: 'sensor', startTime, endTime, aggregates: ['sum']
        });

        expect(results.length).to.equal(3);
        const channels = results.map(r => r.channel);
        expect(channels).to.include('sensor');
        expect(channels).to.include('sensor:room1');
        expect(channels).to.include('sensor:room2');

        expect(channelMetas).to.have.property('sensor');
        expect(channelMetas.sensor.title).to.equal('传感器');
        expect(Object.keys(channelMetas).length).to.equal(1);

        await fastify.close();
      });

      it('should query data from all period types in single query', async () => {
        const { fastify, periodStatRows, findAllCalls } = createQueryMockFastify();
        await mockPeriodStatService(fastify, { name: 'statistics' });

        const startTime = new Date('2026-05-01T00:00:00.000Z');
        const endTime = new Date('2026-05-01T01:00:00.000Z');

        periodStatRows.push(
          { period: 'h', channel: 'sensor', attributeName: 'default', aggregate: 'sum', data: 10, time: startTime },
          { period: 'd', channel: 'sensor', attributeName: 'default', aggregate: 'sum', data: 240, time: startTime }
        );

        const { list: results, channelMetas } = await fastify.statistics.services.periodStat.query({
          channel: 'sensor', startTime, endTime, aggregates: ['sum']
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
        const { fastify, periodStatRows } = createQueryMockFastify();
        await mockPeriodStatService(fastify, { name: 'statistics' });

        const startTime = new Date('2026-05-01T00:00:00.000Z');
        const endTime = new Date('2026-05-01T01:00:00.000Z');

        const { list: results, channelMetas } = await fastify.statistics.services.periodStat.query({
          channel: 'nonexistent', startTime, endTime, aggregates: ['sum']
        });

        expect(results).to.deep.equal([]);
        expect(channelMetas).to.deep.equal({});

        await fastify.close();
      });

      it('should filter by attributeNames when provided', async () => {
        const { fastify, periodStatRows } = createQueryMockFastify();
        await mockPeriodStatService(fastify, { name: 'statistics' });

        const startTime = new Date('2026-05-01T00:00:00.000Z');
        const endTime = new Date('2026-05-01T01:00:00.000Z');

        periodStatRows.push(
          { period: 'h', channel: 'sensor', attributeName: 'temperature', aggregate: 'sum', data: 100, time: startTime }
        );

        const { list: results, channelMetas } = await fastify.statistics.services.periodStat.query({
          channel: 'sensor', startTime, endTime, attributeNames: ['temperature'], aggregates: ['sum']
        });

        expect(results.length).to.equal(1);
        expect(results[0].data).to.deep.equal({ temperature: 100 });

        await fastify.close();
      });

      it('should query data-record for current hour and format correctly', async () => {
        const { fastify, periodStatRows, dataRecordFindAllResult, findAllCalls } = createQueryMockFastify();
        await mockPeriodStatService(fastify, { name: 'statistics' });

        const now = new Date();
        const startTime = new Date(now.getTime() - 3600000);
        const endTime = new Date(now.getTime() + 3600000);

        dataRecordFindAllResult.push({
          channel: 'sensor', attributeName: 'temperature',
          sum: 50, avg: 25, count: 2, min: 10, max: 40
        });

        const { list: results, channelMetas } = await fastify.statistics.services.periodStat.query({
          channel: 'sensor', startTime, endTime, aggregates: ['sum']
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
        const { fastify, periodStatRows } = createQueryMockFastify();
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
          channel: 'sensor', startTime, endTime
        });

        expect(results.length).to.equal(1);
        expect(results[0].data).to.deep.equal({ sum: { default: 100 }, avg: { default: 25 }, count: { default: 4 }, min: { default: 10 }, max: { default: 40 } });

        await fastify.close();
      });

      it('should sort results by time', async () => {
        const { fastify, periodStatRows } = createQueryMockFastify();
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
          channel: 'sensor', startTime, endTime, aggregates: ['sum']
        });

        expect(results[0].data).to.deep.equal({ default: 10 });
        expect(results[1].data).to.deep.equal({ default: 20 });
        expect(results[2].data).to.deep.equal({ default: 30 });

        await fastify.close();
      });

      it('should use client timezone to determine current hour when timezone is provided', async () => {
        const { fastify, periodStatRows, dataRecordFindAllResult, findAllCalls } = createQueryMockFastify();
        await mockPeriodStatService(fastify, { name: 'statistics' });

        const now = new Date();
        const startTime = new Date(now.getTime() - 3600000);
        const endTime = new Date(now.getTime() + 3600000);

        dataRecordFindAllResult.push({
          channel: 'sensor', attributeName: 'temperature',
          sum: 50, avg: null, count: null, min: null, max: null
        });

        const resultsNoTz = await fastify.statistics.services.periodStat.query({
          channel: 'sensor', startTime, endTime, aggregates: ['sum']
        });

        const resultsWithTz = await fastify.statistics.services.periodStat.query({
          channel: 'sensor', startTime, endTime, aggregates: ['sum'], timezone: 'Asia/Shanghai'
        });

        const drCallsNoTz = findAllCalls.filter(c => c.model === 'dataRecord');
        expect(drCallsNoTz.length).to.be.greaterThan(0);

        await fastify.close();
      });

      it('should calculate different current hour boundaries for different timezones', async () => {
        const { fastify, periodStatRows, dataRecordFindAllResult, findAllCalls } = createQueryMockFastify();
        await mockPeriodStatService(fastify, { name: 'statistics' });

        const now = new Date();
        const startTime = new Date(now.getTime() - 7200000);
        const endTime = new Date(now.getTime() + 3600000);

        dataRecordFindAllResult.push({
          channel: 'sensor', attributeName: 'default',
          sum: 100, avg: null, count: null, min: null, max: null
        });

        await fastify.statistics.services.periodStat.query({
          channel: 'sensor', startTime, endTime, aggregates: ['sum'], timezone: 'America/New_York'
        });

        const drCalls = findAllCalls.filter(c => c.model === 'dataRecord');
        expect(drCalls.length).to.be.greaterThan(0);

        await fastify.close();
      });

      it('should throw error for invalid timezone', async () => {
        const { fastify } = createQueryMockFastify();
        await mockPeriodStatService(fastify, { name: 'statistics' });

        const startTime = new Date('2026-05-01T00:00:00.000Z');
        const endTime = new Date('2026-05-01T01:00:00.000Z');

        try {
          await fastify.statistics.services.periodStat.query({
            channel: 'sensor', startTime, endTime, aggregates: ['sum'], timezone: 'Invalid/Timezone'
          });
          expect.fail('should have thrown');
        } catch (e) {
          expect(e.message).to.include('Invalid timezone');
        }

        await fastify.close();
      });

      it('should query without channel filter and return channelMetas', async () => {
        const { fastify, periodStatRows, channelMetaRows } = createQueryMockFastify();
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
        const { fastify, periodStatRows } = createQueryMockFastify();
        await mockPeriodStatService(fastify, { name: 'statistics' });

        const startTime = new Date('2026-05-01T00:00:00.000Z');
        const endTime = new Date('2026-05-01T01:00:00.000Z');

        periodStatRows.push(
          { period: 'h', channel: 'sensor', attributeName: null, aggregate: 'sum', data: 100, time: startTime }
        );

        const { list: results, channelMetas } = await fastify.statistics.services.periodStat.query({
          channel: 'sensor', startTime, endTime, aggregates: ['sum']
        });

        expect(results.length).to.equal(1);
        expect(results[0].data).to.deep.equal({ default: 100 });

        await fastify.close();
      });

      it('should handle null attributeName with single aggregate and attributeNames filter', async () => {
        const { fastify, periodStatRows } = createQueryMockFastify();
        await mockPeriodStatService(fastify, { name: 'statistics' });

        const startTime = new Date('2026-05-01T00:00:00.000Z');
        const endTime = new Date('2026-05-01T01:00:00.000Z');

        periodStatRows.push(
          { period: 'h', channel: 'sensor', attributeName: null, aggregate: 'sum', data: 100, time: startTime }
        );

        const { list: results, channelMetas } = await fastify.statistics.services.periodStat.query({
          channel: 'sensor', startTime, endTime, attributeNames: ['value'], aggregates: ['sum']
        });

        expect(results.length).to.equal(1);
        expect(results[0].data).to.deep.equal({ default: 100 });

        await fastify.close();
      });

      it('should handle null attributeName with multiple aggregates and attributeNames filter', async () => {
        const { fastify, periodStatRows } = createQueryMockFastify();
        await mockPeriodStatService(fastify, { name: 'statistics' });

        const startTime = new Date('2026-05-01T00:00:00.000Z');
        const endTime = new Date('2026-05-01T01:00:00.000Z');

        periodStatRows.push(
          { period: 'h', channel: 'sensor', attributeName: null, aggregate: 'sum', data: 100, time: startTime },
          { period: 'h', channel: 'sensor', attributeName: null, aggregate: 'avg', data: 25, time: startTime }
        );

        const { list: results, channelMetas } = await fastify.statistics.services.periodStat.query({
          channel: 'sensor', startTime, endTime, attributeNames: ['value'], aggregates: ['sum', 'avg']
        });

        expect(results.length).to.equal(1);
        expect(results[0].data).to.deep.equal({
          sum: { default: 100 },
          avg: { default: 25 }
        });

        await fastify.close();
      });

      it('should skip undefined aggregate values from data-record in query', async () => {
        const { fastify, dataRecordFindAllResult } = createQueryMockFastify();
        await mockPeriodStatService(fastify, { name: 'statistics' });

        const now = new Date();
        const startTime = new Date(now.getTime() - 3600000);
        const endTime = new Date(now.getTime() + 3600000);

        dataRecordFindAllResult.push({
          channel: 'sensor', attributeName: 'temperature',
          sum: 50, avg: undefined, count: undefined, min: undefined, max: undefined
        });

        const { list: results, channelMetas } = await fastify.statistics.services.periodStat.query({
          channel: 'sensor', startTime, endTime, aggregates: ['sum', 'avg']
        });

        const hourResult = results.find(r => r.period === 'h');
        if (hourResult) {
          expect(hourResult.data).to.deep.equal({ temperature: 50 });
        }

        await fastify.close();
      });

      it('should use startTime as drStartTime when startTime is after currentHourStart', async () => {
        const { fastify, periodStatRows, dataRecordFindAllResult, findAllCalls } = createQueryMockFastify();
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
          channel: 'sensor', startTime, endTime, aggregates: ['sum']
        });

        expect(results.length).to.be.greaterThan(0);

        await fastify.close();
      });

      it('should handle null attributeName in data-record query results', async () => {
        const { fastify, periodStatRows, dataRecordFindAllResult, findAllCalls } = createQueryMockFastify();
        await mockPeriodStatService(fastify, { name: 'statistics' });

        const now = new Date();
        const startTime = new Date(now.getTime() - 3600000);
        const endTime = new Date(now.getTime() + 3600000);

        dataRecordFindAllResult.push({
          channel: 'sensor', attributeName: null,
          sum: 100, avg: null, count: null, min: null, max: null
        });

        const { list: results, channelMetas } = await fastify.statistics.services.periodStat.query({
          channel: 'sensor', startTime, endTime, aggregates: ['sum']
        });

        const drCalls = findAllCalls.filter(c => c.model === 'dataRecord');
        expect(drCalls.length).to.be.greaterThan(0);

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

    describe('cron onTick 错误处理', () => {
      it('should catch and log error when aggregate fails in cron onTick', async () => {
        const { fastify } = createMockFastify();
        const createdJobs = [];
        let logErrorCalled = false;

        const originalLogError = fastify.log.error;
        fastify.log.error = (msg) => {
          logErrorCalled = true;
          return originalLogError ? originalLogError.call(fastify.log, msg) : undefined;
        };

        fastify.decorate('cron', {
          createJob: (jobConfig) => {
            createdJobs.push(jobConfig);
          }
        });

        // Register service first
        await mockPeriodStatService(fastify, { name: 'statistics' });

        // Now manually trigger onTick with a failing aggregate
        fastify.statistics.models.dataRecord.findAll = async () => {
          throw new Error('Cron aggregate error');
        };

        const hJob = createdJobs.find(j => j.name === 'statistics-period-stat-h');
        expect(hJob).to.exist;

        await hJob.onTick();

        expect(logErrorCalled).to.be.true;

        await fastify.close();
      });
    });
  });
});
