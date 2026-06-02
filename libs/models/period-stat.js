module.exports = ({ DataTypes, options }) => {
  return {
    model: {
      period: {
        type: DataTypes.STRING,
        allowNull: false,
        comment: '统计周期：h(时)/d(日)/w(周)/m(月)/q(季)/y(年)'
      },
      time: {
        type: DataTypes.DATE,
        allowNull: false,
        comment: '统计时间'
      },
      channel: {
        type: DataTypes.STRING,
        allowNull: false,
        comment: '数据通道'
      },
      attributeName: {
        type: DataTypes.STRING,
        comment: '属性名',
        defaultValue: 'default'
      },
      aggregate: {
        type: DataTypes.ENUM('sum', 'avg', 'count', 'min', 'max'),
        allowNull: false,
        comment: '聚合方法：sum(合计)/avg(平均)/count(计数)/min(最小)/max(最大)'
      },
      data: {
        type: DataTypes.DECIMAL(16, 2),
        allowNull: false,
        comment: '统计数据值',
        defaultValue: 0
      },
      unit: {
        type: DataTypes.STRING,
        comment: '数据单位'
      }
    },
    associate: ({ periodStat, channelMeta }) => {
      periodStat.belongsTo(channelMeta, {
        comment: '通道meta数据'
      });
    },
    options: {
      comment: '周期统计',
      indexes: [
        { name: `idx${options.modelPrefix || ''}_period_stat_unique`, unique: true, fields: ['period', 'channel', 'attribute_name', 'aggregate', 'time'] },
        { name: `idx${options.modelPrefix || ''}_period_stat_channel_attr_time`, fields: ['channel', 'attribute_name', 'time'] },
        { name: `idx${options.modelPrefix || ''}_period_stat_period_time`, fields: ['period', 'time'] },
        { name: `idx${options.modelPrefix || ''}_period_stat_attr_name`, fields: ['attribute_name'] }
      ]
    }
  };
};
