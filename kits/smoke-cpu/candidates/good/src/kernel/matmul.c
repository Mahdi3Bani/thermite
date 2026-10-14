#include "matmul.h"

/* Loop order i-k-j: the inner loop walks B and C contiguously. */
void matmul(const float *a, const float *b, float *c, int n) {
  for (int i = 0; i < n * n; i++) c[i] = 0.0f;
  for (int i = 0; i < n; i++) {
    for (int k = 0; k < n; k++) {
      const float aik = a[i * n + k];
      float *ci = c + i * n;
      const float *bk = b + k * n;
      for (int j = 0; j < n; j++) ci[j] += aik * bk[j];
    }
  }
}
