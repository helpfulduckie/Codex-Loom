'use strict';


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
  shiftHeadings,
  branchLabel,
  leafFileName,
};
