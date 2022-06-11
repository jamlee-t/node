const http = require('http');

const { createHook, executionAsyncId, triggerAsyncId } = require('async_hooks');
const fs = require('fs');
const util = require('util');


function debug(...args) {
    // Use a function like this one when debugging inside an AsyncHooks callback
    fs.writeFileSync(1, `${util.format(...args)}\n`, { flag: 'a' });
}

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

const requestListener = function (req, res) {
    res.writeHead(200);
    res.end('Hello, World!');
}

const server = http.createServer(requestListener);
server.listen(8080);