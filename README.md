# gha-outdated

`gha-outdated` is a zero-dependency command-line tool that scans the GitHub Actions workflow files in your repository and reports any actions pinned to an outdated version.

It reads every `.yml`/`.yaml` file in `.github/workflows/`, extracts each `uses:` reference (including reusable workflows like `owner/repo/.github/workflows/file.yml@ref`), queries the GitHub API for the latest release tag of each referenced repository, and compares it against the version you have pinned.

## Highlights

- **Zero configuration** — works out of the box with no setup
- **No runtime dependencies** — uses only the Node.js standard library
- **Fast** — version lookups run in parallel with bounded concurrency
- **Clear output** — outdated actions, skipped refs, and failures are reported separately with reasons
- **Non-invasive** — read-only; never modifies your files
- **CI-friendly** — meaningful exit codes for scripting

## Requirements

- Node.js 20 or newer

## Installation

Run it directly with `npx` (no install needed):

```bash
npx gha-outdated
```

Or install globally:

```bash
npm install -g gha-outdated
gha-outdated
```

## Usage

```bash
npx gha-outdated [options]
```

Options:

| Option | Description |
| ------ | ----------- |
| `-m`, `-M`, `--major` | Only report actions whose latest version is a newer **major** release |
| `-v`, `-V`, `--version` | Print the installed version |
| `-h`, `-H`, `--help` | Show usage help |

### Example output

```
Checking for outdated GitHub Actions...
Found 1 workflow file(s).
Found 3 unique reference(s); checking 3.

Outdated actions:
-----------------
actions/checkout@v1 (MAJOR UPDATE)
  current: v1 -> latest: v4.2.2

Summary: 3 checked, 1 outdated, 0 skipped, 0 failed.
```

### What gets skipped

Some references cannot be meaningfully compared against a latest release and are listed as skipped with a reason:

- Local actions (`./path/to/action`)
- Docker image references (`docker://image:tag`)
- Refs pinned to a commit SHA
- Refs using workflow expressions (`${{ ... }}`)
- Branch refs and other non-numeric versions (e.g. `@main`)
- Malformed `uses:` values

## Authentication and rate limits

The tool works without any credentials, but unauthenticated GitHub API requests are limited to 60 per hour. If you hit the rate limit (or scan many actions), set a `GITHUB_TOKEN` environment variable to use authenticated requests with a much higher limit:

```bash
GITHUB_TOKEN=ghp_yourtoken npx gha-outdated
```

The token is only sent to the GitHub API and is never printed.

## Exit codes

| Code | Meaning |
| ---- | ------- |
| `0` | All checked actions are up to date (or nothing to check) |
| `1` | At least one outdated action was found |
| `2` | Invalid usage, or the check could not be completed (e.g. network failure, rate limit) |

## Contributing

```bash
npm ci            # install dev dependencies
npm run lint      # ESLint
npm test          # node:test suite
npm run coverage  # tests with c8 coverage thresholds
npm run check     # lint + coverage (what CI runs)
```

## License

This project is licensed under the [MIT License](LICENSE).
