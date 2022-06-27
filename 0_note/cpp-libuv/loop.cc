#include "loop.h"

namespace jam {

Loop::Loop(std::unique_ptr<uv_loop_t, Deleter> ptr) noexcept
    : loop{std::move(ptr)} {}

std::shared_ptr<Loop> Loop::getDefault() {
  static std::weak_ptr<Loop> ref;
  std::shared_ptr<Loop> loop;

  if (ref.expired()) {
    auto def = uv_default_loop();

    if (def) {
      auto ptr = std::unique_ptr<uv_loop_t, Deleter>(def, [](uv_loop_t*) {});
      loop = std::shared_ptr<Loop>{new Loop{std::move(ptr)}};
    }

    ref = loop;
  } else {
    loop = ref.lock();
  }

  return loop;
};

}  // namespace jam