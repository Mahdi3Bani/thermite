#include "matmul.h"

#define TILE 16

__global__ static void matmul_ref_kernel(const float *a, const float *b, float *c, int n) {
  __shared__ float as[TILE][TILE];
  __shared__ float bs[TILE][TILE];
  int row = blockIdx.y * TILE + threadIdx.y;
  int col = blockIdx.x * TILE + threadIdx.x;
  float s = 0.0f;
  for (int t = 0; t < (n + TILE - 1) / TILE; t++) {
    int ak = t * TILE + threadIdx.x;
    int bk = t * TILE + threadIdx.y;
    as[threadIdx.y][threadIdx.x] = (row < n && ak < n) ? a[row * n + ak] : 0.0f;
    bs[threadIdx.y][threadIdx.x] = (bk < n && col < n) ? b[bk * n + col] : 0.0f;
    __syncthreads();
    for (int k = 0; k < TILE; k++) s += as[threadIdx.y][k] * bs[k][threadIdx.x];
    __syncthreads();
  }
  if (row < n && col < n) c[row * n + col] = s;
}

void matmul_ref(const float *a, const float *b, float *c, int n) {
  dim3 block(TILE, TILE);
  dim3 grid((n + TILE - 1) / TILE, (n + TILE - 1) / TILE);
  matmul_ref_kernel<<<grid, block>>>(a, b, c, n);
}
