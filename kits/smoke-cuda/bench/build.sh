#!/bin/sh
# Builds the CUDA smoke benchmark. By default it holds native code for every GPU generation from
# sm_60 (Pascal) to sm_90 (Hopper), and PTX for newer GPUs, so no run spends its time compiling
# the kernels at start. CUDA_ARCH, such as sm_86, builds for that architecture only.
set -eu
mkdir -p out
if [ -n "${CUDA_ARCH:-}" ]; then
  set -- -arch="$CUDA_ARCH"
else
  set --
  for sm in 60 70 75 80 86 89; do
    set -- "$@" -gencode "arch=compute_$sm,code=sm_$sm"
  done
  set -- "$@" -gencode "arch=compute_90,code=[sm_90,compute_90]"
fi
nvcc -O2 "$@" -Iinclude \
  -o out/bench \
  .kit/bench/main.cu .kit/bench/probe.c src/kernel/*.cu src/ref/matmul_ref.cu \
  -Xlinker --wrap=matmul_ref
