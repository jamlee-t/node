const { createHook, executionAsyncId, triggerAsyncId } = require('async_hooks');
const fs = require('fs');

createHook({
  init(asyncId, type, triggerAsyncId, resource) {
    fs.writeSync(
      1,
      `init: ${type}(${asyncId}), trigger ${triggerAsyncId} ${resource}\n`);
  },
  before(asyncId, ) {
    fs.writeSync(
      1,
      `before: trigger ${triggerAsyncId()} execution ${executionAsyncId()}\n`);
  },
  after(asyncId) {
    fs.writeSync(
      1,
      `after: trigger ${triggerAsyncId()} execution ${executionAsyncId()}\n`);
  }
}).enable();


// 这里是 Timeout 对象发起回调。async_id 指向这个 Timout 对象。

// 输出
// init: Timeout(2), trigger 1 execution 1
// before: trigger 1 execution 2
// level 1
// init: Timeout(3), trigger 2 execution 2
// after: trigger 1 execution 2

// before: trigger 2 execution 3
// level 2
// after: trigger 2 execution 3
setTimeout(() => {
  fs.writeSync(1, `level 1\n`);
  setTimeout(() => {
    console.trace(); // trace 会打印异步触发的起点位置
    fs.writeSync(1, `level 2\n`);
  }, 3000);
}, 1000)