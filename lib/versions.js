'use strict';

/**
 * Numeric version reference parsing and comparison.
 *
 * Supported refs: an optional `v` prefix followed by one to three numeric
 * components (`v4`, `4`, `v4.1`, `v4.1.2`). Everything else (commit SHAs,
 * branches, expressions, prereleases, malformed tags, custom labels) is
 * excluded from comparison and classified so callers can surface the reason.
 */

const NUMERIC_REF = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/;
const COMMIT_SHA = /^[0-9a-f]{7,40}$/i;

/**
 * Parse a numeric version ref. Returns `null` when the ref is not a
 * supported numeric version.
 *
 * @param {string} ref
 * @returns {{ major: number, minor: number|null, patch: number|null, precision: 1|2|3 }|null}
 */
function parseVersion(ref) {
  if (typeof ref !== 'string') {
    return null;
  }
  const match = NUMERIC_REF.exec(ref.trim());
  if (!match) {
    return null;
  }
  const major = Number.parseInt(match[1], 10);
  const minor = match[2] === undefined ? null : Number.parseInt(match[2], 10);
  const patch = match[3] === undefined ? null : Number.parseInt(match[3], 10);
  if (
    !Number.isSafeInteger(major) ||
    (minor !== null && !Number.isSafeInteger(minor)) ||
    (patch !== null && !Number.isSafeInteger(patch))
  ) {
    return null;
  }
  const precision = patch !== null ? 3 : minor !== null ? 2 : 1;
  return { major, minor, patch, precision };
}

/**
 * Classify a ref so skipped references can carry a human-readable reason.
 *
 * @param {string} ref
 * @returns {'numeric'|'commit-sha'|'expression'|'unsupported'}
 */
function classifyRef(ref) {
  if (parseVersion(ref)) {
    return 'numeric';
  }
  if (typeof ref === 'string' && ref.includes('${{')) {
    return 'expression';
  }
  if (typeof ref === 'string' && COMMIT_SHA.test(ref.trim())) {
    return 'commit-sha';
  }
  return 'unsupported';
}

/**
 * Full three-component comparison. Missing components are treated as 0;
 * ties are broken by precision so a concrete `v4.1.2` outranks a floating
 * `v4` alias of the same release line.
 *
 * @returns {number} negative, zero, or positive
 */
function compareVersions(a, b) {
  const fields = [
    [a.major, b.major],
    [a.minor || 0, b.minor || 0],
    [a.patch || 0, b.patch || 0],
  ];
  for (const [left, right] of fields) {
    if (left !== right) {
      return left - right;
    }
  }
  return a.precision - b.precision;
}

/**
 * Whether `latest` supersedes `current` at the precision the user pinned.
 * A floating `v4` is stale only when a newer major exists; `v4.1` compares
 * major/minor; `v4.1.2` compares major/minor/patch. A lower or equal latest
 * version is never an update.
 */
function isOutdated(current, latest) {
  if (latest.major !== current.major) {
    return latest.major > current.major;
  }
  if (current.precision === 1) {
    return false;
  }
  const latestMinor = latest.minor || 0;
  if (latestMinor !== current.minor) {
    return latestMinor > current.minor;
  }
  if (current.precision === 2) {
    return false;
  }
  return (latest.patch || 0) > current.patch;
}

/** Whether `latest` has a strictly greater major component. */
function isMajorUpdate(current, latest) {
  return latest.major > current.major;
}

module.exports = {
  parseVersion,
  classifyRef,
  compareVersions,
  isOutdated,
  isMajorUpdate,
};
