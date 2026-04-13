---
name: performance-review
description: >
  Reviews code changes for latency regressions, concurrency bottlenecks, caching misuse,
  payload bloat, fan-out risks, and queue/backpressure gaps. Requires measurement evidence
  (benchmarks, profiles, load-test results) before approving performance-sensitive changes.
  Use when a task touches hot paths, caching layers, connection/thread pools, batch/stream
  processing, queue consumers, serialization formats, or when the task description mentions
  latency, throughput, p99, response time, or load testing.
  Trigger phrases: perf review, latency review, performance audit, hot-path review.
  Do NOT use for cosmetic refactors, style changes, or feature work that does not alter
  any hot path, I/O pattern, or resource pool.
license: MIT
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash(*)
  - Write
metadata:
  author: garda-agent-orchestrator
  version: 1.0.0
  domain: quality
  triggers: latency budget, hot path, cache, concurrency, fan-out, payload size, queue, backpressure, benchmark, load test, profiling
  role: specialist
  scope: review
  output-format: review-findings
  related-skills: code-review, architecture-review, node-backend
---

# Performance Review

## Core Workflow

1. **Establish the latency budget.** Identify the SLO or target percentile (p50/p95/p99) for every affected endpoint or pipeline stage. If no budget exists, flag this as a prerequisite before any optimization claim can be evaluated.
2. **Map the hot path.** Trace the request or event from entry to response/ack. Identify every I/O call, serialization step, lock acquisition, and allocation on the critical path. Mark segments that run under concurrency (shared pool, event loop, goroutine fan-out).
3. **Evaluate caching changes.** For any new or modified cache: verify TTL is bounded, invalidation strategy is explicit, cache-stampede protection exists (lock/singleflight/request-coalescing), and cold-start behaviour is acceptable. Flag unbounded in-memory caches and caches without hit-rate observability.
4. **Assess concurrency and pool sizing.** Check connection pools, thread/worker pools, and semaphore limits. Verify that pool exhaustion produces a clear backpressure signal (reject, queue with bounded depth, circuit-break) rather than silent queueing or OOM. Flag shared mutable state accessed without synchronization.
5. **Check payload and serialization.** Verify response payloads are bounded (pagination, field selection, compression). Flag N+1 data fetches, unbounded list expansions, and unnecessary deep cloning or re-serialization on the hot path.
6. **Review fan-out and downstream calls.** For scatter-gather or parallel call patterns, confirm: bounded parallelism, per-call timeout, partial-failure handling, and total latency budget accounting. Flag sequential calls that could be parallelized and parallel calls without a concurrency cap.
7. **Verify queue and backpressure design.** For producer/consumer flows, confirm: bounded queue depth, dead-letter routing, consumer concurrency limit, and visibility timeout or ack deadline. Flag fire-and-forget patterns without delivery guarantees where correctness matters.
8. **Require measurement evidence.** Reject performance claims not supported by before/after benchmarks, profiles, or load-test results. Evidence must include the metric, percentile, sample size, and environment. Micro-benchmarks must note warm-up and GC effects.

## Reference Guide

| Topic | Reference | Load When |
|---|---|---|
| Performance review checklist | `references/checklist.md` | Any performance-sensitive change or review |

## Anti-Patterns

- **Microbenchmark theater**: claiming improvement from isolated benchmarks while ignoring p95 or p99 latency, queue depth, or system-level saturation behavior.
- **Cache without an invalidation story**: adding a cache that improves the happy path while quietly introducing stale reads, stampedes, or unbounded memory growth.
- **Unlimited parallelism**: fan-out that reduces single-request latency in staging but collapses shared pools or downstream dependencies under production concurrency.
- **Pool tuning without overload semantics**: changing worker, connection, or thread counts without stating what happens when the pool saturates.

## Constraints

- Do not approve performance-sensitive changes without measurement evidence (benchmark, profile, or load-test result with before/after comparison).
- Do not accept unbounded caches, unbounded queues, or unbounded fan-out on any hot path.
- Do not permit optimization that sacrifices correctness (e.g., removing locks without proving absence of data races, skipping validation for speed).
- Do not rely on micro-benchmark improvements alone; require system-level or integration-level confirmation for latency claims.
- Do not approve pool or concurrency limit changes without documenting the saturation/backpressure behaviour under overload.
- Treat removal of timeouts, rate limits, or circuit-breakers as a hard-fail unless explicitly justified with load-test evidence.
