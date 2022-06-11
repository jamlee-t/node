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

#include "async_wrap.h"  // NOLINT(build/include_inline)
#include "async_wrap-inl.h"
#include "env-inl.h"
#include "node_errors.h"
#include "tracing/traced_value.h"
#include "util-inl.h"

#include "v8.h"
#include "v8-profiler.h"

using v8::Context;
using v8::DontDelete;
using v8::EscapableHandleScope;
using v8::Function;
using v8::FunctionCallbackInfo;
using v8::FunctionTemplate;
using v8::Global;
using v8::HandleScope;
using v8::Integer;
using v8::Isolate;
using v8::Local;
using v8::MaybeLocal;
using v8::Number;
using v8::Object;
using v8::ObjectTemplate;
using v8::Promise;
using v8::PromiseHookType;
using v8::PropertyAttribute;
using v8::PropertyCallbackInfo;
using v8::ReadOnly;
using v8::String;
using v8::TryCatch;
using v8::Uint32;
using v8::Undefined;
using v8::Value;
using v8::WeakCallbackInfo;
using v8::WeakCallbackType;

using TryCatchScope = node::errors::TryCatchScope;

namespace node {

static const char* const provider_names[] = {
#define V(PROVIDER)                                                           \
  #PROVIDER,
  NODE_ASYNC_PROVIDER_TYPES(V)
#undef V
};


struct AsyncWrapObject : public AsyncWrap {
  static inline void New(const FunctionCallbackInfo<Value>& args) {
    Environment* env = Environment::GetCurrent(args);
    CHECK(args.IsConstructCall());
    CHECK(env->async_wrap_object_ctor_template()->HasInstance(args.This()));
    CHECK(args[0]->IsUint32());
    auto type = static_cast<ProviderType>(args[0].As<Uint32>()->Value());
    new AsyncWrapObject(env, args.This(), type);
  }

  inline AsyncWrapObject(Environment* env, Local<Object> object,
                         ProviderType type) : AsyncWrap(env, object, type) {}

  SET_NO_MEMORY_INFO()
  SET_MEMORY_INFO_NAME(AsyncWrapObject)
  SET_SELF_SIZE(AsyncWrapObject)
};

//////////////////////////////////////////////////////////////////////
//
// AsyncWrap 类方法实现
//
//////////////////////////////////////////////////////////////////////

void AsyncWrap::DestroyAsyncIdsCallback(Environment* env) {
  Local<Function> fn = env->async_hooks_destroy_function();

  TryCatchScope try_catch(env, TryCatchScope::CatchMode::kFatal);

  do {
    std::vector<double> destroy_async_id_list;
    destroy_async_id_list.swap(*env->destroy_async_id_list());
    if (!env->can_call_into_js()) return;
    for (auto async_id : destroy_async_id_list) {
      // Want each callback to be cleaned up after itself, instead of cleaning
      // them all up after the while() loop completes.
      HandleScope scope(env->isolate());
      Local<Value> async_id_value = Number::New(env->isolate(), async_id);
      MaybeLocal<Value> ret = fn->Call(
          env->context(), Undefined(env->isolate()), 1, &async_id_value);

      if (ret.IsEmpty())
        return;
    }
  } while (!env->destroy_async_id_list()->empty());
}

// JAMLEE: 静态方法。所有事件触发最终交由这个函数处理
// env: node 的核心对象
// async_id: init, before, after, destroy 事件的触发的 id。
// type: 异步对象类型。例如 kBefore, kAfter
// fn: 事件触发调用的回调函数。fn->Call(env->context(), Undefined(env->isolate()), 1, &async_id_value)
void Emit(Environment* env, double async_id, AsyncHooks::Fields type,
          Local<Function> fn) {
  // 从 env 取出所有的 hooks。也就是说 hook 是全局的。
  AsyncHooks* async_hooks = env->async_hooks();

  // 如果当前hook对应没有值
  if (async_hooks->fields()[type] == 0 || !env->can_call_into_js())
    return;

  HandleScope handle_scope(env->isolate());
  Local<Value> async_id_value = Number::New(env->isolate(), async_id);
  TryCatchScope try_catch(env, TryCatchScope::CatchMode::kFatal);
  // JAMLEE: 调用 fn->Call(env->context(), Undefined(env->isolate()), 1, &async_id_value)
  // The USE(x, ...) template is used to silence C++ compiler warnings
  // issued for (yet) unused variables (typically parameters).
  // The arguments are guaranteed to be evaluated from left to right.
  USE(fn->Call(env->context(), Undefined(env->isolate()), 1, &async_id_value));
}


void AsyncWrap::EmitPromiseResolve(Environment* env, double async_id) {
  Emit(env, async_id, AsyncHooks::kPromiseResolve,
       env->async_hooks_promise_resolve_function());
}


void AsyncWrap::EmitTraceEventBefore() {
  switch (provider_type()) {
#define V(PROVIDER)                                                           \
    case PROVIDER_ ## PROVIDER:                                               \
      TRACE_EVENT_NESTABLE_ASYNC_BEGIN0(                                      \
        TRACING_CATEGORY_NODE1(async_hooks),                                  \
        #PROVIDER "_CALLBACK", static_cast<int64_t>(get_async_id()));         \
      break;
    NODE_ASYNC_PROVIDER_TYPES(V)
#undef V
    default:
      UNREACHABLE();
  }
}

// JAMLEE: 静态方法。异步调用之前触发。最终会调用 async_hooks_before_function() 获取当前全局的hook函数
void AsyncWrap::EmitBefore(Environment* env, double async_id) {
  Emit(env, async_id, AsyncHooks::kBefore,
       env->async_hooks_before_function());
}

// JAMLEE: 静态方法。
void AsyncWrap::EmitTraceEventAfter(ProviderType type, double async_id) {
  switch (type) {
#define V(PROVIDER)                                                           \
    case PROVIDER_ ## PROVIDER:                                               \
      TRACE_EVENT_NESTABLE_ASYNC_END0(                                        \
        TRACING_CATEGORY_NODE1(async_hooks),                                  \
        #PROVIDER "_CALLBACK", static_cast<int64_t>(async_id));               \
      break;
    NODE_ASYNC_PROVIDER_TYPES(V)
#undef V
    default:
      UNREACHABLE();
  }
}

// JAMLEE: 静态方法。异步调用之后触发
void AsyncWrap::EmitAfter(Environment* env, double async_id) {
  // If the user's callback failed then the after() hooks will be called at the
  // end of _fatalException().
  Emit(env, async_id, AsyncHooks::kAfter,
       env->async_hooks_after_function());
}

// JAMLEE: 为 Promise 设置 PromiseWrap
class PromiseWrap : public AsyncWrap {
 public:
  PromiseWrap(Environment* env, Local<Object> object, bool silent)
      : AsyncWrap(env, object, PROVIDER_PROMISE, kInvalidAsyncId, silent) {
    MakeWeak();
  }

  SET_NO_MEMORY_INFO()
  SET_MEMORY_INFO_NAME(PromiseWrap)
  SET_SELF_SIZE(PromiseWrap)

  static constexpr int kIsChainedPromiseField = 1;
  static constexpr int kInternalFieldCount = 2;

  static PromiseWrap* New(Environment* env,
                          Local<Promise> promise,
                          PromiseWrap* parent_wrap,
                          bool silent);
  static void getIsChainedPromise(Local<String> property,
                                  const PropertyCallbackInfo<Value>& info);
};

PromiseWrap* PromiseWrap::New(Environment* env,
                              Local<Promise> promise,
                              PromiseWrap* parent_wrap,
                              bool silent) {
  Local<Object> obj;
  if (!env->promise_wrap_template()->NewInstance(env->context()).ToLocal(&obj))
    return nullptr;
  obj->SetInternalField(PromiseWrap::kIsChainedPromiseField,
                        parent_wrap != nullptr ? v8::True(env->isolate())
                                               : v8::False(env->isolate()));
  CHECK_NULL(promise->GetAlignedPointerFromInternalField(0));
  promise->SetInternalField(0, obj);
  return new PromiseWrap(env, obj, silent);
}

void PromiseWrap::getIsChainedPromise(Local<String> property,
                                      const PropertyCallbackInfo<Value>& info) {
  info.GetReturnValue().Set(
    info.Holder()->GetInternalField(kIsChainedPromiseField));
}

static PromiseWrap* extractPromiseWrap(Local<Promise> promise) {
  Local<Value> resource_object_value = promise->GetInternalField(0);
  if (resource_object_value->IsObject()) {
    return Unwrap<PromiseWrap>(resource_object_value.As<Object>());
  }
  return nullptr;
}

static void PromiseHook(PromiseHookType type, Local<Promise> promise,
                        Local<Value> parent) {
  Local<Context> context = promise->CreationContext();

  Environment* env = Environment::GetCurrent(context);
  if (env == nullptr) return;
  TraceEventScope trace_scope(TRACING_CATEGORY_NODE1(environment),
                              "EnvPromiseHook", env);

  PromiseWrap* wrap = extractPromiseWrap(promise);
  if (type == PromiseHookType::kInit || wrap == nullptr) {
    bool silent = type != PromiseHookType::kInit;

    // set parent promise's async Id as this promise's triggerAsyncId
    if (parent->IsPromise()) {
      // parent promise exists, current promise
      // is a chained promise, so we set parent promise's id as
      // current promise's triggerAsyncId
      Local<Promise> parent_promise = parent.As<Promise>();
      PromiseWrap* parent_wrap = extractPromiseWrap(parent_promise);
      if (parent_wrap == nullptr) {
        parent_wrap = PromiseWrap::New(env, parent_promise, nullptr, true);
        if (parent_wrap == nullptr) return;
      }

      AsyncHooks::DefaultTriggerAsyncIdScope trigger_scope(parent_wrap);
      wrap = PromiseWrap::New(env, promise, parent_wrap, silent);
    } else {
      wrap = PromiseWrap::New(env, promise, nullptr, silent);
    }
  }

  if (wrap == nullptr) return;

  if (type == PromiseHookType::kBefore) {
    env->async_hooks()->push_async_ids(
      wrap->get_async_id(), wrap->get_trigger_async_id());
    wrap->EmitTraceEventBefore();
    AsyncWrap::EmitBefore(wrap->env(), wrap->get_async_id());
  } else if (type == PromiseHookType::kAfter) {
    wrap->EmitTraceEventAfter(wrap->provider_type(), wrap->get_async_id());
    AsyncWrap::EmitAfter(wrap->env(), wrap->get_async_id());
    if (env->execution_async_id() == wrap->get_async_id()) {
      // This condition might not be true if async_hooks was enabled during
      // the promise callback execution.
      // Popping it off the stack can be skipped in that case, because it is
      // known that it would correspond to exactly one call with
      // PromiseHookType::kBefore that was not witnessed by the PromiseHook.
      env->async_hooks()->pop_async_id(wrap->get_async_id());
    }
  } else if (type == PromiseHookType::kResolve) {
    AsyncWrap::EmitPromiseResolve(wrap->env(), wrap->get_async_id());
  }
}

// JAMLEE: 静态方法。设置 hook。args[0] 是 { init, before, after, destroy, promiseResolve }
static void SetupHooks(const FunctionCallbackInfo<Value>& args) {
  Environment* env = Environment::GetCurrent(args);

  CHECK(args[0]->IsObject());

  // JAMLEE: 内部的 init, before, after, destroy 是 C++ 方法，只应该被调用一次
  // All of init, before, after, destroy are supplied by async_hooks
  // internally, so this should every only be called once. At which time all
  // the functions should be set. Detect this by checking if init !IsEmpty().
  CHECK(env->async_hooks_init_function().IsEmpty());

  Local<Object> fn_obj = args[0].As<Object>();

#define SET_HOOK_FN(name)                                                      \
  do {                                                                         \
    Local<Value> v =                                                           \
        fn_obj->Get(env->context(),                                            \
                    FIXED_ONE_BYTE_STRING(env->isolate(), #name))              \
            .ToLocalChecked();                                                 \
    CHECK(v->IsFunction());                                                    \
    env->set_async_hooks_##name##_function(v.As<Function>());                  \
  } while (0)

  SET_HOOK_FN(init);
  SET_HOOK_FN(before);
  SET_HOOK_FN(after);
  SET_HOOK_FN(destroy);
  SET_HOOK_FN(promise_resolve);
#undef SET_HOOK_FN

  {
    Local<FunctionTemplate> ctor =
        FunctionTemplate::New(env->isolate());
    ctor->SetClassName(FIXED_ONE_BYTE_STRING(env->isolate(), "PromiseWrap"));
    Local<ObjectTemplate> promise_wrap_template = ctor->InstanceTemplate();
    promise_wrap_template->SetInternalFieldCount(
        PromiseWrap::kInternalFieldCount);
    promise_wrap_template->SetAccessor(
        FIXED_ONE_BYTE_STRING(env->isolate(), "isChainedPromise"),
        PromiseWrap::getIsChainedPromise);
    env->set_promise_wrap_template(promise_wrap_template);
  }
}


static void EnablePromiseHook(const FunctionCallbackInfo<Value>& args) {
  args.GetIsolate()->SetPromiseHook(PromiseHook);
}


static void DisablePromiseHook(const FunctionCallbackInfo<Value>& args) {
  Isolate* isolate = args.GetIsolate();

  // The per-Isolate API provides no way of knowing whether there are multiple
  // users of the PromiseHook. That hopefully goes away when V8 introduces
  // a per-context API.
  isolate->SetPromiseHook(nullptr);
}


class DestroyParam {
 public:
  double asyncId;
  Environment* env;
  Global<Object> target;
  Global<Object> propBag;
};

void AsyncWrap::WeakCallback(const WeakCallbackInfo<DestroyParam>& info) {
  HandleScope scope(info.GetIsolate());

  std::unique_ptr<DestroyParam> p{info.GetParameter()};
  Local<Object> prop_bag = PersistentToLocal::Default(info.GetIsolate(),
                                                      p->propBag);
  Local<Value> val;

  if (!prop_bag->Get(p->env->context(), p->env->destroyed_string())
        .ToLocal(&val)) {
    return;
  }

  if (val->IsFalse()) {
    AsyncWrap::EmitDestroy(p->env, p->asyncId);
  }
  // unique_ptr goes out of scope here and pointer is deleted.
}

// JAMLEE: 工具函数，在 Initialize 中被调用。static 这里的含义是和 C 语言一致。表示仅内部用
static void RegisterDestroyHook(const FunctionCallbackInfo<Value>& args) {
  CHECK(args[0]->IsObject());
  CHECK(args[1]->IsNumber());
  CHECK(args[2]->IsObject());

  Isolate* isolate = args.GetIsolate();
  DestroyParam* p = new DestroyParam();
  p->asyncId = args[1].As<Number>()->Value();
  p->env = Environment::GetCurrent(args);
  p->target.Reset(isolate, args[0].As<Object>());
  p->propBag.Reset(isolate, args[2].As<Object>());
  p->target.SetWeak(p, AsyncWrap::WeakCallback, WeakCallbackType::kParameter);
}

// JAMLEE: 获取当前的 async_id
void AsyncWrap::GetAsyncId(const FunctionCallbackInfo<Value>& args) {
  AsyncWrap* wrap;
  args.GetReturnValue().Set(kInvalidAsyncId);
  ASSIGN_OR_RETURN_UNWRAP(&wrap, args.Holder());
  args.GetReturnValue().Set(wrap->get_async_id());
}

// JAMLEE: 静态方法。调用 env->async_hooks()->push_async_ids 把 async_id 存到 env 中。
void AsyncWrap::PushAsyncIds(const FunctionCallbackInfo<Value>& args) {
  Environment* env = Environment::GetCurrent(args);
  // No need for CHECK(IsNumber()) on args because if FromJust() doesn't fail
  // then the checks in push_async_ids() and pop_async_id() will.
  double async_id = args[0]->NumberValue(env->context()).FromJust();
  double trigger_async_id = args[1]->NumberValue(env->context()).FromJust();
  env->async_hooks()->push_async_ids(async_id, trigger_async_id);
}

// JAMLEE: 静态方法。调用 env->async_hooks()->pop_async_id 把 async_id 存到 env 中。
void AsyncWrap::PopAsyncIds(const FunctionCallbackInfo<Value>& args) {
  Environment* env = Environment::GetCurrent(args);
  double async_id = args[0]->NumberValue(env->context()).FromJust();
  args.GetReturnValue().Set(env->async_hooks()->pop_async_id(async_id));
}


// JAMLEE: 静态方法。1. args[0] 是 resource。重置这个resource。 2. args[1] 是 execution_async_id
// 资源的 async_id 设置到 resource 上
void AsyncWrap::AsyncReset(const FunctionCallbackInfo<Value>& args) {
  CHECK(args[0]->IsObject());

  AsyncWrap* wrap;
  ASSIGN_OR_RETURN_UNWRAP(&wrap, args.Holder());

  Local<Object> resource = args[0].As<Object>();
  double execution_async_id =
      args[1]->IsNumber() ? args[1].As<Number>()->Value() : kInvalidAsyncId;
  wrap->AsyncReset(resource, execution_async_id);
}

// JAMLEE: 获取 ProviderType 也就是 TcpWrap。
void AsyncWrap::GetProviderType(const FunctionCallbackInfo<Value>& args) {
  AsyncWrap* wrap;
  args.GetReturnValue().Set(AsyncWrap::PROVIDER_NONE);
  ASSIGN_OR_RETURN_UNWRAP(&wrap, args.Holder());
  args.GetReturnValue().Set(wrap->provider_type());
}


// JAMLEE: 静态方法。触发 Destory 事件
void AsyncWrap::EmitDestroy() {
  AsyncWrap::EmitDestroy(env(), async_id_);
  // Ensure no double destroy is emitted via AsyncReset().
  async_id_ = kInvalidAsyncId;
}

// JAMLEE: 静态方法。触发 Destory 事件
void AsyncWrap::QueueDestroyAsyncId(const FunctionCallbackInfo<Value>& args) {
  CHECK(args[0]->IsNumber());
  AsyncWrap::EmitDestroy(
      Environment::GetCurrent(args),
      args[0].As<Number>()->Value());
}

// JAMLEE: 静态方法。获取1个构造函数（函数模板），用于构造 v8 对象。在 AsyncWrap::Initialize 中被调用
Local<FunctionTemplate> AsyncWrap::GetConstructorTemplate(Environment* env) {
  Local<FunctionTemplate> tmpl = env->async_wrap_ctor_template();
  if (tmpl.IsEmpty()) {
    tmpl = env->NewFunctionTemplate(nullptr);
    tmpl->SetClassName(FIXED_ONE_BYTE_STRING(env->isolate(), "AsyncWrap"));
    env->SetProtoMethod(tmpl, "getAsyncId", AsyncWrap::GetAsyncId);
    env->SetProtoMethod(tmpl, "asyncReset", AsyncWrap::AsyncReset);
    env->SetProtoMethod(tmpl, "getProviderType", AsyncWrap::GetProviderType);
    env->set_async_wrap_ctor_template(tmpl);
  }
  return tmpl;
}

// JAMLEE: 静态方法。构造v8对象 target，为 target 设置上方法。target 是导出的对象，给到 lib/internal/async_hook.js 使用
void AsyncWrap::Initialize(Local<Object> target,
                           Local<Value> unused,
                           Local<Context> context,
                           void* priv) {
  Environment* env = Environment::GetCurrent(context);
  Isolate* isolate = env->isolate();
  HandleScope scope(isolate);

  env->SetMethod(target, "setupHooks", SetupHooks);
  env->SetMethod(target, "pushAsyncIds", PushAsyncIds);
  env->SetMethod(target, "popAsyncIds", PopAsyncIds);
  env->SetMethod(target, "queueDestroyAsyncId", QueueDestroyAsyncId);
  env->SetMethod(target, "enablePromiseHook", EnablePromiseHook);
  env->SetMethod(target, "disablePromiseHook", DisablePromiseHook);
  env->SetMethod(target, "registerDestroyHook", RegisterDestroyHook);

  PropertyAttribute ReadOnlyDontDelete =
      static_cast<PropertyAttribute>(ReadOnly | DontDelete);

  // JAMLEE: 暴露给 lib/internal/async_hook.js
  // const { async_hook_fields, async_id_fields, owner_symbol } = async_wrap;

#define FORCE_SET_TARGET_FIELD(obj, str, field)                               \
  (obj)->DefineOwnProperty(context,                                           \
                           FIXED_ONE_BYTE_STRING(isolate, str),               \
                           field,                                             \
                           ReadOnlyDontDelete).FromJust()

  // Attach the uint32_t[] where each slot contains the count of the number of
  // callbacks waiting to be called on a particular event. It can then be
  // incremented/decremented from JS quickly to communicate to C++ if there are
  // any callbacks waiting to be called.
  FORCE_SET_TARGET_FIELD(target,
                         "async_hook_fields",
                         env->async_hooks()->fields().GetJSArray());

  // JAMLEE: 创建新的 asyncId 用 async_id_fields
  // function newAsyncId() {
  //   return ++async_id_fields[kAsyncIdCounter];
  // }
  
  // The following v8::Float64Array has 5 fields. These fields are shared in
  // this way to allow JS and C++ to read/write each value as quickly as
  // possible. The fields are represented as follows:
  //
  // kAsyncIdCounter: Maintains the state of the next unique id to be assigned.
  //
  // kDefaultTriggerAsyncId: Write the id of the resource responsible for a
  //   handle's creation just before calling the new handle's constructor.
  //   After the new handle is constructed kDefaultTriggerAsyncId is set back
  //   to kInvalidAsyncId.
  FORCE_SET_TARGET_FIELD(target,
                         "async_id_fields",
                         env->async_hooks()->async_id_fields().GetJSArray());

  // JAMLEE: env->async_ids_stack_string() 是 async_ids_stack
  target->Set(context,
              env->async_ids_stack_string(),
              env->async_hooks()->async_ids_stack().GetJSArray()).Check();

  target->Set(context,
              FIXED_ONE_BYTE_STRING(env->isolate(), "owner_symbol"),
              env->owner_symbol()).Check();

  Local<Object> constants = Object::New(isolate);

  // JAMLEE: SET_HOOKS_CONSTANT(kInit); 为 target 设置大量常量对象

  // obj = constants, str = "kInit", field = Integer::New(isolate, AsyncHooks::kInit)
  // FORCE_SET_TARGET_FIELD(                                              
  //     constants, "kInit", Integer::New(isolate, AsyncHooks::kInit))
  // 展开得到: 
  // (constants)->DefineOwnProperty(context,                                      
  //                          FIXED_ONE_BYTE_STRING(isolate, "kInit"),     
  //                          Integer::New(isolate, AsyncHooks::kInit),                          
  //                          ReadOnlyDontDelete).FromJust()

#define SET_HOOKS_CONSTANT(name)                                              \
  FORCE_SET_TARGET_FIELD(                                                     \
      constants, #name, Integer::New(isolate, AsyncHooks::name))

  SET_HOOKS_CONSTANT(kInit);
  SET_HOOKS_CONSTANT(kBefore);
  SET_HOOKS_CONSTANT(kAfter);
  SET_HOOKS_CONSTANT(kDestroy);
  SET_HOOKS_CONSTANT(kPromiseResolve);
  SET_HOOKS_CONSTANT(kTotals);
  SET_HOOKS_CONSTANT(kCheck);
  SET_HOOKS_CONSTANT(kExecutionAsyncId);
  SET_HOOKS_CONSTANT(kTriggerAsyncId);
  SET_HOOKS_CONSTANT(kAsyncIdCounter);
  SET_HOOKS_CONSTANT(kDefaultTriggerAsyncId);
  SET_HOOKS_CONSTANT(kStackLength);
#undef SET_HOOKS_CONSTANT

  // JAMLEE: target.constants = constants
  FORCE_SET_TARGET_FIELD(target, "constants", constants);

  Local<Object> async_providers = Object::New(isolate);
#define V(p)                                                                  \
  FORCE_SET_TARGET_FIELD(                                                     \
      async_providers, #p, Integer::New(isolate, AsyncWrap::PROVIDER_ ## p));
  NODE_ASYNC_PROVIDER_TYPES(V)
#undef V
  FORCE_SET_TARGET_FIELD(target, "Providers", async_providers);

#undef FORCE_SET_TARGET_FIELD

  env->set_async_hooks_init_function(Local<Function>());
  env->set_async_hooks_before_function(Local<Function>());
  env->set_async_hooks_after_function(Local<Function>());
  env->set_async_hooks_destroy_function(Local<Function>());
  env->set_async_hooks_promise_resolve_function(Local<Function>());
  env->set_async_hooks_binding(target);

  // TODO(addaleax): This block might better work as a
  // AsyncWrapObject::Initialize() or AsyncWrapObject::GetConstructorTemplate()
  // function.
  {
    auto class_name = FIXED_ONE_BYTE_STRING(env->isolate(), "AsyncWrap");
    auto function_template = env->NewFunctionTemplate(AsyncWrapObject::New);
    function_template->SetClassName(class_name);
    function_template->Inherit(AsyncWrap::GetConstructorTemplate(env));
    auto instance_template = function_template->InstanceTemplate();
    instance_template->SetInternalFieldCount(1);
    auto function =
        function_template->GetFunction(env->context()).ToLocalChecked();
    target->Set(env->context(), class_name, function).Check();
    env->set_async_wrap_object_ctor_template(function_template);
  }
}

// JAMLEE: AsyncWrap 构造函数
AsyncWrap::AsyncWrap(Environment* env,
                     Local<Object> object,
                     ProviderType provider,
                     double execution_async_id)
    : AsyncWrap(env, object, provider, execution_async_id, false) {}

AsyncWrap::AsyncWrap(Environment* env,
                     Local<Object> object,
                     ProviderType provider,
                     double execution_async_id,
                     bool silent)
    : AsyncWrap(env, object) {
  CHECK_NE(provider, PROVIDER_NONE);
  provider_type_ = provider;

  // Use AsyncReset() call to execute the init() callbacks.
  AsyncReset(execution_async_id, silent);
  init_hook_ran_ = true;
}

// JAMLEE: 构造函数
AsyncWrap::AsyncWrap(Environment* env, Local<Object> object)
  : BaseObject(env, object) {
}

// This method is necessary to work around one specific problem:
// Before the init() hook runs, if there is one, the BaseObject() constructor
// registers this object with the Environment for finilization and debugging
// purposes.
// If the Environment decides to inspect this object for debugging, it tries to
// call virtual methods on this object that are only (meaningfully) implemented
// by the subclasses of AsyncWrap.
// This could, with bad luck, happen during the AsyncWrap() constructor,
// because we run JS code as part of it and that in turn can lead to a heapdump
// being taken, either through the inspector or our programmatic API for it.
// The object being initialized is not fully constructed at that point, and
// in particular its virtual function table points to the AsyncWrap one
// (as the subclass constructor has not yet begun execution at that point).
// This means that the functions that are used for heap dump memory tracking
// are not yet available, and trying to call them would crash the process.
// We use this particular `IsDoneInitializing()` method to tell the Environment
// that such debugging methods are not yet available.
// This may be somewhat unreliable when it comes to future changes, because
// at this point it *only* protects AsyncWrap subclasses, and *only* for cases
// where heap dumps are being taken while the init() hook is on the call stack.
// For now, it seems like the best solution, though.
bool AsyncWrap::IsDoneInitializing() const {
  return init_hook_ran_;
}

// JAMLEE: 析构 AsyncWrap 时触发 EmitDestroy
AsyncWrap::~AsyncWrap() {
  EmitTraceEventDestroy();
  EmitDestroy();
}

// JAMLEE: 静态方法。
void AsyncWrap::EmitTraceEventDestroy() {
  switch (provider_type()) {
  #define V(PROVIDER)                                                         \
    case PROVIDER_ ## PROVIDER:                                               \
      TRACE_EVENT_NESTABLE_ASYNC_END0(                                        \
        TRACING_CATEGORY_NODE1(async_hooks),                                  \
        #PROVIDER, static_cast<int64_t>(get_async_id()));                     \
      break;
    NODE_ASYNC_PROVIDER_TYPES(V)
  #undef V
    default:
      UNREACHABLE();
  }
}

// JAMLEE: 静态方法。
void AsyncWrap::EmitDestroy(Environment* env, double async_id) {
  if (env->async_hooks()->fields()[AsyncHooks::kDestroy] == 0 ||
      !env->can_call_into_js()) {
    return;
  }

  if (env->destroy_async_id_list()->empty()) {
    env->SetUnrefImmediate(&DestroyAsyncIdsCallback);
  }

  env->destroy_async_id_list()->push_back(async_id);
}

// JAMLEE: 有个静态方法 AsyncReset。会新建对象 AsyncWrap，然后调用 reset 方法。
void AsyncWrap::AsyncReset(double execution_async_id, bool silent) {
  // 调用另外 1 个实例方法 AsyncWrap::AsyncReset
  AsyncReset(object(), execution_async_id, silent);
}

// Generalized call for both the constructor and for handles that are pooled
// and reused over their lifetime. This way a new uid can be assigned when
// the resource is pulled out of the pool and put back into use.
void AsyncWrap::AsyncReset(Local<Object> resource, double execution_async_id,
                           bool silent) {
  CHECK_NE(provider_type(), PROVIDER_NONE);

  if (async_id_ != kInvalidAsyncId) {
    // This instance was in use before, we have already emitted an init with
    // its previous async_id and need to emit a matching destroy for that
    // before generating a new async_id.
    EmitDestroy();
  }

  // Now we can assign a new async_id_ to this instance.
  async_id_ = execution_async_id == kInvalidAsyncId ? env()->new_async_id()
                                                     : execution_async_id;
  trigger_async_id_ = env()->get_default_trigger_async_id();

  switch (provider_type()) {
#define V(PROVIDER)                                                           \
    case PROVIDER_ ## PROVIDER:                                               \
      if (*TRACE_EVENT_API_GET_CATEGORY_GROUP_ENABLED(                        \
          TRACING_CATEGORY_NODE1(async_hooks))) {                             \
        auto data = tracing::TracedValue::Create();                           \
        data->SetInteger("executionAsyncId",                                  \
                         static_cast<int64_t>(env()->execution_async_id()));  \
        data->SetInteger("triggerAsyncId",                                    \
                         static_cast<int64_t>(get_trigger_async_id()));       \
        TRACE_EVENT_NESTABLE_ASYNC_BEGIN1(                                    \
          TRACING_CATEGORY_NODE1(async_hooks),                                \
          #PROVIDER, static_cast<int64_t>(get_async_id()),                    \
          "data", std::move(data));                                           \
        }                                                                     \
      break;
    NODE_ASYNC_PROVIDER_TYPES(V)
#undef V
    default:
      UNREACHABLE();
  }

  if (silent) return;

  EmitAsyncInit(env(), resource,
                env()->async_hooks()->provider_string(provider_type()),
                async_id_, trigger_async_id_);
}

// JAMLEE: 静态方法。 触发 Init 方法
void AsyncWrap::EmitAsyncInit(Environment* env,
                              Local<Object> object,
                              Local<String> type,
                              double async_id,
                              double trigger_async_id) {
  CHECK(!object.IsEmpty());
  CHECK(!type.IsEmpty());
  AsyncHooks* async_hooks = env->async_hooks();

  // Nothing to execute, so can continue normally.
  if (async_hooks->fields()[AsyncHooks::kInit] == 0) {
    return;
  }

  HandleScope scope(env->isolate());
  Local<Function> init_fn = env->async_hooks_init_function();

  Local<Value> argv[] = {
    Number::New(env->isolate(), async_id),
    type,
    Number::New(env->isolate(), trigger_async_id),
    object,
  };

  TryCatchScope try_catch(env, TryCatchScope::CatchMode::kFatal);
  USE(init_fn->Call(env->context(), object, arraysize(argv), argv));
}


MaybeLocal<Value> AsyncWrap::MakeCallback(const Local<Function> cb,
                                          int argc,
                                          Local<Value>* argv) {
  EmitTraceEventBefore();

  ProviderType provider = provider_type();
  async_context context { get_async_id(), get_trigger_async_id() };
  MaybeLocal<Value> ret = InternalMakeCallback(
      env(), object(), cb, argc, argv, context);

  // This is a static call with cached values because the `this` object may
  // no longer be alive at this point.
  EmitTraceEventAfter(provider, context.async_id);

  return ret;
}

// JAMLEE: 重写 MemoryRetainer 方法。
std::string AsyncWrap::MemoryInfoName() const {
  return provider_names[provider_type()];
}

std::string AsyncWrap::diagnostic_name() const {
  return MemoryInfoName() + " (" + std::to_string(env()->thread_id()) + ":" +
      std::to_string(static_cast<int64_t>(async_id_)) + ")";
}

Local<Object> AsyncWrap::GetOwner() {
  return GetOwner(env(), object());
}

Local<Object> AsyncWrap::GetOwner(Environment* env, Local<Object> obj) {
  EscapableHandleScope handle_scope(env->isolate());
  CHECK(!obj.IsEmpty());

  TryCatchScope ignore_exceptions(env);
  while (true) {
    Local<Value> owner;
    if (!obj->Get(env->context(),
                  env->owner_symbol()).ToLocal(&owner) ||
        !owner->IsObject()) {
      return handle_scope.Escape(obj);
    }

    obj = owner.As<Object>();
  }
}

}  // namespace node

NODE_MODULE_CONTEXT_AWARE_INTERNAL(async_wrap, node::AsyncWrap::Initialize)
