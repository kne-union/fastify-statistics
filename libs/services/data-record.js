const fp = require('fastify-plugin');

const BUFFER_CACHE_KEY = 'statistics:data-record:buffer';

module.exports = fp(async (fastify, options) => {
  const { models } = fastify[options.name];
  const { Op } = fastify.sequelize.Sequelize;
  const sequelize = fastify.sequelize.instance;
  const cache = options.cache || null;

  const flushInterval = options.collectFlushInterval || 5000;
  const maxBufferSize = options.collectMaxBufferSize || 1000;

  let buffer = [];
  let seq = 0;
  let flushTimer = null;

  const nextSeq = () => {
    seq += 1;
    return seq;
  };

  const persistBuffer = async () => {
    if (!cache || buffer.length === 0) return;
    await cache.set(BUFFER_CACHE_KEY, buffer);
  };

  const restoreBuffer = async () => {
    const saved = await cache.get(BUFFER_CACHE_KEY);
    if (Array.isArray(saved) && saved.length > 0) {
      buffer = saved;
      const maxSeq = buffer.reduce((max, item) => Math.max(max, item._seq || 0), 0);
      seq = maxSeq;
    }
  };

  const flush = async () => {
    if (buffer.length === 0) return;
    const items = buffer.splice(0, buffer.length);
    try {
      const records = items.map(item => {
        const { _seq, ...data } = item;
        return data;
      });
      const transaction = await sequelize.transaction();
      try {
        await models.dataRecord.bulkCreate(records, { transaction });
        await transaction.commit();
      } catch (e) {
        await transaction.rollback();
        throw e;
      }
      await cache.set(BUFFER_CACHE_KEY, buffer);
    } catch (e) {
      buffer = [...items, ...buffer];
      throw e;
    }
  };

  const startFlushTimer = () => {
    if (flushTimer) return;
    flushTimer = setInterval(async () => {
      try {
        await flush();
      } catch (e) {
        console.error('Failed to flush data records:', e);
      }
    }, flushInterval);
    flushTimer.unref();
  };

  const stopFlushTimer = () => {
    clearInterval(flushTimer);
    flushTimer = null;
  };

  const expandChannel = channel => {
    const parts = channel.split(':');
    const channels = [];
    for (let i = parts.length; i >= 1; i--) {
      channels.push(parts.slice(0, i).join(':'));
    }
    return channels;
  };

  const expandData = data => {
    const { data: dataValue, ...rest } = data;
    if (dataValue !== null && typeof dataValue === 'object' && !Array.isArray(dataValue)) {
      return Object.entries(dataValue).map(([attributeName, value]) => ({
        ...rest,
        attributeName,
        data: value
      }));
    }
    return [data];
  };

  const collectImmediate = async data => {
    const expanded = expandData(data);
    const records = [];
    for (const item of expanded) {
      const channels = expandChannel(item.channel);
      for (const channel of channels) {
        const { data: _, ...rest } = item;
        records.push({ ...rest, channel });
      }
    }
    const transaction = await sequelize.transaction();
    try {
      await models.dataRecord.bulkCreate(records, { transaction });
      await transaction.commit();
    } catch (e) {
      await transaction.rollback();
      throw e;
    }
  };

  const collectBuffered = data => {
    const expanded = expandData(data);
    for (const item of expanded) {
      const channels = expandChannel(item.channel);
      for (const channel of channels) {
        buffer.push({ ...item, channel, _seq: nextSeq() });
      }
    }
    if (buffer.length >= maxBufferSize) {
      flush().catch(e => {
        console.error('Failed to flush data records:', e);
      });
    }
  };

  const collect = cache ? collectBuffered : collectImmediate;

  if (cache) {
    await restoreBuffer();
    startFlushTimer();

    fastify.addHook('onClose', async () => {
      stopFlushTimer();
      await persistBuffer();
      await flush();
    });
  }

  Object.assign(fastify[options.name].services, {
    collect,
    dataRecord: {
      collect,
      flush
    }
  });
});
