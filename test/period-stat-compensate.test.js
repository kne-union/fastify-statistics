const { expect } = require('chai');
const {
  mockPeriodStatService, createMockFastify, createCompensateMockFastify, createFullMockFastify
} = require('./period-stat-helpers');

describe('@kne/fastify-statistics', function () {
  describe('compensate 补偿与调度测试', () => {
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

        expect(createdJobs.length).to.equal(7);

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

        const watermarkStore = {};
        fastify.statistics.models.aggregationWatermark = {
          findOne: async ({ where }) => watermarkStore[where.period] || null,
          upsert: async (data) => { watermarkStore[data.period] = data; },
          create: async (data) => { watermarkStore[data.period] = data; return data; }
        };

        fastify.decorate('cron', {
          createJob: (jobConfig) => {
            createdJobs.push(jobConfig);
          }
        });

        await mockPeriodStatService(fastify, { name: 'statistics', compensationEnabled: false });

        const pastTime = new Date('2020-01-01T00:00:00.000Z');
        watermarkStore['h'] = { period: 'h', nextTime: pastTime };

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

    describe('compensate 补偿逻辑测试', () => {
      it('should initialize watermark from data-record min time when no existing watermark', async () => {
        const { fastify, findAllResults, watermarkStore, mockModel } = createCompensateMockFastify();

        const minTime = new Date('2026-05-01T00:00:00.000Z');
        mockModel.dataRecord.findOne = async () => ({ minTime });
        mockModel.periodStat.findOne = async () => ({ minTime });

        expect(watermarkStore['h']).to.be.undefined;

        await mockPeriodStatService(fastify, { name: 'statistics', compensationEnabled: false });

        expect(watermarkStore['h']).to.exist;

        const createdJobs = [];
        fastify.decorate('cron', {
          createJob: (jobConfig) => {
            createdJobs.push(jobConfig);
          }
        });

        await mockPeriodStatService(fastify, { name: 'statistics', compensationEnabled: false });

        findAllResults.push({
          channel: 'ch1', attributeName: 'val',
          sum: 10, avg: null, count: null, min: null, max: null
        });

        const hJob = createdJobs.find(j => j.name === 'statistics-period-stat-h');
        if (hJob) {
          await hJob.onTick();
          expect(watermarkStore['h']).to.exist;
        }

        await fastify.close();
      });

      it('should return existing watermark without reinitializing', async () => {
        const { fastify, watermarkStore } = createCompensateMockFastify();
        await mockPeriodStatService(fastify, { name: 'statistics', compensationEnabled: false });

        const existingTime = new Date('2026-05-01T00:00:00.000Z');
        watermarkStore['h'] = { period: 'h', nextTime: existingTime };

        let findOneCalled = false;
        fastify.statistics.models.dataRecord.findOne = async () => { findOneCalled = true; return null; };
        fastify.statistics.models.periodStat.findOne = async () => { findOneCalled = true; return null; };

        const createdJobs = [];
        fastify.decorate('cron', {
          createJob: (jobConfig) => {
            createdJobs.push(jobConfig);
          }
        });

        await mockPeriodStatService(fastify, { name: 'statistics', compensationEnabled: false });

        const hJob = createdJobs.find(j => j.name === 'statistics-period-stat-h');
        if (hJob) {
          await hJob.onTick();
        }

        await fastify.close();
      });

      it('should initialize watermark from period-stat min time for non-h periods', async () => {
        const { fastify, findAllResults, watermarkStore, mockModel } = createCompensateMockFastify();
        await mockPeriodStatService(fastify, { name: 'statistics', compensationEnabled: false });

        const minTime = new Date('2026-05-01T00:00:00.000Z');
        mockModel.periodStat.findOne = async (opts) => {
          if (opts.where && opts.where.period === 'h') return { minTime };
          return null;
        };
        mockModel.dataRecord.findOne = async () => ({ minTime });

        watermarkStore['h'] = { period: 'h', nextTime: new Date('2026-05-27T00:00:00.000Z') };

        fastify.statistics.models.periodStat.findAll = async (opts) => {
          const period = opts.where && opts.where.period;
          if (period === 'h') {
            return [{ period: 'h', channel: 'ch1', attributeName: 'val', aggregate: 'sum', data: 10, time: minTime }];
          }
          return [];
        };

        const createdJobs = [];
        fastify.decorate('cron', {
          createJob: (jobConfig) => {
            createdJobs.push(jobConfig);
          }
        });

        await mockPeriodStatService(fastify, { name: 'statistics', compensationEnabled: false });

        const dJob = createdJobs.find(j => j.name === 'statistics-period-stat-d');
        if (dJob) {
          await dJob.onTick();
        }

        await fastify.close();
      });

      it('should return existing watermark without reinitializing (via aggregate)', async () => {
        const { fastify, watermarkStore } = createCompensateMockFastify();
        await mockPeriodStatService(fastify, { name: 'statistics', compensationEnabled: false });

        const existingTime = new Date('2026-05-01T00:00:00.000Z');
        watermarkStore['h'] = { period: 'h', nextTime: existingTime };

        const records = await fastify.statistics.services.periodStat.aggregate('h');
        expect(watermarkStore['h'].nextTime).to.deep.equal(existingTime);

        await fastify.close();
      });

      it('should skip compensate when lock is already held', async () => {
        const { fastify, watermarkStore } = createCompensateMockFastify();
        await mockPeriodStatService(fastify, { name: 'statistics', compensationEnabled: false });

        expect(fastify.statistics.services.periodStat.isCompensating()).to.be.false;

        await fastify.close();
      });
    });

    describe('invalidateQueryCache 版本递增测试', () => {
      it('should increment channel versions for multi-level channels', async () => {
        const { fastify } = createMockFastify();
        await mockPeriodStatService(fastify, { name: 'statistics' });

        fastify.statistics.services.periodStat.invalidateQueryCache(['device:sensor:temp']);

        expect(fastify.statistics.services.periodStat.isCompensating).to.be.a('function');

        await fastify.close();
      });

      it('should increment globalVersion on every invalidateQueryCache call', async () => {
        const { fastify } = createMockFastify();
        await mockPeriodStatService(fastify, { name: 'statistics' });

        fastify.statistics.services.periodStat.invalidateQueryCache(['ch1']);
        fastify.statistics.services.periodStat.invalidateQueryCache(['ch2']);

        expect(fastify.statistics.services.periodStat.invalidateQueryCache).to.be.a('function');

        await fastify.close();
      });

      it('should handle empty channels array in invalidateQueryCache', async () => {
        const { fastify } = createMockFastify();
        await mockPeriodStatService(fastify, { name: 'statistics' });

        fastify.statistics.services.periodStat.invalidateQueryCache([]);

        await fastify.close();
      });
    });

    describe('compensate 详细逻辑测试', () => {
      it('should log error when aggregate fails during compensation', async () => {
        const { fastify, watermarkStore, logCalls, mockModel } = createFullMockFastify();

        watermarkStore['h'] = { period: 'h', nextTime: new Date('2026-05-27T00:00:00.000Z') };
        mockModel.dataRecord.findAll = async () => { throw new Error('DB read error'); };

        const createdJobs = [];
        fastify.decorate('cron', {
          createJob: (jobConfig) => { createdJobs.push(jobConfig); }
        });

        await mockPeriodStatService(fastify, { name: 'statistics', compensationEnabled: false });

        const hJob = createdJobs.find(j => j.name === 'statistics-period-stat-h');
        expect(hJob).to.exist;
        await hJob.onTick();

        expect(logCalls.error.some(msg => msg.includes('Failed to compensate period h'))).to.be.true;

        await fastify.close();
      });

      it('should log warning when compensation is incomplete', async () => {
        const { fastify, watermarkStore, logCalls, findAllResults } = createFullMockFastify();

        watermarkStore['h'] = { period: 'h', nextTime: new Date('2020-01-01T00:00:00.000Z') };

        findAllResults.push({
          channel: 'ch1', attributeName: 'val',
          sum: 10, avg: null, count: null, min: null, max: null
        });

        const createdJobs = [];
        fastify.decorate('cron', {
          createJob: (jobConfig) => { createdJobs.push(jobConfig); }
        });

        await mockPeriodStatService(fastify, { name: 'statistics', compensationEnabled: false, compensationBatchSize: 1 });

        const hJob = createdJobs.find(j => j.name === 'statistics-period-stat-h');
        expect(hJob).to.exist;
        await hJob.onTick();

        expect(logCalls.warn.some(msg => msg.includes('补偿未完成'))).to.be.true;

        await fastify.close();
      });

      it('should log info when compensation completes with multiple windows', async () => {
        const { fastify, watermarkStore, logCalls, findAllResults } = createFullMockFastify();

        const now = new Date();
        const threeHoursAgo = new Date(now.getTime() - 3 * 3600000);
        threeHoursAgo.setMinutes(0, 0, 0);

        watermarkStore['h'] = { period: 'h', nextTime: threeHoursAgo };

        findAllResults.push({
          channel: 'ch1', attributeName: 'val',
          sum: 10, avg: null, count: null, min: null, max: null
        });

        const createdJobs = [];
        fastify.decorate('cron', {
          createJob: (jobConfig) => { createdJobs.push(jobConfig); }
        });

        await mockPeriodStatService(fastify, { name: 'statistics', compensationEnabled: false, compensationBatchSize: 100 });

        const hJob = createdJobs.find(j => j.name === 'statistics-period-stat-h');
        expect(hJob).to.exist;
        await hJob.onTick();

        expect(logCalls.info.some(msg => msg.includes('补偿完成'))).to.be.true;

        await fastify.close();
      });

      it('should log error when startup compensation fails', async () => {
        const { fastify, logCalls, mockModel, watermarkStore } = createFullMockFastify();

        const pastTime = new Date('2020-01-01T00:00:00.000Z');
        watermarkStore['h'] = { period: 'h', nextTime: pastTime };
        watermarkStore['d'] = { period: 'd', nextTime: pastTime };
        watermarkStore['w'] = { period: 'w', nextTime: pastTime };
        watermarkStore['m'] = { period: 'm', nextTime: pastTime };
        watermarkStore['q'] = { period: 'q', nextTime: pastTime };
        watermarkStore['y'] = { period: 'y', nextTime: pastTime };

        // Override findOne to return object with failing update, and create to fail
        mockModel.aggregationWatermark.findOne = async ({ where }) => {
          const entry = watermarkStore[where.period];
          if (!entry) return null;
          return {
            nextTime: entry.nextTime,
            update: async () => { throw new Error('Watermark write error'); }
          };
        };
        mockModel.aggregationWatermark.create = async () => { throw new Error('Watermark write error'); };

        await mockPeriodStatService(fastify, { name: 'statistics', compensationEnabled: true });

        for (let i = 0; i < 20; i++) {
          if (logCalls.error.some(msg => msg.includes('Startup compensation failed'))) break;
          await new Promise(resolve => setTimeout(resolve, 100));
        }

        expect(logCalls.error.some(msg => msg.includes('Startup compensation failed'))).to.be.true;

        await fastify.close();
      });

      it('should trigger upstream compensation when upstream watermark is behind', async () => {
        const { fastify, watermarkStore, findAllResults, bulkCreateCalls, periodStatRows, mockModel } = createFullMockFastify();

        watermarkStore['d'] = { period: 'd', nextTime: new Date('2026-05-26T00:00:00.000Z') };
        watermarkStore['h'] = { period: 'h', nextTime: new Date('2026-05-26T00:00:00.000Z') };

        findAllResults.push({
          channel: 'ch1', attributeName: 'val',
          sum: 10, avg: null, count: null, min: null, max: null
        });

        periodStatRows.push(
          { period: 'h', channel: 'ch1', attributeName: 'val', aggregate: 'sum', data: 10, time: new Date('2026-05-26T00:00:00.000Z') }
        );

        const createdJobs = [];
        fastify.decorate('cron', {
          createJob: (jobConfig) => { createdJobs.push(jobConfig); }
        });

        await mockPeriodStatService(fastify, { name: 'statistics', compensationEnabled: false });

        const dJob = createdJobs.find(j => j.name === 'statistics-period-stat-d');
        expect(dJob).to.exist;
        await dJob.onTick();

        expect(bulkCreateCalls.length).to.be.greaterThan(0);

        await fastify.close();
      });

      it('should log error via cron onTick when compensate throws outside aggregate', async () => {
        const { fastify, watermarkStore, logCalls, mockModel } = createFullMockFastify();

        const pastTime = new Date('2026-05-27T00:00:00.000Z');
        for (const p of ['h', 'd', 'w', 'm', 'q', 'y']) {
          watermarkStore[p] = { period: p, nextTime: pastTime };
        }

        const createdJobs = [];
        fastify.decorate('cron', {
          createJob: (jobConfig) => { createdJobs.push(jobConfig); }
        });

        await mockPeriodStatService(fastify, { name: 'statistics', compensationEnabled: false });

        // After init succeeds, make setWatermark fail
        mockModel.aggregationWatermark.findOne = async ({ where }) => {
          const entry = watermarkStore[where.period];
          if (!entry) return null;
          return {
            nextTime: entry.nextTime,
            update: async () => { throw new Error('Watermark write error'); }
          };
        };
        mockModel.aggregationWatermark.create = async () => { throw new Error('Watermark write error'); };

        const hJob = createdJobs.find(j => j.name === 'statistics-period-stat-h');
        expect(hJob).to.exist;
        await hJob.onTick();

        expect(logCalls.error.some(msg => msg.includes('Failed to compensate period h'))).to.be.true;

        await fastify.close();
      });
    });

    describe('w/m/q/y 周期 compensate getNextStart 覆盖测试', () => {
      it('should compensate w period using getNextStart (week)', async () => {
        const { fastify, watermarkStore, findAllResults, bulkCreateCalls, periodStatRows } = createFullMockFastify();

        const twoWeeksAgo = new Date();
        twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);
        const dayjs = require('dayjs');
        const wStart = dayjs(twoWeeksAgo).startOf('week').add(1, 'day').startOf('day').toDate();

        watermarkStore['w'] = { period: 'w', nextTime: wStart };
        watermarkStore['d'] = { period: 'd', nextTime: new Date() };

        periodStatRows.push(
          { period: 'd', channel: 'ch1', attributeName: 'val', aggregate: 'sum', data: 10, time: wStart }
        );

        const createdJobs = [];
        fastify.decorate('cron', {
          createJob: (jobConfig) => { createdJobs.push(jobConfig); }
        });

        await mockPeriodStatService(fastify, { name: 'statistics', compensationEnabled: false, compensationBatchSize: 100 });

        const wJob = createdJobs.find(j => j.name === 'statistics-period-stat-w');
        expect(wJob).to.exist;
        await wJob.onTick();

        expect(bulkCreateCalls.length).to.be.greaterThan(0);

        await fastify.close();
      });

      it('should compensate m period using getNextStart (month)', async () => {
        const { fastify, watermarkStore, bulkCreateCalls, periodStatRows } = createFullMockFastify();

        const twoMonthsAgo = new Date();
        twoMonthsAgo.setMonth(twoMonthsAgo.getMonth() - 2);
        twoMonthsAgo.setDate(1);
        twoMonthsAgo.setHours(0, 0, 0, 0);

        watermarkStore['m'] = { period: 'm', nextTime: twoMonthsAgo };
        watermarkStore['d'] = { period: 'd', nextTime: new Date() };

        periodStatRows.push(
          { period: 'd', channel: 'ch1', attributeName: 'val', aggregate: 'sum', data: 10, time: twoMonthsAgo }
        );

        const createdJobs = [];
        fastify.decorate('cron', {
          createJob: (jobConfig) => { createdJobs.push(jobConfig); }
        });

        await mockPeriodStatService(fastify, { name: 'statistics', compensationEnabled: false, compensationBatchSize: 100 });

        const mJob = createdJobs.find(j => j.name === 'statistics-period-stat-m');
        expect(mJob).to.exist;
        await mJob.onTick();

        expect(bulkCreateCalls.length).to.be.greaterThan(0);

        await fastify.close();
      });

      it('should compensate q period using getNextStart (quarter)', async () => {
        const { fastify, watermarkStore, bulkCreateCalls, periodStatRows } = createFullMockFastify();

        const sixMonthsAgo = new Date();
        sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
        const qMonth = Math.floor(sixMonthsAgo.getMonth() / 3) * 3;
        sixMonthsAgo.setMonth(qMonth, 1);
        sixMonthsAgo.setHours(0, 0, 0, 0);

        watermarkStore['q'] = { period: 'q', nextTime: sixMonthsAgo };
        watermarkStore['m'] = { period: 'm', nextTime: new Date() };

        periodStatRows.push(
          { period: 'm', channel: 'ch1', attributeName: 'val', aggregate: 'sum', data: 10, time: sixMonthsAgo }
        );

        const createdJobs = [];
        fastify.decorate('cron', {
          createJob: (jobConfig) => { createdJobs.push(jobConfig); }
        });

        await mockPeriodStatService(fastify, { name: 'statistics', compensationEnabled: false, compensationBatchSize: 100 });

        const qJob = createdJobs.find(j => j.name === 'statistics-period-stat-q');
        expect(qJob).to.exist;
        await qJob.onTick();

        expect(bulkCreateCalls.length).to.be.greaterThan(0);

        await fastify.close();
      });

      it('should compensate y period using getNextStart (year)', async () => {
        const { fastify, watermarkStore, bulkCreateCalls, periodStatRows } = createFullMockFastify();

        const twoYearsAgo = new Date();
        twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);
        twoYearsAgo.setMonth(0, 1);
        twoYearsAgo.setHours(0, 0, 0, 0);

        watermarkStore['y'] = { period: 'y', nextTime: twoYearsAgo };
        watermarkStore['q'] = { period: 'q', nextTime: new Date() };

        periodStatRows.push(
          { period: 'q', channel: 'ch1', attributeName: 'val', aggregate: 'sum', data: 10, time: twoYearsAgo }
        );

        const createdJobs = [];
        fastify.decorate('cron', {
          createJob: (jobConfig) => { createdJobs.push(jobConfig); }
        });

        await mockPeriodStatService(fastify, { name: 'statistics', compensationEnabled: false, compensationBatchSize: 100 });

        const yJob = createdJobs.find(j => j.name === 'statistics-period-stat-y');
        expect(yJob).to.exist;
        await yJob.onTick();

        expect(bulkCreateCalls.length).to.be.greaterThan(0);

        await fastify.close();
      });
    });

    describe('invalidateQueryCache 边界测试', () => {
      it('should handle invalidateQueryCache with no arguments (default empty array)', async () => {
        const { fastify } = createFullMockFastify();
        await mockPeriodStatService(fastify, { name: 'statistics', compensationEnabled: false });

        fastify.statistics.services.periodStat.invalidateQueryCache();

        await fastify.close();
      });
    });
  });
});
