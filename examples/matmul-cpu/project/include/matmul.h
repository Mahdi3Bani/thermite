#ifndef MATMUL_H
#define MATMUL_H

/* C = A * B for n x n row-major matrices. The kernel candidates work on. */
void matmul(const float *a, const float *b, float *c, int n);

/* Reference implementation. Candidates may not call it from matmul(). */
void matmul_ref(const float *a, const float *b, float *c, int n);

#endif
