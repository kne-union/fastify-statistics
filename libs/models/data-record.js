module.exports = ({ DataTypes, options }) => {
  return {
    model: {
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
      data: {
        type: DataTypes.DECIMAL(16, 2),
        allowNull: false,
        comment: '数据值',
        defaultValue: 0
      },
      unit: {
        type: DataTypes.STRING,
        comment: '数据单位'
      },
      time: {
        type: DataTypes.DATE,
        allowNull: false,
        comment: '采集时间'
      }
    },
    associate: ({}, fastify) => {},
    options: {
      comment: '数据采集记录',
      indexes: [{ fields: ['channel'] }, { fields: ['time'] }, { fields: ['channel', 'time'] }, { fields: ['channel', 'attributeName', 'time'] }, { fields: ['attributeName'] }]
    }
  };
};
