const { createHook, executionAsyncId, triggerAsyncId } = require('async_hooks');
const fs = require('fs');
const net = require('net');

createHook({
  init(asyncId, type, triggerAsyncId) {
    fs.writeSync(
      1,
      `init: ${type}(${asyncId}), trigger ${triggerAsyncId}\n`);
  },
  before(asyncId) {
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
net.createServer((conn) => {}).listen(8080);