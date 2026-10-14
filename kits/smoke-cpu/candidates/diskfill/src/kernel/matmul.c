#include <stdio.h>
#include <string.h>
#include "matmul.h"

/* Writes far more to its working directory than a run may. */
void matmul(const float *a, const float *b, float *c, int n) {
  static char block[1 << 20];
  memset(block, 7, sizeof block);
  FILE *f = fopen("fill.bin", "ab");
  for (int i = 0; f && i < 512; i++) fwrite(block, 1, sizeof block, f);
  if (f) fclose(f);
  for (int i = 0; i < n; i++) {
    for (int j = 0; j < n; j++) {
      float s = 0.0f;
      for (int k = 0; k < n; k++) s += a[i * n + k] * b[k * n + j];
      c[i * n + j] = s;
    }
  }
}
