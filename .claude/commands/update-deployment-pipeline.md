---
name: update-deployment-pipeline
description: Workflow command scaffold for update-deployment-pipeline in olumechat.
allowed_tools: ["Bash", "Read", "Write", "Grep", "Glob"]
---

# /update-deployment-pipeline

Use this workflow when working on **update-deployment-pipeline** in `olumechat`.

## Goal

Updates deployment configuration, Dockerfiles, and CI workflows to support new deployment targets, environments, or policies.

## Common Files

- `.github/workflows/ci.yml`
- `Dockerfile`
- `client/Dockerfile`
- `client/nginx.conf`
- `client/package.json`
- `client/package-lock.json`

## Suggested Sequence

1. Understand the current state and failure mode before editing.
2. Make the smallest coherent change that satisfies the workflow goal.
3. Run the most relevant verification for touched files.
4. Summarize what changed and what still needs review.

## Typical Commit Signals

- Edit .github/workflows/ci.yml to adjust CI steps, environment variables, or add new jobs.
- Update Dockerfile and/or client/Dockerfile for new Node.js versions, build args, or multi-stage builds.
- Modify client/nginx.conf for asset caching or routing changes.
- Update server/docker-entrypoint.sh or scripts/migrar.js for migration or boot logic.
- Synchronize package.json engines fields and related package-lock.json if necessary.

## Notes

- Treat this as a scaffold, not a hard-coded script.
- Update the command if the workflow evolves materially.