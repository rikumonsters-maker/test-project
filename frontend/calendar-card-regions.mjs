import { extractCalendarCandidates } from './screenshot-calendar-ocr.mjs';

// Connected, nearly uniform rectangular fills provide evidence independent of
// OCR reading order. Text islands and page-sized backgrounds are rejected.
export function detectCardRegions({data,width,height}, diagnostics = null) {
  if(diagnostics)Object.assign(diagnostics,{width,height,components:0,rejectedSize:0,rejectedFill:0,cards:0});
  const step=4, cols=Math.ceil(width/step), rows=Math.ceil(height/step);
  const seen=new Uint8Array(cols*rows), regions=[];
  const pixel=i=>{const x=(i%cols)*step,y=Math.floor(i/cols)*step;return (y*width+x)*4;};
  for(let seed=0;seed<seen.length;seed++) {
    if(seen[seed])continue;
    const p=pixel(seed), rgb=[data[p],data[p+1],data[p+2]], queue=[seed];seen[seed]=1;
    let minX=cols,maxX=0,minY=rows,maxY=0;
    for(let n=0;n<queue.length;n++) {
      const i=queue[n],x=i%cols,y=Math.floor(i/cols);
      minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);
      for(const [nx,ny] of [[x-1,y],[x+1,y],[x,y-1],[x,y+1]]) {
        if(nx<0||nx>=cols||ny<0||ny>=rows)continue;
        const next=ny*cols+nx;if(seen[next])continue;
        const q=pixel(next);
        if(rgb.every((value,c)=>Math.abs(value-data[q+c])<=18)) {seen[next]=1;queue.push(next);}
      }
    }
    const w=(maxX-minX+1)*step,h=(maxY-minY+1)*step;
    if(diagnostics)diagnostics.components++;
    if(!(w>=120&&h>=60&&w<width*.85&&h<height*.8)){if(diagnostics)diagnostics.rejectedSize++;continue;}
    if(queue.length/((maxX-minX+1)*(maxY-minY+1))<=.8){if(diagnostics)diagnostics.rejectedFill++;continue;}
    regions.push({x0:minX*step,y0:minY*step,x1:Math.min(width,(maxX+1)*step),y1:Math.min(height,(maxY+1)*step)});
    if(diagnostics)diagnostics.cards++;
  }
  return regions;
}

export function extractCardCandidates(data, regions) {
  const lines=data.lines || (data.blocks||[]).flatMap(b=>(b.paragraphs||[]).flatMap(p=>p.lines||[]));
  const candidates=[];
  for(const region of regions) {
    const contained=box=>box&&box.x0>=region.x0&&box.x1<=region.x1&&box.y0>=region.y0&&box.y1<=region.y1;
    // Sparse OCR can put an axis tick and card text in one line. Clip by word
    // coordinates before grouping; never move the axis token into the card.
    const inside=lines.flatMap(line=>{
      if(contained(line.bbox))return [line];
      const words=(line.words||[]).filter(word=>contained(word.bbox));
      if(words.length)return [{...line,text:words.map(word=>word.text).join(' '),bbox:{x0:Math.min(...words.map(w=>w.bbox.x0)),x1:Math.max(...words.map(w=>w.bbox.x1)),y0:Math.min(...words.map(w=>w.bbox.y0)),y1:Math.max(...words.map(w=>w.bbox.y1))}}];
      return contained(line.bbox)?[line]:[];
    });
    if(!inside.length)continue;
    const headers=lines.filter(l=>l.bbox&&l.bbox.y1<region.y0&&/\d{1,2}\s*月\s*\d{1,2}\s*日/.test(l.text.normalize('NFKC'))&&l.bbox.x0<(region.x0+region.x1)/2&&l.bbox.x1>(region.x0+region.x1)/2);
    if(headers.length!==1)continue;
    const header=headers[0], md=/(\d{1,2})\s*月\s*(\d{1,2})\s*日/.exec(header.text.normalize('NFKC'));
    const times=inside.filter(l=>/\d{1,2}:\d{2}/.test(l.text));
    const titles=inside.filter(l=>!times.includes(l)&&/[\p{L}]/u.test(l.text)&&!/終日/.test(l.text)).sort((a,b)=>a.bbox.x0-b.bbox.x0);
    if(times.length!==1||!titles.length)continue;
    if(titles.some(l=>Math.abs(l.bbox.y0-titles[0].bbox.y0)>12))continue;
    const parsed=extractCalendarCandidates({lines:[{text:`${header.text} ${times[0].text} ${titles.map(l=>l.text).join(' ')}`,confidence:Math.min(...inside.map(l=>Number(l.confidence||0)))}]});
    for(const candidate of parsed.candidates) candidates.push({...candidate,month:Number(md[1]),day:Number(md[2]),weekday:header.text.match(/[（(]([日月火水木金土])[）)]/)?.[1]||''});
  }
  return {candidates,ignoredLineCount:Math.max(0,lines.length-candidates.length*3)};
}

export async function analyseCardImage(file,diagnostics = null) {
  const url=URL.createObjectURL(file),image=new Image();
  try {
    image.src=url;await image.decode();
    const canvas=document.createElement('canvas');canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;
    const context=canvas.getContext('2d',{willReadFrequently:true});context.drawImage(image,0,0);
    try {return detectCardRegions(context.getImageData(0,0,canvas.width,canvas.height),diagnostics);}
    finally {canvas.width=0;canvas.height=0;}
  } finally {image.src='';URL.revokeObjectURL(url);}
}

export async function recognizeCardRegions(file,regions,recognize) {
  const url=URL.createObjectURL(file),image=new Image(),lines=[];
  try {
    image.src=url;await image.decode();
    for(const region of regions.slice(0,20)) {
      const canvas=document.createElement('canvas');canvas.width=region.x1-region.x0;canvas.height=region.y1-region.y0;
      try {
        const ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.drawImage(image,-region.x0,-region.y0);
        const pixels=ctx.getImageData(0,0,canvas.width,canvas.height),p=pixels.data;
        const background=[p[0],p[1],p[2]];
        for(let i=0;i<p.length;i+=4){const ink=Math.max(...background.map((c,j)=>Math.abs(c-p[i+j])))>65; p[i]=p[i+1]=p[i+2]=ink?0:255;p[i+3]=255;}
        ctx.putImageData(pixels,0,0);
        const result=await recognize(canvas);
        const offset=box=>box?{x0:box.x0+region.x0,x1:box.x1+region.x0,y0:box.y0+region.y0,y1:box.y1+region.y0}:box;
        for(const block of result.data.blocks||[])for(const paragraph of block.paragraphs||[])for(const line of paragraph.lines||[])
          lines.push({...line,bbox:offset(line.bbox),words:(line.words||[]).map(w=>({...w,bbox:offset(w.bbox)}))});
      } finally {canvas.width=0;canvas.height=0;}
    }
    return lines;
  } finally {image.src='';URL.revokeObjectURL(url);}
}
