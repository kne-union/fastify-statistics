const fp = require('fastify-plugin');
const { formatData, formatEvent } = require('../common/sse-format');

const DEFAULT_HEARTBEAT_INTERVAL = 30000;
const DEFAULT_MAX_DURATION = 30 * 60 * 1000;

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no'
};

module.exports = fp(async (fastify, options) => {
  const cache = options.cache || null;

  const getCacheKey = (name, params, intervalSeconds) => {
    const intervalMs = intervalSeconds * 1000;
    const truncatedTime = Math.floor(Date.now() / intervalMs) * intervalMs;
    const sortedParams =
      params && typeof params === 'object'
        ? Object.keys(params)
            .sort()
            .reduce((acc, key) => {
              acc[key] = params[key];
              return acc;
            }, {})
        : params;
    return `statistics:sse:${name}:${JSON.stringify(sortedParams)}:${truncatedTime}`;
  };

  const getOrFetchData = async (name, params, fetchData, intervalSeconds) => {
    if (!cache) {
      return await fetchData(params);
    }
    const cacheKey = getCacheKey(name, params, intervalSeconds);
    const cached = await cache.get(cacheKey);
    if (cached !== null && cached !== undefined) {
      return cached;
    }
    const data = await fetchData(params);
    await cache.set(cacheKey, data);
    return data;
  };

  /**
   * Send SSE stream to client
   * @param {object} reply - Fastify reply object
   * @param {object} config
   * @param {string} config.name - Unique name for cache key
   * @param {object} config.params - Parameters passed to fetchData
   * @param {function} config.fetchData - Async function(params) => data
   * @param {number} [config.interval=5] - Push interval in seconds
   * @param {number} [config.heartbeatInterval=30000] - Heartbeat interval in ms
   * @param {number} [config.maxDuration=1800000] - Max connection duration in ms
   * @returns {Promise<object>} SSE context: { isConnected(), close(), onClose(callback) }
   */
  const send = async (reply, { name, params, fetchData, interval = 5, heartbeatInterval = DEFAULT_HEARTBEAT_INTERVAL, maxDuration = DEFAULT_MAX_DURATION }) => {
    const intervalSeconds = interval;
    const pushIntervalMs = intervalSeconds * 1000;
    const res = reply.raw;
    const log = reply.log;
    const startTime = Date.now();

    // Hijack first, then send headers immediately — fixes @fastify/sse Bug #1
    reply.hijack();

    // Transfer any headers set by middleware (CORS, etc.) to raw response
    const replyHeaders = reply.getHeaders();
    for (const [name, value] of Object.entries(replyHeaders)) {
      res.setHeader(name, value);
    }

    res.writeHead(200, SSE_HEADERS);

    let isConnected = true;
    let pushing = false;
    let heartbeatTimer = null;
    let pushTimer = null;
    const closeCallbacks = [];

    const safeWrite = data => {
      if (!isConnected || res.writableEnded) return false;
      const canWrite = res.write(data);
      if (!canWrite) {
        cleanup();
        return false;
      }
      return true;
    };

    const cleanup = () => {
      if (!isConnected) return;
      isConnected = false;
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      if (pushTimer) {
        clearTimeout(pushTimer);
        pushTimer = null;
      }
      for (const cb of closeCallbacks) {
        try {
          cb();
        } catch (e) {
          log.error({ err: e }, 'SSE close callback error');
        }
      }
      closeCallbacks.length = 0;
      if (!res.writableEnded) {
        res.end();
      }
    };

    const onClose = callback => {
      if (isConnected) {
        closeCallbacks.push(callback);
      } else {
        callback();
      }
    };

    // Heartbeat — send comment lines to keep connection alive
    heartbeatTimer = setInterval(() => {
      if (!isConnected || res.writableEnded) {
        cleanup();
        return;
      }
      safeWrite(': heartbeat\n\n');
    }, heartbeatInterval);
    heartbeatTimer.unref();

    // Detect client disconnect
    res.on('close', () => {
      if (isConnected) cleanup();
    });

    // Push loop — prevents overlapping pushes when fetchData is slow
    const doPush = async () => {
      if (!isConnected || res.writableEnded || pushing) return;
      pushing = true;

      try {
        if (Date.now() - startTime >= maxDuration) {
          safeWrite(formatEvent('timeout', { message: '连接已超过30分钟，自动断开' }));
          cleanup();
          return;
        }

        try {
          const data = await getOrFetchData(name, params, fetchData, intervalSeconds);
          if (!isConnected || res.writableEnded) return;
          safeWrite(formatData(data));
        } catch (err) {
          if (!isConnected || res.writableEnded) return;
          log.error({ err }, 'SSE fetchData error');
          safeWrite(formatEvent('error', { message: err.message }));
        }
      } finally {
        pushing = false;
      }

      if (isConnected) {
        pushTimer = setTimeout(doPush, pushIntervalMs);
        pushTimer.unref();
      }
    };

    // Initial push
    await doPush();

    return { isConnected: () => isConnected, close: cleanup, onClose };
  };

  /**
   * Run a long-running task with SSE progress events
   * @param {object} reply - Fastify reply object
   * @param {object} config
   * @param {string} config.name - Task name for logging
   * @param {function} config.task - Async ({ emit }) => result; emit(event, data)
   * @param {number} [config.heartbeatInterval=15000]
   * @param {number} [config.maxDuration=1800000]
   */
  const runTask = async (reply, { name, task, heartbeatInterval = 15000, maxDuration = DEFAULT_MAX_DURATION }) => {
    const res = reply.raw;
    const log = reply.log;
    const startTime = Date.now();

    reply.hijack();

    const replyHeaders = reply.getHeaders();
    for (const [headerName, value] of Object.entries(replyHeaders)) {
      res.setHeader(headerName, value);
    }

    res.writeHead(200, SSE_HEADERS);

    let isConnected = true;
    let heartbeatTimer = null;
    const closeCallbacks = [];

    const cleanup = () => {
      if (!isConnected) return;
      isConnected = false;
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      for (const cb of closeCallbacks) {
        try {
          cb();
        } catch (e) {
          log.error({ err: e }, 'SSE task close callback error');
        }
      }
      closeCallbacks.length = 0;
      if (!res.writableEnded) {
        res.end();
      }
    };

    const safeWrite = data => {
      if (!isConnected || res.writableEnded) return false;
      const canWrite = res.write(data);
      if (!canWrite) {
        cleanup();
        return false;
      }
      return true;
    };

    const emit = (event, data) => {
      if (!isConnected || res.writableEnded) return;
      safeWrite(formatEvent(event, data));
    };

    heartbeatTimer = setInterval(() => {
      if (!isConnected || res.writableEnded) {
        cleanup();
        return;
      }
      safeWrite(': heartbeat\n\n');
    }, heartbeatInterval);
    heartbeatTimer.unref();

    res.on('close', () => {
      if (isConnected) cleanup();
    });

    const timeoutTimer = setTimeout(() => {
      if (!isConnected) return;
      emit('error', { message: '连接已超过最大时长，自动断开', statusCode: 408 });
      cleanup();
    }, maxDuration);
    timeoutTimer.unref();

    try {
      const result = await task({
        emit: (event, data) => emit(event, data)
      });
      if (isConnected) {
        emit('done', { success: true, ...result });
      }
    } catch (err) {
      log.error({ err, name }, 'SSE task error');
      if (isConnected) {
        emit('error', { message: err.message, statusCode: err.statusCode || 500 });
      }
    } finally {
      clearTimeout(timeoutTimer);
      cleanup();
    }

    return { isConnected: () => isConnected, close: cleanup, onClose: callback => closeCallbacks.push(callback) };
  };

  Object.assign(fastify[options.name].services, {
    sseStream: { send, runTask }
  });
});
