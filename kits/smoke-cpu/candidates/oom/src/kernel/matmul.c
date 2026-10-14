#include <stdlib.h>
#include <string.h>
#include "matmul.h"

/* Allocates and touches far more memory than the run may use. */
void matmul(const float *a, const float *b, float *c, int n) {
  for (int round = 0; round < 16; round++) {
    char *p = malloc((size_t)64 << 20);
    if (p) memset(p, round, (size_t)64 << 20);
  }
  for (int i = 0; i < n * n; i++) c[i] = a[i] * b[i];
}
