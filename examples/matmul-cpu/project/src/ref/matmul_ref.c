#include "matmul.h"

void matmul_ref(const float *a, const float *b, float *c, int n) {
  for (int i = 0; i < n * n; i++) c[i] = 0.0f;
  for (int i = 0; i < n; i++) {
    for (int k = 0; k < n; k++) {
      const float aik = a[i * n + k];
      for (int j = 0; j < n; j++) c[i * n + j] += aik * b[k * n + j];
    }
  }
}
