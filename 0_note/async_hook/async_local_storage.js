// 新版才有
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