const { Readable } = require('stream');

class Counter extends Readable {
  constructor(opt) {
    super(opt);
    this._max = 3;
    this._index = 1;
  }

  _read() { // 异步函数
    const i = this._index++;
    if (i > this._max)
      this.push(null);
    else {
      // console.log(`是否是同步: ${this._readableState.sync}`);
      // this.push("hello world");
      process.nextTick(() => {
          console.log(`是否是同步: ${this._readableState.sync}`);
          this.push("hello world");
      })
    }
  }
}

let countStream = new Counter();
console.log(`当前模式: ${countStream.readableFlowing}`);
countStream.on('data', (chunk) => {
    console.log(chunk.toString('utf8'));
});