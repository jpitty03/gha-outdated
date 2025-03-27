# gha-outdated

gha-outdated is a simple command-line tool that scans your GitHub Actions workflows (YAML format) and checks whether the actions/checkout version used is outdated.

It looks for lines like:

```
uses: actions/checkout@vX
```

in your workflow files. By default, it checks:

- `.github/workflows`
- `.gitlab/workflows`

 Then queries the GitHub API to get the latest tag from the [actions/*](https://github.com/actions) repository or other custom actions, and reports if your declared version is outdated.

## Benefits

- Zero Configuration: Works out of the box with no setup

- No Dependencies: Uses only Node.js standard library

- Fast Execution: Checks multiple actions in parallel

- Simple Output: Clear display of what needs to be updated

- Non-Invasive: Read-only operation, doesn't modify your files

## Installation

This tool is published to npm. You can use npx to run it:

```bash
npx gha-outdated
```

## Usage

Run the tool without any options:

```bash
npx gha-outdated
```

It will scan your workflow files, compare the declared checkout version with the latest available version, and then output whether your version is up-to-date.

### Major Version Check

If you want to only check for major version updates (for example, if you only care whether you're using the latest major version rather than a precise semver), add the `-m` flag:

```bash
npx gha-outdated -m
```

or

```bash
npx gha-outdated -M
```

This flag applies a major-version-only comparison.

## How It Works

1. Reads the Githubs/Gitlab Actions workflow folder:
   - `./.github/workflows/*`
   - `./.gitlab/workflows/*`

2. Extracts all lines that use:

   ```
   uses: actions/checkout@<version>
   ```

3. Calls the GitHub API to retrieve the latest tag from the [actions/checkout](https://github.com/actions/checkout) repository.

4. Compares the declared version(s) with the latest available version and outputs whether each is outdated.



## License

This project is licensed under the MIT License.
