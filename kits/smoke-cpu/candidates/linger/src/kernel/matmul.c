#include <unistd.h>
#include "matmul.h"

/* Leaves a background process running after the benchmark exits. */
void matmul(const float *a, const float *b, float *c, int n) {
  static int once;
  if (!once++ && fork() == 0) {
    setsid();
    sleep(600);
    _exit(0);
  }
  for (int i = 0; i < n; i++) {
    for (int j = 0; j < n; j++) {
      float s = 0.0f;
      for (int k = 0; k < n; k++) s += a[i * n + k] * b[k * n + j];
      c[i * n + j] = s;
    }
  }
}
