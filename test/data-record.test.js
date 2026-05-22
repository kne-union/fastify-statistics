const { expect } = require('chai');
const fp = require('fastify-plugin');

const mockDataRecordService = (fastify, options) => {
  const servicePlugin = require('../libs/services/data-record');
  return fp(servicePlugin)(fastify, options);
};

const createMockFastify = ({ flushInterval = 100, maxBufferSize = 3 } = {}) => {
  const bulkCreateCalls = [];
  const cacheStore = {};
  const mockTransaction = {
    commit: async () => {},
    rollback: async () => {}
  };
  const mockModel = {
    dataRecord: {
      bulkCreate: async (records) => {
        bulkCreateCalls.push([...records]);
        return records;
      }
    }
  };

  const fastify = require('fastify')();

  fastify.decorate('sequelize', {
    Sequelize: { Op: {} },
    instance: { transaction: async () => mockTransaction }
  });

  fastify.decorate('statistics', {
    models: mockModel,
    services: {}
  });

  const cache = {
    get: async (key) => cacheStore[key] || null,
    set: async (key, value) => {
      cacheStore[key] = value;
    }
  };

  return { fastify, bulkCreateCalls, cacheStore, mockModel, cache };
};

describe('@kne/fastify-statistics', function () {
  describe('数据采集接口测试', () => {
    describe('无缓存模式（即时入库）', () => {
      it('should write to DB immediately when no cache is provided', async () => {
        const { fastify, bulkCreateCalls } = createMockFastify();
        await mockDataRecordService(fastify, {
          name: 'statistics',
          collectFlushInterval: 60000,
          collectMaxBufferSize: 1000
        });

        await fastify.statistics.services.dataRecord.collect({
          channel: 'ch1',
          title: 'test',
          data: 1,
          time: new Date()
        });

        expect(bulkCreateCalls.length).to.equal(1);
        expect(bulkCreateCalls[0][0].channel).to.equal('ch1');

        await fastify.close();
      });

      it('should write multiple expanded records immediately when no cache', async () => {
        const { fastify, bulkCreateCalls } = createMockFastify();
        await mockDataRecordService(fastify, {
          name: 'statistics',
          collectFlushInterval: 60000,
          collectMaxBufferSize: 1000
        });

        await fastify.statistics.services.dataRecord.collect({
          channel: 'a:b:c',
          title: 'test',
          data: { x: 1, y: 2 },
          time: new Date()
        });

        expect(bulkCreateCalls.length).to.equal(1);
        expect(bulkCreateCalls[0].length).to.equal(6);

        await fastify.close();
      });

      it('should not start flush timer when no cache', async () => {
        const { fastify, bulkCreateCalls } = createMockFastify();
        await mockDataRecordService(fastify, {
          name: 'statistics',
          collectFlushInterval: 50,
          collectMaxBufferSize: 1000
        });

        await fastify.statistics.services.dataRecord.collect({
          channel: 'ch1',
          title: 'test',
          data: 1,
          time: new Date()
        });

        expect(bulkCreateCalls.length).to.equal(1);

        await new Promise(resolve => setTimeout(resolve, 150));

        expect(bulkCreateCalls.length).to.equal(1);

        await fastify.close();
      });
    });

    describe('缓存模式（延迟入库）', () => {
      it('should buffer data when cache is provided', async () => {
        const { fastify, bulkCreateCalls, cache } = createMockFastify();
        await mockDataRecordService(fastify, {
          name: 'statistics',
          collectFlushInterval: 60000,
          collectMaxBufferSize: 1000,
          cache
        });

        fastify.statistics.services.dataRecord.collect({
          channel: 'temperature',
          title: '温度',
          data: 36.5,
          unit: '℃',
          time: new Date()
        });

        expect(bulkCreateCalls.length).to.equal(0);
        await fastify.close();
      });

      it('should trigger flush when buffer reaches maxBufferSize', async () => {
        const { fastify, bulkCreateCalls, cache } = createMockFastify({ maxBufferSize: 2 });
        await mockDataRecordService(fastify, {
          name: 'statistics',
          collectFlushInterval: 60000,
          collectMaxBufferSize: 2,
          cache
        });

        fastify.statistics.services.dataRecord.collect({
          channel: 'ch1',
          title: 'test',
          data: 1,
          time: new Date()
        });

        expect(bulkCreateCalls.length).to.equal(0);

        fastify.statistics.services.dataRecord.collect({
          channel: 'ch2',
          title: 'test',
          data: 2,
          time: new Date()
        });

        await new Promise(resolve => setTimeout(resolve, 50));

        expect(bulkCreateCalls.length).to.equal(1);
        expect(bulkCreateCalls[0].length).to.equal(2);
        expect(bulkCreateCalls[0][0].channel).to.equal('ch1');
        expect(bulkCreateCalls[0][1].channel).to.equal('ch2');

        await fastify.close();
      });

      it('should not include _seq in bulkCreate records', async () => {
        const { fastify, bulkCreateCalls, cache } = createMockFastify({ maxBufferSize: 1 });
        await mockDataRecordService(fastify, {
          name: 'statistics',
          collectFlushInterval: 60000,
          collectMaxBufferSize: 1,
          cache
        });

        fastify.statistics.services.dataRecord.collect({
          channel: 'ch1',
          title: 'test',
          data: 1,
          time: new Date()
        });

        await new Promise(resolve => setTimeout(resolve, 50));

        expect(bulkCreateCalls.length).to.equal(1);
        const record = bulkCreateCalls[0][0];
        expect(record._seq).to.be.undefined;
        expect(record.channel).to.equal('ch1');

        await fastify.close();
      });
    });

    describe('flush 方法', () => {
      it('should flush all buffered records to database', async () => {
        const { fastify, bulkCreateCalls, cache } = createMockFastify();
        await mockDataRecordService(fastify, {
          name: 'statistics',
          collectFlushInterval: 60000,
          collectMaxBufferSize: 1000,
          cache
        });

        fastify.statistics.services.dataRecord.collect({
          channel: 'ch1',
          title: 'test',
          data: 1,
          time: new Date()
        });
        fastify.statistics.services.dataRecord.collect({
          channel: 'ch2',
          title: 'test',
          data: 2,
          time: new Date()
        });

        await fastify.statistics.services.dataRecord.flush();

        expect(bulkCreateCalls.length).to.equal(1);
        expect(bulkCreateCalls[0].length).to.equal(2);

        await fastify.close();
      });

      it('should do nothing when buffer is empty', async () => {
        const { fastify, bulkCreateCalls, cache } = createMockFastify();
        await mockDataRecordService(fastify, {
          name: 'statistics',
          collectFlushInterval: 60000,
          collectMaxBufferSize: 1000,
          cache
        });

        await fastify.statistics.services.dataRecord.flush();

        expect(bulkCreateCalls.length).to.equal(0);

        await fastify.close();
      });

      it('should restore buffer items when bulkCreate fails', async () => {
        const { fastify, mockModel, cache } = createMockFastify();
        let shouldFail = true;
        const originalBulkCreate = mockModel.dataRecord.bulkCreate;
        mockModel.dataRecord.bulkCreate = async (records) => {
          if (shouldFail) {
            shouldFail = false;
            throw new Error('DB error');
          }
          return originalBulkCreate(records);
        };

        await mockDataRecordService(fastify, {
          name: 'statistics',
          collectFlushInterval: 60000,
          collectMaxBufferSize: 1000,
          cache
        });

        fastify.statistics.services.dataRecord.collect({
          channel: 'ch1',
          title: 'test',
          data: 1,
          time: new Date()
        });

        try {
          await fastify.statistics.services.dataRecord.flush();
        } catch (e) {
          expect(e.message).to.equal('DB error');
        }

        await fastify.statistics.services.dataRecord.flush();

        await fastify.close();
      });
    });

    describe('定时 flush 测试', () => {
      it('should flush periodically based on flushInterval', async () => {
        const { fastify, bulkCreateCalls, cache } = createMockFastify({ flushInterval: 100 });
        await mockDataRecordService(fastify, {
          name: 'statistics',
          collectFlushInterval: 100,
          collectMaxBufferSize: 1000,
          cache
        });

        fastify.statistics.services.dataRecord.collect({
          channel: 'ch1',
          title: 'test',
          data: 1,
          time: new Date()
        });

        expect(bulkCreateCalls.length).to.equal(0);

        await new Promise(resolve => setTimeout(resolve, 200));

        expect(bulkCreateCalls.length).to.equal(1);
        expect(bulkCreateCalls[0].length).to.equal(1);

        await fastify.close();
      });
    });

    describe('缓存持久化测试', () => {
      it('should persist buffer to cache on flush', async () => {
        const { fastify, cacheStore, cache } = createMockFastify({ maxBufferSize: 1 });
        await mockDataRecordService(fastify, {
          name: 'statistics',
          collectFlushInterval: 60000,
          collectMaxBufferSize: 1,
          cache
        });

        fastify.statistics.services.dataRecord.collect({
          channel: 'ch1',
          title: 'test',
          data: 1,
          time: new Date()
        });

        await new Promise(resolve => setTimeout(resolve, 50));

        const cacheKey = 'statistics:data-record:buffer';
        expect(cacheStore[cacheKey]).to.exist;
        expect(cacheStore[cacheKey].length).to.equal(0);

        await fastify.close();
      });

      it('should restore buffer from cache on startup', async () => {
        const cacheStore = {
          'statistics:data-record:buffer': [
            { _seq: 1, channel: 'ch1', title: 'test', data: 1, time: new Date().toISOString() }
          ]
        };

        const { fastify, bulkCreateCalls } = createMockFastify();
        const cache = {
          get: async (key) => cacheStore[key] || null,
          set: async (key, value) => { cacheStore[key] = value; }
        };

        await mockDataRecordService(fastify, {
          name: 'statistics',
          collectFlushInterval: 60000,
          collectMaxBufferSize: 1000,
          cache
        });

        await fastify.statistics.services.dataRecord.flush();

        expect(bulkCreateCalls.length).to.equal(1);
        expect(bulkCreateCalls[0][0].channel).to.equal('ch1');

        await fastify.close();
      });
    });

    describe('onClose 钩子测试', () => {
      it('should flush remaining buffer on close', async () => {
        const { fastify, bulkCreateCalls, cache } = createMockFastify();
        await mockDataRecordService(fastify, {
          name: 'statistics',
          collectFlushInterval: 60000,
          collectMaxBufferSize: 1000,
          cache
        });

        fastify.statistics.services.dataRecord.collect({
          channel: 'ch1',
          title: 'test',
          data: 1,
          time: new Date()
        });

        expect(bulkCreateCalls.length).to.equal(0);

        await fastify.close();

        expect(bulkCreateCalls.length).to.equal(1);
        expect(bulkCreateCalls[0][0].channel).to.equal('ch1');
      });

      it('should persist buffer to cache before flush on close', async () => {
        const { fastify, cacheStore, cache } = createMockFastify();
        await mockDataRecordService(fastify, {
          name: 'statistics',
          collectFlushInterval: 60000,
          collectMaxBufferSize: 1000,
          cache
        });

        fastify.statistics.services.dataRecord.collect({
          channel: 'ch1',
          title: 'test',
          data: 1,
          time: new Date()
        });

        await fastify.close();

        const cacheKey = 'statistics:data-record:buffer';
        expect(cacheStore[cacheKey]).to.exist;
      });

      it('should not register onClose hook when no cache', async () => {
        const { fastify, bulkCreateCalls } = createMockFastify();
        await mockDataRecordService(fastify, {
          name: 'statistics',
          collectFlushInterval: 60000,
          collectMaxBufferSize: 1000
        });

        await fastify.statistics.services.dataRecord.collect({
          channel: 'ch1',
          title: 'test',
          data: 1,
          time: new Date()
        });

        expect(bulkCreateCalls.length).to.equal(1);

        await fastify.close();

        expect(bulkCreateCalls.length).to.equal(1);
      });
    });

    describe('默认配置测试', () => {
      it('should use default flushInterval and maxBufferSize when not provided', async () => {
        const { fastify, bulkCreateCalls, cache } = createMockFastify();
        await mockDataRecordService(fastify, {
          name: 'statistics',
          cache
        });

        fastify.statistics.services.dataRecord.collect({
          channel: 'ch1',
          title: 'test',
          data: 1,
          time: new Date()
        });

        expect(bulkCreateCalls.length).to.equal(0);

        await fastify.statistics.services.dataRecord.flush();
        expect(bulkCreateCalls.length).to.equal(1);
        expect(bulkCreateCalls[0][0].channel).to.equal('ch1');

        await fastify.close();
      });
    });

    describe('缓存恢复测试 - 无 _seq', () => {
      it('should handle buffer items without _seq field', async () => {
        const cacheStore = {
          'statistics:data-record:buffer': [
            { channel: 'ch1', title: 'test', data: 1, time: new Date().toISOString() }
          ]
        };

        const { fastify, bulkCreateCalls } = createMockFastify();
        const cache = {
          get: async (key) => cacheStore[key] || null,
          set: async (key, value) => { cacheStore[key] = value; }
        };

        await mockDataRecordService(fastify, {
          name: 'statistics',
          cache
        });

        await fastify.statistics.services.dataRecord.flush();

        expect(bulkCreateCalls.length).to.equal(1);
        expect(bulkCreateCalls[0][0].channel).to.equal('ch1');

        await fastify.close();
      });
    });

    describe('事务回滚测试', () => {
      it('should rollback transaction when collectImmediate bulkCreate fails', async () => {
        const { fastify, mockModel } = createMockFastify();
        let rollbackCalled = false;
        const mockTransaction = {
          commit: async () => {},
          rollback: async () => { rollbackCalled = true; }
        };
        fastify.sequelize.instance.transaction = async () => mockTransaction;

        mockModel.dataRecord.bulkCreate = async () => {
          throw new Error('DB write error');
        };

        await mockDataRecordService(fastify, {
          name: 'statistics',
          collectFlushInterval: 60000,
          collectMaxBufferSize: 1000
        });

        try {
          await fastify.statistics.services.dataRecord.collect({
            channel: 'ch1',
            title: 'test',
            data: 1,
            time: new Date()
          });
          expect.fail('should have thrown');
        } catch (e) {
          expect(e.message).to.equal('DB write error');
          expect(rollbackCalled).to.be.true;
        }

        await fastify.close();
      });
    });

    describe('persistBuffer 错误处理测试', () => {
      it('should log error when cache.set fails in persistBuffer', async () => {
        const { fastify, bulkCreateCalls } = createMockFastify();
        let errorLogged = false;
        const origLogError = fastify.log.error;
        fastify.log.error = function (...args) {
          if (args[1] === 'Failed to persist buffer to cache') {
            errorLogged = true;
          }
          return origLogError ? origLogError.apply(this, args) : undefined;
        };

        let setCallCount = 0;
        const cache = {
          get: async () => null,
          set: async (key, value) => {
            setCallCount++;
            if (setCallCount === 1) {
              throw new Error('Cache write error');
            }
          }
        };

        await mockDataRecordService(fastify, {
          name: 'statistics',
          collectFlushInterval: 60000,
          collectMaxBufferSize: 1000,
          cache
        });

        fastify.statistics.services.dataRecord.collect({
          channel: 'ch1',
          title: 'test',
          data: 1,
          time: new Date()
        });

        await fastify.close();

        expect(errorLogged).to.be.true;
        fastify.log.error = origLogError;
      });
    });

    describe('定时 flush 错误处理测试', () => {
      it('should catch and log error when flush fails in timer', async () => {
        const { fastify, mockModel, cache } = createMockFastify({ flushInterval: 50 });
        let errorLogged = false;
        const origLogError = fastify.log.error;
        fastify.log.error = function (...args) {
          if (args[1] === 'Failed to flush data records') {
            errorLogged = true;
          }
          return origLogError ? origLogError.apply(this, args) : undefined;
        };

        let failCount = 0;
        const originalBulkCreate = mockModel.dataRecord.bulkCreate;
        mockModel.dataRecord.bulkCreate = async (...args) => {
          failCount++;
          if (failCount === 1) {
            throw new Error('Timer flush error');
          }
          return originalBulkCreate(...args);
        };

        await mockDataRecordService(fastify, {
          name: 'statistics',
          collectFlushInterval: 50,
          collectMaxBufferSize: 1000,
          cache
        });

        fastify.statistics.services.dataRecord.collect({
          channel: 'ch1',
          title: 'test',
          data: 1,
          time: new Date()
        });

        await new Promise(resolve => setTimeout(resolve, 150));

        expect(errorLogged).to.be.true;

        fastify.log.error = origLogError;
        await fastify.close();
      });

      it('should catch and log error when flush fails on buffer overflow', async () => {
        const { fastify, mockModel, cache } = createMockFastify({ maxBufferSize: 1 });
        let errorLogged = false;
        const origLogError = fastify.log.error;
        fastify.log.error = function (...args) {
          if (args[1] === 'Failed to flush data records on buffer overflow') {
            errorLogged = true;
          }
          return origLogError ? origLogError.apply(this, args) : undefined;
        };

        let failCount = 0;
        const originalBulkCreate = mockModel.dataRecord.bulkCreate;
        mockModel.dataRecord.bulkCreate = async (...args) => {
          failCount++;
          if (failCount === 1) {
            throw new Error('Buffer overflow flush error');
          }
          return originalBulkCreate(...args);
        };

        await mockDataRecordService(fastify, {
          name: 'statistics',
          collectFlushInterval: 60000,
          collectMaxBufferSize: 1,
          cache
        });

        fastify.statistics.services.dataRecord.collect({
          channel: 'ch1',
          title: 'test',
          data: 1,
          time: new Date()
        });

        await new Promise(resolve => setTimeout(resolve, 100));

        expect(errorLogged).to.be.true;

        fastify.log.error = origLogError;
        await fastify.close();
      });
    });
  });
});
