#ifndef MATMUL_H
#define MATMUL_H

/* C linkage, also from CUDA C++ files: the judge's dispatch probe wraps matmul_ref by name. */
#ifdef __cplusplus
extern "C" {
#endif

/* C = A * B for n x n row-major matrices already on the device. Launches and returns. */
void matmul(const float *a, const float *b, float *c, int n);

/* Reference implementation. Candidates may not call it from matmul(). */
void matmul_ref(const float *a, const float *b, float *c, int n);

#ifdef __cplusplus
}
#endif

#endif
