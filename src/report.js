'use strict';

const path = require('path');

const { PATH_UNSAFE_CHARS } = require('./util');


function csvCell(value) {
  const s = String(value === undefined || value === null ? '' : value);
  return s.includes(',') || s.includes('"') || s.includes('\n')
    ? `"${s.replace(/"/g, '""')}"`
    : s;
}


const UNSAFE_FILENAME_CHARS = new RegExp('[' + PATH_UNSAFE_CHARS + ']', 'g');

function sanitizeFilename(name) {
  return name.replace(UNSAFE_FILENAME_CHARS, '_').trim();
}

const REPORT_CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;
const WINDOWS_DEVICE_STEM = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i;

function reportStem(name) {
  const stem = String(name == null ? '' : name)
    .replace(UNSAFE_FILENAME_CHARS, '_')
    .replace(REPORT_CONTROL_CHARS, '_')
    .replace(/[ .]+$/g, '');
  if (!stem || /^\.+$/.test(stem)) return '';
  return WINDOWS_DEVICE_STEM.test(stem) ? `_${stem}` : stem;
}

function reportIdentity(title, fallbackName) {
  const fallback = path.basename(String(fallbackName == null ? '' : fallbackName)).trim();
  const authored = typeof title === 'string' && title.trim() ? title.trim() : fallback;
  const label = authored || 'report';
  return { label, stem: reportStem(label) || reportStem(fallback) || 'report' };
}


function shiftHeadings(content, shift) {
  if (shift <= 0) return content;
  return content.replace(/^(#{1,6})(?= )/gm, (_, hashes) => {
    const newLevel = Math.min(hashes.length + shift, 6);
    return '#'.repeat(newLevel);
  });
}


function branchLabel(branchNames, rootDirName) {
  return branchNames.length > 0 ? branchNames.join(' - ') : rootDirName;
}


function leafFileName(branchNames, rootDirName, isSingleLeaf) {
  const fileBase = isSingleLeaf && branchNames.length === 0
    ? rootDirName
    : branchNames.join(' - ');
  return sanitizeFilename(fileBase || rootDirName) + '.leaf.md';
}

module.exports = {
  csvCell,
  sanitizeFilename,
  reportIdentity,
  reportStem,
  shiftHeadings,
  branchLabel,
  leafFileName,
};
