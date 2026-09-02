# Plain Ubuntu base — multi-arch (ARM64/x86_64 auto-detected)
FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

# Install build tools required for KiCad WASM build
RUN apt-get update && apt-get install -y \
    cmake \
    autoconf \
    automake \
    libtool \
    meson \
    ninja-build \
    pkg-config \
    curl \
    git \
    python3 \
    python3-dev \
    protobuf-compiler \
    swig \
    unixodbc-dev \
    ccache \
    rsync \
    xz-utils \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Install emsdk from source (same approach as scripts/setup-emsdk.sh). The version is the SINGLE
# source of truth in scripts/common/versions.sh, passed in as a build arg by docker/build.sh (via the
# compose build.args). Do NOT hardcode it here — fail fast if the arg is missing so a stale image can
# never silently use the wrong toolchain.
ARG EMSCRIPTEN_VERSION
ARG EMSDK_TARBALL_SHA256
# Release tarball, not `git clone`: the CI runners intermittently get GitHub's refusal of
# ANONYMOUS git-over-HTTPS ("fatal: could not read Username for 'https://github.com'", seen
# 2026-09-01/02 on the shared Ubicloud egress), which killed every image build. Plain HTTPS
# archive downloads (the same class as every scripts/deps tarball) are not affected, and the
# sha256 pin makes the toolchain fetch content-addressable. The emsdk tag equals the
# emscripten version; `./emsdk install` itself only talks to storage.googleapis.com.
RUN test -n "${EMSCRIPTEN_VERSION}" || { echo "EMSCRIPTEN_VERSION build-arg required (scripts/common/versions.sh)"; exit 1; }; \
    test -n "${EMSDK_TARBALL_SHA256}" || { echo "EMSDK_TARBALL_SHA256 build-arg required (scripts/common/versions.sh)"; exit 1; }; \
    curl -fsSL --retry 5 --retry-all-errors -o /tmp/emsdk.tar.gz \
        "https://github.com/emscripten-core/emsdk/archive/refs/tags/${EMSCRIPTEN_VERSION}.tar.gz" \
    && echo "${EMSDK_TARBALL_SHA256}  /tmp/emsdk.tar.gz" | sha256sum -c - \
    && mkdir -p /emsdk \
    && tar xzf /tmp/emsdk.tar.gz -C /emsdk --strip-components=1 \
    && rm -f /tmp/emsdk.tar.gz \
    && cd /emsdk \
    && ./emsdk install ${EMSCRIPTEN_VERSION} \
    && ./emsdk activate ${EMSCRIPTEN_VERSION}

# Make Docker's own emsdk authoritative for EVERY process in the container, including
# `docker compose exec` (which bypasses the ENTRYPOINT). env.sh keys off $EMSDK: with it
# set, env.sh sources /emsdk/emsdk_env.sh and never falls back to the local tools/emsdk
# (which, inside this Linux container, can be a host macOS emsdk rsync'd in by mistake and
# thus unrunnable). This is what lets the wxWidgets autoconf build find emmake on PATH.
ENV EMSDK=/emsdk

# Configure ccache for Emscripten
# CCACHE_DIR in named volume persists across containers
ENV CCACHE_DIR=/workspace/build-wasm/.ccache
ENV CCACHE_MAXSIZE=10G
ENV CCACHE_COMPILERCHECK=content
ENV CCACHE_SLOPPINESS=include_file_mtime,time_macros,pch_defines
ENV CCACHE_BASEDIR=/workspace

WORKDIR /workspace

# Entry point that sources Emscripten environment
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
CMD ["bash"]
