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
const bySubject = new WeakMap();

/** The usage record for an item or other object, made on first request. */
function usageOf(subject) {
  if (!bySubject.has(subject)) bySubject.set(subject, { variables: new Set(), roles: new Set() });
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

module.exports = { usageOf, withUsage, noteVariable, noteRole };
