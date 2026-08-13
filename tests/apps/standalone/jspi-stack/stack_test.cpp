// jspi-stack — shadow-stack red/green harness (emscripten #27364).
//
// JSPI switches the NATIVE wasm stack per promising activation, but the C/C++
// linear-memory spill stack (__stack_pointer) is shared module state. Two
// concurrently-suspended activations therefore interleave their spill frames
// in one region, and a completed activation's epilogue resets __stack_pointer
// over a still-suspended activation's live frames. This harness makes that
// corruption OBSERVABLE (red leg) and proves a mitigation closes it (green
// leg). Mitigation policy lives entirely in the JS driver so the same binary
// serves both legs; see driver.mjs.
//
// Wx-free and libcontext-free on purpose: a failure here can only be the
// primitive (the sched-context doctrine).

#include <emscripten.h>
#include <emscripten/em_js.h>
#include <emscripten/stack.h>
#include <cstdint>
#include <cstdio>

// The suspend point. Under -sJSPI every EM_ASYNC_JS import is wrapped in
// WebAssembly.Suspending automatically. The driver resolves gates by id, in
// whatever order the scenario prescribes.
EM_ASYNC_JS(int, js_gate, (int id), {
  return await globalThis.__jspiGate(id);
});

namespace {

// Per-frame canary: value depends on activation id, recursion depth, and slot,
// so a frame overwritten by ANY other frame (same or different activation)
// cannot verify.
inline uint32_t canary(int id, int depth, int slot) {
  return 0x9E3779B9u * (uint32_t)(id * 1000003 + depth * 8191 + slot + 1);
}

constexpr int SLOTS = 64; // 256 B of spill payload per frame

// Recurse to `depth`, stamping canaries into a stack buffer at every level;
// suspend at the bottom; verify every frame's canaries on the way back up.
// The buffer is spilled to the shadow stack (address taken via the volatile
// pointer, so it cannot live in registers/locals only). noinline keeps one
// real spill frame per recursion level.
__attribute__((noinline))
int canary_frame(int id, int depth) {
  uint32_t buf[SLOTS];
  volatile uint32_t* p = buf;
  for (int i = 0; i < SLOTS; i++) p[i] = canary(id, depth, i);

  int corrupt = 0;
  if (depth > 0) {
    corrupt = canary_frame(id, depth - 1);
  } else {
    js_gate(id); // park this activation; driver decides when it wakes
  }

  for (int i = 0; i < SLOTS; i++) {
    if (p[i] != canary(id, depth, i)) corrupt++;
  }
  return corrupt;
}

} // namespace

extern "C" {

// A promising activation (must be in JSPI_EXPORTS): recurse `depth` frames,
// suspend at the bottom, return the number of corrupted canary words observed
// while unwinding. 0 == clean.
EMSCRIPTEN_KEEPALIVE
int activation(int id, int depth) {
  return canary_frame(id, depth);
}

// Plain (non-promising) export: deep central-stack work that scribbles its own
// frames. This is the "other wasm work" that grows down over a suspended
// activation's live frames once another activation's epilogue reset the SP.
EMSCRIPTEN_KEEPALIVE
__attribute__((noinline))
int stomp(int depth) {
  uint32_t buf[SLOTS];
  volatile uint32_t* p = buf;
  for (int i = 0; i < SLOTS; i++) p[i] = 0xDEADBEEFu;
  int acc = (int)p[depth % SLOTS];
  if (depth > 0) acc ^= stomp(depth - 1);
  return acc;
}

// Introspection for the driver's mitigation bookkeeping.
EMSCRIPTEN_KEEPALIVE uintptr_t stack_current(void) { return emscripten_stack_get_current(); }
EMSCRIPTEN_KEEPALIVE uintptr_t stack_base(void)    { return emscripten_stack_get_base(); }
EMSCRIPTEN_KEEPALIVE uintptr_t stack_end(void)     { return emscripten_stack_get_end(); }

} // extern "C"

#ifdef __EMSCRIPTEN_PTHREADS__
// Production shape: worker threads never suspend, but they churn the shared
// allocator while main-thread activations sit suspended. The churn thread
// must not perturb suspended activations' spill frames.
#include <atomic>
#include <thread>
#include <cstdlib>

namespace {
std::atomic<bool> g_churn{false};
std::thread g_churn_thread;
}

extern "C" {
EMSCRIPTEN_KEEPALIVE void start_churn(void) {
  g_churn = true;
  g_churn_thread = std::thread([] {
    while (g_churn) {
      void* blocks[32];
      for (auto& b : blocks) b = std::malloc(64 + (rand() % 512));
      for (auto& b : blocks) std::free(b);
    }
  });
}
EMSCRIPTEN_KEEPALIVE void stop_churn(void) {
  g_churn = false;
  if (g_churn_thread.joinable()) g_churn_thread.join();
}
} // extern "C"
#endif

int main() {
  // Driver-controlled; nothing to do. Keep the runtime alive for export calls.
  EM_ASM({ console.log("[JSPI_STACK] READY"); });
  return 0;
}
