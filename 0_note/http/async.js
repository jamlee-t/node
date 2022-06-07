const http = require('http');

const async_hooks = require('async_hooks');
const fs = require('fs');
const util = require('util');


function debug(...args) {
    // Use a function like this one when debugging inside an AsyncHooks callback
    fs.writeFileSync(__dirname + '/log.out', `${util.format(...args)}\n`, { flag: 'a' });
}
function getAsyncInfo() {
    const eid = async_hooks.executionAsyncId();
    debug(`当前的异步任务ID: ${eid}`);
    const tid = async_hooks.triggerAsyncId();
    debug(`上一级的异步任务ID: ${tid}`);
}

const requestListener = function (req, res) {
    getAsyncInfo();
    res.writeHead(200);
    res.end('Hello, World!');
}

const server = http.createServer(requestListener);
server.listen(8080);