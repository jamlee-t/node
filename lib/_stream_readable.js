// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

'use strict';

const { Object } = primordials;

module.exports = Readable;
Readable.ReadableState = ReadableState;

const EE = require('events');
const Stream = require('stream');
const { Buffer } = require('buffer');

const debug = require('internal/util/debuglog').debuglog('stream');
const BufferList = require('internal/streams/buffer_list');
const destroyImpl = require('internal/streams/destroy');
const {
  getHighWaterMark,
  getDefaultHighWaterMark
} = require('internal/streams/state');
const {
  ERR_INVALID_ARG_TYPE,
  ERR_STREAM_PUSH_AFTER_EOF,
  ERR_METHOD_NOT_IMPLEMENTED,
  ERR_STREAM_UNSHIFT_AFTER_END_EVENT
} = require('internal/errors').codes;

// Lazy loaded to improve the startup performance.
let StringDecoder;
let createReadableStreamAsyncIterator;
let from;

Object.setPrototypeOf(Readable.prototype, Stream.prototype);
Object.setPrototypeOf(Readable, Stream);

const { errorOrDestroy } = destroyImpl;
const kProxyEvents = ['error', 'close', 'destroy', 'pause', 'resume'];

function prependListener(emitter, event, fn) {
  // Sadly this is not cacheable as some libraries bundle their own
  // event emitter implementation with them.
  if (typeof emitter.prependListener === 'function')
    return emitter.prependListener(event, fn);

  // This is a hack to make sure that our error handler is attached before any
  // userland ones.  NEVER DO THIS. This is here only because this code needs
  // to continue to work with older versions of Node.js that do not include
  // the prependListener() method. The goal is to eventually remove this hack.
  if (!emitter._events || !emitter._events[event])
    emitter.on(event, fn);
  else if (Array.isArray(emitter._events[event]))
    emitter._events[event].unshift(fn);
  else
    emitter._events[event] = [fn, emitter._events[event]];
}

// JAMLEE: ReadableState 状态类。每个 Readable 必然有个 readable 状态类。
function ReadableState(options, stream, isDuplex) {
  // Duplex streams are both readable and writable, but share
  // the same options object.
  // However, some cases require setting options to different
  // values for the readable and the writable sides of the duplex stream.
  // These options can be provided separately as readableXXX and writableXXX.
  if (typeof isDuplex !== 'boolean')
    isDuplex = stream instanceof Stream.Duplex;

  // Object stream flag. Used to make read(n) ignore n and to
  // make all the buffer merging and length checks go away
  this.objectMode = !!(options && options.objectMode);

  if (isDuplex)
    this.objectMode = this.objectMode ||
      !!(options && options.readableObjectMode);

  // The point at which it stops calling _read() to fill the buffer
  // Note: 0 is a valid value, means "don't call _read preemptively ever"
  this.highWaterMark = options ?
    getHighWaterMark(this, options, 'readableHighWaterMark', isDuplex) :
    getDefaultHighWaterMark(false);

  // A linked list is used to store data chunks instead of an array because the
  // linked list can remove elements from the beginning faster than
  // array.shift()
  this.buffer = new BufferList(); // JAMLEE: 流读取的数据就会放置到 buffer 中。
  this.length = 0; // JAMLEE: 当前 buffer 中的未消费数据字节
  this.pipes = null;
  this.pipesCount = 0;
  this.flowing = null; // JAMLEE: stream 是持续读取中。处于 flowing 模式。
  this.ended = false;
  this.endEmitted = false; // JAMLEE: readable 对象的 end 事件是否已经被触发。意味着 end 只能被触发 1 次。
  this.reading = false; // JAMLEE: 当前流是不是处于正在读取的阶段。

  // A flag to be able to tell if the event 'readable'/'data' is emitted
  // immediately, or on a later tick.  We set this to true at first, because
  // any actions that shouldn't happen until "later" should generally also
  // not happen before the first read call.
  this.sync = true;

  // Whenever we return null, then we set a flag to say
  // that we're awaiting a 'readable' event emission.
  this.needReadable = false; // JAMLEE: 需要读取数据，意思是说数据超过了水位线。执行一次 _read，填充数据到 buffer 中。
  this.emittedReadable = false; // JAMLEE: 是否已经提交过 emittedReadable 事件。这个标志位被设置，意味为不能再次触发，当前这个 readable 事件还没处理完毕
  this.readableListening = false;
  this.resumeScheduled = false;
  this.paused = true;  // JAMLEE: stream 处于暂停模式中。

  // Should close be emitted on destroy. Defaults to true.
  this.emitClose = !options || options.emitClose !== false;

  // Should .destroy() be called after 'end' (and potentially 'finish')
  this.autoDestroy = !!(options && options.autoDestroy);

  // Has it been destroyed
  this.destroyed = false; // JAMLEE: stream 是否是销毁的

  // Crypto is kind of old and crusty.  Historically, its default string
  // encoding is 'binary' so we have to make this configurable.
  // Everything else in the universe uses 'utf8', though.
  this.defaultEncoding = (options && options.defaultEncoding) || 'utf8';

  // The number of writers that are awaiting a drain event in .pipe()s
  this.awaitDrain = 0;

  // If true, a maybeReadMore has been scheduled
  this.readingMore = false;

  // 流数据的解码和编码
  this.decoder = null;
  this.encoding = null;
  if (options && options.encoding) {
    if (!StringDecoder)
      StringDecoder = require('string_decoder').StringDecoder;
    this.decoder = new StringDecoder(options.encoding);
    this.encoding = options.encoding;
  }
}

// JAMLEE: 1 个 readable 的流。继承这个 stream 必须实现 read 函数。可以在 read 中调用push函数。
// const Stream = require('stream')
// const readableStream = new Stream.Readable({
//   read() {},
// });
// setInterval(() => {
//   readableStream.push('ping!\n');
// }, 1000)
// readableStream.pipe(process.stdout);
function Readable(options) {
  if (!(this instanceof Readable))
    return new Readable(options);

  // Checking for a Stream.Duplex instance is faster here instead of inside
  // the ReadableState constructor, at least with V8 6.5
  const isDuplex = this instanceof Stream.Duplex;

  this._readableState = new ReadableState(options, this, isDuplex);

  // legacy
  this.readable = true; // JAMLEE: 当前 readable 对象是否处于可读。在触发 end 事件前一行代码将 readable 改为 false.

  if (options) {
    if (typeof options.read === 'function')
      this._read = options.read; // JAMLEE: 可覆盖 read 函数

    if (typeof options.destroy === 'function')
      this._destroy = options.destroy;  // JAMLEE: 可覆盖 destroy 函数
  }

  Stream.call(this);
}

// JAMLEE: 当前流是否已经被销毁
Object.defineProperty(Readable.prototype, 'destroyed', {
  // Making it explicit this property is not enumerable
  // because otherwise some prototype manipulation in
  // userland will fail
  enumerable: false,
  get() {
    if (this._readableState === undefined) {
      return false;
    }
    return this._readableState.destroyed;
  },
  set(value) {
    // We ignore the value if the stream
    // has not been initialized yet
    if (!this._readableState) {
      return;
    }

    // Backward compatibility, the user is explicitly
    // managing destroyed
    this._readableState.destroyed = value;
  }
});

// JAMLEE: 当前流是否已经被结束。也就是流的对端主动关闭了流了。
Object.defineProperty(Readable.prototype, 'readableEnded', {
  // Making it explicit this property is not enumerable
  // because otherwise some prototype manipulation in
  // userland will fail
  enumerable: false,
  get() {
    return this._readableState ? this._readableState.endEmitted : false;
  }
});

Readable.prototype.destroy = destroyImpl.destroy;
Readable.prototype._undestroy = destroyImpl.undestroy;
Readable.prototype._destroy = function(err, cb) {
  cb(err);
};

// JAMLEE：添加数据块。也就是往 stream 中写入数据。在 read 函数中调用。
// Manually shove something into the read() buffer.
// This returns true if the highWaterMark has not been hit yet,
// similar to how Writable.write() returns true if you should
// write() some more.
Readable.prototype.push = function(chunk, encoding) {
  return readableAddChunk(this, chunk, encoding, false);
};

// JAMLEE：添加数据块。也就是往 stream 中写入数据。在 read 函数中调用。
// Unshift should *always* be something directly out of read()
Readable.prototype.unshift = function(chunk, encoding) {
  return readableAddChunk(this, chunk, encoding, true);
};

// JAMLEE: readableAddChunk->addChunk
function readableAddChunk(stream, chunk, encoding, addToFront) {
  debug('readableAddChunk', chunk);
  const state = stream._readableState;

  let skipChunkCheck;

  if (!state.objectMode) {
    if (typeof chunk === 'string') {
      encoding = encoding || state.defaultEncoding;
      if (addToFront && state.encoding && state.encoding !== encoding) {
        // When unshifting, if state.encoding is set, we have to save
        // the string in the BufferList with the state encoding
        chunk = Buffer.from(chunk, encoding).toString(state.encoding);
      } else if (encoding !== state.encoding) {
        chunk = Buffer.from(chunk, encoding);
        encoding = '';
      }
      skipChunkCheck = true;
    }
  } else {
    skipChunkCheck = true;
  }

  if (chunk === null) { // JAMLEE: 如果 push 是 null, 意味着当前的流结束
    state.reading = false;
    onEofChunk(stream, state);
  } else {
    var er;
    if (!skipChunkCheck)
      er = chunkInvalid(state, chunk);
    if (er) {
      errorOrDestroy(stream, er);
    } else if (state.objectMode || (chunk && chunk.length > 0)) {
      if (typeof chunk !== 'string' &&
          !state.objectMode &&
          // Do not use Object.getPrototypeOf as it is slower since V8 7.3.
          !(chunk instanceof Buffer)) {
        chunk = Stream._uint8ArrayToBuffer(chunk);
      }

      if (addToFront) {
        if (state.endEmitted)
          errorOrDestroy(stream, new ERR_STREAM_UNSHIFT_AFTER_END_EVENT());
        else
          addChunk(stream, state, chunk, true);
      } else if (state.ended) {
        errorOrDestroy(stream, new ERR_STREAM_PUSH_AFTER_EOF());
      } else if (state.destroyed) {
        return false;
      } else {
        state.reading = false;
        if (state.decoder && !encoding) {
          chunk = state.decoder.write(chunk);
          if (state.objectMode || chunk.length !== 0)
            addChunk(stream, state, chunk, false);
          else
            maybeReadMore(stream, state);
        } else {
          addChunk(stream, state, chunk, false);
        }
      }
    } else if (!addToFront) {
      state.reading = false;
      maybeReadMore(stream, state);
    }
  }

  // We can push more data if we are below the highWaterMark.
  // Also, if we have no data yet, we can stand some more bytes.
  // This is to work around cases where hwm=0, such as the repl.
  return !state.ended &&
    (state.length < state.highWaterMark || state.length === 0);
}

// JAMLEE: push->readableAddChunk->addChunk, 添加 chunk 到 state.buffer。
function addChunk(stream, state, chunk, addToFront) {
  if (state.flowing && state.length === 0 && !state.sync) {
    state.awaitDrain = 0;
    stream.emit('data', chunk);
  } else {
    // Update the buffer info.
    state.length += state.objectMode ? 1 : chunk.length;
    if (addToFront)
      state.buffer.unshift(chunk);
    else
      state.buffer.push(chunk);

    if (state.needReadable)
      emitReadable(stream);
  }
  maybeReadMore(stream, state);
}

function chunkInvalid(state, chunk) {
  if (!Stream._isUint8Array(chunk) &&
      typeof chunk !== 'string' &&
      chunk !== undefined &&
      !state.objectMode) {
    return new ERR_INVALID_ARG_TYPE(
      'chunk', ['string', 'Buffer', 'Uint8Array'], chunk);
  }
}

// JAMLEE: 当前流是否已经暂停。
Readable.prototype.isPaused = function() {
  return this._readableState.flowing === false;
};

// JAMLEE: 设置当前流内容的编码
// Backwards compatibility.
Readable.prototype.setEncoding = function(enc) {
  if (!StringDecoder)
    StringDecoder = require('string_decoder').StringDecoder;
  const decoder = new StringDecoder(enc);
  this._readableState.decoder = decoder;
  // If setEncoding(null), decoder.encoding equals utf8
  this._readableState.encoding = this._readableState.decoder.encoding;

  const buffer = this._readableState.buffer;
  // Iterate over current buffer to convert already stored Buffers:
  let content = '';
  for (const data of buffer) {
    content += decoder.write(data);
  }
  buffer.clear();
  if (content !== '')
    buffer.push(content);
  this._readableState.length = content.length;
  return this;
};

// JAMLEE: 计算一个新的水位线大小。
// Don't raise the hwm > 8MB
const MAX_HWM = 0x800000;
function computeNewHighWaterMark(n) {
  if (n >= MAX_HWM) {
    n = MAX_HWM;
  } else {
    // Get the next highest power of 2 to prevent increasing hwm excessively in
    // tiny amounts
    n--;
    n |= n >>> 1;
    n |= n >>> 2;
    n |= n >>> 4;
    n |= n >>> 8;
    n |= n >>> 16;
    n++;
  }
  return n;
}

// JAMLEE: 预计有多少数据可以读取。
// This function is designed to be inlinable, so please take care when making
// changes to the function body.
function howMuchToRead(n, state) {
  if (n <= 0 || (state.length === 0 && state.ended))
    return 0;
  if (state.objectMode)
    return 1;
  if (Number.isNaN(n)) {
    // Only flow one buffer at a time
    if (state.flowing && state.length)
      return state.buffer.first().length;
    else
      return state.length;
  }
  if (n <= state.length)
    return n;
  return state.ended ? state.length : 0;
}

// JAMLEE: 从流中读取数据 n 字节。
// 1. 在 read 函数调用 push，将数据设置到当前的 buffer 中。
// 2. _read 函数用于给子类覆盖，或者直接覆盖 read函数、
// You can override either this method, or the async _read(n) below.
Readable.prototype.read = function(n) {
  debug('read', n);
  // Same as parseInt(undefined, 10), however V8 7.3 performance regressed
  // in this scenario, so we are doing it manually.
  if (n === undefined) { // JAMLEE: 如果 n 没有定义
    n = NaN;
  } else if (!Number.isInteger(n)) {
    n = parseInt(n, 10);
  }
  const state = this._readableState; // JAMLEE: 当前的 state 对象。
  const nOrig = n;

  // JAMLEE: 如果 n 大于当前的水位线，动态设置 1 个新的值。
  // If we're asking for more than the current hwm, then raise the hwm.
  if (n > state.highWaterMark)
    state.highWaterMark = computeNewHighWaterMark(n);

  if (n !== 0)
    state.emittedReadable = false;

  // JAMLEE: 如果 n = 0, 触发 readable 事件。
  // 1. n === 0
  // 2. state.needReadable 是 true
  // 3. 水位线不为 0; 当前的 state.length 高于水位线; state.length 不为 0; 或者state.ended 表示可读流已经是结束的。

  // 什么情况会触发 readable?
  // 1. The 'readable' event is emitted when there is data available to be read from the stream. In some cases, attaching a listener for the 'readable' event will cause some amount of data to be read into an internal buffer.
  // 2. The 'readable' event will also be emitted once the end of the stream data has been reached but before the 'end' event is emitted.

  // If we're doing read(0) to trigger a readable event, but we
  // already have a bunch of data in the buffer, then just trigger
  // the 'readable' event and move on.
  if (n === 0 &&
      state.needReadable &&
      ((state.highWaterMark !== 0 ?
        state.length >= state.highWaterMark :
        state.length > 0) ||
       state.ended)) {
    debug('read: emitReadable', state.length, state.ended);
    if (state.length === 0 && state.ended) // JAMLEE: 如果没有buffer数据，且流已经被end。那么触发 end 事件
      endReadable(this);
    else
      emitReadable(this);
    return null;
  }

  // JAMLEE: 到这里是希望进行 data 事件触发了。而不是 readable 事件。

  n = howMuchToRead(n, state); // JAMLEE: 调整下 n，看有多少字节可以读取。

  // If we've ended, and we're now clear, then finish it up.
  if (n === 0 && state.ended) { // 如果 n==0 且 state 是终止状态，直接返回。
    if (state.length === 0)
      endReadable(this); 
    return null;
  }

  // 大块注释翻译：
  // 所有实际的块生成逻辑都需要*在*下面*调用 _read。原因是在某些合成流的情况，
  // 比如passthrough流，_read可能是一个完全同步的操作，可能会改变读缓冲区的状态，当提供足够的数据时在*不够*之前。
  //
  // 所以，步骤是：
  // 1. 弄清楚我们做完之后事情的状态从缓冲区读取。
  //
  // 2. 如果结果状态将触发 _read，则调用 _read。请注意，这可能是异步的，也可能是同步的。是的
  // 以这种方式编写 API 非常难看，但这并不意味着Readable 类的行为应该不正确，因为流是
  // 设计为与同步/异步无关。注意 _read 调用是同步还是异步（即，如果读取调用
  // 还没有返回），以便我们知道发射是否安全“可读”等。
  //
  // 3. 实际上将请求的块从缓冲区中拉出并返回。

  // All the actual chunk generation logic needs to be
  // *below* the call to _read.  The reason is that in certain
  // synthetic stream cases, such as passthrough streams, _read
  // may be a completely synchronous operation which may change
  // the state of the read buffer, providing enough data when
  // before there was *not* enough.
  //
  // So, the steps are:
  // 1. Figure out what the state of things will be after we do
  // a read from the buffer.
  //
  // 2. If that resulting state will trigger a _read, then call _read.
  // Note that this may be asynchronous, or synchronous.  Yes, it is
  // deeply ugly to write APIs this way, but that still doesn't mean
  // that the Readable class should behave improperly, as streams are
  // designed to be sync/async agnostic.
  // Take note if the _read call is sync or async (ie, if the read call
  // has returned yet), so that we know whether or not it's safe to emit
  // 'readable' etc.
  //
  // 3. Actually pull the requested chunks out of the buffer and return.

  // if we need a readable event, then we need to do some reading.
  var doRead = state.needReadable; // JAMLEE: 如果 state.needReadable 是需要读取的。也就是需要执行 1 次 read 函数。
  debug('need readable', doRead);

  // 如果当前 state 中的数据为 0 或者读取了 n 之后小于水位线。
  // If we currently have less than the highWaterMark, then also read some
  if (state.length === 0 || state.length - n < state.highWaterMark) {
    doRead = true;
    debug('length less than watermark', doRead);
  }

  // JAMLEE: 如果 state 是结束的。或者是 reading 的。或者是已经销毁的。则 doRead 是 false
  // However, if we've ended, then there's no point, if we're already
  // reading, then it's unnecessary, and if we're destroyed, then it's
  // not allowed.
  if (state.ended || state.reading || state.destroyed) {
    doRead = false;
    debug('reading or ended', doRead);
  } else if (doRead) { // 如果是 doRead，那么 state.reading 设置为 true
    debug('do read');
    state.reading = true;
    state.sync = true; // JAMLEE: 数据 _read 中
    // If the length is currently zero, then we *need* a readable event.
    if (state.length === 0)
      state.needReadable = true;
    // Call internal read method
    this._read(state.highWaterMark); // 调用内置的 _read 方法， 写入到 buffer
    state.sync = false; // JAMLEE: 数据 _read 结束了
    // If _read pushed data synchronously, then `reading` will be false,
    // and we need to re-evaluate how much data we can return to the user.
    if (!state.reading)
      n = howMuchToRead(nOrig, state);
  }

  var ret;
  if (n > 0)
    ret = fromList(n, state); // 从内置的 buffer 中读取数据。内置的 buffer 是 read 填充的
  else
    ret = null;

  if (ret === null) {
    state.needReadable = state.length <= state.highWaterMark; // 当前 buffer 的长度，小于了水位线。需要新的一次触发 needReadable，给 buffer 添加数据
    n = 0;
  } else {
    state.length -= n;
    state.awaitDrain = 0;
  }

  if (state.length === 0) { // 如果当前 state.buffer 中的数据为 0。
    // If we have nothing in the buffer, then we want to know
    // as soon as we *do* get something into the buffer.
    if (!state.ended)
      state.needReadable = true;

    // If we tried to read() past the EOF, then emit end on the next tick.
    if (nOrig !== n && state.ended)
      endReadable(this);
  }

  if (ret !== null)
    this.emit('data', ret); // 触发数据事件，发送 ret，也就是读取的数据

  return ret; // 如果读取的数据为空，则返回 null。
};

// JAMLEE: 发送最后一块数据，意味着流的结束。
function onEofChunk(stream, state) {
  debug('onEofChunk');
  if (state.ended) return;
  if (state.decoder) {
    var chunk = state.decoder.end();
    if (chunk && chunk.length) {
      state.buffer.push(chunk);
      state.length += state.objectMode ? 1 : chunk.length;
    }
  }
  state.ended = true;

  if (state.sync) {
    // If we are sync, wait until next tick to emit the data.
    // Otherwise we risk emitting data in the flow()
    // the readable code triggers during a read() call
    emitReadable(stream);
  } else {
    // Emit 'readable' now to make sure it gets picked up.
    state.needReadable = false;
    state.emittedReadable = true;
    // We have to emit readable now that we are EOF. Modules
    // in the ecosystem (e.g. dicer) rely on this event being sync.
    emitReadable_(stream);
  }
}

// JAMLEE: 触发 1 次 readable 事件。意味着当前的 buffer 中数据量不够水位，需要再一次读取数据
// Don't emit readable right away in sync mode, because this can trigger
// another read() call => stack overflow.  This way, it might trigger
// a nextTick recursion warning, but that's not so bad.
function emitReadable(stream) {
  const state = stream._readableState;
  debug('emitReadable', state.needReadable, state.emittedReadable);
  state.needReadable = false;
  if (!state.emittedReadable) { // 当前没有已经提交过 readable 事件
    debug('emitReadable', state.flowing);
    state.emittedReadable = true;
    process.nextTick(emitReadable_, stream);
  }
}

// JAMLEE: 提交 readable 事件。告知需要执行 1 次 _read
function emitReadable_(stream) {
  const state = stream._readableState;
  debug('emitReadable_', state.destroyed, state.length, state.ended);
  if (!state.destroyed && (state.length || state.ended)) {
    stream.emit('readable');
    state.emittedReadable = false;
  }

  // 是否需要再次调度一次 readable 事件
  // The stream needs another readable event if
  // 1. It is not flowing, as the flow mechanism will take
  //    care of it.
  // 2. It is not ended.
  // 3. It is below the highWaterMark, so we can schedule
  //    another readable later.
  state.needReadable =
    !state.flowing &&
    !state.ended &&
    state.length <= state.highWaterMark;
  flow(stream); // 读取 1 次数据
}


// JAMLEE: push->readableAddChunk->addChunk, 尝试读取更多数据。
// https://nodejs.org/zh-cn/docs/guides/event-loop-timers-and-nexttick/
//    ┌───────────────────────────┐
// ┌─>│           timers          │
// │  └─────────────┬─────────────┘
// │  ┌─────────────┴─────────────┐
// │  │     pending callbacks     │
// │  └─────────────┬─────────────┘
// │  ┌─────────────┴─────────────┐
// │  │       idle, prepare       │
// │  └─────────────┬─────────────┘      ┌───────────────┐
// │  ┌─────────────┴─────────────┐      │   incoming:   │
// │  │           poll            │<─────┤  connections, │
// │  └─────────────┬─────────────┘      │   data, etc.  │
// │  ┌─────────────┴─────────────┐      └───────────────┘
// │  │           check           │
// │  └─────────────┬─────────────┘
// │  ┌─────────────┴─────────────┐
// └──┤      close callbacks      │
//    └───────────────────────────┘
// At this point, the user has presumably seen the 'readable' event,
// and called read() to consume some data.  that may have triggered
// in turn another _read(n) call, in which case reading = true if
// it's in progress.
// However, if we're not ended, or reading, and the length < hwm,
// then go ahead and try to read some more preemptively.
function maybeReadMore(stream, state) {
  if (!state.readingMore) {
    state.readingMore = true;
    process.nextTick(maybeReadMore_, stream, state);
  }
}

// JAMLEE: push->readableAddChunk->addChunk->maybeReadMore_, 尝试读取更多数据。
function maybeReadMore_(stream, state) {
  // Attempt to read more data if we should.
  //
  // The conditions for reading more data are (one of):
  // - Not enough data buffered (state.length < state.highWaterMark). The loop
  //   is responsible for filling the buffer with enough data if such data
  //   is available. If highWaterMark is 0 and we are not in the flowing mode
  //   we should _not_ attempt to buffer any extra data. We'll get more data
  //   when the stream consumer calls read() instead.
  // - No data in the buffer, and the stream is in flowing mode. In this mode
  //   the loop below is responsible for ensuring read() is called. Failing to
  //   call read here would abort the flow and there's no other mechanism for
  //   continuing the flow if the stream consumer has just subscribed to the
  //   'data' event.
  //
  // In addition to the above conditions to keep reading data, the following
  // conditions prevent the data from being read:
  // - The stream has ended (state.ended).
  // - There is already a pending 'read' operation (state.reading). This is a
  //   case where the the stream has called the implementation defined _read()
  //   method, but they are processing the call asynchronously and have _not_
  //   called push() with new data. In this case we skip performing more
  //   read()s. The execution ends in this method again after the _read() ends
  //   up calling push() with more data.
  while (!state.reading && !state.ended &&
         (state.length < state.highWaterMark ||
          (state.flowing && state.length === 0))) {
    const len = state.length;
    debug('maybeReadMore read 0');
    stream.read(0);
    if (len === state.length)
      // Didn't get any data, stop spinning.
      break;
  }
  state.readingMore = false;
}

// JAMLEE: 定义抽象方法 _read。也就说当前的继承 Stream 类的必须实现这个函数。
// Abstract method.  to be overridden in specific implementation classes.
// call cb(er, data) where data is <= n in length.
// for virtual (non-string, non-buffer) streams, "length" is somewhat
// arbitrary, and perhaps not very meaningful.
Readable.prototype._read = function(n) {
  errorOrDestroy(this, new ERR_METHOD_NOT_IMPLEMENTED('_read()'));
};

Readable.prototype.pipe = function(dest, pipeOpts) {
  const src = this;
  const state = this._readableState;

  switch (state.pipesCount) {
    case 0:
      state.pipes = dest;
      break;
    case 1:
      state.pipes = [state.pipes, dest];
      break;
    default:
      state.pipes.push(dest);
      break;
  }
  state.pipesCount += 1;
  debug('pipe count=%d opts=%j', state.pipesCount, pipeOpts);

  const doEnd = (!pipeOpts || pipeOpts.end !== false) &&
              dest !== process.stdout &&
              dest !== process.stderr;

  const endFn = doEnd ? onend : unpipe;
  if (state.endEmitted)
    process.nextTick(endFn);
  else
    src.once('end', endFn);

  dest.on('unpipe', onunpipe);
  function onunpipe(readable, unpipeInfo) {
    debug('onunpipe');
    if (readable === src) {
      if (unpipeInfo && unpipeInfo.hasUnpiped === false) {
        unpipeInfo.hasUnpiped = true;
        cleanup();
      }
    }
  }

  function onend() {
    debug('onend');
    dest.end();
  }

  let ondrain;

  var cleanedUp = false;
  function cleanup() {
    debug('cleanup');
    // Cleanup event handlers once the pipe is broken
    dest.removeListener('close', onclose);
    dest.removeListener('finish', onfinish);
    if (ondrain) {
      dest.removeListener('drain', ondrain);
    }
    dest.removeListener('error', onerror);
    dest.removeListener('unpipe', onunpipe);
    src.removeListener('end', onend);
    src.removeListener('end', unpipe);
    src.removeListener('data', ondata);

    cleanedUp = true;

    // If the reader is waiting for a drain event from this
    // specific writer, then it would cause it to never start
    // flowing again.
    // So, if this is awaiting a drain, then we just call it now.
    // If we don't know, then assume that we are waiting for one.
    if (ondrain && state.awaitDrain &&
        (!dest._writableState || dest._writableState.needDrain))
      ondrain();
  }

  src.on('data', ondata);
  function ondata(chunk) {
    debug('ondata');
    const ret = dest.write(chunk);
    debug('dest.write', ret);
    if (ret === false) {
      // If the user unpiped during `dest.write()`, it is possible
      // to get stuck in a permanently paused state if that write
      // also returned false.
      // => Check whether `dest` is still a piping destination.
      if (((state.pipesCount === 1 && state.pipes === dest) ||
           (state.pipesCount > 1 && state.pipes.includes(dest))) &&
          !cleanedUp) {
        debug('false write response, pause', state.awaitDrain);
        state.awaitDrain++;
      }
      if (!ondrain) {
        // When the dest drains, it reduces the awaitDrain counter
        // on the source.  This would be more elegant with a .once()
        // handler in flow(), but adding and removing repeatedly is
        // too slow.
        ondrain = pipeOnDrain(src);
        dest.on('drain', ondrain);
      }
      src.pause();
    }
  }

  // If the dest has an error, then stop piping into it.
  // However, don't suppress the throwing behavior for this.
  function onerror(er) {
    debug('onerror', er);
    unpipe();
    dest.removeListener('error', onerror);
    if (EE.listenerCount(dest, 'error') === 0)
      errorOrDestroy(dest, er);
  }

  // Make sure our error handler is attached before userland ones.
  prependListener(dest, 'error', onerror);

  // Both close and finish should trigger unpipe, but only once.
  function onclose() {
    dest.removeListener('finish', onfinish);
    unpipe();
  }
  dest.once('close', onclose);
  function onfinish() {
    debug('onfinish');
    dest.removeListener('close', onclose);
    unpipe();
  }
  dest.once('finish', onfinish);

  function unpipe() {
    debug('unpipe');
    src.unpipe(dest);
  }

  // Tell the dest that it's being piped to
  dest.emit('pipe', src);

  // Start the flow if it hasn't been started already.
  if (!state.flowing) {
    debug('pipe resume');
    src.resume();
  }

  return dest;
};

function pipeOnDrain(src) {
  return function pipeOnDrainFunctionResult() {
    const state = src._readableState;
    debug('pipeOnDrain', state.awaitDrain);
    if (state.awaitDrain)
      state.awaitDrain--;
    if (state.awaitDrain === 0 && EE.listenerCount(src, 'data')) {
      state.flowing = true;
      flow(src);
    }
  };
}


Readable.prototype.unpipe = function(dest) {
  const state = this._readableState;
  const unpipeInfo = { hasUnpiped: false };

  // If we're not piping anywhere, then do nothing.
  if (state.pipesCount === 0)
    return this;

  // Just one destination.  most common case.
  if (state.pipesCount === 1) {
    // Passed in one, but it's not the right one.
    if (dest && dest !== state.pipes)
      return this;

    if (!dest)
      dest = state.pipes;

    // got a match.
    state.pipes = null;
    state.pipesCount = 0;
    state.flowing = false;
    if (dest)
      dest.emit('unpipe', this, unpipeInfo);
    return this;
  }

  // Slow case with multiple pipe destinations.

  if (!dest) {
    // remove all.
    var dests = state.pipes;
    var len = state.pipesCount;
    state.pipes = null;
    state.pipesCount = 0;
    state.flowing = false;

    for (var i = 0; i < len; i++)
      dests[i].emit('unpipe', this, { hasUnpiped: false });
    return this;
  }

  // Try to find the right one.
  const index = state.pipes.indexOf(dest);
  if (index === -1)
    return this;

  state.pipes.splice(index, 1);
  state.pipesCount -= 1;
  if (state.pipesCount === 1)
    state.pipes = state.pipes[0];

  dest.emit('unpipe', this, unpipeInfo);

  return this;
};

// Set up data events if they are asked for
// Ensure readable listeners eventually get something
Readable.prototype.on = function(ev, fn) {
  const res = Stream.prototype.on.call(this, ev, fn);
  const state = this._readableState;

  if (ev === 'data') {
    // Update readableListening so that resume() may be a no-op
    // a few lines down. This is needed to support once('readable').
    state.readableListening = this.listenerCount('readable') > 0;

    // Try start flowing on next tick if stream isn't explicitly paused
    if (state.flowing !== false)
      this.resume();
  } else if (ev === 'readable') {
    if (!state.endEmitted && !state.readableListening) {
      state.readableListening = state.needReadable = true;
      state.flowing = false;
      state.emittedReadable = false;
      debug('on readable', state.length, state.reading);
      if (state.length) {
        emitReadable(this);
      } else if (!state.reading) {
        process.nextTick(nReadingNextTick, this);
      }
    }
  }

  return res;
};
Readable.prototype.addListener = Readable.prototype.on;

Readable.prototype.removeListener = function(ev, fn) {
  const res = Stream.prototype.removeListener.call(this, ev, fn);

  if (ev === 'readable') {
    // We need to check if there is someone still listening to
    // readable and reset the state. However this needs to happen
    // after readable has been emitted but before I/O (nextTick) to
    // support once('readable', fn) cycles. This means that calling
    // resume within the same tick will have no
    // effect.
    process.nextTick(updateReadableListening, this);
  }

  return res;
};
Readable.prototype.off = Readable.prototype.removeListener;

Readable.prototype.removeAllListeners = function(ev) {
  const res = Stream.prototype.removeAllListeners.apply(this, arguments);

  if (ev === 'readable' || ev === undefined) {
    // We need to check if there is someone still listening to
    // readable and reset the state. However this needs to happen
    // after readable has been emitted but before I/O (nextTick) to
    // support once('readable', fn) cycles. This means that calling
    // resume within the same tick will have no
    // effect.
    process.nextTick(updateReadableListening, this);
  }

  return res;
};

function updateReadableListening(self) {
  const state = self._readableState;
  state.readableListening = self.listenerCount('readable') > 0;

  if (state.resumeScheduled && !state.paused) {
    // Flowing needs to be set to true now, otherwise
    // the upcoming resume will not flow.
    state.flowing = true;

    // Crude way to check if we should resume
  } else if (self.listenerCount('data') > 0) {
    self.resume();
  }
}

function nReadingNextTick(self) {
  debug('readable nexttick read 0');
  self.read(0);
}

// pause() and resume() are remnants of the legacy readable stream API
// If the user uses them, then switch into old mode.
Readable.prototype.resume = function() {
  const state = this._readableState;
  if (!state.flowing) {
    debug('resume');
    // We flow only if there is no one listening
    // for readable, but we still have to call
    // resume()
    state.flowing = !state.readableListening;
    resume(this, state);
  }
  state.paused = false;
  return this;
};

// JAMLEE: 恢复暂停的流。首次调用会启动 flow
function resume(stream, state) {
  if (!state.resumeScheduled) {
    state.resumeScheduled = true;
    process.nextTick(resume_, stream, state);
  }
}

function resume_(stream, state) {
  debug('resume', state.reading);
  if (!state.reading) {
    stream.read(0); // 调用 1 次 read 函数。
  }

  state.resumeScheduled = false;
  stream.emit('resume');
  flow(stream);
  if (state.flowing && !state.reading)
    stream.read(0);
}

Readable.prototype.pause = function() {
  debug('call pause flowing=%j', this._readableState.flowing);
  if (this._readableState.flowing !== false) {
    debug('pause');
    this._readableState.flowing = false;
    this.emit('pause');
  }
  this._readableState.paused = true;
  return this;
};

// JAMLEE: 开始循环不断读取，称作为 flow。
function flow(stream) {
  const state = stream._readableState;
  debug('flow', state.flowing);
  while (state.flowing && stream.read() !== null); // JAMLEE: 不断读取数据直到读出的数据为空
}

// Wrap an old-style stream as the async data source.
// This is *not* part of the readable stream interface.
// It is an ugly unfortunate mess of history.
Readable.prototype.wrap = function(stream) {
  const state = this._readableState;
  var paused = false;

  stream.on('end', () => {
    debug('wrapped end');
    if (state.decoder && !state.ended) {
      var chunk = state.decoder.end();
      if (chunk && chunk.length)
        this.push(chunk);
    }

    this.push(null);
  });

  stream.on('data', (chunk) => {
    debug('wrapped data');
    if (state.decoder)
      chunk = state.decoder.write(chunk);

    // Don't skip over falsy values in objectMode
    if (state.objectMode && (chunk === null || chunk === undefined))
      return;
    else if (!state.objectMode && (!chunk || !chunk.length))
      return;

    const ret = this.push(chunk);
    if (!ret) {
      paused = true;
      stream.pause();
    }
  });

  // Proxy all the other methods. Important when wrapping filters and duplexes.
  for (const i in stream) {
    if (this[i] === undefined && typeof stream[i] === 'function') {
      this[i] = function methodWrap(method) {
        return function methodWrapReturnFunction() {
          return stream[method].apply(stream, arguments);
        };
      }(i);
    }
  }

  // Proxy certain important events.
  for (var n = 0; n < kProxyEvents.length; n++) {
    stream.on(kProxyEvents[n], this.emit.bind(this, kProxyEvents[n]));
  }

  // When we try to consume some more bytes, simply unpause the
  // underlying stream.
  this._read = (n) => {
    debug('wrapped _read', n);
    if (paused) {
      paused = false;
      stream.resume();
    }
  };

  return this;
};

Readable.prototype[Symbol.asyncIterator] = function() {
  if (createReadableStreamAsyncIterator === undefined) {
    createReadableStreamAsyncIterator =
      require('internal/streams/async_iterator');
  }
  return createReadableStreamAsyncIterator(this);
};

Object.defineProperty(Readable.prototype, 'readableHighWaterMark', {
  // Making it explicit this property is not enumerable
  // because otherwise some prototype manipulation in
  // userland will fail
  enumerable: false,
  get: function() {
    return this._readableState.highWaterMark;
  }
});

Object.defineProperty(Readable.prototype, 'readableBuffer', {
  // Making it explicit this property is not enumerable
  // because otherwise some prototype manipulation in
  // userland will fail
  enumerable: false,
  get: function() {
    return this._readableState && this._readableState.buffer;
  }
});

Object.defineProperty(Readable.prototype, 'readableFlowing', {
  // Making it explicit this property is not enumerable
  // because otherwise some prototype manipulation in
  // userland will fail
  enumerable: false,
  get: function() {
    return this._readableState.flowing;
  },
  set: function(state) {
    if (this._readableState) {
      this._readableState.flowing = state;
    }
  }
});

// Exposed for testing purposes only.
Readable._fromList = fromList;

Object.defineProperty(Readable.prototype, 'readableLength', {
  // Making it explicit this property is not enumerable
  // because otherwise some prototype manipulation in
  // userland will fail
  enumerable: false,
  get() {
    return this._readableState.length;
  }
});

Object.defineProperty(Readable.prototype, 'readableObjectMode', {
  enumerable: false,
  get() {
    return this._readableState ? this._readableState.objectMode : false;
  }
});

Object.defineProperty(Readable.prototype, 'readableEncoding', {
  enumerable: false,
  get() {
    return this._readableState ? this._readableState.encoding : null;
  }
});

// Pluck off n bytes from an array of buffers.
// Length is the combined lengths of all the buffers in the list.
// This function is designed to be inlinable, so please take care when making
// changes to the function body.
function fromList(n, state) {
  // nothing buffered
  if (state.length === 0)
    return null;

  var ret;
  if (state.objectMode)
    ret = state.buffer.shift();
  else if (!n || n >= state.length) {
    // Read it all, truncate the list
    if (state.decoder)
      ret = state.buffer.join('');
    else if (state.buffer.length === 1)
      ret = state.buffer.first();
    else
      ret = state.buffer.concat(state.length);
    state.buffer.clear();
  } else {
    // read part of list
    ret = state.buffer.consume(n, state.decoder);
  }

  return ret;
}

// JAMLEE: 当前的流已经end，且没有数据可读了，触发Readable 的 end 事件，通知 end 事件的监听者。
function endReadable(stream) {
  const state = stream._readableState;

  debug('endReadable', state.endEmitted);
  if (!state.endEmitted) {
    state.ended = true;
    process.nextTick(endReadableNT, state, stream);
  }
}

// JAMLEE: 在 node 中一般 *NT 的函数会用于触发子类的事件。
function endReadableNT(state, stream) {
  debug('endReadableNT', state.endEmitted, state.length);

  // Check that we didn't get one last unshift.
  if (!state.endEmitted && state.length === 0) { // JAMLEE: end 事件没有被提交过，且当前存在 state.buffer 中的数据为空才能成功触发
    state.endEmitted = true;
    stream.readable = false;
    stream.emit('end');

    if (state.autoDestroy) {
      // In case of duplex streams we need a way to detect
      // if the writable side is ready for autoDestroy as well
      const wState = stream._writableState;
      if (!wState || (wState.autoDestroy && wState.finished)) {
        stream.destroy();
      }
    }
  }
}

Readable.from = function(iterable, opts) {
  if (from === undefined) {
    from = require('internal/streams/from');
  }
  return from(Readable, iterable, opts);
};
