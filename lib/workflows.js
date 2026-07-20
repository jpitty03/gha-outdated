'use strict';

/**
 * Workflow discovery and `uses:` reference extraction.
 *
 * This is intentionally a line-oriented parser, not a full YAML parser.
 * It accepts optional single/double quotes and trailing `#` comments on
 * `uses:` lines, and recognizes `owner/repo@ref`, `owner/repo/subpath@ref`,
 * and reusable-workflow refs (`owner/repo/.github/workflows/file.yml@ref`).
 * Local (`./...`) and Docker (`docker://...`) actions are explicitly ignored.
 */

const path = require('path');

const USES_LINE = /^\s*(?:-\s*)?uses:\s*(\S.*)$/;
const NAME_SEGMENT = /^[A-Za-z0-9_.-]+$/;

/** Error thrown when a workflow file exists but cannot be read. */
class WorkflowReadError extends Error {
  constructor(filePath, cause) {
    super(`Unable to read workflow file ${filePath}: ${cause.message}`);
    this.name = 'WorkflowReadError';
    this.filePath = filePath;
  }
}

/**
 * Find top-level `.yml`/`.yaml` files in `.github/workflows` under `cwd`.
 *
 * @param {string} cwd
 * @param {{ fs?: typeof import('fs') }} [options]
 * @returns {string[]} absolute paths, sorted for deterministic output
 */
function findWorkflowFiles(cwd, options = {}) {
  const fs = options.fs || require('fs');
  const workflowDir = path.join(cwd, '.github', 'workflows');
  if (!fs.existsSync(workflowDir)) {
    return [];
  }
  return fs
    .readdirSync(workflowDir, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        (entry.name.endsWith('.yml') || entry.name.endsWith('.yaml'))
    )
    .map((entry) => path.join(workflowDir, entry.name))
    .sort();
}

/**
 * Extract the value portion of a `uses:` line, honoring optional quotes
 * and trailing comments. Returns `null` when the line is malformed.
 */
function parseUsesValue(raw) {
  const trimmed = raw.trim();
  for (const quote of ['"', "'"]) {
    if (trimmed.startsWith(quote)) {
      const end = trimmed.indexOf(quote, 1);
      if (end === -1) {
        return null;
      }
      const rest = trimmed.slice(end + 1).trim();
      if (rest !== '' && !rest.startsWith('#')) {
        return null;
      }
      return trimmed.slice(1, end) || null;
    }
  }
  const match = /^([^\s#]+)\s*(?:#.*)?$/.exec(trimmed);
  if (match) {
    return match[1];
  }
  // Workflow expressions may contain spaces, e.g.
  // `uses: owner/repo@${{ inputs.version }}` — accept them so the
  // reference can be classified (and skipped) as an expression ref.
  const expressionMatch = /^([^\s#]*\$\{\{.*?\}\}[^\s#]*)\s*(?:#.*)?$/.exec(
    trimmed
  );
  return expressionMatch ? expressionMatch[1] : null;
}

/**
 * Extract action references from workflow file content.
 *
 * @param {string} content
 * @returns {Array<{ uses: string, kind: 'action'|'local'|'docker'|'malformed', repo?: string, ref?: string }>}
 */
function extractReferences(content) {
  const references = [];
  for (const line of content.split(/\r?\n/)) {
    const lineMatch = USES_LINE.exec(line);
    if (!lineMatch) {
      continue;
    }
    const value = parseUsesValue(lineMatch[1]);
    if (value === null) {
      references.push({ uses: lineMatch[1].trim(), kind: 'malformed' });
      continue;
    }
    if (value.startsWith('./') || value === '.') {
      references.push({ uses: value, kind: 'local' });
      continue;
    }
    if (value.startsWith('docker://')) {
      references.push({ uses: value, kind: 'docker' });
      continue;
    }
    const atIndex = value.lastIndexOf('@');
    if (atIndex <= 0 || atIndex === value.length - 1) {
      references.push({ uses: value, kind: 'malformed' });
      continue;
    }
    const spec = value.slice(0, atIndex);
    const ref = value.slice(atIndex + 1);
    const segments = spec.split('/');
    if (
      segments.length < 2 ||
      !NAME_SEGMENT.test(segments[0]) ||
      !NAME_SEGMENT.test(segments[1])
    ) {
      references.push({ uses: value, kind: 'malformed' });
      continue;
    }
    references.push({
      uses: value,
      kind: 'action',
      repo: `${segments[0]}/${segments[1]}`,
      ref,
    });
  }
  return references;
}

/**
 * Read every workflow file and collect deduplicated references with their
 * source files. Unreadable files raise {@link WorkflowReadError} so partial
 * scans are never mistaken for complete ones.
 *
 * @param {string[]} files
 * @param {{ fs?: typeof import('fs') }} [options]
 * @returns {Array<{ uses: string, kind: string, repo?: string, ref?: string, files: string[] }>}
 */
function collectReferences(files, options = {}) {
  const fs = options.fs || require('fs');
  const byUses = new Map();
  for (const file of files) {
    let content;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch (error) {
      throw new WorkflowReadError(file, error);
    }
    for (const reference of extractReferences(content)) {
      const existing = byUses.get(reference.uses);
      if (existing) {
        if (!existing.files.includes(file)) {
          existing.files.push(file);
        }
      } else {
        byUses.set(reference.uses, { ...reference, files: [file] });
      }
    }
  }
  return [...byUses.values()];
}

module.exports = {
  WorkflowReadError,
  findWorkflowFiles,
  parseUsesValue,
  extractReferences,
  collectReferences,
};
