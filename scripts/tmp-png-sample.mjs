import fs from 'node:fs';
import zlib from 'node:zlib';
const buf=fs.readFileSync('artifacts/full-overview.png');
let off=8,w,h,depth,color,parts=[];
while(off<buf.length){const n=buf.readUInt32BE(off);const t=buf.toString('ascii',off+4,off+8);const d=buf.subarray(off+8,off+8+n);off+=12+n;if(t==='IHDR'){w=d.readUInt32BE(0);h=d.readUInt32BE(4);depth=d[8];color=d[9];}if(t==='IDAT')parts.push(d);if(t==='IEND')break;}
const raw=zlib.inflateSync(Buffer.concat(parts));const bpp=color===2?3:4,row=w*bpp;const out=Buffer.alloc(h*row);let p=0;
for(let y=0;y<h;y++){const f=raw[p++],cur=out.subarray(y*row,(y+1)*row),prev=y?out.subarray((y-1)*row,y*row):null;for(let x=0;x<row;x++){const a=x>=bpp?cur[x-bpp]:0,b=prev?prev[x]:0,c=prev&&x>=bpp?prev[x-bpp]:0;let v=raw[p++];if(f===1)v=(v+a)&255;else if(f===2)v=(v+b)&255;else if(f===3)v=(v+Math.floor((a+b)/2))&255;else if(f===4){const q=a+b-c,pa=Math.abs(q-a),pb=Math.abs(q-b),pc=Math.abs(q-c);v=(v+(pa<=pb&&pa<=pc?a:pb<=pc?b:c))&255;}cur[x]=v;}}
console.log({w,h,depth,color});for(const x of [50,100,400,800,1000]){console.log('x',x,[0,200,400,600,800,1000,1200,1400,1600,1800,2000,2200,2400].filter(y=>y<h).map(y=>[y,[out[y*row+x*bpp],out[y*row+x*bpp+1],out[y*row+x*bpp+2]]]));}
