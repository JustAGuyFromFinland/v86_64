# v86 Copilot Instructions

v86 is an x86-to-WebAssembly JIT emulator that runs operating systems in the browser. It translates x86 machine code to WASM modules at runtime.

## Architecture Overview

**Dual-language codebase:** JavaScript handles device emulation and browser integration; Rust handles CPU emulation and JIT compilation to WebAssembly.

- `src/browser/starter.js` — Main API entry point (`V86` constructor), browser adapters
- `src/cpu.js` — JavaScript CPU wrapper, device initialization, state management
- `src/rust/jit.rs` — Core JIT compiler: x86 → WASM translation
- `src/rust/cpu/` — CPU instruction implementations in Rust
- `gen/x86_table.js` — x86 instruction encoding definitions (generates Rust code)
- `lib/` — 9p filesystem, marshalling utilities

**Code generation pipeline:** `gen/*.js` scripts generate `src/rust/gen/*.rs` files from `gen/x86_table.js`. These must be regenerated when instruction definitions change.

## Build System

```bash
make                    # Debug build → debug.html + build/v86-debug.wasm
make all                # Release build → index.html + build/v86.wasm
make run                # Serve files locally (Python HTTP server)
```

**Dependencies:** Rust (wasm32-unknown-unknown target), clang, Java (Closure Compiler), Node.js v16+

Generated files pattern: `src/rust/gen/{jit,jit0f,interpreter,interpreter0f,analyzer,analyzer0f}.rs`

## Testing

```bash
make tests              # Integration tests (requires disk images)
make nasmtests          # Assembly unit tests (nasm, gdb, qemu)
make rust-test          # Rust unit tests
make kvm-unit-test      # KVM project CPU tests
make qemutests          # QEMU-based CPU instruction tests
```

Download test images first: see README for `curl` command. Environment variables: `TEST_RELEASE_BUILD=1`, `MAX_PARALLEL_TESTS=n`, `TEST_NAME="…"`.

## Key Patterns

**JIT Compilation:** Pages are profiled for "hotness" (`JIT_THRESHOLD` in `jit.rs`). Hot pages get compiled to WASM modules with a big switch (brtable) for all entry points. The "stackifier" algorithm handles structured control flow conversion.

**Memory/Paging:** TLB cache in WASM memory. Fast path checks `tlb[addr >> 12]`; slow path in `safe_read_jit_slow` handles page faults, mmio.

**Device I/O:** Register handlers via `io.register_read/write` in `src/io.js`. Memory-mapped I/O via `io.mmap_register`.

**State serialization:** `CPU.prototype.get_state/set_state` handles save/restore. Bitmap tracks non-zero memory pages.

## File Conventions

- Rust files use `snake_case`; JS uses `camelCase` for functions, `PascalCase` for constructors
- Hardware constants in `src/const.js` (shared with Rust via wasm exports)
- Device implementations: `src/{device}.js` (e.g., `vga.js`, `ide.js`, `uart.js`)
- Browser adapters: `src/browser/{adapter}.js` (screen, keyboard, mouse, serial, network)

## Common Tasks

**Adding x86 instructions:** Edit `gen/x86_table.js`, run `make src/rust/gen/jit.rs` (or let build regenerate). Implement in `src/rust/cpu/` and `src/rust/jit_instructions.rs`.

**Device emulation:** Create class in `src/`, register I/O ports, add to `CPU.prototype.init` device setup.

**API changes:** Update `V86` prototype in `src/browser/starter.js`, document in `v86.d.ts`.

## Debugging Tips

- `debug.html` loads source files directly (no Closure compilation)
- Set `DEBUG=true` in source for verbose logging
- Use `LOG_CPU`, `LOG_BIOS` etc. log levels from `src/log.js`
- WASM debugging: `DUMP_GENERATED_WASM=true` in `cpu.js`
