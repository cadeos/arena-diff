/**
 * TEI P5 diff export — add/del/subst markup and XML escaping.
 */

import { ArenaDiff, toTeiDiff } from '../src/index.js';

const differ = new ArenaDiff();
await differ.init();

const textA = 'The quick brown fox.';
const textB = 'The quick red fox jumps.';
const result = await differ.compare(textA, textB);

const fragment = toTeiDiff(result);
if (!fragment.includes('<subst><del>brown</del><add>red</add></subst>')) {
  throw new Error('expected substitution wrapped in <subst>');
}
if (!fragment.includes('<add>jumps</add>')) {
  throw new Error('expected trailing insertion in <add>');
}
if (fragment.includes('<ins>')) {
  throw new Error('TEI export must not use HTML <ins> tags');
}

const xssA = 'safe <script>alert(1)</script> text';
const xssB = 'safe text';
const xssResult = await differ.compare(xssA, xssB);
const xssTei = toTeiDiff(xssResult);
if (xssTei.includes('<script>') || xssTei.match(/<script[\s>]/)) {
  throw new Error('TEI export must escape user text');
}
if (!xssTei.includes('&lt;') || !xssTei.includes('&gt;')) {
  throw new Error('expected escaped angle brackets in TEI export');
}

const doc = toTeiDiff(result, { wrapDocument: true, title: 'Revision' });
if (!doc.startsWith('<?xml version="1.0"')) {
  throw new Error('wrapDocument should emit a TEI XML declaration');
}
if (!doc.includes('xmlns="http://www.tei-c.org/ns/1.0"')) {
  throw new Error('wrapDocument should use the TEI namespace');
}
if (!doc.includes('<title>Revision</title>')) {
  throw new Error('wrapDocument should include the requested title');
}

console.log('OK — toTeiDiff fragment and document');
