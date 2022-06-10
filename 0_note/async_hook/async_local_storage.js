// 例子，来自 node v18.x
// https://github.com/nodejs/node/blob/v18.3.0/lib/async_hooks.js#L158

import http from 'node:http';
import { AsyncLocalStorage } from 'node:async_hooks';

const asyncLocalStorage = new AsyncLocalStorage();

function logWithId(msg) {
  const id = asyncLocalStorage.getStore();
  console.log(`${id !== undefined ? id : '-'}:`, msg);
}

let idSeq = 0;
http.createServer((req, res) => {
  // 参数：run(store, callback, ...args)。
  asyncLocalStorage.run(idSeq++, () => {
    logWithId('start'); // 这里能够获取到 store，从全局变量 asyncLocalStorage 中获取 store
    // Imagine any chain of async operations here
    setImmediate(() => {
      logWithId('finish');  // 这里能够获取到 store，从全局变量 asyncLocalStorage 中获取 store
      res.end();
    });
  });
}).listen(8080);

http.get('http://localhost:8080');
http.get('http://localhost:8080');

/////////////////////////////////////////////////////////////////////
//
// 标准库代码
//
/////////////////////////////////////////////////////////////////////
// 包装 1 个异步资源。回调可以在这个代码中执行
class AsyncResource {
  constructor(type, opts = {}) {
    validateString(type, 'type');

    let triggerAsyncId = opts;
    let requireManualDestroy = false;
    if (typeof opts !== 'number') {
      triggerAsyncId = opts.triggerAsyncId === undefined ?
        getDefaultTriggerAsyncId() : opts.triggerAsyncId;
      requireManualDestroy = !!opts.requireManualDestroy;
    }

    // Unlike emitInitScript, AsyncResource doesn't supports null as the
    // triggerAsyncId.
    if (!NumberIsSafeInteger(triggerAsyncId) || triggerAsyncId < -1) {
      throw new ERR_INVALID_ASYNC_ID('triggerAsyncId', triggerAsyncId);
    }

    const asyncId = newAsyncId();
    this[async_id_symbol] = asyncId;
    this[trigger_async_id_symbol] = triggerAsyncId;

    if (initHooksExist()) {
      if (enabledHooksExist() && type.length === 0) {
        throw new ERR_ASYNC_TYPE(type);
      }

      emitInit(asyncId, type, triggerAsyncId, this);
    }

    if (!requireManualDestroy && destroyHooksExist()) {
      // This prop name (destroyed) has to be synchronized with C++
      const destroyed = { destroyed: false };
      this[destroyedSymbol] = destroyed;
      registerDestroyHook(this, asyncId, destroyed);
    }
  }

  runInAsyncScope(fn, thisArg, ...args) {
    const asyncId = this[async_id_symbol];
    emitBefore(asyncId, this[trigger_async_id_symbol], this);

    try {
      const ret =
        ReflectApply(fn, thisArg, args);

      return ret;
    } finally {
      if (hasAsyncIdStack())
        emitAfter(asyncId);
    }
  }

  emitDestroy() {
    if (this[destroyedSymbol] !== undefined) {
      this[destroyedSymbol].destroyed = true;
    }
    emitDestroy(this[async_id_symbol]);
    return this;
  }

  asyncId() {
    return this[async_id_symbol];
  }

  triggerAsyncId() {
    return this[trigger_async_id_symbol];
  }

  bind(fn, thisArg) {
    validateFunction(fn, 'fn');
    let bound;
    if (thisArg === undefined) {
      const resource = this;
      bound = function(...args) {
        ArrayPrototypeUnshift(args, fn, this);
        return ReflectApply(resource.runInAsyncScope, resource, args);
      };
    } else {
      bound = FunctionPrototypeBind(this.runInAsyncScope, this, fn, thisArg);
    }
    ObjectDefineProperties(bound, {
      'length': {
        configurable: true,
        enumerable: false,
        value: fn.length,
        writable: false,
      },
      'asyncResource': {
        configurable: true,
        enumerable: true,
        value: this,
        writable: true,
      }
    });
    return bound;
  }

  static bind(fn, type, thisArg) {
    type = type || fn.name;
    return (new AsyncResource(type || 'bound-anonymous-fn')).bind(fn, thisArg);
  }
}

class AsyncLocalStorage {
  constructor() {
    this.kResourceStore = Symbol('kResourceStore');
    this.enabled = false;
  }

  disable() {
    if (this.enabled) {
      this.enabled = false;
      // If this.enabled, the instance must be in storageList
      ArrayPrototypeSplice(storageList,
                           ArrayPrototypeIndexOf(storageList, this), 1);
      if (storageList.length === 0) {
        storageHook.disable();
      }
    }
  }

  _enable() {
    if (!this.enabled) {
      this.enabled = true;
      ArrayPrototypePush(storageList, this);
      storageHook.enable();
    }
  }

  // JAMLEE: resource 传递给子对象
  // Propagate the context from a parent resource to a child one
  _propagate(resource, triggerResource) {
    const store = triggerResource[this.kResourceStore];
    if (this.enabled) {
      resource[this.kResourceStore] = store;
    }
  }

  enterWith(store) {
    this._enable();
    const resource = executionAsyncResource();
    resource[this.kResourceStore] = store;
  }

  run(store, callback, ...args) {
    // Avoid creation of an AsyncResource if store is already active
    if (ObjectIs(store, this.getStore())) {
      return ReflectApply(callback, null, args);
    }

    this._enable();

    const resource = executionAsyncResource();
    const oldStore = resource[this.kResourceStore];

    resource[this.kResourceStore] = store;

    try {
      return ReflectApply(callback, null, args);
    } finally {
      resource[this.kResourceStore] = oldStore;
    }
  }

  exit(callback, ...args) {
    if (!this.enabled) {
      return ReflectApply(callback, null, args);
    }
    this.disable();
    try {
      return ReflectApply(callback, null, args);
    } finally {
      this._enable();
    }
  }

  getStore() {
    if (this.enabled) {
      const resource = executionAsyncResource();
      return resource[this.kResourceStore];
    }
  }
}

////////////////////////////////////////////////////////////////////

// 简化的代码
class AsyncLocalStorage {
  constructor() {
    this.kResourceStore = Symbol('kResourceStore');
    this.enabled = false;
  }
}

const asyncLocalStorage = new AsyncLocalStorage();

asyncLocalStorage.run(store, callback, ...args) {
  // 新建一个AsyncResource
  const resource = new AsyncResource('AsyncLocalStorage', defaultAlsResourceOpts);
  // 通过runInAsyncScope把resource的执行上下文设置完当前的执行上下文
  return resource.emitDestroy().runInAsyncScope(() => {
    this.enterWith(store);

    // 调用回调 https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Reflect/apply
    // The static Reflect.apply() method calls a target function with arguments as specified.
    // 调用 callback。this 是 null，带参数 args。此时 callback 是例如:
    // () => {
    //   logWithId('start');
    //   // Imagine any chain of async operations here
    //   setImmediate(() => {
    //     logWithId('finish');
    //     res.end();
    //   });
    // }
    return ReflectApply(callback, null, args);
  });
}