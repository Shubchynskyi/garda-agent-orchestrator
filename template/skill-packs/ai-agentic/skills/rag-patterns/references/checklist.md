# RAG Patterns Checklist

## Corpus & Ingestion

- [ ] Corpus boundaries are explicitly defined; every source collection has a documented scope, cadence, and access-control policy.
- [ ] Ingestion rejects corrupt, empty, or duplicate documents and logs failures with structured context.
- [ ] Metadata (source URI, timestamp, author, section hierarchy) is stored alongside every chunk.
- [ ] Incremental re-ingestion and soft-delete/tombstone flows exist for updated and removed content.

## Chunking

- [ ] Chunking strategy is chosen based on measured retrieval recall, not defaults.
- [ ] Chunk size, overlap, and splitting heuristic are in version-controlled configuration.
- [ ] Parent-child or hierarchical chunking is evaluated when documents have structural nesting.

## Embedding Pipeline

- [ ] Embedding model version and dimensionality are pinned in configuration.
- [ ] Same document + same model version produces the same vector (reproducible indexing).
- [ ] Embedding model changes are treated as breaking migrations requiring full re-index.

## Vector Store & Retrieval

- [ ] Index type, distance metric, and HNSW/IVF parameters are documented and tuned for the corpus size.
- [ ] Tenant or permission metadata is a mandatory filter, not an optional post-filter.
- [ ] Initial top-k and reranker top-n are separate, configurable values with logged scores.
- [ ] Similarity threshold is externalized; no hard-coded magic numbers in retrieval code.

## Context Packing & Generation

- [ ] A fixed token budget is allocated for retrieved chunks, separate from system instructions and history.
- [ ] Context overflow drops lowest-ranked whole chunks, never truncates mid-chunk.
- [ ] The generation prompt instructs the model to cite specific chunk IDs or source URIs.
- [ ] Every citation in the response is validated against the actual retrieved chunk set.

## Staleness & Freshness

- [ ] Every indexed chunk carries a freshness timestamp or version.
- [ ] Response metadata surfaces the age of the oldest retrieved chunk.
- [ ] Stale content detection runs on a schedule or ingestion trigger, not only on query time.

## Evaluation

- [ ] Retrieval quality (recall, precision, MRR) is measured on a labeled query set, separate from answer quality.
- [ ] End-to-end answer correctness is tracked independently of retrieval metrics.
- [ ] Both metric sets are monitored over time; regressions trigger alerts before user impact.
