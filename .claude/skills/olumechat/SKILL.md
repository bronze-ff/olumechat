```markdown
# olumechat Development Patterns

> Auto-generated skill from repository analysis

## Overview
This skill provides a comprehensive guide to the development patterns used in the `olumechat` JavaScript codebase. It covers coding conventions, deployment and CI/CD workflows, and testing practices. Whether you're onboarding or maintaining the project, this document will help you follow established standards and automate common tasks.

## Coding Conventions

### File Naming
- Use **camelCase** for filenames.
  - Example: `userProfile.js`, `messageHandler.js`

### Import Style
- Use **relative imports** for modules within the project.
  ```js
  import { fetchMessages } from './api/messages.js';
  ```

### Export Style
- Use **named exports**.
  ```js
  // In userUtils.js
  export function formatUserName(user) { ... }
  export function isActive(user) { ... }

  // In another file
  import { formatUserName, isActive } from './userUtils.js';
  ```

### Commit Messages
- Follow **conventional commit** format.
  - Prefixes: `fix`, `chore`
  - Example: `fix: correct user avatar rendering on profile page`

## Workflows

### Update Deployment Pipeline
**Trigger:** When you need to adjust deployment for new infrastructure, update Node.js versions, or change CI/CD behavior.  
**Command:** `/update-deployment`

1. Edit `.github/workflows/ci.yml` to adjust CI steps, environment variables, or add new jobs.
2. Update `Dockerfile` and/or `client/Dockerfile` for new Node.js versions, build arguments, or multi-stage builds.
3. Modify `client/nginx.conf` for asset caching or routing changes.
4. Update `server/docker-entrypoint.sh` or `server/scripts/migrar.js` for migration or boot logic.
5. Synchronize `package.json` engines fields and related `package-lock.json` if necessary.

**Files Involved:**
- `.github/workflows/ci.yml`
- `Dockerfile`
- `client/Dockerfile`
- `client/nginx.conf`
- `client/package.json`
- `client/package-lock.json`
- `server/docker-entrypoint.sh`
- `server/scripts/migrar.js`

#### Example: Updating Node.js Version in Dockerfile
```dockerfile
FROM node:18-alpine
# ...rest of Dockerfile
```

#### Example: Adding a New Job to CI Workflow
```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      # existing steps
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - run: npm run lint
```

---

### Fix Deployment Issues
**Trigger:** When a deployment or CI run fails, or after a code review points out issues in deployment configuration.  
**Command:** `/fix-deployment`

1. Edit `.github/workflows/ci.yml` to fix environment variables or job logic.
2. Update `client/Dockerfile` or `client/nginx.conf` to correct build arguments or caching.
3. Patch `server/scripts/migrar.js` for migration locking or error handling.
4. Synchronize related configuration in `client/src/pages` or other affected files.

**Files Involved:**
- `.github/workflows/ci.yml`
- `client/Dockerfile`
- `client/nginx.conf`
- `client/src/pages/Landing.jsx`
- `server/scripts/migrar.js`

#### Example: Fixing an Environment Variable in CI
```yaml
env:
  NODE_ENV: production
  API_URL: ${{ secrets.API_URL }}
```

#### Example: Correcting Asset Caching in Nginx
```nginx
location /static/ {
  expires 30d;
  add_header Cache-Control "public";
}
```

---

## Testing Patterns

- **Test files** use the `*.test.*` naming convention.
  - Example: `userUtils.test.js`
- **Testing framework** is not explicitly detected; inspect test files for framework usage.
- Place tests alongside the files they cover or in a dedicated `__tests__` directory.

#### Example Test File
```js
// userUtils.test.js
import { formatUserName } from './userUtils';

test('formats user name correctly', () => {
  expect(formatUserName({ first: 'Jane', last: 'Doe' })).toBe('Jane Doe');
});
```

## Commands

| Command             | Purpose                                                      |
|---------------------|--------------------------------------------------------------|
| /update-deployment  | Update deployment pipeline for new infra, Node.js, or CI/CD. |
| /fix-deployment     | Apply fixes to deployment, CI, or migration scripts.         |
```
