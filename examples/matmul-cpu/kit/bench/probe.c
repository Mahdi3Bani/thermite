/*
 * Dispatch probe. The build links with --wrap=matmul_ref, so every call to the reference
 * implementation from the candidate's code passes through here and is counted. A run with
 * a nonzero count fell back to the reference op and fails the dispatch proof.
 */
unsigned long long thermite_ref_calls = 0;

void __real_matmul_ref(const float *a, const float *b, float *c, int n);

void __wrap_matmul_ref(const float *a, const float *b, float *c, int n) {
  thermite_ref_calls++;
  __real_matmul_ref(a, b, c, n);
}
