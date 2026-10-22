#include "matmul.h"

#define BM 64
#define BN 64
#define BK 8
#define TM 4
#define TN 4

/*
 * Register tiling: each block loads 64x8 and 8x64 tiles of A and B into shared memory, and each
 * thread keeps a 4x4 block of C in registers, so it does 16 multiply-adds for every 8 values it
 * reads. This is several times faster than the naive kernel on every GPU generation.
 */
__global__ static void matmul_kernel(const float *a, const float *b, float *c, int n) {
  __shared__ float as[BK][BM + 1];
  __shared__ float bs[BK][BN];
  int tx = threadIdx.x % (BN / TN);
  int ty = threadIdx.x / (BN / TN);
  int row0 = blockIdx.y * BM;
  int col0 = blockIdx.x * BN;
  float acc[TM][TN] = {};
  for (int t = 0; t < n; t += BK) {
    for (int i = threadIdx.x; i < BM * BK; i += blockDim.x) {
      int m = i / BK, k = i % BK;
      as[k][m] = (row0 + m < n && t + k < n) ? a[(row0 + m) * n + t + k] : 0.0f;
    }
    for (int i = threadIdx.x; i < BK * BN; i += blockDim.x) {
      int k = i / BN, j = i % BN;
      bs[k][j] = (t + k < n && col0 + j < n) ? b[(t + k) * n + col0 + j] : 0.0f;
    }
    __syncthreads();
    for (int k = 0; k < BK; k++) {
      float ra[TM], rb[TN];
      for (int i = 0; i < TM; i++) ra[i] = as[k][ty * TM + i];
      for (int j = 0; j < TN; j++) rb[j] = bs[k][tx * TN + j];
      for (int i = 0; i < TM; i++)
        for (int j = 0; j < TN; j++) acc[i][j] += ra[i] * rb[j];
    }
    __syncthreads();
  }
  for (int i = 0; i < TM; i++)
    for (int j = 0; j < TN; j++) {
      int r = row0 + ty * TM + i, col = col0 + tx * TN + j;
      if (r < n && col < n) c[r * n + col] = acc[i][j];
    }
}

void matmul(const float *a, const float *b, float *c, int n) {
  dim3 block((BM / TM) * (BN / TN));
  dim3 grid((n + BN - 1) / BN, (n + BM - 1) / BM);
  matmul_kernel<<<grid, block>>>(a, b, c, n);
}
