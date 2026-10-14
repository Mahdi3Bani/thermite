# Smoke project (CUDA)

The CUDA counterpart of `examples/smoke-project`, for judge acceptance on a GPU unit. `src/kernel/matmul.cu` is a naive kernel that candidates may change, and `src/ref/matmul_ref.cu` is a faster tiled reference that they may not call. The matching kit is `kits/smoke-cuda`.
