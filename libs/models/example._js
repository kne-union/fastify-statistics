module.exports = ({DataTypes, options}) => {
    return {
        //name: 'modelName',//此处定义modelName，默认根据文件名转驼峰命名，可以缺省
        model: {
            name: {
                type: DataTypes.STRING,
                comment: '名称'
            }
        }, associate: ({/*这里可以获取models*/}, fastify) => {
            //可以这样获取某个namespace的models fastify.account.models
            // options.getUserModel() 可以获取 user model
        }, options: {
            comment: '',
            indexes: []
        }
    };
};

