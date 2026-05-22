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
      title: {
        type: DataTypes.STRING,
        allowNull: false,
        comment: '标题'
      },
      description: {
        type: DataTypes.TEXT,
        comment: '描述'
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
    associate: ({}, fastify) => {},
    options: {
      comment: '周期统计',
      indexes: [{ unique: true, fields: ['period', 'channel', 'attributeName', 'aggregate', 'time'] }, { fields: ['channel', 'attributeName', 'time'] }, { fields: ['period', 'time'] }, { fields: ['attributeName'] }]
    }
  };
};
