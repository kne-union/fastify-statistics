const fp = require('fastify-plugin');

const BUFFER_CACHE_KEY = 'statistics:data-record:buffer';

module.exports = fp(async (fastify, options) => {
  const { models } = fastify[options.name];
  const { Op } = fastify.sequelize.Sequelize;
  const sequelize = fastify.sequelize.instance;
  const log = fastify.log;
  const cache = options.cache || null;

  const flushInterval = options.collectFlushInterval || 5000;
  const maxBufferSize = options.collectMaxBufferSize || 1000;
  const maxBufferOverflow = options.collectMaxBufferOverflow || maxBufferSize * 2;

  let buffer = [];
  let seq = 0;
  let flushTimer = null;
  let isFlushing = false;

  const nextSeq = () => {
    seq += 1;
    return seq;
  };

  const persistBuffer = async () => {
    if (!cache || buffer.length === 0) return;
    try {
      await cache.set(BUFFER_CACHE_KEY, buffer);
    } catch (e) {
      log.error({ err: e }, 'Failed to persist buffer to cache');
    }
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
    if (buffer.length === 0 || isFlushing) return;
    isFlushing = true;
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
      buffer = [...items, ...buffer].slice(-maxBufferOverflow);
      throw e;
    } finally {
      isFlushing = false;
    }
  };

  const startFlushTimer = () => {
    if (flushTimer) return;
    flushTimer = setInterval(async () => {
      try {
        await flush();
      } catch (e) {
        log.error({ err: e }, 'Failed to flush data records');
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
    startFlushTimer();
    if (buffer.length >= maxBufferSize) {
      flush().catch(e => {
        log.error({ err: e }, 'Failed to flush data records on buffer overflow');
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
