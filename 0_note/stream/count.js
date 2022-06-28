const { Readable } = require('stream');

class Counter extends Readable {
  constructor(opt) {
    super(opt);
    this._max = 5;
    this._index = 1;
  }

  _read() { // 异步函数
    const i = this._index++;
    if (i > this._max)
      this.push(null);
    else {
        process.nextTick(() => {
            this.push("hello world");
        });
    }
  }
}

// 此时流处于 flowing == null 的状态。也就是 paused 模式。
let countStream = new Counter();
console.log(`当前模式: ${countStream.readableFlowing}`);

countStream.on('data', (chunk) => {
    console.log(chunk.toString('utf8'));
});
countStream.pause();
console.log(`当前模式: ${countStream.readableFlowing}`);
console.log(`流被暂停了: ${countStream._readableState.paused}`)

// countStream.on('readable', function() {
//     while (data = this.read()) {
//         console.log(data.toString('utf8'));
//     }
// });
// countStream.pause();
// console.log(`当前模式: ${countStream.readableFlowing}`);
