'use strict';

// HOW and WHY the timers implementation works the way it does.
//
// Timers are crucial to Node.js. Internally, any TCP I/O connection creates a
// timer so that we can time out of connections. Additionally, many user
// libraries and applications also use timers. As such there may be a
// significantly large amount of timeouts scheduled at any given time.
// Therefore, it is very important that the timers implementation is performant
// and efficient.
//
// Note: It is suggested you first read through the lib/internal/linkedlist.js
// linked list implementation, since timers depend on it extensively. It can be
// somewhat counter-intuitive at first, as it is not actually a class. Instead,
// it is a set of helpers that operate on an existing object.
//
// In order to be as performant as possible, the architecture and data
// structures are designed so that they are optimized to handle the following
// use cases as efficiently as possible:

// - Adding a new timer. (insert)
// - Removing an existing timer. (remove)
// - Handling a timer timing out. (timeout)
//
// Whenever possible, the implementation tries to make the complexity of these
// operations as close to constant-time as possible.
// (So that performance is not impacted by the number of scheduled timers.)
//
// Object maps are kept which contain linked lists keyed by their duration in
// milliseconds.
//
/* eslint-disable node-core/non-ascii-character */
//
// ╔════ > Object Map
// ║
// ╠══
// ║ lists: { '40': { }, '320': { etc } } (keys of millisecond duration)
// ╚══          ┌────┘
//              │
// ╔══          │
// ║ TimersList { _idleNext: { }, _idlePrev: (self) }
// ║         ┌────────────────┘
// ║    ╔══  │                              ^
// ║    ║    { _idleNext: { },  _idlePrev: { }, _onTimeout: (callback) }
// ║    ║      ┌───────────┘
// ║    ║      │                                  ^
// ║    ║      { _idleNext: { etc },  _idlePrev: { }, _onTimeout: (callback) }
// ╠══  ╠══
// ║    ║
// ║    ╚════ >  Actual JavaScript timeouts
// ║
// ╚════ > Linked List
//
/* eslint-enable node-core/non-ascii-character */
//
// With this, virtually constant-time insertion (append), removal, and timeout
// is possible in the JavaScript layer. Any one list of timers is able to be
// sorted by just appending to it because all timers within share the same
// duration. Therefore, any timer added later will always have been scheduled to
// timeout later, thus only needing to be appended.
// Removal from an object-property linked list is also virtually constant-time
// as can be seen in the lib/internal/linkedlist.js implementation.
// Timeouts only need to process any timers currently due to expire, which will
// always be at the beginning of the list for reasons stated above. Any timers
// after the first one encountered that does not yet need to timeout will also
// always be due to timeout at a later time.
//
// Less-than constant time operations are thus contained in two places:
// The PriorityQueue — an efficient binary heap implementation that does all
// operations in worst-case O(log n) time — which manages the order of expiring
// Timeout lists and the object map lookup of a specific list by the duration of
// timers within (or creation of a new list). However, these operations combined
// have shown to be trivial in comparison to other timers architectures.

const { Math, Object } = primordials;

const {
  scheduleTimer,
  toggleTimerRef,
  getLibuvNow,
  immediateInfo
} = internalBinding('timers');

const {
  getDefaultTriggerAsyncId,
  newAsyncId,
  initHooksExist,
  destroyHooksExist,
  // The needed emit*() functions.
  emitInit,
  emitBefore,
  emitAfter,
  emitDestroy
} = require('internal/async_hooks');

// Symbols for storing async id state.
const async_id_symbol = Symbol('asyncId');
const trigger_async_id_symbol = Symbol('triggerId');

const {
  ERR_INVALID_CALLBACK,
  ERR_OUT_OF_RANGE
} = require('internal/errors').codes;
const { validateNumber } = require('internal/validators');

const L = require('internal/linkedlist');
const PriorityQueue = require('internal/priority_queue');

const { inspect } = require('internal/util/inspect');
const debug = require('internal/util/debuglog').debuglog('timer');

// *Must* match Environment::ImmediateInfo::Fields in src/env.h.
const kCount = 0;
const kRefCount = 1;
const kHasOutstanding = 2;

// Timeout values > TIMEOUT_MAX are set to 1.
const TIMEOUT_MAX = 2 ** 31 - 1;

let timerListId = Number.MIN_SAFE_INTEGER;

const kRefed = Symbol('refed');

// Create a single linked list instance only once at startup
const immediateQueue = new ImmediateList();

let nextExpiry = Infinity;
let refCount = 0;

// This is a priority queue with a custom sorting function that first compares
// the expiry times of two lists and if they're the same then compares their
// individual IDs to determine which list was created first.
const timerListQueue = new PriorityQueue(compareTimersLists, setPosition);

// JAMLEE: 定时器，用1个map表示
// Object map containing linked lists of timers, keyed and sorted by their
// duration in milliseconds.
//
// - key = time in milliseconds
// - value = linked list
const timerListMap = Object.create(null);

// JAMLEE: 定时任务执行时会在新的 AsyncId 下。
function initAsyncResource(resource, type) {
  // 创建新的 AsyncId。
  const asyncId = resource[async_id_symbol] = newAsyncId();
  // 触发这个异步任务的 AsyncId。
  const triggerAsyncId =
    resource[trigger_async_id_symbol] = getDefaultTriggerAsyncId();
  
  // 触发 async_hook
  if (initHooksExist())
    emitInit(asyncId, type, triggerAsyncId, resource);
}

// Timer constructor function.
// The entire prototype is defined in lib/timers.js
function Timeout(callback, after, args, isRepeat) {
  after *= 1; // Coalesce to number or NaN
  if (!(after >= 1 && after <= TIMEOUT_MAX)) {
    if (after > TIMEOUT_MAX) {
      process.emitWarning(`${after} does not fit into` +
                          ' a 32-bit signed integer.' +
                          '\nTimeout duration was set to 1.',
                          'TimeoutOverflowWarning');
    }
    after = 1; // Schedule on next tick, follows browser behavior
  }

  this._idleTimeout = after;
  
  // JAMLEE: timeout 和 list 差不多。也有链表的头节点。所以 Timeout 和 TimersList 可以放到一起。 TimersList 成为链表头，记录些额外的信息。
  this._idlePrev = this;
  this._idleNext = this;

  this._idleStart = null;
  // This must be set to null first to avoid function tracking
  // on the hidden class, revisit in V8 versions after 6.2
  this._onTimeout = null;
  this._onTimeout = callback;
  this._timerArgs = args;
  this._repeat = isRepeat ? after : null;
  this._destroyed = false;

  this[kRefed] = null;

  initAsyncResource(this, 'Timeout');
}

// Make sure the linked list only shows the minimal necessary information.
Timeout.prototype[inspect.custom] = function(_, options) {
  return inspect(this, {
    ...options,
    // Only inspect one level.
    depth: 0,
    // It should not recurse.
    customInspect: false
  });
};

Timeout.prototype.refresh = function() {
  if (this[kRefed])
    active(this);
  else
    unrefActive(this);

  return this;
};

Timeout.prototype.unref = function() {
  if (this[kRefed]) {
    this[kRefed] = false;
    decRefCount();
  }
  return this;
};

Timeout.prototype.ref = function() {
  if (this[kRefed] === false) {
    this[kRefed] = true;
    incRefCount();
  }
  return this;
};

Timeout.prototype.hasRef = function() {
  return !!this[kRefed];
};

// JAMLEE: 定时器链表
function TimersList(expiry, msecs) {
  this._idleNext = this; // Create the list with the linkedlist properties to
  this._idlePrev = this; // Prevent any unnecessary hidden class changes.
  this.expiry = expiry; // 到期时间
  this.id = timerListId++;
  this.msecs = msecs; // 多久超时
  this.priorityQueuePosition = null;
}

// Make sure the linked list only shows the minimal necessary information.
TimersList.prototype[inspect.custom] = function(_, options) {
  return inspect(this, {
    ...options,
    // Only inspect one level.
    depth: 0,
    // It should not recurse.
    customInspect: false
  });
};

// A linked list for storing `setImmediate()` requests
function ImmediateList() {
  this.head = null;
  this.tail = null;
}

// Appends an item to the end of the linked list, adjusting the current tail's
// previous and next pointers where applicable
ImmediateList.prototype.append = function(item) {
  if (this.tail !== null) {
    this.tail._idleNext = item;
    item._idlePrev = this.tail;
  } else {
    this.head = item;
  }
  this.tail = item;
};

// Removes an item from the linked list, adjusting the pointers of adjacent
// items and the linked list's head or tail pointers as necessary
ImmediateList.prototype.remove = function(item) {
  if (item._idleNext !== null) {
    item._idleNext._idlePrev = item._idlePrev;
  }

  if (item._idlePrev !== null) {
    item._idlePrev._idleNext = item._idleNext;
  }

  if (item === this.head)
    this.head = item._idleNext;
  if (item === this.tail)
    this.tail = item._idlePrev;

  item._idleNext = null;
  item._idlePrev = null;
};

function incRefCount() {
  if (refCount++ === 0)
    toggleTimerRef(true);
}

function decRefCount() {
  if (--refCount === 0)
    toggleTimerRef(false);
}

// Schedule or re-schedule a timer.
// The item must have been enroll()'d first.
function active(item) {
  insert(item, true, getLibuvNow());
}

// Internal APIs that need timeouts should use `unrefActive()` instead of
// `active()` so that they do not unnecessarily keep the process open.
function unrefActive(item) {
  insert(item, false, getLibuvNow());
}

// The underlying logic for scheduling or re-scheduling a timer.
//
// Appends a timer onto the end of an existing timers list, or creates a new
// list if one does not already exist for the specified timeout duration.
function insert(item, refed, start) {
  let msecs = item._idleTimeout;
  if (msecs < 0 || msecs === undefined)
    return;

  // Truncate so that accuracy of sub-millisecond timers is not assumed.
  msecs = Math.trunc(msecs);

  item._idleStart = start;

  // Use an existing list if there is one, otherwise we need to make a new one.
  var list = timerListMap[msecs];
  if (list === undefined) { // 如果当前设置为msec的链表为空（一个这种时间的定时都没有）
    debug('no %d list was found in insert, creating a new one', msecs);
    const expiry = start + msecs; // 计算过期时间 expiry。这是未来的1个数字。
    timerListMap[msecs] = list = new TimersList(expiry, msecs);
    timerListQueue.insert(list); // 将 list 插入到 timerListQueue。但是 list 没有和 item 关联没有问题吗？

    if (nextExpiry > expiry) {
      scheduleTimer(msecs);
      nextExpiry = expiry;
    }
  }

  if (!item[async_id_symbol] || item._destroyed) {
    item._destroyed = false;
    initAsyncResource(item, 'Timeout');
  }

  if (refed === !item[kRefed]) {
    if (refed)
      incRefCount();
    else
      decRefCount();
  }
  item[kRefed] = refed;

  // list 和 item 关联起来。
  L.append(list, item);
}

function setUnrefTimeout(callback, after) {
  // Type checking identical to setTimeout()
  if (typeof callback !== 'function') {
    throw new ERR_INVALID_CALLBACK(callback);
  }

  const timer = new Timeout(callback, after, undefined, false);
  unrefActive(timer);

  return timer;
}

// Type checking used by timers.enroll() and Socket#setTimeout()
function getTimerDuration(msecs, name) {
  validateNumber(msecs, name);
  if (msecs < 0 || !isFinite(msecs)) {
    throw new ERR_OUT_OF_RANGE(name, 'a non-negative finite number', msecs);
  }

  // Ensure that msecs fits into signed int32
  if (msecs > TIMEOUT_MAX) {
    process.emitWarning(`${msecs} does not fit into a 32-bit signed integer.` +
                        `\nTimer duration was truncated to ${TIMEOUT_MAX}.`,
                        'TimeoutOverflowWarning');
    return TIMEOUT_MAX;
  }

  return msecs;
}

function compareTimersLists(a, b) {
  const expiryDiff = a.expiry - b.expiry;
  if (expiryDiff === 0) {
    if (a.id < b.id)
      return -1;
    if (a.id > b.id)
      return 1;
  }
  return expiryDiff;
}

function setPosition(node, pos) {
  node.priorityQueuePosition = pos;
}

function getTimerCallbacks(runNextTicks) {
  // If an uncaught exception was thrown during execution of immediateQueue,
  // this queue will store all remaining Immediates that need to run upon
  // resolution of all error handling (if process is still alive).
  const outstandingQueue = new ImmediateList();

  function processImmediate() {
    const queue = outstandingQueue.head !== null ?
      outstandingQueue : immediateQueue;
    var immediate = queue.head;

    // Clear the linked list early in case new `setImmediate()`
    // calls occur while immediate callbacks are executed
    if (queue !== outstandingQueue) {
      queue.head = queue.tail = null;
      immediateInfo[kHasOutstanding] = 1;
    }

    let prevImmediate;
    let ranAtLeastOneImmediate = false;
    while (immediate !== null) {
      if (ranAtLeastOneImmediate)
        runNextTicks();
      else
        ranAtLeastOneImmediate = true;

      // It's possible for this current Immediate to be cleared while executing
      // the next tick queue above, which means we need to use the previous
      // Immediate's _idleNext which is guaranteed to not have been cleared.
      if (immediate._destroyed) {
        outstandingQueue.head = immediate = prevImmediate._idleNext;
        continue;
      }

      immediate._destroyed = true;

      immediateInfo[kCount]--;
      if (immediate[kRefed])
        immediateInfo[kRefCount]--;
      immediate[kRefed] = null;

      prevImmediate = immediate;

      const asyncId = immediate[async_id_symbol];
      emitBefore(asyncId, immediate[trigger_async_id_symbol]);

      try {
        const argv = immediate._argv;
        if (!argv)
          immediate._onImmediate();
        else
          immediate._onImmediate(...argv);
      } finally {
        immediate._onImmediate = null;

        if (destroyHooksExist())
          emitDestroy(asyncId);

        outstandingQueue.head = immediate = immediate._idleNext;
      }

      emitAfter(asyncId);
    }

    if (queue === outstandingQueue)
      outstandingQueue.head = null;
    immediateInfo[kHasOutstanding] = 0;
  }


  // JAMLEE: 从 C++ 代码触发上来的位置。打印 stack 时会显示在这里
  // console.trace()
  // Trace
  //   at Timeout._onTimeout (/root/code/node/0_note/timer/async_hook_2.js:39:13)
  //   at listOnTimeout (internal/timers.js:531:17)
  //   at processTimers (internal/timers.js:475:7)
  function processTimers(now) {
    debug('process timer lists %d', now);
    nextExpiry = Infinity;

    let list;
    let ranAtLeastOneList = false;
    while (list = timerListQueue.peek()) {
      if (list.expiry > now) {
        nextExpiry = list.expiry;
        return refCount > 0 ? nextExpiry : -nextExpiry;
      }
      if (ranAtLeastOneList)
        runNextTicks();
      else
        ranAtLeastOneList = true;
      listOnTimeout(list, now);
    }
    return 0;
  }

  function listOnTimeout(list, now) {
    const msecs = list.msecs;

    debug('timeout callback %d', msecs);

    var diff, timer;
    let ranAtLeastOneTimer = false;
    while (timer = L.peek(list)) {
      diff = now - timer._idleStart;

      // Check if this loop iteration is too early for the next timer.
      // This happens if there are more timers scheduled for later in the list.
      if (diff < msecs) {
        list.expiry = Math.max(timer._idleStart + msecs, now + 1);
        list.id = timerListId++;
        timerListQueue.percolateDown(1);
        debug('%d list wait because diff is %d', msecs, diff);
        return;
      }

      if (ranAtLeastOneTimer)
        runNextTicks();
      else
        ranAtLeastOneTimer = true;

      // The actual logic for when a timeout happens.
      L.remove(timer);

      const asyncId = timer[async_id_symbol];

      if (!timer._onTimeout) {
        if (timer[kRefed])
          refCount--;
        timer[kRefed] = null;

        if (destroyHooksExist() && !timer._destroyed) {
          emitDestroy(asyncId);
          timer._destroyed = true;
        }
        continue;
      }

      emitBefore(asyncId, timer[trigger_async_id_symbol]);

      let start;
      if (timer._repeat)
        start = getLibuvNow();

      try {
        const args = timer._timerArgs;
        if (args === undefined)
          timer._onTimeout();
        else
          timer._onTimeout(...args);
      } finally {
        if (timer._repeat && timer._idleTimeout !== -1) {
          timer._idleTimeout = timer._repeat;
          if (start === undefined)
            start = getLibuvNow();
          insert(timer, timer[kRefed], start);
        } else if (!timer._idleNext && !timer._idlePrev) {
          if (timer[kRefed])
            refCount--;
          timer[kRefed] = null;

          if (destroyHooksExist() && !timer._destroyed) {
            emitDestroy(timer[async_id_symbol]);
          }
          timer._destroyed = true;
        }
      }

      emitAfter(asyncId);
    }

    // If `L.peek(list)` returned nothing, the list was either empty or we have
    // called all of the timer timeouts.
    // As such, we can remove the list from the object map and
    // the PriorityQueue.
    debug('%d list empty', msecs);

    // The current list may have been removed and recreated since the reference
    // to `list` was created. Make sure they're the same instance of the list
    // before destroying.
    if (list === timerListMap[msecs]) {
      delete timerListMap[msecs];
      timerListQueue.shift();
    }
  }

  return {
    processImmediate,
    processTimers
  };
}

module.exports = {
  TIMEOUT_MAX,
  kTimeout: Symbol('timeout'), // For hiding Timeouts on other internals.
  async_id_symbol,
  trigger_async_id_symbol,
  Timeout,
  kRefed,
  initAsyncResource,
  setUnrefTimeout,
  getTimerDuration,
  immediateQueue,
  getTimerCallbacks,
  immediateInfoFields: {
    kCount,
    kRefCount,
    kHasOutstanding
  },
  active,
  unrefActive,
  timerListMap,
  timerListQueue,
  decRefCount,
  incRefCount
};
