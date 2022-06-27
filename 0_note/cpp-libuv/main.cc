// https://github.com/skypjack/uvw/blob/master/src/uvw/loop.h
// https://github.com/skypjack/uvw/blob/master/test/main.cpp

#include "loop.h"
#include "uv.h"

extern "C" {
#include <stdio.h>
#include <stdlib.h>
}

using namespace jam;

// JAMLEE: 暂时未调通
int main() {
    auto loop = Loop::getDefault();
    printf("Now quitting.\n");
    uv_run(loop.get(), UV_RUN_DEFAULT);
    uv_loop_close(loop.get());
    return 0;
}
