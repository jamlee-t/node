#include "node_native_module.h"
#include "util-inl.h"

namespace node {
namespace native_module {

using v8::Context;
using v8::EscapableHandleScope;
using v8::Function;
using v8::HandleScope;
using v8::Integer;
using v8::Isolate;
using v8::Local;
using v8::Maybe;
using v8::MaybeLocal;
using v8::Object;
using v8::Script;
using v8::ScriptCompiler;
using v8::ScriptOrigin;
using v8::String;

// JAMLEE: 全局变量 instance_ 
NativeModuleLoader NativeModuleLoader::instance_;

NativeModuleLoader::NativeModuleLoader() : config_(GetConfig()) {
  // JAMLEE: js 源码编译成了字符串编译到了 _source 中
  LoadJavaScriptSource();
}

// JAMLEE: 静态变量，获取实例（单例模式）
NativeModuleLoader* NativeModuleLoader::GetInstance() {
  return &instance_;
}

bool NativeModuleLoader::Exists(const char* id) {
  return source_.find(id) != source_.end();
}

Local<Object> NativeModuleLoader::GetSourceObject(Local<Context> context) {
  Isolate* isolate = context->GetIsolate();
  Local<Object> out = Object::New(isolate);
  for (auto const& x : source_) {
    Local<String> key = OneByteString(isolate, x.first.c_str(), x.first.size());
    out->Set(context, key, x.second.ToStringChecked(isolate)).FromJust();
  }
  return out;
}

Local<String> NativeModuleLoader::GetConfigString(Isolate* isolate) {
  return config_.ToStringChecked(isolate);
}

// JAMLEE: 获取 moduleids。
std::vector<std::string> NativeModuleLoader::GetModuleIds() {
  std::vector<std::string> ids;
  ids.reserve(source_.size());
  for (auto const& x : source_) {
    ids.emplace_back(x.first);
  }
  return ids;
}

void NativeModuleLoader::InitializeModuleCategories() {
  if (module_categories_.is_initialized) {
    DCHECK(!module_categories_.can_be_required.empty());
    return;
  }

  std::vector<std::string> prefixes = {
#if !HAVE_OPENSSL
    "internal/crypto/",
#endif  // !HAVE_OPENSSL

    "internal/bootstrap/",
    "internal/per_context/",
    "internal/deps/",
    "internal/main/"
  };

  // 不能被 require 的模块 id 前缀
  module_categories_.cannot_be_required = std::set<std::string> {
#if !HAVE_INSPECTOR
      "inspector",
      "internal/util/inspector",
#endif  // !HAVE_INSPECTOR

#if !NODE_USE_V8_PLATFORM || !defined(NODE_HAVE_I18N_SUPPORT)
      "trace_events",
#endif  // !NODE_USE_V8_PLATFORM

#if !HAVE_OPENSSL
      "crypto",
      "https",
      "http2",
      "tls",
      "_tls_common",
      "_tls_wrap",
      "internal/http2/core",
      "internal/http2/compat",
      "internal/policy/manifest",
      "internal/process/policy",
      "internal/streams/lazy_transform",
#endif  // !HAVE_OPENSSL

      "sys",  // Deprecated.
      "internal/test/binding",
      "internal/v8_prof_polyfill",
      "internal/v8_prof_processor",
  };

  for (auto const& x : source_) {
    const std::string& id = x.first;
    for (auto const& prefix : prefixes) {
      if (prefix.length() > id.length()) {
        continue;
      }
      if (id.find(prefix) == 0) {
        module_categories_.cannot_be_required.emplace(id);
      }
    }
  }

  for (auto const& x : source_) {
    const std::string& id = x.first;
    if (0 == module_categories_.cannot_be_required.count(id)) {
      module_categories_.can_be_required.emplace(id);
    }
  }

  module_categories_.is_initialized = true;
}

// JAMLEE: 获取不能被 require 的模块 id，是个字符串数组。
const std::set<std::string>& NativeModuleLoader::GetCannotBeRequired() {
  InitializeModuleCategories();
  return module_categories_.cannot_be_required;
}

// JAMLEE: 获取能被 require 的模块 id，是个字符串数组。
const std::set<std::string>& NativeModuleLoader::GetCanBeRequired() {
  InitializeModuleCategories();
  return module_categories_.can_be_required;
}

// JAMLEE: 判断该模块是否能够被 require
bool NativeModuleLoader::CanBeRequired(const char* id) {
  return GetCanBeRequired().count(id) == 1;
}

// JAMLEE: 判断该模块是否是不能够被 require
bool NativeModuleLoader::CannotBeRequired(const char* id) {
  return GetCannotBeRequired().count(id) == 1;
}

NativeModuleCacheMap* NativeModuleLoader::code_cache() {
  return &code_cache_;
}

ScriptCompiler::CachedData* NativeModuleLoader::GetCodeCache(
    const char* id) const {
  Mutex::ScopedLock lock(code_cache_mutex_);
  const auto it = code_cache_.find(id);
  if (it == code_cache_.end()) {
    // The module has not been compiled before.
    return nullptr;
  }
  return it->second.get();
}

MaybeLocal<Function> NativeModuleLoader::CompileAsModule(
    Local<Context> context,
    const char* id,
    NativeModuleLoader::Result* result) {
  Isolate* isolate = context->GetIsolate();
  std::vector<Local<String>> parameters = {
      FIXED_ONE_BYTE_STRING(isolate, "exports"),
      FIXED_ONE_BYTE_STRING(isolate, "require"),
      FIXED_ONE_BYTE_STRING(isolate, "module"),
      FIXED_ONE_BYTE_STRING(isolate, "process"),
      FIXED_ONE_BYTE_STRING(isolate, "internalBinding"),
      FIXED_ONE_BYTE_STRING(isolate, "primordials")};
  return LookupAndCompile(context, id, &parameters, result);
}

//////////////////////////////////////////////////////////////////////////
//
// JAMLEE: 静态方法。将 JS 文件编译为 1 个函数。这里会有编译缓存可以使用。
//
//////////////////////////////////////////////////////////////////////////
// Returns Local<Function> of the compiled module if return_code_cache
// is false (we are only compiling the function).
// Otherwise return a Local<Object> containing the cache.
MaybeLocal<Function> NativeModuleLoader::LookupAndCompile(
    Local<Context> context,
    const char* id,
    std::vector<Local<String>>* parameters,
    NativeModuleLoader::Result* result) {
  Isolate* isolate = context->GetIsolate();
  EscapableHandleScope scope(isolate);

  // 从 source 中查询 id。source 是 NativeModuleRecordMap 类对象，也就是 std::map<std::string, UnionBytes>
  const auto source_it = source_.find(id);
  CHECK_NE(source_it, source_.end());
  Local<String> source = source_it->second.ToStringChecked(isolate);

  // id 后面添加 .js 后缀
  std::string filename_s = id + std::string(".js");
  Local<String> filename =
      OneByteString(isolate, filename_s.c_str(), filename_s.size());
  Local<Integer> line_offset = Integer::New(isolate, 0);
  Local<Integer> column_offset = Integer::New(isolate, 0);

  // 脚本源？说明这个脚本来自哪里。
  ScriptOrigin origin(filename, line_offset, column_offset, True(isolate));

  Mutex::ScopedLock lock(code_cache_mutex_);

  ScriptCompiler::CachedData* cached_data = nullptr;
  {
    auto cache_it = code_cache_.find(id);
    if (cache_it != code_cache_.end()) {
      // Transfer ownership to ScriptCompiler::Source later.
      cached_data = cache_it->second.release();
      code_cache_.erase(cache_it);
    }
  }

  const bool has_cache = cached_data != nullptr;
  ScriptCompiler::CompileOptions options =
      has_cache ? ScriptCompiler::kConsumeCodeCache
                : ScriptCompiler::kEagerCompile;
  ScriptCompiler::Source script_source(source, origin, cached_data);

  // ScriptCompiler::CompileFunctionInContext 是调用 v8 的函数编译出 1 个函数（指定 context）。
  MaybeLocal<Function> maybe_fun =
      ScriptCompiler::CompileFunctionInContext(context,
                                               &script_source,
                                               parameters->size(),
                                               parameters->data(),
                                               0,
                                               nullptr,
                                               options);

  // This could fail when there are early errors in the native modules,
  // e.g. the syntax errors
  if (maybe_fun.IsEmpty()) {
    // In the case of early errors, v8 is already capable of
    // decorating the stack for us - note that we use CompileFunctionInContext
    // so there is no need to worry about wrappers.
    return MaybeLocal<Function>();
  }

  Local<Function> fun = maybe_fun.ToLocalChecked();
  // XXX(joyeecheung): this bookkeeping is not exactly accurate because
  // it only starts after the Environment is created, so the per_context.js
  // will never be in any of these two sets, but the two sets are only for
  // testing anyway.

  *result = (has_cache && !script_source.GetCachedData()->rejected)
                ? Result::kWithCache
                : Result::kWithoutCache;
  // Generate new cache for next compilation
  std::unique_ptr<ScriptCompiler::CachedData> new_cached_data(
      ScriptCompiler::CreateCodeCacheForFunction(fun));
  CHECK_NOT_NULL(new_cached_data);

  // The old entry should've been erased by now so we can just emplace
  code_cache_.emplace(id, std::move(new_cached_data));

  return scope.Escape(fun);
}

}  // namespace native_module
}  // namespace node
