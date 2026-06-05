const DATE_RE = /^\d{4}(-\d{2})?(-\d{2})?$/;
const NUMERIC_SIGNAL_RE = /(^|[^a-zA-Z])(\$?\d[\d,.]*(\.\d+)?\s?(%|bps|m|mm|b|bn|k|trillion|billion|million)?|\d+\s?x)([^a-zA-Z]|$)/i;

export function isFact(value) {
  return Boolean(
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.prototype.hasOwnProperty.call(value, 'value')
  );
}

export function makeFact({ value, asOf, sourceLabel, sourceUrl, note }) {
  if (value === undefined || value === null || value === '') throw userErr('add-fact requires --value');
  if (!asOf) throw userErr('add-fact requires --asOf YYYY-MM-DD, YYYY-MM, or YYYY');
  if (!DATE_RE.test(String(asOf))) throw userErr('--asOf must be YYYY-MM-DD, YYYY-MM, or YYYY');
  if (!sourceLabel && !sourceUrl) throw userErr('add-fact requires --source-label or --source-url');

  return clean({
    value: String(value),
    asOf: String(asOf),
    source: clean({ label: sourceLabel, url: sourceUrl }),
    note,
  });
}

export function auditCanvasFacts(canvas) {
  const issues = [];
  for (const node of canvas.nodes ?? []) {
    const metadata = node.metadata && typeof node.metadata === 'object' && !Array.isArray(node.metadata)
      ? node.metadata
      : {};

    for (const [key, value] of Object.entries(metadata)) {
      if (isFact(value)) {
        if (!value.asOf || !DATE_RE.test(String(value.asOf))) {
          issues.push(issue(node.id, key, 'fact is missing a valid asOf date'));
        }
        if (!value.source || (!value.source.label && !value.source.url)) {
          issues.push(issue(node.id, key, 'fact is missing source label/url'));
        }
        continue;
      }

      if (looksQuantitative(value)) {
        issues.push(issue(node.id, key, 'numeric-looking metadata should be stored as a fact with value, asOf, and source'));
      }
    }
  }

  return { ok: issues.length === 0, issues };
}

export function looksQuantitative(value) {
  if (typeof value === 'number') return true;
  if (typeof value !== 'string') return false;
  return NUMERIC_SIGNAL_RE.test(value);
}

function issue(nodeId, key, message) {
  return { nodeId, key, message };
}

function clean(obj) {
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined && value !== null && value !== '') out[key] = value;
  }
  return out;
}

function userErr(msg) {
  const error = new Error(msg);
  error.isUserError = true;
  return error;
}
