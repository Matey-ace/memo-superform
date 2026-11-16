'use strict';
const assert=require('assert/strict');
const fs=require('fs');
const os=require('os');
const path=require('path');
const zlib=require('zlib');
const {spawnSync}=require('child_process');
const {validateMatrix,EXPECTED,ALLOWED_ERROR,LIGHT_EXCEPTIONS}=require('./baseline-matrix');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'memo-matrix-verify-'));
const folder=path.join(temp,'fixture');
fs.mkdirSync(folder);
// Minimal valid RGB PNG; fixture dimensions are 1x1, not 153 large screenshots.
function crc32(bytes){let c=0xffffffff;for(const x of bytes){c^=x;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return (c^0xffffffff)>>>0;}
function chunk(type,data){const t=Buffer.from(type),b=Buffer.alloc(data.length+12);b.writeUInt32BE(data.length);t.copy(b,4);data.copy(b,8);b.writeUInt32BE(crc32(Buffer.concat([t,data])),8+data.length);return b;}
const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(1,0);ihdr.writeUInt32BE(1,4);ihdr[8]=8;ihdr[9]=2;
const png=Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',ihdr),chunk('IDAT',zlib.deflateSync(Buffer.from([0,0,0,0]))),chunk('IEND',Buffer.alloc(0))]);
const expected=[{state:'layout-single',variant:'standard-light',width:1,height:1}];
function fixture(){
 const e=expected[0],key=`${e.state}@${e.variant}@1x1`;
 const row={...e,file:'fixture/'+key+'.png',metricsFile:'fixture/'+key+'.json',errors:[],metrics:{theme:'standard',bodyClass:'standard-mode',overflow:false,scrollWidth:1,clientWidth:1,keys:{'#welcomeOverlay':[{visible:false}]}}};
 return {rows:[row],failures:[]};
}
function files(m){for(const r of m.rows){fs.writeFileSync(path.join(temp,r.file),png);fs.writeFileSync(path.join(temp,r.metricsFile),JSON.stringify(r));}}
let count=0;
function check(name,mutate,ok=false){const m=fixture();if(mutate)mutate(m);files(m);const result=validateMatrix(folder,m,expected);assert.equal(result.ok,ok,name+': '+JSON.stringify(result));count++;console.log('PASS',name);}
try{
 check('correct minimal fixture',null,true);
 check('only exact known 401 allowed',m=>m.rows[0].errors.push(ALLOWED_ERROR),true);
 check('empty set rejected',m=>m.rows=[]);
 check('duplicate rejected',m=>m.rows.push(structuredClone(m.rows[0])));
 check('missing combination rejected',m=>m.rows[0].state='settings');
 check('overflow rejected',m=>m.rows[0].metrics.overflow=true);
 check('actual numeric overflow rejected',m=>m.rows[0].metrics.scrollWidth=2);
 check('wrong dark state rejected',m=>m.rows[0].metrics.bodyClass+=' dark');
 check('wrong theme rejected',m=>m.rows[0].metrics.theme='notebook');
 check('welcome visible rejected',m=>m.rows[0].metrics.keys['#welcomeOverlay'][0].visible=true);
 check('missing welcome metrics rejected',m=>delete m.rows[0].metrics.keys['#welcomeOverlay']);
 check('pageerror rejected',m=>m.rows[0].errors.push('pageerror: boom'));
 check('unapproved console rejected',m=>m.rows[0].errors.push('console: something failed'));
 check('near-match 401 rejected',m=>m.rows[0].errors.push(ALLOWED_ERROR+' extra'));
 check('capture failures rejected',m=>m.failures.push({error:'failed action'}));
 for(const [name,action] of [
  ['missing PNG',m=>fs.unlinkSync(path.join(temp,m.rows[0].file))],
  ['empty PNG',m=>fs.writeFileSync(path.join(temp,m.rows[0].file),'')],
  ['corrupt PNG',m=>fs.writeFileSync(path.join(temp,m.rows[0].file),'not a PNG')],
  ['truncated PNG',m=>fs.writeFileSync(path.join(temp,m.rows[0].file),png.subarray(0,40))],
  ['wrong PNG size',m=>{const b=Buffer.from(png);b.writeUInt32BE(2,16);fs.writeFileSync(path.join(temp,m.rows[0].file),b);}],
  ['missing sidecar',m=>fs.unlinkSync(path.join(temp,m.rows[0].metricsFile))],
  ['invalid sidecar JSON',m=>fs.writeFileSync(path.join(temp,m.rows[0].metricsFile),'{')]
 ]){const m=fixture();files(m);action(m);assert.equal(validateMatrix(folder,m,expected).ok,false,name);count++;console.log('PASS',name);}
 assert.equal(EXPECTED.length,153);assert.equal(new Set(EXPECTED.map(r=>`${r.state}@${r.variant}@${r.width}x${r.height}`)).size,153);assert.equal(LIGHT_EXCEPTIONS.length,6);count++;console.log('PASS exact 153 combinations and six explicit historical exceptions');
 const m=fixture();files(m);fs.writeFileSync(path.join(folder,'matrix.json'),JSON.stringify(m));
 const script=path.join(__dirname,'baseline-matrix.js'),untouched=path.join(temp,'must-not-be-created');
 const before=fs.readFileSync(path.join(folder,'matrix.json'));
 // No piped stdio: Windows sandbox may reject named pipes.
 const child=spawnSync(process.execPath,[script,'--out',untouched,'--verify',folder],{stdio:'ignore'});
 if(child.error)throw child.error;
 assert.equal(child.status,1,'CLI rejects incomplete real matrix');assert.equal(fs.existsSync(untouched),false,'--verify must not create --out');assert.deepEqual(fs.readFileSync(path.join(folder,'matrix.json')),before,'--verify must not overwrite input');count++;console.log('PASS CLI exit1 and no filesystem writes');
 console.log('MATRIX_VERIFY_SELFTEST_PASS',count);
} finally {fs.rmSync(temp,{recursive:true,force:true});}
