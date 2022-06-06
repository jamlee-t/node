var util = require('util');
var Readable = require('stream').Readable;

var MyStream = function(options) {
  Readable.call(this, options); // pass through the options to the Readable constructor
  this.counter = 1000;
};
util.inherits(MyStream, Readable); // inherit the prototype methods

MyStream.prototype._read = function(n) {
  setTimeout(() => this.push('hello world\n'), 5000);
  if (this.counter-- === 0) { // stop the stream
    this.push(null)
  }
};

// 设置两秒之后timeout
let mystream = new MyStream();
mystream.pipe(process.stdout);