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

//
// The following are the callbacks that can be passed to createHook().
//
// init is called during object construction. The resource may not have
// completed construction when this callback runs, therefore all fields of the
// resource referenced by "asyncId" may not have been populated.
function init(asyncId, type, triggerAsyncId, resource) { 

    // 这里 resource 会是 1个类。例如 Timeout
    debug(`异步任务初始化 ${asyncId}, ${resource.constructor.name}`);
}
// Before is called just before the resource's callback is called. It can be
// called 0-N times for handles (e.g. TCPWrap), and will be called exactly 1
// time for requests (e.g. FSReqCallback).
function before(asyncId) { }
// After is called just after the resource's callback has finished.
function after(asyncId) { }
// Destroy is called when an AsyncWrap instance is destroyed.
function destroy(asyncId) { }
// promiseResolve is called only for promise resources, when the
// `resolve` function passed to the `Promise` constructor is invoked
// (either directly or through other means of resolving a promise).
function promiseResolve(asyncId) { }

const asyncHook =async_hooks.createHook({ init, before, after, destroy, promiseResolve });
asyncHook.enable();

getAsyncInfo();
setTimeout(() => { 
    getAsyncInfo() ;
}, 1000);
setTimeout(() => { 
    getAsyncInfo() ;
}, 1500);
setTimeout(() => { 
    getAsyncInfo() ;
}, 2000);
