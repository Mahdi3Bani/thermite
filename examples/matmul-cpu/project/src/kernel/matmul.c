#include "matmul.h"

void matmul(const float *a, const float *b, float *c, int n) {
  for (int i = 0; i < n; i++) {
    for (int j = 0; j < n; j++) {
      float s = 0.0f;
      for (int k = 0; k < n; k++) s += a[i * n + k] * b[k * n + j];
      c[i * n + j] = s;
    }
  }
}
