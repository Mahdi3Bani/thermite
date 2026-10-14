#include "matmul.h"

__global__ static void matmul_kernel(const float *a, const float *b, float *c, int n) {
  int row = blockIdx.y * blockDim.y + threadIdx.y;
  int col = blockIdx.x * blockDim.x + threadIdx.x;
  if (row >= n || col >= n) return;
  float s = 0.0f;
  for (int k = 0; k < n; k++) s += a[row * n + k] * b[k * n + col];
  c[row * n + col] = s;
}

void matmul(const float *a, const float *b, float *c, int n) {
  dim3 block(8, 8);
  dim3 grid((n + 7) / 8, (n + 7) / 8);
  matmul_kernel<<<grid, block>>>(a, b, c, n);
}
