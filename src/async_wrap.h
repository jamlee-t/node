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

#ifndef SRC_ASYNC_WRAP_H_
#define SRC_ASYNC_WRAP_H_

#if defined(NODE_WANT_INTERNALS) && NODE_WANT_INTERNALS

#include "base_object.h"
#include "v8.h"

#include <cstdint>

namespace node {

// JAMLEE: 所有的异步操作，都会对应 1 个 Provider 类型。Provider 必然和事件循环有联系，在这轮循环中发起异步，在别的循环中检测到
// 异步完成，执行回调。
#define NODE_ASYNC_NON_CRYPTO_PROVIDER_TYPES(V)                               \
  V(NONE)                                                                     \
  V(DIRHANDLE)                                                                \
  V(DNSCHANNEL)                                                               \
  V(ELDHISTOGRAM)                                                             \
  V(FILEHANDLE)                                                               \
  V(FILEHANDLECLOSEREQ)                                                       \
  V(FSEVENTWRAP)                                                              \
  V(FSREQCALLBACK)                                                            \
  V(FSREQPROMISE)                                                             \
  V(GETADDRINFOREQWRAP)                                                       \
  V(GETNAMEINFOREQWRAP)                                                       \
  V(HEAPSNAPSHOT)                                                             \
  V(HTTP2SESSION)                                                             \
  V(HTTP2STREAM)                                                              \
  V(HTTP2PING)                                                                \
  V(HTTP2SETTINGS)                                                            \
  V(HTTPINCOMINGMESSAGE)                                                      \
  V(HTTPCLIENTREQUEST)                                                        \
  V(JSSTREAM)                                                                 \
  V(MESSAGEPORT)                                                              \
  V(PIPECONNECTWRAP)                                                          \
  V(PIPESERVERWRAP)                                                           \
  V(PIPEWRAP)                                                                 \
  V(PROCESSWRAP)                                                              \
  V(PROMISE)                                                                  \
  V(QUERYWRAP)                                                                \
  V(SHUTDOWNWRAP)                                                             \
  V(SIGNALWRAP)                                                               \
  V(STATWATCHER)                                                              \
  V(STREAMPIPE)                                                               \
  V(TCPCONNECTWRAP)                                                           \
  V(TCPSERVERWRAP)                                                            \
  V(TCPWRAP)                                                                  \
  V(TTYWRAP)                                                                  \
  V(UDPSENDWRAP)                                                              \
  V(UDPWRAP)                                                                  \
  V(WORKER)                                                                   \
  V(WRITEWRAP)                                                                \
  V(ZLIB)

#if HAVE_OPENSSL
#define NODE_ASYNC_CRYPTO_PROVIDER_TYPES(V)                                   \
  V(PBKDF2REQUEST)                                                            \
  V(KEYPAIRGENREQUEST)                                                        \
  V(RANDOMBYTESREQUEST)                                                       \
  V(SCRYPTREQUEST)                                                            \
  V(TLSWRAP)
#else
#define NODE_ASYNC_CRYPTO_PROVIDER_TYPES(V)
#endif  // HAVE_OPENSSL

#if HAVE_INSPECTOR
#define NODE_ASYNC_INSPECTOR_PROVIDER_TYPES(V)                                \
  V(INSPECTORJSBINDING)
#else
#define NODE_ASYNC_INSPECTOR_PROVIDER_TYPES(V)
#endif  // HAVE_INSPECTOR

#define NODE_ASYNC_PROVIDER_TYPES(V)                                          \
  NODE_ASYNC_NON_CRYPTO_PROVIDER_TYPES(V)                                     \
  NODE_ASYNC_CRYPTO_PROVIDER_TYPES(V)                                         \
  NODE_ASYNC_INSPECTOR_PROVIDER_TYPES(V)

class Environment;
class DestroyParam;

// JAMLEE: 每个 async scope 有 1 个 id: async_id。
// 1. AsyncWrap 不仅仅要对内部，还要暴露给 JS。在 JS 也可以配置 AsyncResource 用于在 JS 层面触发 async hook。
// 2. lib/async_hook.js 中定义了 AsyncResource 对象。构造 AsyncResource 对象触发 emitInit; runInAsyncScope 触发 emitBefore 和 emitAfter 3. 触发 emitDestroy
// 3. 在 lib/internal/timer.js 中直接调用了 emitInit 等。没有使用 AsyncResource，效果一样。
class AsyncWrap : public BaseObject {
 public:
  enum ProviderType {
#define V(PROVIDER)                                                           \
    PROVIDER_ ## PROVIDER,
    NODE_ASYNC_PROVIDER_TYPES(V)
#undef V
    PROVIDERS_LENGTH,
  };

  // JAMLEE: 参数 env, v8 object, provider 每个异步都是由 provider 在事件循环发起事件。
  // execution_async_id 当前执行异步回调时分配的 id。
  // 异步不应该是 1 个 context，和 1 个v8对象，node baseObject 做起来关联是做什么解释?
  // 1. 异步操作一定由 1 个 Provider 来发起的（Promise除外）。AsyncWrap 就是给所有 Provider 用的。
  AsyncWrap(Environment* env,
            v8::Local<v8::Object> object,
            ProviderType provider,
            double execution_async_id = kInvalidAsyncId);

  // This constructor creates a reusable instance where user is responsible
  // to call set_provider_type() and AsyncReset() before use.
  AsyncWrap(Environment* env, v8::Local<v8::Object> object);

  ~AsyncWrap() override;

  AsyncWrap() = delete;

  static constexpr double kInvalidAsyncId = -1;

  // JAMLEE: 获取当前 v8 对象的构造函数（函数模板）
  static v8::Local<v8::FunctionTemplate> GetConstructorTemplate(
      Environment* env);

  // JAMLEE: 注意这些是静态方法。初始化 target，这个是 v8 对象。也就是当前关联的 v8 对象。
  static void Initialize(v8::Local<v8::Object> target,
                         v8::Local<v8::Value> unused,
                         v8::Local<v8::Context> context,
                         void* priv);

  static void GetAsyncId(const v8::FunctionCallbackInfo<v8::Value>& args);
  static void PushAsyncIds(const v8::FunctionCallbackInfo<v8::Value>& args);
  static void PopAsyncIds(const v8::FunctionCallbackInfo<v8::Value>& args);
  static void AsyncReset(const v8::FunctionCallbackInfo<v8::Value>& args);
  static void GetProviderType(const v8::FunctionCallbackInfo<v8::Value>& args);
  static void QueueDestroyAsyncId(
    const v8::FunctionCallbackInfo<v8::Value>& args);

  // JAMLEE: 注意这些是静态方法。触发异步hook事件
  static void EmitAsyncInit(Environment* env,
                            v8::Local<v8::Object> object,
                            v8::Local<v8::String> type,
                            double async_id,
                            double trigger_async_id);

  static void EmitDestroy(Environment* env, double async_id);
  static void EmitBefore(Environment* env, double async_id);
  static void EmitAfter(Environment* env, double async_id);
  static void EmitPromiseResolve(Environment* env, double async_id);

  void EmitDestroy();

  void EmitTraceEventBefore();
  static void EmitTraceEventAfter(ProviderType type, double async_id);
  void EmitTraceEventDestroy();

  static void DestroyAsyncIdsCallback(Environment* env);

  inline ProviderType provider_type() const;
  inline ProviderType set_provider_type(ProviderType provider);

  inline double get_async_id() const;

  inline double get_trigger_async_id() const;

  void AsyncReset(v8::Local<v8::Object> resource,
                  double execution_async_id = kInvalidAsyncId,
                  bool silent = false);

  void AsyncReset(double execution_async_id = kInvalidAsyncId,
                  bool silent = false);

  // JAMLEE: libuv -> C++ -> JS。从 C++ 调用到 JS 中
  // Only call these within a valid HandleScope.
  v8::MaybeLocal<v8::Value> MakeCallback(const v8::Local<v8::Function> cb,
                                         int argc,
                                         v8::Local<v8::Value>* argv);
  inline v8::MaybeLocal<v8::Value> MakeCallback(
      const v8::Local<v8::Symbol> symbol,
      int argc,
      v8::Local<v8::Value>* argv);
  inline v8::MaybeLocal<v8::Value> MakeCallback(
      const v8::Local<v8::String> symbol,
      int argc,
      v8::Local<v8::Value>* argv);
  inline v8::MaybeLocal<v8::Value> MakeCallback(
      const v8::Local<v8::Name> symbol,
      int argc,
      v8::Local<v8::Value>* argv);

  virtual std::string diagnostic_name() const;

  // JAMLEE: 重写 MemoryRetainer 的 MemoryInfoName 纯虚函数。
  std::string MemoryInfoName() const override;

  static void WeakCallback(const v8::WeakCallbackInfo<DestroyParam> &info);

  // Returns the object that 'owns' an async wrap. For example, for a
  // TCP connection handle, this is the corresponding net.Socket.
  v8::Local<v8::Object> GetOwner();
  static v8::Local<v8::Object> GetOwner(Environment* env,
                                        v8::Local<v8::Object> obj);

  // JAMLEE: 代表 1 个 AsyncScope。在 AsyncScope 中执行异步回调代码
  /*
  EmitBefore(env, wrap->get_async_id()); // 构造 AsyncScope 时
  EmitAfter(env, wrap_->get_async_id()); // 析构 AsyncScope 时
  */
  // This is a simplified version of InternalCallbackScope that only runs
  // the `before` and `after` hooks. Only use it when not actually calling
  // back into JS; otherwise, use InternalCallbackScope.
  class AsyncScope {
   public:
    explicit inline AsyncScope(AsyncWrap* wrap);
    ~AsyncScope();

   private:
    AsyncWrap* wrap_ = nullptr;
  };

  bool IsDoneInitializing() const override;

 private:
  friend class PromiseWrap;

  // JAMLEE: AsyncWrap 对 1 个 promise 对象做封装。
  AsyncWrap(Environment* env,
            v8::Local<v8::Object> promise,
            ProviderType provider,
            double execution_async_id,
            bool silent);
  ProviderType provider_type_ = PROVIDER_NONE;
  bool init_hook_ran_ = false;
  // Because the values may be Reset(), cannot be made const.
  double async_id_ = kInvalidAsyncId;
  double trigger_async_id_;
};

}  // namespace node

#endif  // defined(NODE_WANT_INTERNALS) && NODE_WANT_INTERNALS

#endif  // SRC_ASYNC_WRAP_H_
