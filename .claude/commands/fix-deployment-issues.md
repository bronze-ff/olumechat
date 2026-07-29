---
name: fix-deployment-issues
description: Workflow command scaffold for fix-deployment-issues in olumechat.
allowed_tools: ["Bash", "Read", "Write", "Grep", "Glob"]
---

# /fix-deployment-issues

Use this workflow when working on **fix-deployment-issues** in `olumechat`.

## Goal

Applies fixes to deployment pipeline, environment variables, migration scripts, and caching logic after review or failed deploys.

## Common Files

- `.github/workflows/ci.yml`
- `client/Dockerfile`
- `client/nginx.conf`
- `client/src/pages/Landing.jsx`
- `server/scripts/migrar.js`

## Suggested Sequence

1. Understand the current state and failure mode before editing.
2. Make the smallest coherent change that satisfies the workflow goal.
3. Run the most relevant verification for touched files.
4. Summarize what changed and what still needs review.

## Typical Commit Signals

- Edit .github/workflows/ci.yml to fix environment variables or job logic.
- Update client/Dockerfile or client/nginx.conf to correct build args or caching.
- Patch server/scripts/migrar.js for migration locking or error handling.
- Synchronize related configuration in client/src/pages or other affected files.

## Notes

- Treat this as a scaffold, not a hard-coded script.
- Update the command if the workflow evolves materially.