#!/bin/sh
# Builds the CUDA smoke benchmark. By default it holds native code for every GPU generation the
# toolkit builds for, and PTX for newer GPUs, so no run spends its time compiling the kernels at
# start: with CUDA 12, sm_60 (Pascal) to sm_90 (Hopper); with CUDA 13, which builds for nothing
# older than Turing, sm_75 to sm_120 (Blackwell; its code also runs on the DGX Spark's sm_121).
# CUDA_ARCH, such as sm_86, builds for that architecture only.
set -eu
mkdir -p out
if [ -n "${CUDA_ARCH:-}" ]; then
  set -- -arch="$CUDA_ARCH"
else
  major=$(nvcc --version | sed -n 's/.*release \([0-9][0-9]*\)\..*/\1/p')
  if [ "${major:-12}" -ge 13 ]; then
    native="75 80 86 89 90 100"
    newest=120
  else
    native="60 70 75 80 86 89"
    newest=90
  fi
  set --
  for sm in $native; do
    set -- "$@" -gencode "arch=compute_$sm,code=sm_$sm"
  done
  set -- "$@" -gencode "arch=compute_$newest,code=[sm_$newest,compute_$newest]"
fi
nvcc -O2 "$@" -Iinclude \
  -o out/bench \
  .kit/bench/main.cu .kit/bench/probe.c src/kernel/*.cu src/ref/matmul_ref.cu \
  -Xlinker --wrap=matmul_ref
