const builtin = require('module').builtinModules;

// 打印当前的主模块信息
console.log(require.main);

console.log(require.resolve("./test02"));

console.log(require.resolve("http"));

console.log(builtin);