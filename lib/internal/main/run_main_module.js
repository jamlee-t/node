'use strict';

// JAMLEE: 在执行用户自己的主函数之后，执行 CJSModule 和 prepareMainThreadExecution
const {
  prepareMainThreadExecution
} = require('internal/bootstrap/pre_execution');

prepareMainThreadExecution(true);

// JAMLEE: 自定义打印日志.。解析 argv 就绝对不是 -- 开头的 option 了
const debug = require('internal/util/debuglog').debuglog('JAMLEE:RUN_MAIN_MODULE');
debug(process.argv);

const CJSModule = require('internal/modules/cjs/loader');

// JAMLEE: 标记当前 bootstrap 阶段已经完成。
markBootstrapComplete();

// Note: this actually tries to run the module as a ESM first if
// --experimental-modules is on.
// TODO(joyeecheung): can we move that logic to here? Note that this
// is an undocumented method available via `require('module').runMain`
CJSModule.runMain();
