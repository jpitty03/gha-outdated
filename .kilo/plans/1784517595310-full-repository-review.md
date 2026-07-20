# Full Repository Review and Remediation Plan

## Goal and Decisions

Review and harden the `gha-outdated` Node CLI end to end: fix confirmed correctness and reliability defects, create deterministic unit/integration coverage, replace the unsafe demonstration workflow with real CI, add dependency automation, and make the package metadata and README match actual behavior.

- Keep production dependency-free and CommonJS-based.
- Target Node.js 20 and newer; test Node 20, 22, and 24.
- Support numeric refs (`v4`, `4`, `v4.1`, `v4.1.2`) and skip commit SHAs, branches, expressions, and custom refs with a visible reason.
- Compare only the precision pinned by the user: a floating `v4` is stale only when a newer major exists; a full version compares major/minor/patch. Never treat mere string inequality or a lower latest version as an update.
- Use exit code `0` for a complete clean check, `1` for confirmed outdated refs, and `2` for invalid usage or any incomplete/operational failure.
- Enforce at least 90% line coverage and 85% branch coverage.

## Confirmed Review Findings

- `bin/index.js:13-29` prints `Unknown command` for valid help and silently accepts unknown arguments when `--major` is also present.
- `bin/index.js:64` is line-regex based but mishandles quoted values, action subpaths, and reusable workflows; its captured ref can include quote punctuation.
- `bin/index.js:103-162` equates a different latest-release string with an upgrade, cannot distinguish floating major refs, misses repositories without GitHub releases, makes unauthenticated unbounded parallel requests without a timeout, and hides network/API/JSON failures as successful null results.
- `bin/index.js:199-225` repeats API work for different refs from the same repository and can print “all up to date” after partial failures.
- `.github/workflows/test.yml` is a live workflow rather than a fixture or test suite. It deliberately runs stale third-party actions, obsolete runtimes, secret-unlock code, and a tmate debugging action; it does not install or test this package.
- `package.json` has no scripts, engine contract, development tooling, package-content allowlist, or lockfile. `npm test` currently fails and `npm pack --dry-run` includes the workflow file.
- There are no tests, coverage reporting, lint/static checks, Dependabot configuration, or ignore rules for generated artifacts.
- `README.md` describes only `actions/checkout` despite broader matching, calls `.gitlab/workflows` a GitHub Actions source, omits authentication/rate-limit and exit-code behavior, and does not document limitations or development checks.
- `LICENSE:3` still contains the placeholder `Your Name`, inconsistent with the package author metadata.

## Implementation Steps

1. **Define testable CLI boundaries before changing behavior.**
   - Keep `bin/index.js` as a shebang wrapper that invokes the CLI and assigns `process.exitCode`; move implementation into focused CommonJS modules under `lib/` for argument parsing/orchestration, workflow discovery/reference parsing, numeric version comparison, and GitHub API access.
   - Inject the working directory, filesystem/request functions, environment, and output streams where needed so tests never depend on the developer's repository, live GitHub API, or global process mutation.
   - Preserve the existing command names and `-m`, `-M`, `--major`, `-h`, `-H`, and `--help` aliases. Help exits `0` without an unknown-command prefix; any unsupported argument exits `2` and does no scanning.

2. **Correct workflow discovery and reference extraction.**
   - Scan top-level `.yml` and `.yaml` files in `.github/workflows`; remove the misleading `.gitlab/workflows` default because GitLab CI does not use GitHub Actions workflow semantics.
   - Parse line-oriented `uses:` values with optional YAML quotes and trailing comments. Recognize `owner/repo@ref`, `owner/repo/subpath@ref`, and `owner/repo/.github/workflows/file.yml@ref`; use the first two path segments as the GitHub repository while retaining the full reference for output.
   - Explicitly ignore local (`./...`) and Docker (`docker://...`) actions. Deduplicate identical references while retaining enough source context to produce useful diagnostics.
   - Treat unreadable workflow files as operational failures rather than empty action lists. Keep “no workflow files” and “no supported action references” as successful, clearly worded outcomes.

3. **Implement deterministic version semantics.**
   - Add a small numeric parser for optional `v` prefixes and one-to-three numeric components; reject prereleases, SHAs, branches, expressions, malformed tags, and custom labels from comparison.
   - Compare major-only refs by major, major/minor refs by those components, and complete refs by semantic major/minor/patch ordering. `--major` filters findings to a strictly greater latest major.
   - Emit one concise skipped-reference notice and include checked, skipped, outdated, and failed counts in the final summary so unsupported refs cannot be mistaken for current refs.

4. **Harden GitHub API behavior.**
   - Query stable numeric repository tags, with bounded pagination, and choose the highest semantic version rather than trusting release date or string inequality; ignore floating duplicate tags and prereleases when selecting the highest concrete version.
   - Cache repository lookups so subpath actions or multiple refs from the same owner/repository cause one logical lookup. Limit request concurrency to a small fixed number to avoid bursts.
   - Send a descriptive user agent, GitHub JSON accept header, API-version header, and `Authorization: Bearer ...` when `GITHUB_TOKEN` is set. Never print the token.
   - Add a finite request timeout, response-size guard, and explicit handling for socket errors, invalid JSON, redirects if encountered, 404s, rate-limit responses, and other non-2xx statuses. Surface repository-specific diagnostics and use exit `2` if any lookup fails, even if other outdated refs were found.
   - Include actionable rate-limit guidance and response metadata where available; do not claim all actions are current after an incomplete check.

5. **Build the unit and integration test suite.**
   - Use `node:test` and `node:assert/strict`. Add fixture projects under `test/fixtures/`, including the useful stale-action examples currently embedded in the live workflow.
   - Unit-test argument aliases, valid help, mixed valid/invalid arguments, and the `0/1/2` exit contract.
   - Unit-test workflow discovery for both extensions, quoted/unquoted refs, comments, repeated refs, owner/repo subpaths, reusable workflows, local/Docker exclusions, malformed input, no workflows, and read failures.
   - Table-test version parsing/comparison for optional `v`, partial and full versions, equal/newer/older values, `--major`, prereleases, SHAs, branches, and malformed refs.
   - Test the GitHub client with stubbed responses for pagination, highest-version selection, authentication headers, cache reuse, success, no usable tags, 404, 403/rate limit, 5xx, timeout, socket failure, oversized body, and invalid JSON.
   - Add orchestration tests proving clean, outdated, skipped, and partial-failure summaries and proving no live network requests or direct `process.exit()` occur in imported code.
   - Add dev-only `c8` coverage and ESLint tooling, lock dependencies, and scripts for `test`, `coverage`, `lint`, and a combined `check`. Configure coverage to include all `lib/**/*.js` and fail below 90% lines or 85% branches (also set sensible 90% statement/function gates).

6. **Replace CI and secure repository automation.**
   - Replace `.github/workflows/test.yml` with a real CI workflow triggered by pull requests, pushes to `main`, and manual dispatch. Grant read-only contents permission, add job timeouts, use npm cache, run `npm ci`, and run the combined lint/test/coverage check across Node 20, 22, and 24.
   - Pin third-party workflow actions to reviewed immutable commit SHAs with version comments where practical; use current supported action releases at implementation time and avoid secrets, tmate, cross-compilation, and unrelated language setup.
   - Add `.github/dependabot.yml` with weekly, grouped updates for both `npm` and `github-actions`, targeting `main`, limiting open PRs, and using consistent commit-message prefixes. The npm ecosystem tracks dev tooling while GitHub Actions tracking keeps CI pins current.
   - Add `.gitignore` entries for `node_modules/`, coverage output, logs, and generated package tarballs.

7. **Align package and publishing metadata.**
   - Update `package.json` with `engines.node: >=20`, the new scripts/dev dependencies, and a `files` allowlist containing only runtime `bin/` and `lib/` content (npm automatically includes package metadata, README, and license). Point `main` at an import-safe library module rather than the executable side-effect entry point.
   - Generate and commit `package-lock.json`; keep the published runtime dependency count at zero. Do not bump the package version or publish as part of this review.
   - Replace the MIT license placeholder with the existing package author name (`Josh F.`), preserving the original 2023 copyright year.

8. **Rewrite README sections to match the reviewed contract.**
   - Describe scanning all repository-based GitHub Actions and reusable workflows, not only `actions/checkout`; remove GitLab claims.
   - Document Node 20+, installation, all options, `GITHUB_TOKEN`, authenticated/unauthenticated rate-limit behavior, supported numeric refs, skipped ref types, major-only precision, output examples, and exit codes `0`, `1`, and `2`.
   - Document zero runtime dependencies separately from development dependencies, read-only behavior, API/network limitations, and why immutable SHA refs are reported as skipped rather than incorrectly evaluated.
   - Add contributor commands for install, tests, lint, coverage thresholds, full checks, and package verification. Keep examples aligned with tests to prevent future documentation drift.

## Validation and Final Review

1. Run `npm ci`, `npm run lint`, `npm test`, `npm run coverage`, and `npm run check` on the minimum supported Node 20 runtime; repeat the combined check on Node 22 and 24 through CI.
2. Run fixture-backed CLI checks for help, invalid arguments, no workflows, clean refs, outdated refs, major-only filtering, unsupported refs, rate limiting, timeout, and partial API failure; verify exact exit codes and that no failure path reports “up to date.”
3. Run `npm audit` and review all direct/transitive dev dependencies; confirm `npm ls --omit=dev` reports no runtime packages.
4. Run `npm pack --dry-run` and inspect the manifest: include only `bin/`, `lib/`, `package.json`, `README.md`, and `LICENSE`; exclude tests, fixtures, workflows, coverage, and local tooling.
5. Validate `.github/workflows/*.yml` and `.github/dependabot.yml` syntax, least-privilege permissions, action pins, matrix coverage, and timeout settings.
6. Perform a final code review focused on parser edge cases, token redaction, bounded network/resource use, exit-code precedence, Windows/Linux path behavior, and README/CLI output consistency.

## Risks and Boundaries

- A dependency-free line parser is intentionally not a complete YAML parser; document unsupported YAML constructs and cover accepted forms with tests rather than pretending full YAML compliance.
- Tag conventions vary by repository. Only stable numeric tags are comparable; unsupported conventions are visible skips, while inability to complete an otherwise supported repository lookup is an exit-`2` failure.
- GitHub API tests remain fully stubbed. A live smoke test may be run manually with and without `GITHUB_TOKEN`, but it must not be required for deterministic CI.
- Version bumping, npm publication, automatic workflow rewriting, SHA-to-release comparison, and support for non-GitHub forges are out of scope.
