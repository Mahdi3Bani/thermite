# Matrix multiply

A small C matrix multiply: `C = A * B` for square, row-major `float` matrices.

- `src/kernel/matmul.c` is the kernel. It uses the plain i-j-k loop order, which reads `B` one column at a time and is slow.
- `src/ref/matmul_ref.c` is a reference implementation. The kernel must not call it.
- `include/matmul.h` declares both.

The benchmark that times the kernel, and the check of its answers, are kept apart from this folder.
