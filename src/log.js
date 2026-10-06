'use strict';


const noop = () => {};

const NULL_LOG = Object.freeze({ info: noop, verbose: noop });

module.exports = { NULL_LOG };
