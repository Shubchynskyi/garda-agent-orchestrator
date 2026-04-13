# Performance Review Checklist

## Latency Budget

- [ ] Target latency percentile (p50/p95/p99) is defined for each affected endpoint or stage.
- [ ] End-to-end latency budget is allocated across stages; no single stage exceeds its share.
- [ ] Timeout values are set and consistent with the latency budget (timeout ≤ budget, not >>).

## Hot Path & I/O

- [ ] Critical path is identified; no unnecessary I/O, allocation, or serialization on it.
- [ ] N+1 query/call patterns are absent or mitigated (batching, DataLoader, join).
- [ ] Blocking calls do not run on an async/event-loop thread.
- [ ] Heavy computation is offloaded from the request-serving thread/loop where applicable.

## Caching

- [ ] Every cache has a bounded TTL; no indefinite in-memory growth.
- [ ] Invalidation strategy is explicit and tested (event-driven, TTL, versioned key).
- [ ] Cache-stampede protection exists (singleflight, lock, request coalescing).
- [ ] Cache hit-rate is observable (metric or log); cold-start behaviour is acceptable.
- [ ] Cached data does not bypass authorization checks on read.

## Concurrency & Pools

- [ ] Connection/thread/worker pool sizes are configured, not left at unbounded defaults.
- [ ] Pool exhaustion produces a clear signal (reject, backpressure, metric) not silent hang.
- [ ] Shared mutable state is accessed under proper synchronization (lock, atomic, channel).
- [ ] No lock held across I/O or awaited future on the hot path.

## Payload & Serialization

- [ ] Response payloads are bounded (pagination, field selection, max-items).
- [ ] Large payloads use streaming or chunked transfer where appropriate.
- [ ] Compression is enabled for text-heavy responses over the size threshold.
- [ ] No unnecessary deep clone or re-serialization on the hot path.

## Fan-Out & Downstream Calls

- [ ] Parallel calls have bounded concurrency (semaphore, pool, `Promise.allSettled` with limit).
- [ ] Each downstream call has an individual timeout shorter than the overall budget.
- [ ] Partial failure handling is defined (degrade, retry subset, abort).
- [ ] Sequential calls that could safely run in parallel are flagged for improvement.

## Queue & Backpressure

- [ ] Queue depth is bounded; producers receive backpressure when the queue is full.
- [ ] Dead-letter or poison-message routing is configured for unprocessable items.
- [ ] Consumer concurrency is capped; visibility timeout or ack deadline matches processing time.
- [ ] Fire-and-forget patterns are documented and acceptable for the correctness requirement.

## Measurement & Evidence

- [ ] Before/after benchmark or load-test results are provided for performance claims.
- [ ] Results include metric name, percentile, sample size, and test environment.
- [ ] Micro-benchmarks account for warm-up, GC, and JIT effects.
- [ ] Regression tests or performance gates exist to prevent silent future degradation.
