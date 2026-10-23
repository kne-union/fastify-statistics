// 响应 schema 只用于 OpenAPI 文档：对象允许额外字段，结构随参数变化的字段不声明类型，避免序列化改变实际输出
const any = description => ({ description });

const success = (description, schema) => ({ 200: Object.assign({}, schema || { type: 'object', additionalProperties: true }, { description }) });

// 非 JSON 或结构随请求变化的接口只写说明，不参与序列化
const describeOnly = description => ({ 200: { description } });

const queryResult = {
  type: 'object',
  additionalProperties: true,
  properties: {
    channelMetas: any('通道元信息，键为根通道，值含 id、channel、title、description 等（format=totals 时不返回）'),
    list: any('format=default 时返回：统计结果列表，每项为 { channel, period, time, data, unit }，data 按聚合方法分组（如 { sum: { 属性名: 值 } }）；channelScope=descendantsTree 时每项为 { channel, items, children } 树形结构'),
    records: any('format=flat 时返回：扁平记录列表，每项为 { channel, period, time, attributeName, aggregate, data, unit }'),
    meta: any('查询元信息：channelScope 通道范围、isRealtime 是否含实时数据、windowsUsed 实际使用的统计窗口；format=totals 时另含 retentionPolicy 各周期保留策略'),
    totals: any('format=totals 时返回：按聚合方法、属性名汇总的总计'),
    totalsByChannel: any('format=totals 时返回：按通道汇总的总计'),
    maxByChannel: any('format=totals 时返回：按通道的最大值'),
    attrStats: any('format=totals 时返回：按属性名的统计信息')
  }
};

module.exports = { any, success, describeOnly, queryResult };
