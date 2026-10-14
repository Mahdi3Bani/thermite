# Smoke project

A tiny matrix-multiply "project" for the judge's acceptance tests and the local compose stack.

- `src/kernel/matmul.c` is the kernel candidates may change (a naive loop order to start).
- `src/ref/matmul_ref.c` is a faster reference implementation. Candidates may not edit it, and a candidate that simply calls it fails the dispatch proof.

The matching kit is `kits/smoke-cpu`.
