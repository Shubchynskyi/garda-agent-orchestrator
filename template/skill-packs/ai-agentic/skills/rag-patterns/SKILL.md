---
name: rag-patterns
description: >
  Production patterns for retrieval-augmented generation systems: corpus boundary
  definition, ingestion quality, chunking trade-offs, embedding pipeline design,
  vector store configuration, retrieval ranking and reranking, context packing
  within token budgets, grounding and citation enforcement, staleness management,
  and evaluation of retrieval quality vs answer quality.
  Use when a task creates or modifies chunking logic, embedding pipelines, vector
  store configuration, retriever or reranker components, ingestion jobs, prompt
  templates that assemble retrieved context, or evaluation harnesses that measure
  retrieval recall/precision.
  Trigger phrases: rag pipeline, vector search, semantic retrieval, chunking
  strategy, embedding pipeline, reranker, citation grounding, ingestion job,
  knowledge base, document index.
  Do NOT use for general prompt engineering without retrieval (use llm-app-basics),
  multi-step tool orchestration (use tool-calling-patterns), or evaluation framework
  design unrelated to retrieval quality (use evals-design).
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
  domain: ai-agentic
  triggers: chunker, embedding pipeline, vector store, retriever, reranker, ingestion job, citation template, corpus config
  role: specialist
  scope: implementation
  output-format: code-and-review
  related-skills: llm-app-basics, tool-calling-patterns, evals-design, code-review
---

# RAG Patterns

## Core Workflow

1. **Define corpus boundaries before writing code.** Enumerate every source collection the system may query, its update cadence, access-control scope, and expected document count. Reject designs where the retriever silently crosses corpus boundaries or mixes tenants without explicit filtering metadata.
2. **Treat ingestion as a data-quality gate.** Validate source documents on entry: reject corrupt, empty, or duplicate content; normalize encoding and structure; extract and store metadata (source URI, timestamp, author, section hierarchy) alongside every chunk. Log ingestion failures with structured context so stale or missing documents are discoverable.
3. **Choose chunking strategy by content structure, not by default.** Evaluate fixed-size, sentence-boundary, recursive-character, semantic, and parent-child chunking against the actual corpus. Measure retrieval recall on a representative query set before committing to a strategy. Record chunk overlap size, maximum chunk tokens, and splitting heuristic in version-controlled configuration.
4. **Isolate the embedding pipeline.** Pin the embedding model version and dimensionality in configuration. Ensure re-indexing is reproducible: same document and same model version must produce the same vector. Track embedding model changes as breaking schema migrations that require full re-index.
5. **Configure retrieval and reranking as separate, tunable stages.** Set the initial retrieval top-k generously, then apply a reranker or cross-encoder to compress to the final top-n. Expose both k values and the similarity/score threshold as configuration, not hard-coded constants. Log retrieval scores alongside returned chunk IDs for observability.
6. **Pack context within an explicit token budget.** Allocate a fixed token band for retrieved chunks separate from system instructions and conversation history. When retrieved context exceeds the band, drop lowest-ranked chunks rather than truncating mid-chunk. Never silently overflow the model's context window.
7. **Enforce grounding and citation in the generation prompt.** Instruct the model to reference specific retrieved chunks by ID or source URI. Validate that every claim in the response maps to at least one retrieved chunk; surface unsupported claims as low-confidence or flag for human review. Do not allow the model to fabricate sources.
8. **Manage staleness explicitly.** Attach a freshness timestamp or version to every indexed chunk. Implement incremental re-ingestion for updated sources and tombstone or soft-delete for removed content. Surface the age of the oldest retrieved chunk in the response metadata so callers can assess currency.
9. **Evaluate retrieval quality and answer quality independently.** Measure retrieval recall, precision, and MRR against a labeled query set separate from end-to-end answer correctness. Track both metrics over time; a drop in retrieval quality is an early signal before answer quality degrades visibly.

## Reference Guide

| Topic | Reference | Load When |
|---|---|---|
| RAG delivery checklist | `references/checklist.md` | Any RAG feature, ingestion change, retrieval tuning, or retrieval-related review |

## Constraints

- Do not mix documents from different access-control scopes in a single unfiltered index; enforce tenant or permission metadata as a mandatory retrieval filter.
- Do not hard-code chunk size, overlap, top-k, or similarity thresholds in application logic; externalize to configuration so tuning does not require code changes.
- Do not assume embedding model compatibility across versions; treat any model change as a full re-index migration.
- Do not truncate retrieved chunks mid-sentence to fit a token budget; drop the lowest-ranked whole chunk instead.
- Do not ship retrieval changes without measuring recall and precision on a representative query set; gut-feel tuning is a production risk.
- Do not let the generation model cite sources it did not receive in context; validate every citation against the actual retrieved chunk set.
- Do not treat ingestion as a fire-and-forget job; monitor for failures, duplicates, and format drift, and surface ingestion health as an operational metric.
