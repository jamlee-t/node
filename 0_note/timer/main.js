// 很重要的类 Timeout，setIntval 和 setTimeout 都是基于这个类
// const {
//     async_id_symbol,
//     Timeout,
//     decRefCount,
//     immediateInfoFields: {
//       kCount,
//       kRefCount
//     },
//     kRefed,
//     initAsyncResource,
//     getTimerDuration,
//     timerListMap,
//     timerListQueue,
//     immediateQueue,
//     active,
//     unrefActive
// } = require('internal/timers');


function Animal(name) {
  this.name = name;
}

Animal.prototype.showName = function() {
  console.log(this.name);
}

let cat = new Animal('cat');

setTimeout(cat.showName, 1000);
setTimeout(cat.showName.bind(cat), 1000);