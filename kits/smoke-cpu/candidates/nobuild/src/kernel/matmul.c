#include "matmul.h"

void matmul(const float *a, const float *b, float *c, int n) {
  for (int i = 0; i < n; i++) {
    c[i] = a[i] * b[i]   /* missing semicolon */
  }
}
