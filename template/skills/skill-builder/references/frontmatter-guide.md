# Frontmatter Guide

`SKILL.md` frontmatter is still recommended for client compatibility, but every new skill must also have a sibling `skill.json` manifest with the compact structured metadata.

Minimum fields:
- `name`
- `description`
- `allowed-tools`
- `metadata.author`
- `metadata.version`

Description pattern:
- what the skill does
- when to use (explicit trigger phrases)
- when NOT to use (negative triggers)

Example phrase block:
- Use for "api review", "contract review", "backward compatibility check".
- Do NOT use for UI style-only changes.
