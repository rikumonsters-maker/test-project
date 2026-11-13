import test from 'node:test';
import assert from 'node:assert/strict';
import {detectCardRegions,extractCardCandidates} from './calendar-card-regions.mjs';
test('rectangle detection isolates a filled card from the page',()=>{
  const width=400,height=300,data=new Uint8ClampedArray(width*height*4).fill(255);
  for(let y=100;y<200;y++)for(let x=100;x<300;x++){const i=(y*width+x)*4;data[i]=180;data[i+1]=220;data[i+2]=190;}
  assert.deepEqual(detectCardRegions({data,width,height}),[{x0:100,y0:100,x1:300,y1:200}]);
});
test('a separate title and range inside a bounded card preserve a yearless date',()=>{
  const line=(text,x0,y0,x1,y1)=>({text,confidence:95,bbox:{x0,y0,x1,y1}});
  const parsed=extractCardCandidates({lines:[line('11月18日（水）',150,10,280,40),line('ソフトウェア 締切',120,110,290,130),line('20:00-21:00',120,150,250,180)]},[{x0:100,y0:100,x1:300,y1:200}]);
  assert.equal(parsed.candidates.length,1);
  assert.deepEqual(parsed.candidates.map(c=>[c.title,c.month,c.day,c.date,c.start,c.end]),[['ソフトウェア 締切',11,18,'','20:00','21:00']]);
});
test('dark card geometry and unrelated columns never merge',()=>{
  const width=400,height=300,data=new Uint8ClampedArray(width*height*4);
  for(let i=0;i<data.length;i+=4){data[i]=data[i+1]=data[i+2]=20;data[i+3]=255;}
  for(let y=100;y<200;y++)for(let x=100;x<300;x++){const i=(y*width+x)*4;data[i]=65;data[i+1]=90;data[i+2]=80;}
  assert.equal(detectCardRegions({data,width,height}).length,1);
  const l=(text,x,y)=>({text,confidence:95,bbox:{x0:x,x1:x+80,y0:y,y1:y+20}});
  const region={x0:100,y0:100,x1:300,y1:200};
  assert.equal(extractCardCandidates({lines:[l('11月18日',170,10),l('20:00-21:00',110,150),l('別カード',310,120)]},[region]).candidates.length,0);
  assert.equal(extractCardCandidates({lines:[l('11月18日',170,10),l('11月19日',170,40),l('20:00-21:00',110,150),l('会議',110,120)]},[region]).candidates.length,0);
});
