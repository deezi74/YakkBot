#!/usr/bin/env bash
# Builds llama.cpp's OpenAI-compatible server for arm64 Android and puts it into the APK's
# native libraries as libllamaserver.so (Android only lets an app run programs from its
# native library folder). llama.cpp is MIT licensed and runs as a separate program.
# Same build as D-Agent's.
#
#   ANDROID_NDK_HOME=... bash scripts/build-llama-server.sh [out-dir]
set -euo pipefail

LLAMA_TAG="${LLAMA_TAG:-b12017}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${1:-$ROOT/app/src/main/jniLibs/arm64-v8a}"
OUT="$OUT_DIR/libllamaserver.so"
WORK="${LLAMA_WORK:-$ROOT/deps/llama}"

if [ -f "$OUT" ]; then
  echo "== llama-server already built ($(du -h "$OUT" | cut -f1))"
  exit 0
fi
: "${ANDROID_NDK_HOME:?set ANDROID_NDK_HOME}"
command -v cmake >/dev/null || { echo "cmake missing" >&2; exit 1; }

mkdir -p "$WORK"
if [ ! -f "$WORK/src/CMakeLists.txt" ]; then
  rm -rf "$WORK/src"
  git clone --depth 1 --branch "$LLAMA_TAG" https://github.com/ggml-org/llama.cpp.git "$WORK/src"
fi

cmake -S "$WORK/src" -B "$WORK/build" \
  -DCMAKE_TOOLCHAIN_FILE="$ANDROID_NDK_HOME/build/cmake/android.toolchain.cmake" \
  -DANDROID_ABI=arm64-v8a -DANDROID_PLATFORM=android-28 -DANDROID_STL=c++_static \
  -DCMAKE_BUILD_TYPE=Release \
  -DBUILD_SHARED_LIBS=OFF \
  -DLLAMA_BUILD_COMMON=ON -DLLAMA_BUILD_TOOLS=ON -DLLAMA_BUILD_SERVER=ON \
  -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF \
  -DLLAMA_CURL=OFF -DLLAMA_OPENSSL=OFF \
  -DGGML_NATIVE=OFF -DGGML_OPENMP=OFF -DGGML_LLAMAFILE=ON \
  -DGGML_CPU_ARM_ARCH=armv8.2-a+dotprod+fp16
cmake --build "$WORK/build" --target llama-server -j"$(nproc 2>/dev/null || echo 4)"

bin="$(find "$WORK/build" -type f -name llama-server -perm -u+x | head -1)"
[ -n "$bin" ] || { echo "llama-server not produced" >&2; exit 1; }
mkdir -p "$OUT_DIR"
"$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64/bin/llvm-strip" -o "$OUT" "$bin"
echo "== llama-server -> $OUT ($(du -h "$OUT" | cut -f1))"
