# Skill Template

Use this skeleton for each new specialist skill.

## `skill.json`

```json
{
  "id": "<skill-id>",
  "name": "<Skill Name>",
  "summary": "<what it does in one compact sentence>",
  "tags": ["<domain>", "<area>"],
  "aliases": ["<trigger phrase 1>", "<trigger phrase 2>"],
  "references": ["<checklist>.md"],
  "cost_hint": "low",
  "priority": 50,
  "autoload": "manual"
}
```

## `SKILL.md`

```md
---
name: <skill-name>
description: <what it does + when to use + trigger phrases + negative trigger>
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash(*)
  - Write
metadata:
  author: <team>
  version: 1.0.0
---

# <Skill Name>

## Required Inputs
- ...

## Review Workflow
1. ...

## Mandatory Output Format
1. Findings by severity with file references.
2. Checklist rows with `rule_id`, `status`, `evidence`.
3. Residual risks.
4. Explicit verdict token.

## Hard Fail Conditions
- ...

## Evidence Rules
- ...
```
