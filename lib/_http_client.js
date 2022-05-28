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

const net = require('net');
const url = require('url');
const assert = require('internal/assert');
const {
  _checkIsHttpToken: checkIsHttpToken,
  debug,
  freeParser,
  parsers,
  HTTPParser,
  prepareError,
} = require('_http_common');
const { OutgoingMessage } = require('_http_outgoing');
const Agent = require('_http_agent');
const { Buffer } = require('buffer');
const { defaultTriggerAsyncIdScope } = require('internal/async_hooks');
const { URL, urlToOptions, searchParamsSymbol } = require('internal/url');
const { kOutHeaders, kNeedDrain } = require('internal/http');
const { connResetException, codes } = require('internal/errors');
const {
  ERR_HTTP_HEADERS_SENT,
  ERR_INVALID_ARG_TYPE,
  ERR_INVALID_HTTP_TOKEN,
  ERR_INVALID_PROTOCOL,
  ERR_UNESCAPED_CHARACTERS
} = codes;
const { getTimerDuration } = require('internal/timers');
const {
  DTRACE_HTTP_CLIENT_REQUEST,
  DTRACE_HTTP_CLIENT_RESPONSE
} = require('internal/dtrace');

const INVALID_PATH_REGEX = /[^\u0021-\u00ff]/;

function validateHost(host, name) {
  if (host !== null && host !== undefined && typeof host !== 'string') {
    throw new ERR_INVALID_ARG_TYPE(`options.${name}`,
                                   ['string', 'undefined', 'null'],
                                   host);
  }
  return host;
}

class HTTPClientAsyncResource {
  constructor(type, req) {
    this.type = type;
    this.req = req;
  }
}

// JAMLEE: 生成 ClientRequest 对象，继承自 OutgoingMessage。发起请求，返回 1 个 res 对象，用于读取服务器的响应。
// http.request(options[, callback])
// http.request(url[, options][, callback])
let urlWarningEmitted = false;
function ClientRequest(input, options, cb) {
  OutgoingMessage.call(this);

  // JAMLEE: 如果 input 是 url，调用就是下面3种之一
  // http.request(url, options)
  // http.request(url, callback)
  // http.request(url, options, callback)
  if (typeof input === 'string') {
    const urlStr = input;
    try {
      input = urlToOptions(new URL(urlStr)); // input 变成对象了
    } catch (err) {
      input = url.parse(urlStr);
      if (!input.hostname) {
        throw err;
      }
      if (!urlWarningEmitted && !process.noDeprecation) {
        urlWarningEmitted = true;
        process.emitWarning(
          `The provided URL ${urlStr} is not a valid URL, and is supported ` +
          'in the http module solely for compatibility.',
          'DeprecationWarning', 'DEP0109');
      }
    }
  } else if (input && input[searchParamsSymbol] &&
             input[searchParamsSymbol][searchParamsSymbol]) {
    // url.URL instance
    input = urlToOptions(input);
  } else {  // JAMLEE: 如果 input 是 对象，就是 http.request(options[, callback])
    cb = options;
    options = input;
    input = null;
  }

  // JAMLEE: 程序执行到这里，得到 options 对象或者 input 对象，最终把他们合并到一起成为 options。
  // 1. 如果 options 是函数，那么它一定是回调函数。当前是2个参数
  // 2. 
  if (typeof options === 'function') {
    cb = options;
    options = input || {};
  } else {
    // Object.assign(target, ...sources), options 合并到 input 得到新的 options
    options = Object.assign(input || {}, options);
  }
  // JAMLEE: 此时回调是 cb, 选项是 options + input。这里 options 也可能是 cb。

  // JAMLEE: 
  // 1. 管理 agent，默认使用 defaultAgent 或者调用 options.createConnection  创建连接
  // 2. 或者使用 options 中定义的 agent。
  var agent = options.agent;
  const defaultAgent = options._defaultAgent || Agent.globalAgent;
  if (agent === false) {
    agent = new defaultAgent.constructor();
  } else if (agent === null || agent === undefined) {
    if (typeof options.createConnection !== 'function') {
      agent = defaultAgent;
    }
    // Explicitly pass through this statement as agent will not be used
    // when createConnection is provided.
  } else if (typeof agent.addRequest !== 'function') {
    throw new ERR_INVALID_ARG_TYPE('options.agent',
                                   ['Agent-like Object', 'undefined', 'false'],
                                   agent);
  }
  this.agent = agent;

  // JAMLEE: 连接的协议 http: 或者 https:，从 options 中取或者从 defaultAgent 中取到默认 http:。
  const protocol = options.protocol || defaultAgent.protocol;
  var expectedProtocol = defaultAgent.protocol;
  if (this.agent && this.agent.protocol)
    expectedProtocol = this.agent.protocol; // expectedProtocol 也就是当前请求需要使用的协议

  // JAMLEE: 当前需要请求的路径
  var path;
  if (options.path) {
    path = String(options.path);
    if (INVALID_PATH_REGEX.test(path))
      throw new ERR_UNESCAPED_CHARACTERS('Request path');
  }

  // JAMLEE: 如果 options 中定义的协议和 agent 中定义得不一致则不能使用。意思说 http 和 https 不能共用 1 个agent。
  if (protocol !== expectedProtocol) {
    throw new ERR_INVALID_PROTOCOL(protocol, expectedProtocol);
  }

  // JAMLEE: 决定当前访问的端口默认是 80
  const defaultPort = options.defaultPort ||
                    (this.agent && this.agent.defaultPort);

  const port = options.port = options.port || defaultPort || 80;
  const host = options.host = validateHost(options.hostname, 'hostname') ||
                            validateHost(options.host, 'host') || 'localhost';

  const setHost = (options.setHost === undefined || Boolean(options.setHost));

  this.socketPath = options.socketPath;

  // JAMLEE: options 设置 timeout，如果超时请求会被主动 abort
  if (options.timeout !== undefined)
    this.timeout = getTimerDuration(options.timeout, 'timeout');

  // JAMLEE: 决定当前的请求方法，标准情况转成大写。默认是 get
  var method = options.method;
  const methodIsString = (typeof method === 'string');
  if (method !== null && method !== undefined && !methodIsString) {
    throw new ERR_INVALID_ARG_TYPE('method', 'string', method);
  }

  if (methodIsString && method) {
    if (!checkIsHttpToken(method)) {
      throw new ERR_INVALID_HTTP_TOKEN('Method', method);
    }
    method = this.method = method.toUpperCase();
  } else {
    method = this.method = 'GET';
  }

  // JAMLEE: cb 意味着请求返回时，执行一次。在 cb 中执行：
  // res.on('data', (chunk) => {...}); res.on('end', (chunk) => {...});
  this.path = options.path || '/';
  if (cb) {
    this.once('response', cb);
  }

  // JAMLEE: 是否使用 ChunkedEncoding
  if (method === 'GET' ||
      method === 'HEAD' ||
      method === 'DELETE' ||
      method === 'OPTIONS' ||
      method === 'TRACE' ||
      method === 'CONNECT') {
    this.useChunkedEncodingByDefault = false;
  } else {
    this.useChunkedEncodingByDefault = true;
  }

  this._ended = false; // 请求是否结束
  this.res = null; // 请求返回的 res 对象
  this.aborted = false; // 请求是否主动 abort，或者被 abort
  this.timeoutCb = null; // 请求超时时，执行回调
  this.upgradeOrConnect = false; // 是否是反向代理或者WS
  this.parser = null;  // http 协议返回解析
  this.maxHeadersCount = null;  // 头的数量最大多少

  var called = false;

  // JAMLEE: 使用 agent时，当前这个 request 使用了 keepalive
  if (this.agent) {
    // If there is an agent we should default to Connection:keep-alive,
    // but only if the Agent will actually reuse the connection!
    // If it's not a keepAlive agent, and the maxSockets==Infinity, then
    // there's never a case where this socket will actually be reused
    if (!this.agent.keepAlive && !Number.isFinite(this.agent.maxSockets)) {
      this._last = true;
      this.shouldKeepAlive = false;
    } else {
      this._last = false;
      this.shouldKeepAlive = true;
    }
  }

  // JAMLEE: 当前请求头需要携带的自定义头，可以是数组或者对象。
  const headersArray = Array.isArray(options.headers);
  if (!headersArray) {
    if (options.headers) {
      var keys = Object.keys(options.headers);
      for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        this.setHeader(key, options.headers[key]);
      }
    }

    if (host && !this.getHeader('host') && setHost) {
      var hostHeader = host;

      // For the Host header, ensure that IPv6 addresses are enclosed
      // in square brackets, as defined by URI formatting
      // https://tools.ietf.org/html/rfc3986#section-3.2.2
      var posColon = hostHeader.indexOf(':');
      if (posColon !== -1 &&
          hostHeader.includes(':', posColon + 1) &&
          hostHeader.charCodeAt(0) !== 91/* '[' */) {
        hostHeader = `[${hostHeader}]`;
      }

      if (port && +port !== defaultPort) {
        hostHeader += ':' + port;
      }
      this.setHeader('Host', hostHeader);
    }

    if (options.auth && !this.getHeader('Authorization')) {
      this.setHeader('Authorization', 'Basic ' +
                     Buffer.from(options.auth).toString('base64'));
    }

    if (this.getHeader('expect')) {
      if (this._header) {
        throw new ERR_HTTP_HEADERS_SENT('render');
      }

      this._storeHeader(this.method + ' ' + this.path + ' HTTP/1.1\r\n',
                        this[kOutHeaders]);
    }
  } else {
    this._storeHeader(this.method + ' ' + this.path + ' HTTP/1.1\r\n',
                      options.headers);
  }

  // JAMLEE: 如果 options 中含有 createConnection，调用本函数将 socket 和 err 传递给 req。
  const oncreate = (err, socket) => {
    if (called)
      return;
    called = true;
    if (err) {
      process.nextTick(() => this.emit('error', err));
      return;
    }
    this.onSocket(socket);
    this._deferToConnect(null, null, () => this._flush());
  };

  // initiate connection
  if (this.agent) {
    this.agent.addRequest(this, options);
  } else {
    // No agent, default to Connection:close.
    this._last = true;
    this.shouldKeepAlive = false;
    if (typeof options.createConnection === 'function') {
      const newSocket = options.createConnection(options, oncreate);
      if (newSocket && !called) {
        called = true;
        this.onSocket(newSocket);
      } else {
        return;
      }
    } else {
      debug('CLIENT use net.createConnection', options);
      this.onSocket(net.createConnection(options));
    }
  }

  // 连接建立后要 flush 1 次数据。因为 socket 可能是 end 后才被附加给 request
  this._deferToConnect(null, null, () => this._flush());
}
Object.setPrototypeOf(ClientRequest.prototype, OutgoingMessage.prototype);
Object.setPrototypeOf(ClientRequest, OutgoingMessage);
// JAMLEE: 继承函数的属性和原型的属性。

// JAMLEE: 当前请求完成时调用回调
ClientRequest.prototype._finish = function _finish() {
  DTRACE_HTTP_CLIENT_REQUEST(this, this.connection);
  OutgoingMessage.prototype._finish.call(this);
};

// JAMLEE: 默认的 firstLine + 头。
ClientRequest.prototype._implicitHeader = function _implicitHeader() {
  if (this._header) {
    throw new ERR_HTTP_HEADERS_SENT('render');
  }
  this._storeHeader(this.method + ' ' + this.path + ' HTTP/1.1\r\n',
                    this[kOutHeaders]);
};

// JAMLEE: 主动中断连接。
ClientRequest.prototype.abort = function abort() {
  if (!this.aborted) { // 在下次循环中触发 abort 事件
    process.nextTick(emitAbortNT.bind(this));
  }
  this.aborted = true;

  // If we're aborting, we don't care about any more response data.
  if (this.res) {
    this.res._dump();
  }

  // In the event that we don't have a socket, we will pop out of
  // the request queue through handling in onSocket.
  if (this.socket) {
    // in-progress
    this.socket.destroy();
  }
};


function emitAbortNT() {
  this.emit('abort');
}

function ondrain() {
  const msg = this._httpMessage;
  if (msg && !msg.finished && msg[kNeedDrain]) {
    msg[kNeedDrain] = false;
    msg.emit('drain');
  }
}

// JAMLEE: http 的 socket 的关闭事件回调。
function socketCloseListener() {
  const socket = this;
  const req = socket._httpMessage; // 当前 socket 关联的 req 对象。
  debug('HTTP socket close');

  // Pull through final chunk, if anything is buffered.
  // the ondata function will handle it properly, and this
  // is a no-op if no final chunk remains.
  socket.read();

  // NOTE: It's important to get parser here, because it could be freed by
  // the `socketOnData`.
  const parser = socket.parser; // 当前 socket 关联的 parser 对象。
  const res = req.res;  // 当前 req 关联的 res 对象。
  if (res) { // 如果 res 对象存在，说明 res 开始返回。要中断这个 res
    // Socket closed before we emitted 'end' below.
    if (!res.complete) {  // res 未结束，中断。触发 res 对象的中断事件。
      res.aborted = true;
      res.emit('aborted');
    }
    req.emit('close');  // 触发 req 对象的 close 事件。
    if (res.readable) { // 如何 res 是可读的，触发 res 的 end 事件。
      res.on('end', function() {
        this.emit('close');
      });
      res.push(null);
    } else {
      res.emit('close'); // 否则直接触发 res 的 close 事件
    }
  } else {
    if (!req.socket._hadError) {
      // This socket error fired before we started to
      // receive a response. The error needs to
      // fire on the request.
      req.socket._hadError = true;
      req.emit('error', connResetException('socket hang up'));
    }
    req.emit('close');
  }

  // Too bad.  That output wasn't getting written.
  // This is pretty terrible that it doesn't raise an error.
  // Fixed better in v0.10
  if (req.outputData)
    req.outputData.length = 0;

  // JAMLEE: 如果有 parser，调用其完成函数。并释放 parser
  if (parser) {
    parser.finish();
    freeParser(parser, req, socket);
  }
}

// JAMLEE: http 的 socket 的错误事件回调。
function socketErrorListener(err) {
  const socket = this;
  const req = socket._httpMessage;
  debug('SOCKET ERROR:', err.message, err.stack);

  if (req) {
    // For Safety. Some additional errors might fire later on
    // and we need to make sure we don't double-fire the error event.
    req.socket._hadError = true;
    req.emit('error', err);
  }

  // Handle any pending data
  socket.read();

  const parser = socket.parser;
  if (parser) {
    parser.finish();
    freeParser(parser, req, socket);
  }

  // Ensure that no further data will come out of the socket
  socket.removeListener('data', socketOnData); // 移除data事件，防止传递新的数据给上层业务代码
  socket.removeListener('end', socketOnEnd); // 移除end事件，当前不是正常关闭
  socket.destroy();
}

// JAMLEE: socket 处于空闲时（不关联 req），遭遇错误时的回调。
function freeSocketErrorListener(err) {
  const socket = this;
  debug('SOCKET ERROR on FREE socket:', err.message, err.stack);
  socket.destroy();
  socket.emit('agentRemove');
}

// JAMLEE: socket 结束时的回调。
function socketOnEnd() {
  const socket = this;
  const req = this._httpMessage;
  const parser = this.parser;

  // JAMLEE: 如果没有 res 且 req.socket 没有错误。说明 req 本身存在问题
  if (!req.res && !req.socket._hadError) {
    // If we don't have a response then we know that the socket
    // ended prematurely and we need to emit an error on the request.
    req.socket._hadError = true;
    req.emit('error', connResetException('socket hang up'));
  }
  if (parser) {
    parser.finish();
    freeParser(parser, req, socket);
  }
  socket.destroy();
}

// JAMLEE: socket 结束时的回调。
function socketOnData(d) {
  const socket = this;
  const req = this._httpMessage;
  const parser = this.parser;

  assert(parser && parser.socket === socket);

  // 解析响应的数据
  const ret = parser.execute(d);
  if (ret instanceof Error) { // 如果解析错误了，关闭 socket
    prepareError(ret, parser, d);
    debug('parse error', ret);
    freeParser(parser, req, socket);
    socket.destroy();
    req.socket._hadError = true;
    req.emit('error', ret);
  } else if (parser.incoming && parser.incoming.upgrade) { // 如果是反向代理或者ws
    // Upgrade (if status code 101) or CONNECT
    var bytesParsed = ret;
    var res = parser.incoming;
    req.res = res;

    socket.removeListener('data', socketOnData);
    socket.removeListener('end', socketOnEnd);
    socket.removeListener('drain', ondrain);
    parser.finish();
    freeParser(parser, req, socket);

    var bodyHead = d.slice(bytesParsed, d.length);

    var eventName = req.method === 'CONNECT' ? 'connect' : 'upgrade';
    if (req.listenerCount(eventName) > 0) {
      req.upgradeOrConnect = true;

      // detach the socket
      socket.emit('agentRemove');
      socket.removeListener('close', socketCloseListener);
      socket.removeListener('error', socketErrorListener);

      socket._httpMessage = null;
      socket.readableFlowing = null;

      req.emit(eventName, res, socket, bodyHead);
      req.emit('close');
    } else {
      // Requested Upgrade or used CONNECT method, but have no handler.
      socket.destroy();
    }
  } else if (parser.incoming && parser.incoming.complete && // 如果解析已经完成，移除 socket 的 listen。
             // When the status code is informational (100, 102-199),
             // the server will send a final response after this client
             // sends a request body, so we must not free the parser.
             // 101 (Switching Protocols) and all other status codes
             // should be processed normally.
             !statusIsInformational(parser.incoming.statusCode)) {
    socket.removeListener('data', socketOnData);
    socket.removeListener('end', socketOnEnd);
    socket.removeListener('drain', ondrain);
    freeParser(parser, req, socket);
  }
}

function statusIsInformational(status) {
  // 100 (Continue)    RFC7231 Section 6.2.1
  // 102 (Processing)  RFC2518
  // 103 (Early Hints) RFC8297
  // 104-199 (Unassigned)
  return (status < 200 && status >= 100 && status !== 101);
}

// 解析接收的数据
// client
function parserOnIncomingClient(res, shouldKeepAlive) {
  const socket = this.socket;
  const req = socket._httpMessage;

  debug('AGENT incoming response!');

  if (req.res) { // 如果服务端发送了两次 res
    // We already have a response object, this means the server
    // sent a double response.
    socket.destroy();
    return 0;  // No special treatment.
  }
  req.res = res;

  // Skip body and treat as Upgrade.
  if (res.upgrade)
    return 2;

  // Responses to CONNECT request is handled as Upgrade.
  const method = req.method;
  if (method === 'CONNECT') {
    res.upgrade = true;
    return 2;  // Skip body and treat as Upgrade.
  }

  if (statusIsInformational(res.statusCode)) {
    // Restart the parser, as this is a 1xx informational message.
    req.res = null; // Clear res so that we don't hit double-responses.
    // Maintain compatibility by sending 100-specific events
    if (res.statusCode === 100) {
      req.emit('continue');
    }
    // Send information events to all 1xx responses except 101 Upgrade.
    req.emit('information', {
      statusCode: res.statusCode,
      statusMessage: res.statusMessage,
      httpVersion: res.httpVersion,
      httpVersionMajor: res.httpVersionMajor,
      httpVersionMinor: res.httpVersionMinor,
      headers: res.headers,
      rawHeaders: res.rawHeaders
    });

    return 1;  // Skip body but don't treat as Upgrade.
  }

  // 服务器必须返回 keepAlive
  if (req.shouldKeepAlive && !shouldKeepAlive && !req.upgradeOrConnect) {
    // Server MUST respond with Connection:keep-alive for us to enable it.
    // If we've been upgraded (via WebSockets) we also shouldn't try to
    // keep the connection open.
    req.shouldKeepAlive = false;
  }

  // 互联关联起来
  DTRACE_HTTP_CLIENT_RESPONSE(socket, req);
  req.res = res;
  res.req = req;

  // 添加 res 的 end 事件。req 的 prefinish 事件。
  // Add our listener first, so that we guarantee socket cleanup
  res.on('end', responseOnEnd);
  req.on('prefinish', requestOnPrefinish);

  // If the user did not listen for the 'response' event, then they
  // can't possibly read the data, so we ._dump() it into the void
  // so that the socket doesn't hang there in a paused state.
  if (req.aborted || !req.emit('response', res))
    res._dump();

  if (method === 'HEAD')
    return 1;  // Skip body but don't treat as Upgrade.

  return 0;  // No special treatment.
}

// JAMLEE: req 的请求是 keepalive 的需要方 socket 还原，调用 emitFreeNT
// client
function responseKeepAlive(req) {
  const socket = req.socket;

  debug('AGENT socket keep-alive');
  if (req.timeoutCb) {
    socket.setTimeout(0, req.timeoutCb);
    req.timeoutCb = null;
  }
  socket.removeListener('close', socketCloseListener);
  socket.removeListener('error', socketErrorListener);
  // 设置 socket 空闲时（不关联到req时），触发了 socket 的 error 事件。
  socket.once('error', freeSocketErrorListener);
  // There are cases where _handle === null. Avoid those. Passing null to
  // nextTick() will call getDefaultTriggerAsyncId() to retrieve the id.
  const asyncId = socket._handle ? socket._handle.getAsyncId() : undefined;
  // Mark this socket as available, AFTER user-added end
  // handlers have a chance to run.
  defaultTriggerAsyncIdScope(asyncId, process.nextTick, emitFreeNT, socket);
}

// JAMLEE: 当 res 请求 end 时调用
function responseOnEnd() {
  const req = this.req;

  if (req.socket && req.timeoutCb) {
    req.socket.removeListener('timeout', emitRequestTimeout);
  }

  req._ended = true;

  // 如果 req 不是 keepalive的。直接 destroy 当前的 socket
  if (!req.shouldKeepAlive) {
    const socket = req.socket;
    if (socket.writable) {
      debug('AGENT socket.destroySoon()');
      if (typeof socket.destroySoon === 'function')
        socket.destroySoon();
      else
        socket.end();
    }
    assert(!socket.writable);
  } else if (req.finished) {
    // We can assume `req.finished` means all data has been written since:
    // - `'responseOnEnd'` means we have been assigned a socket.
    // - when we have a socket we write directly to it without buffering.
    // - `req.finished` means `end()` has been called and no further data.
    //   can be written
    responseKeepAlive(req);
  }
}

// JAMLEE: req.finished 
function requestOnPrefinish() {
  const req = this;

  if (req.shouldKeepAlive && req._ended)
    responseKeepAlive(req);
}

function emitFreeNT(socket) {
  socket.emit('free');
}

// JAMLEE: 把 socket 设置到 req 上。
function tickOnSocket(req, socket) {
  const parser = parsers.alloc();
  req.socket = socket;
  req.connection = socket; // outgoing 里的函数都在这里，没有socket时，当请求是写入在这个 req 的 buffer 中的
  parser.initialize(HTTPParser.RESPONSE,
                    new HTTPClientAsyncResource('HTTPINCOMINGMESSAGE', req));
  parser.socket = socket;
  parser.outgoing = req;
  req.parser = parser;

  socket.parser = parser;
  socket._httpMessage = req;

  // Propagate headers limit from request object to parser
  if (typeof req.maxHeadersCount === 'number') {
    parser.maxHeaderPairs = req.maxHeadersCount << 1;
  }

  ////////////////////////////////////////////////////////////////////
  //
  // 设置 socket 的事件。
  //
  ////////////////////////////////////////////////////////////////////
  parser.onIncoming = parserOnIncomingClient;
  socket.removeListener('error', freeSocketErrorListener);
  socket.on('error', socketErrorListener);
  socket.on('data', socketOnData);
  // By default (allowHalfOpen is false) the socket will send a FIN packet back and destroy its file descriptor once it has written out its pending write queue.
  // However, if allowHalfOpen is set to true, the socket will not automatically end() its writable side, allowing the user to write arbitrary amounts of data. 
  // The user must call end() explicitly to close the connection (i.e. sending a FIN packet back).
  socket.on('end', socketOnEnd); // 类似 c 语言的 shutdown，当接收到另外一端的 FIN 时，关闭 TCP 的 readable 端。
  socket.on('close', socketCloseListener); // 当 socket 完全关闭后触发。hadError 用于判断当前 socket 是不是异常关闭。
  socket.on('drain', ondrain); // 当前的 write buffer 已经为空

  if (
    req.timeout !== undefined ||
    (req.agent && req.agent.options && req.agent.options.timeout)
  ) {
    listenSocketTimeout(req);
  }
  req.emit('socket', socket); // 触发 req 的 socket 事件
}

// JAMLEE: 触发当前 req 的 timeout 时间
function emitRequestTimeout() {
  const req = this._httpMessage;
  if (req) {
    req.emit('timeout');
  }
}

// JAMLEE：如果 req.timeoutCb 没有设置，监听 socket 超时函数。
function listenSocketTimeout(req) {
  if (req.timeoutCb) {
    return;
  }
  // Set timeoutCb so it will get cleaned up on request end.
  req.timeoutCb = emitRequestTimeout;
  // Delegate socket timeout event.
  if (req.socket) {
    req.socket.once('timeout', emitRequestTimeout);
  } else {
    req.on('socket', (socket) => {
      socket.once('timeout', emitRequestTimeout);
    });
  }
}

// 触发 onSocket 事件，调用 onSocketNT来触发 socket 事件。其中有1个 flush 函数，意味着附加 socket 时必然刷新一次数据。
ClientRequest.prototype.onSocket = function onSocket(socket) {
  process.nextTick(onSocketNT, this, socket);
};

// JAMLEE: 给 req 设置 socket
function onSocketNT(req, socket) {
  if (req.aborted) {
    // If we were aborted while waiting for a socket, skip the whole thing.
    if (!req.agent) {
      socket.destroy();
    } else {
      socket.emit('free');
    }
  } else {
    tickOnSocket(req, socket);
  }
}

// JAMLEE: 
// 1. 当 socket 连接时(或者已连接就直接调用了)，执行一个特殊函数。当 socket 被添加时，调用 socket 的
// method（带参数 arguments_ ），以及回调函数。
ClientRequest.prototype._deferToConnect = _deferToConnect;
function _deferToConnect(method, arguments_, cb) {
  // This function is for calls that need to happen once the socket is
  // assigned to this request and writable. It's an important promisy
  // thing for all the socket calls that happen either now
  // (when a socket is assigned) or in the future (when a socket gets
  // assigned out of the pool and is eventually writable).

  const callSocketMethod = () => {
    if (method)
      this.socket[method].apply(this.socket, arguments_);

    if (typeof cb === 'function')
      cb();
  };

  const onSocket = () => {
    if (this.socket.writable) {
      callSocketMethod();
    } else {
      this.socket.once('connect', callSocketMethod);
    }
  };

  if (!this.socket) { // 当前有在监控 req 附加 socket 的事件
    this.once('socket', onSocket);
  } else {
    onSocket();
  }
}

// JAMLEE: 设置 request 的请求时间最大等待多少时间
ClientRequest.prototype.setTimeout = function setTimeout(msecs, callback) {
  if (this._ended) {
    return this;
  }

  // req.socket 的 emitRequestTimeout 事件设置。 当 socket 超时时，也触发 req 的 timeout 事件。
  listenSocketTimeout(this);

  msecs = getTimerDuration(msecs, 'msecs');
  if (callback) this.once('timeout', callback);

  // 设置 socket 的超时事件。
  if (this.socket) {
    setSocketTimeout(this.socket, msecs);
  } else {
    this.once('socket', (sock) => setSocketTimeout(sock, msecs));
  }

  return this;
};

// JAMLEE: 设置 socket 的超时事件
function setSocketTimeout(sock, msecs) {
  if (sock.connecting) {
    sock.once('connect', function() {
      sock.setTimeout(msecs);
    });
  } else {
    sock.setTimeout(msecs);
  }
}

// JAMLEE: socket 连接时，或者 socket 已经连接。调用 setNoDelay 方法
ClientRequest.prototype.setNoDelay = function setNoDelay(noDelay) {
  this._deferToConnect('setNoDelay', [noDelay]);
};

// JAMLEE: socket 连接时，或者 socket 已经连接。调用 setKeepAlive 方法
ClientRequest.prototype.setSocketKeepAlive =
    function setSocketKeepAlive(enable, initialDelay) {
      this._deferToConnect('setKeepAlive', [enable, initialDelay]);
    };

// JAMLEE: 当前的 timeout 被重置为 0
ClientRequest.prototype.clearTimeout = function clearTimeout(cb) {
  this.setTimeout(0, cb);
};

module.exports = {
  ClientRequest
};
