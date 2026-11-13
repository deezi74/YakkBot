#!/usr/bin/env bash
# Puts an arm64 PRoot engine into the APK for YakkBot's built-in Linux (same approach as D-Agent).
# PRoot (GPL-2.0, https://github.com/termux/proot) runs as a separate program,
# so YakkBot's own code is not affected by its license. Binaries come from the
# Termux package repository. They must ship as lib*.so files so Android extracts
# them to the app's native library folder, the only place an app may run programs from.
set -euo pipefail
OUT="${1:-app/src/main/jniLibs/arm64-v8a}"
REPO="https://packages.termux.dev/apt/termux-main"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$OUT"
for tool in curl dpkg-deb patchelf readelf; do command -v "$tool" >/dev/null || { echo "missing $tool"; exit 1; }; done

curl -fsSL --retry 4 "$REPO/dists/stable/main/binary-aarch64/Packages" -o "$WORK/Packages"
deb_path() { awk -v p="$1" '$1=="Package:"{cur=$2} $1=="Filename:" && cur==p {print $2; exit}' "$WORK/Packages"; }

for pkg in proot libtalloc libandroid-shmem; do
  path="$(deb_path "$pkg")"
  [ -n "$path" ] || { echo "package $pkg not found in Termux index"; exit 1; }
  echo "Downloading $pkg: $path"
  curl -fsSL --retry 4 "$REPO/$path" -o "$WORK/$pkg.deb"
  dpkg-deb -x "$WORK/$pkg.deb" "$WORK/root"
done

PREFIX="$WORK/root/data/data/com.termux/files/usr"
cp "$PREFIX/bin/proot" "$OUT/libproot.so"
cp "$PREFIX/libexec/proot/loader" "$OUT/libproot-loader.so"
[ -f "$PREFIX/libexec/proot/loader32" ] && cp "$PREFIX/libexec/proot/loader32" "$OUT/libproot-loader32.so" || true
TALLOC="$(ls "$PREFIX"/lib/libtalloc.so.* | grep -E 'libtalloc\.so\.[0-9]+$' | head -1 || true)"
[ -n "$TALLOC" ] || TALLOC="$(ls "$PREFIX"/lib/libtalloc.so* | head -1)"
cp -L "$TALLOC" "$OUT/libtalloc.so"
cp -L "$PREFIX/lib/libandroid-shmem.so" "$OUT/libandroid-shmem.so"
patchelf --remove-rpath "$OUT/libandroid-shmem.so" || true

# Point proot at the renamed talloc and drop Termux's library path.
SONAME="$(readelf -d "$OUT/libproot.so" | awk -F'[][]' '/NEEDED/ && /talloc/ {print $2}')"
[ -n "$SONAME" ] && patchelf --replace-needed "$SONAME" libtalloc.so "$OUT/libproot.so"
patchelf --remove-rpath "$OUT/libproot.so" || true
patchelf --set-soname libtalloc.so "$OUT/libtalloc.so" || true

echo "NEEDED by proot:"; readelf -d "$OUT/libproot.so" | grep NEEDED
for lib in $(readelf -d "$OUT/libproot.so" "$OUT/libtalloc.so" "$OUT/libandroid-shmem.so" | awk -F'[][]' '/NEEDED/ {print $2}'); do
  case "$lib" in libc.so|libdl.so|libm.so|liblog.so|libtalloc.so|libandroid-shmem.so) ;; *) echo "unexpected dependency $lib"; exit 1 ;; esac
done
ls -l "$OUT"
