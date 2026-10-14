/* Dispatch probe: counts host-side calls to the reference launcher (linked with --wrap). */
unsigned long long thermite_ref_calls = 0;

void __real_matmul_ref(const float *a, const float *b, float *c, int n);

void __wrap_matmul_ref(const float *a, const float *b, float *c, int n) {
  thermite_ref_calls++;
  __real_matmul_ref(a, b, c, n);
}
