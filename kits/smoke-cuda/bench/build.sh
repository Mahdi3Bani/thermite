#!/bin/sh
# Builds the CUDA smoke benchmark for the rig's GPU architecture (CUDA_ARCH, default sm_60).
set -eu
mkdir -p out
nvcc -O2 -arch="${CUDA_ARCH:-sm_60}" -Iinclude \
  -o out/bench \
  .kit/bench/main.cu .kit/bench/probe.c src/kernel/*.cu src/ref/matmul_ref.cu \
  -Xlinker --wrap=matmul_ref
