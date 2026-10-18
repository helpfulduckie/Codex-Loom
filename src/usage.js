'use strict';

/**
 * Which variables and roles the text being resolved reads.
 *
 * Variables expand in `resolveVariables` and roles in `resolveRole`, each reached from many
 * call sites that know nothing of what they are rendering for. So the caller that does know
 * names a subject for the duration of its work, and the two resolvers note against whichever
 * subject is current. With no subject named, nothing is recorded.
 */

let current = null;
let enabled = false;
const bySubject = new WeakMap();

function createUsage() {
  return enabled ? { variables: new Set(), roles: new Set() } : null;
}

function withUsageCapture(capture, fn) {
  const outer = enabled;
  const outerCurrent = current;
  enabled = !!capture;
  current = null;
  try { return fn(); } finally { enabled = outer; current = outerCurrent; }
}

/** The usage record for an item or other object, made on first request. */
function usageOf(subject) {
  if (!bySubject.has(subject)) {
    const record = createUsage();
    if (!record) return null;
    bySubject.set(subject, record);
  }
  return bySubject.get(subject);
}

/** Run `fn` with every variable and role it resolves noted against `usage`. */
function withUsage(usage, fn) {
  const outer = current;
  current = usage;
  try {
    return fn();
  } finally {
    current = outer;
  }
}

function noteVariable(name) {
  if (current) current.variables.add(String(name));
}

function noteRole(name) {
  if (current) current.roles.add(String(name));
}

function serializeUsage(usage) {
  if (!usage) return null;
  const names = (set) => [...set].sort((a, b) => a.localeCompare(b));
  return { variables: names(usage.variables), roles: names(usage.roles) };
}

module.exports = { createUsage, withUsageCapture, usageOf, withUsage, noteVariable, noteRole, serializeUsage };
