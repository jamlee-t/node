// https://github.com/skypjack/uvw/blob/master/src/uvw/loop.h
// https://github.com/skypjack/uvw/blob/master/test/main.cpp

#include "loop.h"
#include "uv.h"

extern "C" {
#include <stdio.h>
#include <stdlib.h>
}

using namespace jam;

// JAMLEE: 先创建 loop 然后，创建 tcp 相关的资源，最后执行run函数。
// https://github.com/skypjack/uvw/blob/master/test/main.cpp
// auto loop = uvw::Loop::getDefault();
// listen(*loop);
// conn(*loop);
// loop->run();
// loop = nullptr;

int main() {
  auto loop = Loop::getDefault();
  (*loop).TCPListen();
  return 0;
}
