'use strict';
// Reuse the component assertions, directing only evidence to a new directory.
const fs = require('fs');
const path = require('path');
const Module = require('module');
const root = path.resolve(__dirname, '../..');
const file = path.join(root, 'docs/redesign/sa4/fixes-round1/verify.cjs');
const out = path.resolve(process.argv[2] || path.join(root, 'docs/redesign/sa4/lead-round1-review'));
if (fs.existsSync(out)) throw new Error('Refuse evidence overwrite: ' + out);
fs.mkdirSync(out, { recursive:true });
let source = fs.readFileSync(file, 'utf8');
source = source.replace('const OUT=__dirname', 'const OUT=' + JSON.stringify(out));
source = source.replace("path.join(OUT,'components-before.css')", JSON.stringify(path.join(path.dirname(file), 'components-before.css')));
const execution = new Module(file);
execution.filename = file;
execution.paths = Module._nodeModulePaths(path.dirname(file));
execution._compile(source, file);
