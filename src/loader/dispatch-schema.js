'use strict';

const { TYPES } = require('../schema');

const DISPATCH = { type: TYPES.RECORD, of: { type: TYPES.MAP, keys: {} } };
DISPATCH.of.keys.branches = DISPATCH;

module.exports = { DISPATCH };
