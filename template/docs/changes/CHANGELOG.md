# Change Log

Current baseline:

- runtime is Node-only
- lifecycle commands and gates run through `bin/garda.js`
- template content no longer ships shell lifecycle or gate entrypoints
- `record-review-result` can ingest reviewer output from stdin, but still persists the same canonical raw `*-review-output.md` artifact before verdict, routing, and receipt validation so direct ingest cannot bypass the review audit path

For source-level release notes, see the repository root `CHANGELOG.md`.
