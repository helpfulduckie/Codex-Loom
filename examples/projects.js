'use strict';


const PROJECTS = [
  {
    name: 'showcase',
    dir: 'showcase',
    reports: ['seed-map', 'body-sizes', 'lint', 'overview', 'leaf-review'],
    compileReports: ['inventory', 'schemaTables'],
  },
  {
    name: 'variants-and-fieldops',
    dir: 'variants-and-fieldops',
    reports: [],
    compileReports: [],
  },
  {
    name: 'roles-and-pronouns',
    dir: 'roles-and-pronouns',
    reports: [],
    compileReports: [],
  },
  {
    name: 'tiers-and-mods',
    dir: 'tiers-and-mods',
    reports: [],
    compileReports: [],
  },
];

const CONFIG_NAME = 'compile.cl.yaml';
const SOURCE_SUBDIR = '.';
const OUTPUT_SUBDIR = 'output';
const BASELINE_SUBDIR = 'output';
const REPORTS_SUBDIR = 'Review';

const REPORTS_IN_PLACE = true;

module.exports = {
  PROJECTS,
  CONFIG_NAME,
  SOURCE_SUBDIR,
  OUTPUT_SUBDIR,
  BASELINE_SUBDIR,
  REPORTS_SUBDIR,
  REPORTS_IN_PLACE,
};