// JAMLEE: https://yjhjstz.gitbooks.io/deep-into-node/content/chapter2/chapter2-2.html
// builtin module: Node 中以 c++ 形式提供的模块，如 tcp_wrap、contextify 等
// constants module: Node 中定义常量的模块，用来导出如 signal, openssl 库、文件访问权限等常量的定义。如文件访问权限中的 O_RDONLY，O_CREAT、signal 中的 SIGHUP，SIGINT 等。
// native module: Node 中以 JavaScript 形式提供的模块，如 http,https,fs 等。有些 native module 需要借助于 builtin module 实现背后的功能。如对于 native 模块 buffer , 还是需要借助 builtin node_buffer.cc 中提供的功能来实现大容量内存申请和管理，目的是能够脱离 V8 内存大小使用限制。
// 3rd-party module: 以上模块可以统称 Node 内建模块，除此之外为第三方模块，典型的如 express 模块。

// JAMLEE: https://www.infoq.cn/article/uutxdjclyty1qwtf0elg
// type
// 它决定当前 package.json 层级目录内文件遵循哪种规范，包含两种值，默认为 commonjs。
// commonjs: js 和 cjs 文件遵循 CommonJS 规范，mjs 文件遵循 ESM 规范
// module: js 和 mjs 文件遵循 ESM 规范，cjs 文件遵循 CommonJS 规范

// 是相对较老的特性，exports
// type 是相对较老的特性，exports 则是鲜有人知。
// 功能来自 proposal-pkg-exports 提案，以实验特性 --experimental-exports 加入 v12.7.0，于 v12.16.0 正式引入。具体时间线可以通过这个 PR 追溯。

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

const {
  JSON,
  Object,
  ObjectPrototype,
  Reflect,
  SafeMap,
  StringPrototype,
} = primordials;

const { NativeModule } = require('internal/bootstrap/loaders');
const {
  maybeCacheSourceMap,
  rekeySourceMap
} = require('internal/source_map/source_map_cache');
const { pathToFileURL, fileURLToPath, URL } = require('internal/url');
const { deprecate } = require('internal/util');
const vm = require('vm');
const assert = require('internal/assert');
const fs = require('fs');
const internalFS = require('internal/fs/utils');
const path = require('path');
const {
  internalModuleReadJSON,
  internalModuleStat
} = internalBinding('fs');
const { safeGetenv } = internalBinding('credentials');
const {
  makeRequireFunction,
  normalizeReferrerURL,
  stripBOM,
  stripShebang,
  loadNativeModule
} = require('internal/modules/cjs/helpers');
const { getOptionValue } = require('internal/options');
const enableSourceMaps = getOptionValue('--enable-source-maps');
const preserveSymlinks = getOptionValue('--preserve-symlinks');
const preserveSymlinksMain = getOptionValue('--preserve-symlinks-main');

// JAMLEE: 在2017年，Node.js 8.9.0发布了对ECMAScript模块的实验性支持。这种ECMAScript模块的支持是需要在后面加上--experimental-modules标识来运行。
const experimentalModules = getOptionValue('--experimental-modules');

// JAMLEE: --experimental-policy 标志可用于在加载模块时启用策略特性。
// 一旦设置好，则所有模块都必须符合传给标志的策略清单文件：
// node --experimental-policy=policy.json app.js
const manifest = getOptionValue('--experimental-policy') ?
  require('internal/process/policy').manifest :
  null;

const { compileFunction } = internalBinding('contextify');

const {
  ERR_INVALID_ARG_VALUE,
  ERR_INVALID_OPT_VALUE,
  ERR_REQUIRE_ESM
} = require('internal/errors').codes;
const { validateString } = require('internal/validators');
const pendingDeprecation = getOptionValue('--pending-deprecation');
const experimentalExports = getOptionValue('--experimental-exports');

module.exports = Module;

let asyncESM, ModuleJob, ModuleWrap, kInstantiated;

const {
  CHAR_FORWARD_SLASH,
  CHAR_BACKWARD_SLASH,
  CHAR_COLON
} = require('internal/constants');

const isWindows = process.platform === 'win32';

const relativeResolveCache = Object.create(null);

let requireDepth = 0;
let statCache = null;

function enrichCJSError(err) {
  const stack = err.stack.split('\n');

  const lineWithErr = stack[1];

  /*
    The regular expression below targets the most common import statement
    usage. However, some cases are not matching, cases like import statement
    after a comment block and/or after a variable definition.
  */
  if (err.message.startsWith('Unexpected token \'export\'') ||
    (/^\s*import(?=[ {'"*])\s*(?![ (])/).test(lineWithErr)) {
    process.emitWarning(
      'To load an ES module, set "type": "module" in the package.json or use ' +
      'the .mjs extension.',
      undefined,
      undefined,
      undefined,
      true);
  }
}

function stat(filename) {
  filename = path.toNamespacedPath(filename);
  if (statCache !== null) {
    const result = statCache.get(filename);
    if (result !== undefined) return result;
  }
  const result = internalModuleStat(filename);
  if (statCache !== null) statCache.set(filename, result);
  return result;
}

function updateChildren(parent, child, scan) {
  const children = parent && parent.children;
  if (children && !(scan && children.includes(child)))
    children.push(child);
}

///////////////////////////////////////////////////////////////////////////
//
// JAMLEE: 模块类
//
///////////////////////////////////////////////////////////////////////////
function Module(id = '', parent) {
  this.id = id;
  this.path = path.dirname(id);
  this.exports = {};
  this.parent = parent;
  updateChildren(parent, this, false);
  this.filename = null;
  this.loaded = false;
  this.children = [];
}

// JAMLEE: 用户可以加载的 C++ 模块
const builtinModules = [];
for (const [id, mod] of NativeModule.map) {
  if (mod.canBeRequiredByUsers) {
    builtinModules.push(id);
  }
}

Object.freeze(builtinModules);
Module.builtinModules = builtinModules;

Module._cache = Object.create(null);
Module._pathCache = Object.create(null);
Module._extensions = Object.create(null);
var modulePaths = [];
Module.globalPaths = [];

let patched = false;

// JAMLEE: 包装 1 个 JS 文件, 使得其成为 1 个函数。
// eslint-disable-next-line func-style
let wrap = function(script) {
  return Module.wrapper[0] + script + Module.wrapper[1];
};

// JAMLEE: 加载模块时的函数参数
const wrapper = [
  '(function (exports, require, module, __filename, __dirname) { ',
  '\n});'
];

let wrapperProxy = new Proxy(wrapper, {
  set(target, property, value, receiver) {
    patched = true;
    return Reflect.set(target, property, value, receiver);
  },

  defineProperty(target, property, descriptor) {
    patched = true;
    return Object.defineProperty(target, property, descriptor);
  }
});

// JAMLEE: Module.wrap 函数
Object.defineProperty(Module, 'wrap', {
  get() {
    return wrap;
  },

  set(value) {
    patched = true;
    wrap = value;
  }
});

Object.defineProperty(Module, 'wrapper', {
  get() {
    return wrapperProxy;
  },

  set(value) {
    patched = true;
    wrapperProxy = value;
  }
});

const debug = require('internal/util/debuglog').debuglog('module');
Module._debug = deprecate(debug, 'Module._debug is deprecated.', 'DEP0077');

// Given a module name, and a list of paths to test, returns the first
// matching file in the following precedence.
//
// require("a.<ext>")
//   -> a.<ext>
//
// require("a")
//   -> a
//   -> a.<ext>
//   -> a/index.<ext>

const packageJsonCache = new SafeMap();

// JAMLEE: 存在模块是文件夹的情况。requestPath 是 require("requestPath") 的参数。返回：
// filtered = {
//   main: parsed.main,
//   exports: parsed.exports,
//   type: parsed.type
// };

// let originalPath = "C:\\Windows\\users"; 
// console.log("Original Path:", originalPath); 
// let nameSpacedPath = path.toNamespacedPath(originalPath); 
// console.log("Namespaced Path:", nameSpacedPath);
// 得到:
// Original Path:C:\Windows\users
// Namespaced Path:\\?\C:\Windows\users
function readPackage(requestPath) {
  const jsonPath = path.resolve(requestPath, 'package.json');

  // 函数: The path.resolve() method resolves a sequence of paths or path segments into an absolute path.
  const existing = packageJsonCache.get(jsonPath);
  if (existing !== undefined) return existing;

  // 函数：path.toNamespacedPath, On Windows systems only, returns an equivalent namespace-prefixed path for the given path
  const json = internalModuleReadJSON(path.toNamespacedPath(jsonPath));
  if (json === undefined) {
    packageJsonCache.set(jsonPath, false);
    return false;
  }

  if (manifest) {
    const jsonURL = pathToFileURL(jsonPath);
    manifest.assertIntegrity(jsonURL, json);
  }

  // JSON 文件真的存在，返回 filtered。
  try {
    const parsed = JSON.parse(json);
    const filtered = {
      main: parsed.main,
      exports: parsed.exports,
      type: parsed.type
    };
    packageJsonCache.set(jsonPath, filtered);
    return filtered;
  } catch (e) {
    e.path = jsonPath;
    e.message = 'Error parsing ' + jsonPath + ': ' + e.message;
    throw e;
  }
}

function readPackageScope(checkPath) {
  const rootSeparatorIndex = checkPath.indexOf(path.sep);
  let separatorIndex;
  while (
    (separatorIndex = checkPath.lastIndexOf(path.sep)) > rootSeparatorIndex
  ) {
    checkPath = checkPath.slice(0, separatorIndex);
    if (checkPath.endsWith(path.sep + 'node_modules'))
      return false;
    const pjson = readPackage(checkPath);
    if (pjson) return {
      path: checkPath,
      data: pjson
    };
  }
  return false;
}

// JAMLEE: 获取模块的 package.json 中的 main 字段。
function readPackageMain(requestPath) {
  const pkg = readPackage(requestPath);
  return pkg ? pkg.main : undefined;
}

// JAMLEE: 获取模块的 package.json 中的 exports 字段。
function readPackageExports(requestPath) {
  const pkg = readPackage(requestPath);
  return pkg ? pkg.exports : undefined;
}

// JAMLEE: 尝试去读取文件夹组织的模块。返回这个模块是否真实存在。
function tryPackage(requestPath, exts, isMain, originalPath) {
  const pkg = readPackageMain(requestPath);

  // JAMLEE: 如果 package.json 没有定义 main 字段。尝试加载名字为 index，后缀不同的文件。
  // https://nodejs.org/docs/v12.13.1/api/modules.html#modules_all_together
  // 也就是 LOAD_INDEX。这个优先级比 pkg 低。
  if (!pkg) {
    return tryExtensions(path.resolve(requestPath, 'index'), exts, isMain);
  }

  // JAMLEE: package.json 中 main 字段定义的文件。最终都会调用 tryFile 得到 actual 变量。actual 表示当前模块是真实存在。
  const filename = path.resolve(requestPath, pkg);
  let actual = tryFile(filename, isMain) ||
    tryExtensions(filename, exts, isMain) ||
    tryExtensions(path.resolve(filename, 'index'), exts, isMain);
  if (actual === false) {
    actual = tryExtensions(path.resolve(requestPath, 'index'), exts, isMain);
    if (!actual) {
      // eslint-disable-next-line no-restricted-syntax
      const err = new Error(
        `Cannot find module '${filename}'. ` +
        'Please verify that the package.json has a valid "main" entry'
      );
      err.code = 'MODULE_NOT_FOUND';
      err.path = path.resolve(requestPath, 'package.json');
      err.requestPath = originalPath;
      // TODO(BridgeAR): Add the requireStack as well.
      throw err;
    } else if (pendingDeprecation) {
      const jsonPath = path.resolve(requestPath, 'package.json');
      process.emitWarning(
        `Invalid 'main' field in '${jsonPath}' of '${pkg}'. ` +
          'Please either fix that or report it to the module author',
        'DeprecationWarning',
        'DEP0128'
      );
    }
  }
  return actual;
}

// In order to minimize unnecessary lstat() calls,
// this cache is a list of known-real paths.
// Set to an empty Map to reset.
const realpathCache = new Map();

// JAMLEE: 文件组织的模块是否真实存在。返回 bool，表示是否可以加载
// Check if the file exists and is not a directory
// if using --preserve-symlinks and isMain is false,
// keep symlinks intact, otherwise resolve to the
// absolute realpath.
function tryFile(requestPath, isMain) {
  const rc = stat(requestPath);
  if (preserveSymlinks && !isMain) {
    return rc === 0 && path.resolve(requestPath);
  }
  return rc === 0 && toRealPath(requestPath);
}

// JAMLEE: 返回文件的绝对路径
function toRealPath(requestPath) {
  return fs.realpathSync(requestPath, {
    [internalFS.realpathCacheKey]: realpathCache
  });
}

// JAMLEE: 测试文件名+扩展名后是否是存在。
// Given a path, check if the file exists with any of the set extensions
function tryExtensions(p, exts, isMain) {
  for (var i = 0; i < exts.length; i++) {
    const filename = tryFile(p + exts[i], isMain);

    if (filename) {
      return filename;
    }
  }
  return false;
}

// JAMLEE: 查找最长匹配的
// Find the longest (possibly multi-dot) extension registered in
// Module._extensions
function findLongestRegisteredExtension(filename) {
  const name = path.basename(filename);
  let currentExtension;
  let index;
  let startIndex = 0;
  while ((index = name.indexOf('.', startIndex)) !== -1) {
    startIndex = index + 1;
    if (index === 0) continue; // Skip dotfiles like .gitignore
    currentExtension = name.slice(index);
    if (Module._extensions[currentExtension]) return currentExtension;
  }
  return '.js';
}

// path.resolve() 用法
// 1、不带参数时
// path.resolve() 返回的是当前的文件的绝对路径/Users/xxxx/
// 2、带不是/开头的参数
// path.resolve('a') 返回的是当前绝对路径拼接现在的参数/Users/xxxx/a
// path.resolve('a'，'b') 返回的是当前绝对路径拼接现在的参数/Users/xxxx/a/b
// 3、带./开头的参数
// path.resolve('./a') 返回的是当前绝对路径拼接现在的参数/Users/xxxx/a
// path.resolve('./a','./b') 返回的是当前绝对路径拼接现在的参数/Users/xxxx/a/b
// 4、带/开头的参数 返回的是 /+‘最后一个前面加/的文件文件名’+‘剩下文件夹
// path.resolve('/a') 返回的是当前绝对路径拼接现在的参数/a
// path.resolve('/a'，'/b') 返回的是当前绝对路径拼接现在的参数/b
// path.resolve('/a'，'/b', 'c') 返回的是当前绝对路径拼接现在的参数/b/c

// JAMLEE: 返回 node_modules中的模块路径。实验性质的 package.json 中的 exports 字段
// nmPath: node_modules 路径。
// This only applies to requests of a specific form:
// 1. name/.*
// 2. @scope/name/.*
const EXPORTS_PATTERN = /^((?:@[^/\\%]+\/)?[^./\\%][^/\\%]*)(\/.*)?$/;
function resolveExports(nmPath, request, absoluteRequest) {
  // The implementation's behavior is meant to mirror resolution in ESM.
  if (experimentalExports && !absoluteRequest) {
    const [, name, expansion = ''] =
      StringPrototype.match(request, EXPORTS_PATTERN) || [];
    if (!name) {
      return path.resolve(nmPath, request);
    }

    const basePath = path.resolve(nmPath, name);
    const pkgExports = readPackageExports(basePath);
    const mappingKey = `.${expansion}`;

    if (typeof pkgExports === 'object' && pkgExports !== null) {
      if (ObjectPrototype.hasOwnProperty(pkgExports, mappingKey)) {
        const mapping = pkgExports[mappingKey];
        return resolveExportsTarget(pathToFileURL(basePath + '/'), mapping, '',
                                    basePath, mappingKey);
      }

      let dirMatch = '';
      for (const candidateKey of Object.keys(pkgExports)) {
        if (candidateKey[candidateKey.length - 1] !== '/') continue;
        if (candidateKey.length > dirMatch.length &&
            StringPrototype.startsWith(mappingKey, candidateKey)) {
          dirMatch = candidateKey;
        }
      }

      if (dirMatch !== '') {
        const mapping = pkgExports[dirMatch];
        const subpath = StringPrototype.slice(mappingKey, dirMatch.length);
        return resolveExportsTarget(pathToFileURL(basePath + '/'), mapping,
                                    subpath, basePath, mappingKey);
      }
    }
    if (mappingKey === '.' && typeof pkgExports === 'string') {
      return resolveExportsTarget(pathToFileURL(basePath + '/'), pkgExports,
                                  '', basePath, mappingKey);
    }
    if (pkgExports != null) {
      // eslint-disable-next-line no-restricted-syntax
      const e = new Error(`Package exports for '${basePath}' do not define ` +
          `a '${mappingKey}' subpath`);
      e.code = 'MODULE_NOT_FOUND';
      throw e;
    }
  }

  return path.resolve(nmPath, request);
}

// JAMLEE: resolveExports -> resolveExportsTarget 仅仅用于这个 resolveExports 函数。
function resolveExportsTarget(pkgPath, target, subpath, basePath, mappingKey) {
  if (typeof target === 'string') {
    if (target.startsWith('./') &&
        (subpath.length === 0 || target.endsWith('/'))) {
      const resolvedTarget = new URL(target, pkgPath);
      const pkgPathPath = pkgPath.pathname;
      const resolvedTargetPath = resolvedTarget.pathname;
      if (StringPrototype.startsWith(resolvedTargetPath, pkgPathPath) &&
          StringPrototype.indexOf(resolvedTargetPath, '/node_modules/',
                                  pkgPathPath.length - 1) === -1) {
        const resolved = new URL(subpath, resolvedTarget);
        const resolvedPath = resolved.pathname;
        if (StringPrototype.startsWith(resolvedPath, resolvedTargetPath) &&
            StringPrototype.indexOf(resolvedPath, '/node_modules/',
                                    pkgPathPath.length - 1) === -1) {
          return fileURLToPath(resolved);
        }
      }
    }
  } else if (Array.isArray(target)) {
    for (const targetValue of target) {
      if (typeof targetValue !== 'string') continue;
      try {
        return resolveExportsTarget(pkgPath, targetValue, subpath, basePath,
                                    mappingKey);
      } catch (e) {
        if (e.code !== 'MODULE_NOT_FOUND') throw e;
      }
    }
  }
  // eslint-disable-next-line no-restricted-syntax
  const e = new Error(`Package exports for '${basePath}' do not define a ` +
      `valid '${mappingKey}' target${subpath ? 'for ' + subpath : ''}`);
  e.code = 'MODULE_NOT_FOUND';
  throw e;
}

// JAMLEE: 在路径中查找模块。paths 是数组，每个成员是模块路径。
// request: reuqire 中的值。
// 返回: false 或者模块的文件名
Module._findPath = function(request, paths, isMain) {
  const absoluteRequest = path.isAbsolute(request);
  if (absoluteRequest) {
    paths = [''];
  } else if (!paths || paths.length === 0) {
    return false;
  }

  // JAMLEE: 生成1个缓存key文件。如果缓存key已经存在，从缓存中读取。
  const cacheKey = request + '\x00' +
                (paths.length === 1 ? paths[0] : paths.join('\x00'));
  const entry = Module._pathCache[cacheKey];
  if (entry)
    return entry;

  // JAMLEE: 这里的匹配会是 thisis/test/.. 或者 thisis/test/. 中的 /.. 和 /. 如果是这样的尾部那么 trailingSlash 是 true
  // CHAR_FORWARD_SLASH: 47, /* / */
  var exts;
  var trailingSlash = request.length > 0 &&
    request.charCodeAt(request.length - 1) === CHAR_FORWARD_SLASH;
  if (!trailingSlash) {
    trailingSlash = /(?:^|\/)\.?\.$/.test(request);
  }

  debug("JAMLEE: Module._findPath, request %s", request);
  // For each path
  for (var i = 0; i < paths.length; i++) {
    // Don't search further if path doesn't exist
    const curPath = paths[i];
    if (curPath && stat(curPath) < 1) continue;
    // JAMLEE: curPath 是1个 node_modules 路径。request, absoluteRequest 是绝对路径和相对路径。
    // 返回: node_modules/request 得到基础路径。
    var basePath = resolveExports(curPath, request, absoluteRequest);
    var filename;

    debug("JAMLEE: Module._findPath, basePath", basePath);
    // JAMLEE: node_modules/request 的信息。这里可能是个文件。
    var rc = stat(basePath);
    if (!trailingSlash) { // JAMLEE: 尾部没有 slash 符号
      if (rc === 0) {  // File.
        if (!isMain) { // JAMLEE: 如果不是主模块（也就是 node test 中的 test）
          if (preserveSymlinks) {
            filename = path.resolve(basePath);
          } else {
            filename = toRealPath(basePath); // JAMLEE: 转换为真实路径。
          }
        } else if (preserveSymlinksMain) {
          // For the main module, we use the preserveSymlinksMain flag instead
          // mainly for backward compatibility, as the preserveSymlinks flag
          // historically has not applied to the main module.  Most likely this
          // was intended to keep .bin/ binaries working, as following those
          // symlinks is usually required for the imports in the corresponding
          // files to resolve; that said, in some use cases following symlinks
          // causes bigger problems which is why the preserveSymlinksMain option
          // is needed.
          filename = path.resolve(basePath);
        } else {
          filename = toRealPath(basePath);
        }
      }

      if (!filename) { // JAMLEE: 如果文件不存在，尝试使用后缀测试
        // Try it with each of the extensions
        if (exts === undefined)
          exts = Object.keys(Module._extensions);
        filename = tryExtensions(basePath, exts, isMain);
        debug("JAMLEE: Module._findPath, tryExtensions %s", filename);
      }
    }

    // JAMLEE: 例如: require("./hello/");
    if (!filename && rc === 1) {  // Directory.
      // try it with each of the extensions at "index"
      if (exts === undefined)
        exts = Object.keys(Module._extensions);
      filename = tryPackage(basePath, exts, isMain, request);
    }

    // JAMLEE: 如果文件名存在返回文件名。并在缓存中存储好文件名。
    if (filename) {
      Module._pathCache[cacheKey] = filename;
      return filename;
    }
  }
  return false;
};

// 'node_modules' character codes reversed
const nmChars = [ 115, 101, 108, 117, 100, 111, 109, 95, 101, 100, 111, 110 ];
const nmLen = nmChars.length;
if (isWindows) { // JAMLEE: Windows 主机，忽略
  // 'from' is the __dirname of the module.
  Module._nodeModulePaths = function(from) {
    // Guarantee that 'from' is absolute.
    from = path.resolve(from);

    // note: this approach *only* works when the path is guaranteed
    // to be absolute.  Doing a fully-edge-case-correct path.split
    // that works on both Windows and Posix is non-trivial.

    // return root node_modules when path is 'D:\\'.
    // path.resolve will make sure from.length >=3 in Windows.
    if (from.charCodeAt(from.length - 1) === CHAR_BACKWARD_SLASH &&
        from.charCodeAt(from.length - 2) === CHAR_COLON)
      return [from + 'node_modules'];

    const paths = [];
    var p = 0;
    var last = from.length;
    for (var i = from.length - 1; i >= 0; --i) {
      const code = from.charCodeAt(i);
      // The path segment separator check ('\' and '/') was used to get
      // node_modules path for every path segment.
      // Use colon as an extra condition since we can get node_modules
      // path for drive root like 'C:\node_modules' and don't need to
      // parse drive name.
      if (code === CHAR_BACKWARD_SLASH ||
          code === CHAR_FORWARD_SLASH ||
          code === CHAR_COLON) {
        if (p !== nmLen)
          paths.push(from.slice(0, last) + '\\node_modules');
        last = i;
        p = 0;
      } else if (p !== -1) {
        if (nmChars[p] === code) {
          ++p;
        } else {
          p = -1;
        }
      }
    }

    return paths;
  };
} else { // posix 
  // JAMLEE: Linux 和 Mac 只需要看这里。从某个目录开始解析，获取到所有需要查找的 node_modules 位置。
  // 例如： /home/jamlee/nodetest,会从 [/home/jamlee/nodetest/node_modules, /home/jamlee/node_modules, /home/node_modules, /node_modules]
  // 'from' is the __dirname of the module.
  Module._nodeModulePaths = function(from) {
    // Guarantee that 'from' is absolute.
    from = path.resolve(from);
    // Return early not only to avoid unnecessary work, but to *avoid* returning
    // an array of two items for a root: [ '//node_modules', '/node_modules' ]
    if (from === '/')
      return ['/node_modules'];

    // note: this approach *only* works when the path is guaranteed
    // to be absolute.  Doing a fully-edge-case-correct path.split
    // that works on both Windows and Posix is non-trivial.
    const paths = [];
    var p = 0;
    var last = from.length;
    for (var i = from.length - 1; i >= 0; --i) {
      const code = from.charCodeAt(i);
      if (code === CHAR_FORWARD_SLASH) {
        if (p !== nmLen)
          paths.push(from.slice(0, last) + '/node_modules');
        last = i;
        p = 0;
      } else if (p !== -1) {
        if (nmChars[p] === code) {
          ++p;
        } else {
          p = -1;
        }
      }
    }

    // Append /node_modules to handle root paths.
    paths.push('/node_modules');

    return paths;
  };
}

// JAMLEE: 返回 1 个数组。数组包含多个路径(node_modules的路径)。这些路径中用于搜寻模块。如果 request 以 . 或者 .. 起始, 那么只差当前目录了。
// null: 模块是 NativeModule。
// 数组: 模块可以从这些目录中查找。
Module._resolveLookupPaths = function(request, parent) {
  // JAMLEE: 如果模块可以被用户 require。不用查询路径了
  if (NativeModule.canBeRequiredByUsers(request)) {
    debug('looking for %j in []', request);
    return null;
  }

  // JAMLEE: request 不是以 . 开头; 或者 request 不是 ./ .. 开头的。说明从 modulePaths（node_modules 文件中） 中引入模块。
  // 那么 path 就直接在 当前目录中寻找就可以了。不需要查 node_modules
  // Check for node modules paths.
  if (request.charAt(0) !== '.' ||
      (request.length > 1 &&
      request.charAt(1) !== '.' &&
      request.charAt(1) !== '/' &&
      (!isWindows || request.charAt(1) !== '\\'))) {

    let paths = modulePaths;
    if (parent != null && parent.paths && parent.paths.length) {
      paths = parent.paths.concat(paths);
    }

    debug('looking for %j in %j', request, paths);
    return paths.length > 0 ? paths : null;
  }

  // JAMLEE: 从当前文件所在的位置解析文件名。且 parent 是空。从当前目录解析出来可以搜索的 node_module 路径。
  // 从文件位置解析的 node_modules，和系统指定的 node_modules。
  // With --eval, parent.id is not set and parent.filename is null.
  if (!parent || !parent.id || !parent.filename) {
    // Make require('./path/to/foo') work - normally the path is taken
    // from realpath(__filename) but with eval there is no filename
    const mainPaths = ['.'].concat(Module._nodeModulePaths('.'), modulePaths);

    debug('looking for %j in %j', request, mainPaths);
    return mainPaths;
  }

  debug('RELATIVE: requested: %s from parent.id %s', request, parent.id);

  const parentDir = [path.dirname(parent.filename)];
  debug('looking for %j', parentDir);
  return parentDir;
};

// JAMLEE: 加载模块。例如加载主模块（运行入口文件）时，参数为： process.argv[1], null, true
// Check the cache for the requested file.
// 1. If a module already exists in the cache: return its exports object.
// 2. If the module is native: call
//    `NativeModule.prototype.compileForPublicLoader()` and return the exports.
// 3. Otherwise, create a new module for the file and save it to the cache.
//    Then have it load  the file contents before returning its exports
//    object.
Module._load = function(request, parent, isMain) {
  let relResolveCacheIdentifier;
  if (parent) { // JAMLEE: 父级模块
    debug('Module._load REQUEST %s parent: %s', request, parent.id);
    // Fast path for (lazy loaded) modules in the same directory. The indirect
    // caching is required to allow cache invalidation without changing the old
    // cache key names.
    relResolveCacheIdentifier = `${parent.path}\x00${request}`;
    const filename = relativeResolveCache[relResolveCacheIdentifier];
    if (filename !== undefined) {
      const cachedModule = Module._cache[filename];
      if (cachedModule !== undefined) {
        updateChildren(parent, cachedModule, true);
        return cachedModule.exports;
      }
      delete relativeResolveCache[relResolveCacheIdentifier];
    }
  }

  // JAMLEE: 运行文件时，解析模块对应的文件，isMain = true。options 参数直接没有传入。
  // Module._resolveFilename("/root/code/node/0_note/modules/test01", parent, isMain)
  const filename = Module._resolveFilename(request, parent, isMain);

  debug("JAMLEE: filename %s, request %s, isMain %s, parent %s", filename, request, isMain, parent);

  // JAMLEE: 如果模块在 cache 中，直接返回 cachedModule.exports
  const cachedModule = Module._cache[filename];
  if (cachedModule !== undefined) {
    updateChildren(parent, cachedModule, true);
    return cachedModule.exports;
  }

  // JAMLEE: 否则 loadNativeModule。如果模块存在且模块可以被用户引用，那么直接返回 mod.exports
  const mod = loadNativeModule(filename, request, experimentalModules);
  if (mod && mod.canBeRequiredByUsers) return mod.exports;

  // JAMLEE: 创建新模块。新模块在后面加载，加载也就是编译 js 文件。
  // Don't call updateChildren(), Module constructor already does.
  const module = new Module(filename, parent);

  // 如果模块是 main, id 直接为 .
  if (isMain) {
    process.mainModule = module;
    module.id = '.';
  }

  Module._cache[filename] = module;
  if (parent !== undefined) {
    relativeResolveCache[relResolveCacheIdentifier] = filename;
  }

  let threw = true;
  try {
    // Intercept exceptions that occur during the first tick and rekey them
    // on error instance rather than module instance (which will immediately be
    // garbage collected).
    if (enableSourceMaps) {
      try {
        module.load(filename); // JAMLEE: 加载 filename 对应的 js 文件。也就是编译
      } catch (err) {
        rekeySourceMap(Module._cache[filename], err);
        throw err; /* node-do-not-add-exception-line */
      }
    } else {
      module.load(filename);
    }
    threw = false;
  } finally {
    if (threw) {
      delete Module._cache[filename];
      if (parent !== undefined) {
        delete relativeResolveCache[relResolveCacheIdentifier];
      }
    }
  }

  return module.exports; // 返回 module 的 exports 对象
};

// JAMLEE: 根据传入的参数解析出正确的文件名，request 例如: test.js test test.json test.node 等等。
Module._resolveFilename = function(request, parent, isMain, options) {
  // JAMLEE: 如果 request 是可以被用户 require 的模块。直接返回模块名。
  if (NativeModule.canBeRequiredByUsers(request)) {
    return request;
  }

  var paths;

  // JAMLEE: 1. runMain 时，options 参数直接没有传入
  if (typeof options === 'object' && options !== null) {
    if (Array.isArray(options.paths)) {
      const isRelative = request.startsWith('./') ||
          request.startsWith('../') ||
          ((isWindows && request.startsWith('.\\')) ||
          request.startsWith('..\\'));

      if (isRelative) {
        paths = options.paths;
      } else {
        const fakeParent = new Module('', null);

        paths = [];

        for (var i = 0; i < options.paths.length; i++) {
          const path = options.paths[i];
          fakeParent.paths = Module._nodeModulePaths(path);
          const lookupPaths = Module._resolveLookupPaths(request, fakeParent);

          for (var j = 0; j < lookupPaths.length; j++) {
            if (!paths.includes(lookupPaths[j]))
              paths.push(lookupPaths[j]);
          }
        }
      }
    } else if (options.paths === undefined) {
      paths = Module._resolveLookupPaths(request, parent);
    } else {
      throw new ERR_INVALID_OPT_VALUE('options.paths', options.paths);
    }
  } else {
    paths = Module._resolveLookupPaths(request, parent);
    debug("JAMLEE: paths %s", paths);
  }

  // JAMLEE: 在 paths 中查找模块。paths 是 1个数组。运行文件时（node test01），isMain 是 true。
  // Look up the filename first, since that's the cache key.
  const filename = Module._findPath(request, paths, isMain);
  debug("JAMLEE: Module._findPath return filename %s", filename);
  if (!filename) { // JAMLEE: 如果 filename 是 false 意味着，在模块路径中找不到
    const requireStack = [];
    for (var cursor = parent;
      cursor;
      cursor = cursor.parent) {
      requireStack.push(cursor.filename || cursor.id);
    }
    let message = `Cannot find module '${request}'`;
    if (requireStack.length > 0) {
      message = message + '\nRequire stack:\n- ' + requireStack.join('\n- ');
    }
    // eslint-disable-next-line no-restricted-syntax
    var err = new Error(message);
    err.code = 'MODULE_NOT_FOUND';
    err.requireStack = requireStack;
    throw err;
  }
  return filename;
};

// JAMLEE: 加载模块。
// Given a file name, pass it to the proper extension handler.
Module.prototype.load = function(filename) {
  debug('load %j for module %j', filename, this.id);

  assert(!this.loaded);
  this.filename = filename;
  // JAMLEE: 找到所有可以加载模块的 node_modules 位置。
  this.paths = Module._nodeModulePaths(path.dirname(filename));

  // JAMLEE: 所谓加载函数，也就是编译函数了。
  const extension = findLongestRegisteredExtension(filename);
  Module._extensions[extension](this, filename);
  this.loaded = true;

  if (experimentalModules) {
    const ESMLoader = asyncESM.ESMLoader;
    const url = `${pathToFileURL(filename)}`;
    const module = ESMLoader.moduleMap.get(url);
    // Create module entry at load time to snapshot exports correctly
    const exports = this.exports;
    // Called from cjs translator
    if (module !== undefined && module.module !== undefined) {
      if (module.module.getStatus() >= kInstantiated)
        module.module.setExport('default', exports);
    } else { // preemptively cache
      ESMLoader.moduleMap.set(
        url,
        new ModuleJob(ESMLoader, url, () =>
          new ModuleWrap(function() {
            this.setExport('default', exports);
          }, ['default'], url)
        )
      );
    }
  }
};


// JAMLEE: require 函数。
// Loads a module at the given file path. Returns that module's
// `exports` property.
Module.prototype.require = function(id) {
  validateString(id, 'id');
  if (id === '') {
    throw new ERR_INVALID_ARG_VALUE('id', id,
                                    'must be a non-empty string');
  }
  requireDepth++;
  try {
    return Module._load(id, this, /* isMain */ false);
  } finally {
    requireDepth--;
  }
};


// Resolved path to process.argv[1] will be lazily placed here
// (needed for setting breakpoint when called with --inspect-brk)
var resolvedArgv;
let hasPausedEntry = false;

// JAMLEE: 核心编译 JS 程序。
// Run the file contents in the correct scope or sandbox. Expose
// the correct helper variables (require, module, exports) to
// the file.
// Returns exception, if any.
Module.prototype._compile = function(content, filename) {
  let moduleURL;
  let redirects;
  if (manifest) {
    moduleURL = pathToFileURL(filename);
    redirects = manifest.getRedirector(moduleURL);
    manifest.assertIntegrity(moduleURL, content);
  }

  content = stripShebang(content);
  maybeCacheSourceMap(filename, content, this);

  let compiledWrapper;
  if (patched) {
    const wrapper = Module.wrap(content); // JAMLEE: 这里添加了函数参数。wrapper 是包装了js文件内容的函数。
    compiledWrapper = vm.runInThisContext(wrapper, {
      filename,
      lineOffset: 0,
      displayErrors: true,
      importModuleDynamically: experimentalModules ? async (specifier) => {
        const loader = await asyncESM.loaderPromise;
        return loader.import(specifier, normalizeReferrerURL(filename));
      } : undefined,
    });
  } else {
    let compiled;
    try {
      // JAMLEE: 给JS文件编译成函数时，设置了参数。
      compiled = compileFunction(
        content,
        filename,
        0,
        0,
        undefined,
        false,
        undefined,
        [],
        [
          'exports',
          'require',
          'module',
          '__filename',
          '__dirname',
        ]
      );
    } catch (err) {
      if (experimentalModules) {
        enrichCJSError(err);
      }
      throw err;
    }

    if (experimentalModules) {
      const { callbackMap } = internalBinding('module_wrap');
      callbackMap.set(compiled.cacheKey, {
        importModuleDynamically: async (specifier) => {
          const loader = await asyncESM.loaderPromise;
          return loader.import(specifier, normalizeReferrerURL(filename));
        }
      });
    }
    compiledWrapper = compiled.function;
  }

  var inspectorWrapper = null;
  if (getOptionValue('--inspect-brk') && process._eval == null) {
    if (!resolvedArgv) {
      // We enter the repl if we're not given a filename argument.
      if (process.argv[1]) {
        resolvedArgv = Module._resolveFilename(process.argv[1], null, false);
      } else {
        resolvedArgv = 'repl';
      }
    }

    // Set breakpoint on module start
    if (!hasPausedEntry && filename === resolvedArgv) {
      hasPausedEntry = true;
      inspectorWrapper = internalBinding('inspector').callAndPauseOnStart;
    }
  }
  const dirname = path.dirname(filename);
  // JAMLEE: cjs 的 require 函数。
  const require = makeRequireFunction(this, redirects);
  var result;
  const exports = this.exports;
  const thisValue = exports;
  const module = this; // JAMLEE: 有个 module 对象，代表模块当前本身。
  if (requireDepth === 0) statCache = new Map();
  if (inspectorWrapper) {
    result = inspectorWrapper(compiledWrapper, thisValue, exports,
                              require, module, filename, dirname);
  } else {
    result = compiledWrapper.call(thisValue, exports, require, module,
                                  filename, dirname);
  }
  if (requireDepth === 0) statCache = null;

  // JAMLEE: 得到最终 js 文件执行的结果
  return result;
};

// JAMLEE: .js 后缀模块的加载。
// Native extension for .js
let warnRequireESM = true;
Module._extensions['.js'] = function(module, filename) {
  if (filename.endsWith('.js')) {
    const pkg = readPackageScope(filename);
    if (pkg && pkg.data && pkg.data.type === 'module') {
      if (warnRequireESM) {
        const parentPath = module.parent && module.parent.filename;
        const basename = parentPath &&
            path.basename(filename) === path.basename(parentPath) ?
          filename : path.basename(filename);
        process.emitWarning(
          'require() of ES modules is not supported.\nrequire() of ' +
          `${filename} ${parentPath ? `from ${module.parent.filename} ` : ''}` +
          'is an ES module file as it is a .js file whose nearest parent ' +
          'package.json contains "type": "module" which defines all .js ' +
          'files in that package scope as ES modules.\nInstead rename ' +
          `${basename} to end in .cjs, change the requiring code to use ` +
          'import(), or remove "type": "module" from ' +
          `${path.resolve(pkg.path, 'package.json')}.`
        );
        warnRequireESM = false;
      }
      if (experimentalModules) {
        throw new ERR_REQUIRE_ESM(filename);
      }
    }
  }
  const content = fs.readFileSync(filename, 'utf8');
  module._compile(stripBOM(content), filename);
};


// JAMLEE: .json 后缀模块的加载。
// Native extension for .json
Module._extensions['.json'] = function(module, filename) {
  const content = fs.readFileSync(filename, 'utf8');

  if (manifest) {
    const moduleURL = pathToFileURL(filename);
    manifest.assertIntegrity(moduleURL, content);
  }

  try {
    module.exports = JSON.parse(stripBOM(content));
  } catch (err) {
    err.message = filename + ': ' + err.message;
    throw err;
  }
};

// JAMLEE: .node 后缀模块的加载。
// Native extension for .node
Module._extensions['.node'] = function(module, filename) {
  if (manifest) {
    const content = fs.readFileSync(filename);
    const moduleURL = pathToFileURL(filename);
    manifest.assertIntegrity(moduleURL, content);
  }
  // Be aware this doesn't use `content`
  return process.dlopen(module, path.toNamespacedPath(filename));
};

Module._extensions['.mjs'] = function(module, filename) {
  throw new ERR_REQUIRE_ESM(filename);
};

// JAMLEE: 启动主模块, 也就是用户指定给node程序的入口 js 文件。这里入口文件 process.argv[1] 是绝对路径。
// 例如 ../../out/Debug/node  test01
// Module._load("/root/code/node/0_note/modules/test01", null, true);
// Bootstrap main module.
Module.runMain = function() {
  // Load the main module--the command line argument.
  if (experimentalModules) {
    asyncESM.loaderPromise.then((loader) => {
      return loader.import(pathToFileURL(process.argv[1]).href);
    })
    .catch((e) => {
      internalBinding('errors').triggerUncaughtException(
        e,
        true /* fromPromise */
      );
    });
    return;
  }
  debug("JAMLEE: module._load %s", process.argv[1]);
  Module._load(process.argv[1], null, true);
};

function createRequireFromPath(filename) {
  // Allow a directory to be passed as the filename
  const trailingSlash =
    filename.endsWith('/') || (isWindows && filename.endsWith('\\'));

  const proxyPath = trailingSlash ?
    path.join(filename, 'noop.js') :
    filename;

  const m = new Module(proxyPath);
  m.filename = proxyPath;

  m.paths = Module._nodeModulePaths(m.path);
  return makeRequireFunction(m, null);
}

Module.createRequireFromPath = createRequireFromPath;

const createRequireError = 'must be a file URL object, file URL string, or ' +
  'absolute path string';

function createRequire(filename) {
  let filepath;

  if (filename instanceof URL ||
      (typeof filename === 'string' && !path.isAbsolute(filename))) {
    try {
      filepath = fileURLToPath(filename);
    } catch {
      throw new ERR_INVALID_ARG_VALUE('filename', filename,
                                      createRequireError);
    }
  } else if (typeof filename !== 'string') {
    throw new ERR_INVALID_ARG_VALUE('filename', filename, createRequireError);
  } else {
    filepath = filename;
  }
  return createRequireFromPath(filepath);
}

Module.createRequire = createRequire;

// JAMLEE: 多个 node_module，可以查询的目录
Module._initPaths = function() {
  // JAMLEE: 用户目录和NODE_PATH文件夹路径。兼容 Windows
  var homeDir;
  var nodePath;
  if (isWindows) {
    homeDir = process.env.USERPROFILE;
    nodePath = process.env.NODE_PATH;
  } else {
    homeDir = safeGetenv('HOME');
    nodePath = safeGetenv('NODE_PATH');
  }

  // JAMLEE: prefixDir 是 node.js 的安装目录
  // $PREFIX/lib/node, where $PREFIX is the root of the Node.js installation.
  var prefixDir;
  // process.execPath is $PREFIX/bin/node except on Windows where it is
  // $PREFIX\node.exe.
  if (isWindows) {
    prefixDir = path.resolve(process.execPath, '..');
  } else {
    prefixDir = path.resolve(process.execPath, '..', '..'); // JAMLEE: 根据 node 二进制的位置得到安装目录
  }
  var paths = [path.resolve(prefixDir, 'lib', 'node')];

  if (homeDir) {
    paths.unshift(path.resolve(homeDir, '.node_libraries'));
    paths.unshift(path.resolve(homeDir, '.node_modules'));
  }

  // windows 是指 ; linux 是指 :
  // console.log(process.env.PATH);
  // Prints: '/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin'
  // process.env.PATH.split(path.delimiter);
  // Returns: ['/usr/bin', '/bin', '/usr/sbin', '/sbin', '/usr/local/bin']
  if (nodePath) {
    paths = nodePath.split(path.delimiter).filter(function pathsFilterCB(path) {
      return !!path;
    }).concat(paths);
  }

  // JAMLEE: ["$prefixDir/lib/node", "$HOME/.node_libraries", "$HOME/.node_modules", "$nodePath...."]
  modulePaths = paths;

  // Clone as a shallow copy, for introspection.
  Module.globalPaths = modulePaths.slice(0);
};

// JAMLEE: 需要预先加载的模块
Module._preloadModules = function(requests) {
  if (!Array.isArray(requests))
    return;

  // Preloaded modules have a dummy parent module which is deemed to exist
  // in the current working directory. This seeds the search path for
  // preloaded modules.
  const parent = new Module('internal/preload', null);
  try {
    parent.paths = Module._nodeModulePaths(process.cwd());
  } catch (e) {
    if (e.code !== 'ENOENT') {
      throw e;
    }
  }
  for (var n = 0; n < requests.length; n++)
    parent.require(requests[n]);
};

Module.syncBuiltinESMExports = function syncBuiltinESMExports() {
  for (const mod of NativeModule.map.values()) {
    if (mod.canBeRequiredByUsers) {
      mod.syncExports();
    }
  }
};

// Backwards compatibility
Module.Module = Module;

// We have to load the esm things after module.exports!
if (experimentalModules) {
  asyncESM = require('internal/process/esm_loader');
  ModuleJob = require('internal/modules/esm/module_job');
  ({ ModuleWrap, kInstantiated } = internalBinding('module_wrap'));
}
