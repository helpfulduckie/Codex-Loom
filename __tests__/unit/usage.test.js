'use strict';

const { createUsage, usageOf, withUsageCapture, withUsage, noteVariable, noteRole, serializeUsage } = require('../../src/usage');
const { groupUsage } = require('../../src/usageReport');

test('usage allocation requires capture and capture restores after failures', () => {
  expect(createUsage()).toBeNull();
  expect(usageOf({})).toBeNull();
  const subject = {};
  expect(() => withUsageCapture(true, () => {
    const record = usageOf(subject);
    expect(record).not.toBeNull();
    withUsage(record, () => { noteVariable('z'); noteVariable('a'); noteRole('guide'); });
    withUsageCapture(false, () => expect(usageOf({})).toBeNull());
    expect(createUsage()).not.toBeNull();
    throw new Error('stop');
  })).toThrow('stop');
  expect(createUsage()).toBeNull();
  expect(usageOf({})).toBeNull();
  expect(serializeUsage(usageOf(subject))).toEqual({ variables: ['a', 'z'], roles: ['guide'] });
});

test('usage groups identical reader sets independently for each binding', () => {
  const record = (leaf, kind, id, variables, roles = []) => ({ leaf, kind, id, uses: { variables, roles } });
  expect(groupUsage([
    record('B', 'item', 'Hero', ['place']), record('A', 'item', 'Hero', ['place']),
    record('C', 'section', 'plotEssential/intro', ['place'], ['guide']),
  ])).toEqual([
    { kind: 'role', name: 'guide', branches: ['C'], readers: [['section', 'plotEssential/intro']] },
    { kind: 'variable', name: 'place', branches: ['A', 'B'], readers: [['item', 'Hero']] },
    { kind: 'variable', name: 'place', branches: ['C'], readers: [['section', 'plotEssential/intro']] },
  ]);
});
