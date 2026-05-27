<!-- garda-agent-orchestrator:managed-start -->
# AGENTS.md

This file is managed by `garda-agent-orchestrator`.
At setup, source of truth is selected via `-SourceOfTruth` ({{SOURCE_OF_TRUTH_VALUES}}).
This is the generic root entrypoint surface. After setup, it either contains canonical routing index content or redirects to the selected source-of-truth file.
Use compact command protocol from `40-commands.md`: first `scan`, then `inspect`, then verbose `debug` only by exception.
<!-- garda-agent-orchestrator:managed-end -->
