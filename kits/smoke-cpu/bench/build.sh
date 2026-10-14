#!/bin/sh
# Builds the smoke benchmark from the candidate's sources and the kit's driver.
# Needs GNU ld for --wrap (the dispatch probe), so it runs in the Linux harness image.
set -eu
mkdir -p out
cc -O2 -std=c11 -Wall -Iinclude \
  -o out/bench \
  .kit/bench/main.c .kit/bench/probe.c src/kernel/*.c src/ref/matmul_ref.c \
  -Wl,--wrap=matmul_ref
