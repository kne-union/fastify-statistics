const { expect } = require('chai');
const fp = require('fastify-plugin');

const mockChannelMetaService = (fastify, options) => {
  const servicePlugin = require('../libs/services/channel-meta');
  return fp(servicePlugin)(fastify, options);
};

const createMockFastify = () => {
  const store = {};
  const mockModel = {
    channelMeta: {
      findOne: async ({ where }) => {
        return store[where.channel] || null;
      },
      findAll: async ({ where }) => {
        if (where && where.channel) {
          return Object.values(store).filter(item => item.channel === where.channel);
        }
        return Object.values(store);
      },
      update: async (values, { where }) => {
        const item = store[where.channel];
        if (!item) return [0];
        Object.assign(item, values);
        return [1];
      }
    }
  };

  const fastify = require('fastify')();

  fastify.decorate('statistics', {
    models: mockModel,
    services: {}
  });

  return { fastify, store };
};

describe('Channel Meta Service', () => {
  describe('detail', () => {
    it('should return null when channel meta not found', async () => {
      const { fastify } = createMockFastify();
      await mockChannelMetaService(fastify, { name: 'statistics' });

      const result = await fastify.statistics.services.channelMeta.detail({
        channel: 'nonexistent'
      });
      expect(result).to.be.null;

      await fastify.close();
    });

    it('should return channel meta when found', async () => {
      const { fastify, store } = createMockFastify();
      store['sensor'] = {
        channel: 'sensor',
        title: '传感器',
        description: '温度传感器'
      };
      await mockChannelMetaService(fastify, { name: 'statistics' });

      const result = await fastify.statistics.services.channelMeta.detail({
        channel: 'sensor'
      });
      expect(result).to.not.be.null;
      expect(result.channel).to.equal('sensor');
      expect(result.title).to.equal('传感器');

      await fastify.close();
    });
  });

  describe('list', () => {
    it('should return all channel metas when no filter', async () => {
      const { fastify, store } = createMockFastify();
      store['sensor'] = { channel: 'sensor', title: '传感器' };
      store['humidity'] = { channel: 'humidity', title: '湿度' };
      await mockChannelMetaService(fastify, { name: 'statistics' });

      const result = await fastify.statistics.services.channelMeta.list({});
      expect(result.length).to.equal(2);

      await fastify.close();
    });

    it('should filter by channel', async () => {
      const { fastify, store } = createMockFastify();
      store['sensor'] = { channel: 'sensor', title: '传感器' };
      store['humidity'] = { channel: 'humidity', title: '湿度' };
      await mockChannelMetaService(fastify, { name: 'statistics' });

      const result = await fastify.statistics.services.channelMeta.list({ filter: { channel: 'sensor' } });
      expect(result.length).to.equal(1);
      expect(result[0].channel).to.equal('sensor');

      await fastify.close();
    });

    it('should return empty array when no match', async () => {
      const { fastify } = createMockFastify();
      await mockChannelMetaService(fastify, { name: 'statistics' });

      const result = await fastify.statistics.services.channelMeta.list({ filter: { channel: 'nonexistent' } });
      expect(result).to.deep.equal([]);

      await fastify.close();
    });

    it('should return all when filter is empty', async () => {
      const { fastify, store } = createMockFastify();
      store['sensor'] = { channel: 'sensor', title: '传感器' };
      await mockChannelMetaService(fastify, { name: 'statistics' });

      const result = await fastify.statistics.services.channelMeta.list({ filter: {} });
      expect(result.length).to.equal(1);

      await fastify.close();
    });
  });

  describe('save', () => {
    it('should update channel meta fields', async () => {
      const { fastify, store } = createMockFastify();
      store['sensor'] = {
        channel: 'sensor',
        title: '旧标题',
        description: null
      };
      await mockChannelMetaService(fastify, { name: 'statistics' });

      const result = await fastify.statistics.services.channelMeta.save({
        channel: 'sensor',
        title: '新标题',
        description: '新描述'
      });

      expect(result.title).to.equal('新标题');
      expect(result.description).to.equal('新描述');

      await fastify.close();
    });

    it('should throw error when channel meta not found', async () => {
      const { fastify } = createMockFastify();
      await mockChannelMetaService(fastify, { name: 'statistics' });

      try {
        await fastify.statistics.services.channelMeta.save({
          channel: 'nonexistent',
          title: 'test'
        });
        expect.fail('Should have thrown');
      } catch (e) {
        expect(e.message).to.include('Channel meta not found');
      }

      await fastify.close();
    });

    it('should not overwrite channel field', async () => {
      const { fastify, store } = createMockFastify();
      store['sensor'] = {
        channel: 'sensor',
        title: '旧标题',
        description: null
      };
      await mockChannelMetaService(fastify, { name: 'statistics' });

      await fastify.statistics.services.channelMeta.save({
        channel: 'sensor',
        title: '新标题',
        description: '描述'
      });

      expect(store['sensor'].channel).to.equal('sensor');

      await fastify.close();
    });
  });
});
