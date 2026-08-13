> **Historical (asyncify era).** These benches timed the Binaryen
> `apply-asyncify` post-link tail, which the JSPI migration deleted — the
> scripts below that reference it are gone. The VM provisioning pieces
> (setup-vm.sh, vm-build.sh, cloud-init) remain useful for any host-side
> build benching.

# wasm-opt allocator/core benchmark

Fast, local feedback loop for the CI perf issue: the host-side `wasm-opt`/asyncify
pass (`scripts/common/apply-asyncify.sh`) is slow on the glibc Linux CI runner
because glibc `malloc` collapses into per-arena lock (`futex`) contention under
many threads. We preload **jemalloc** to fix it. This harness measures the effect
locally instead of paying for a full ~160-min Hetzner CI run per experiment.

**Key idea:** `wasm-opt`/asyncify is a standalone pass over an *already-compiled*
`.wasm` (`docker/build.sh:194`). So we build the eeschema `.wasm` **once** on the
Mac, copy it into a Linux VM, and replay only the optimizer across a matrix of
`{glibc, jemalloc} × core counts`. No KiCad compile happens in the VM.

## Caveats (read before trusting numbers)

- **This Mac is 10 cores / 32 GB.** The local core sweep tops out at ~10 threads.
  The CI runner is 32 vCPU, so the *full* 32-thread contention is **not**
  reproducible here — the local run shows the **direction** (jemalloc vs glibc,
  and how wall-clock scales with cores), not CI's absolute worst case. The final
  32-thread pick must still be confirmed on the real runner.
- **aarch64 ≠ CI's x86_64.** The VM is aarch64 (HVF, near-native speed). The
  glibc arena-lock pathology is arch-independent, so the **ratios** transfer;
  **absolute seconds do not** match the x86_64 AMD runner.
- asyncify peaks ~10–15 GB RAM → the VM gets 20 GB; close other heavy apps.

## 1. Build the fixture (once, on the Mac)

```bash
mkdir -p bench
./docker/build.sh eeschema --build-deps          # long: full cold build
# Pull the Docker-side raw (pre-finalize) wasm while the builder container is up:
docker compose -f docker/docker-compose.yml cp \
  kicad-wasm-builder:/workspace/build-wasm/kicad-eeschema/eeschema/eeschema.wasm \
  bench/eeschema.raw.wasm
# Finalize it to match what asyncify actually consumes in the pipeline:
./scripts/common/apply-finalize.sh bench/eeschema.raw.wasm bench/eeschema.finalized.wasm
```

Fallback if `compose cp` fails:
`docker compose -f docker/docker-compose.yml exec kicad-wasm-builder cat <path> > bench/eeschema.raw.wasm`

## 2. Provision and boot the VM (Mac)

```bash
brew install qemu                 # one-time
./scripts/bench/setup-vm.sh prepare
./scripts/bench/setup-vm.sh run   # serial console; quit with Ctrl-a x
```

Wait ~1–2 min for cloud-init (installs git/curl/time/libjemalloc2/strace).

## 3. Load repo + fixture into the VM

```bash
# from the Mac, in another terminal:
scp -P 2222 -o StrictHostKeyChecking=no bench/eeschema.finalized.wasm bench@localhost:~/
./scripts/bench/setup-vm.sh ssh
# inside the VM:
git clone <this-repo-url> repo && cd repo
git checkout istvanmatejcsok/feat/ci-hetzner-allcores
mkdir -p bench && mv ~/eeschema.finalized.wasm bench/
# get-wasm-opt.sh auto-downloads Binaryen v121 aarch64-linux on first use
```

## 4. Run the benchmark (in the VM)

```bash
STRACE=1 ./scripts/bench/wasm-opt-bench.sh
```

Sweeps `CORES="1 4 8 10"` × `{glibc, jemalloc}`, writing `bench/results.csv`
(wall-clock + peak RSS per cell) and per-cell logs under `bench/results/`. With
`STRACE=1` it also records `futex` syscall share per allocator (expect ~99% on
glibc, far lower with jemalloc). Override the sweep with e.g. `CORES="8 10"`.

## Interpreting

- jemalloc rows should show **lower wall-clock** than glibc, widening as cores rise.
- glibc wall-clock that *stops improving* (or worsens) with more cores = the
  arena-lock storm; jemalloc should keep scaling.
- These ratios justify the `LD_PRELOAD` fix; use them (plus one real-runner
  confirmation) to choose CI's `BINARYEN_CORES`.

Artifacts (`bench/*.wasm`, `bench/results*`, `scripts/bench/vm/`) are gitignored.

## 5. Full Docker build in the VM (CI dry-run) — vm-build.sh

Verifies CI orchestration changes (docker/build.sh, compose limits, pipelining)
on Linux+Docker without burning a Hetzner slot. The guest is aarch64/HVF:
a *functional* CI proxy, not an x86 performance proxy.

```bash
# one-time: bigger disk + Docker-enabled cloud-init, then boot
VM_DISK=80G ./scripts/bench/setup-vm.sh prepare
./scripts/bench/setup-vm.sh run            # leave running in its own terminal

# from the Mac: cold calculator build inside the guest (deps + docker image)
./scripts/bench/vm-build.sh                # = calculator --build-deps

# pipeline smoke test (deps already in the guest volume from the previous run)
KICAD_PIPELINE=1 ./scripts/bench/vm-build.sh calculator,pl_editor
```

Prints the guest build wall time at the end; build logs stream through ssh.
