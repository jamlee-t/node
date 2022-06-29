#ifndef T_LOOP_H
#define T_LOOP_H

#include <chrono>
#include <functional>
#include <memory>
#include <type_traits>
#include <utility>
#include "uv.h"

namespace jam {

class Loop final {
  // it's private by default for class (and public for struct).
  using Deleter = void (*)(uv_loop_t*);

 public:
  static std::shared_ptr<Loop> getDefault();
  Loop(std::unique_ptr<uv_loop_t, Deleter> ptr) noexcept;

  // 监听TCP端口
  void TCPListen();
  void Run();

 private:
  std::unique_ptr<uv_loop_t, Deleter> loop;
};

}  // namespace jam

#endif  // T_LOOP_H
