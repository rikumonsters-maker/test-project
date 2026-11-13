import {test,expect} from '@playwright/test';
import {syntheticApi} from './synthetic-api.mjs';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';

for(const brand of ['apple','google']) test(`real OCR ${brand} separate-line card`,async({page})=>{
  test.setTimeout(180000);
  const api=syntheticApi({groups:[],personalSyncActive:false});await api.attach(page.context());
  await page.route('**/screenshot-calendar-import.mjs',route=>route.fulfill({contentType:'application/javascript',body:readFileSync(new URL('../screenshot-calendar-import.mjs',import.meta.url),'utf8').replace('const cardResult=extractCardCandidates(result.data,regions);','window.__syntheticCardAudit={data:result.data,regions}; const cardResult=extractCardCandidates(result.data,regions);')}));
  await page.goto('/');await page.locator('#account-open').click();
  await page.locator('#profile-data-management').evaluate(el=>{el.open=true;});
  await page.locator('#screenshot-import-open').click();
  const image=readFileSync(new URL(`./fixtures/${brand}-calendar-card.png`,import.meta.url));
  await page.evaluate(async base64=>{
    const {analyseCardImage}=await import('/calendar-card-regions.mjs');
    const stats={};await analyseCardImage(new Blob([Uint8Array.from(atob(base64),c=>c.charCodeAt(0))]),stats);
    window.__syntheticShapeStats=stats;
  },image.toString('base64'));

  await page.locator('#screenshot-import-file').setInputFiles({name:`${brand}.png`,mimeType:'image/png',buffer:image});
  await expect(page.locator('#screenshot-import-status')).toContainText(/候補/, {timeout:90000});
  const audit=await page.evaluate(()=>{
    const {data,regions}=window.__syntheticCardAudit;
    const lines=data.lines||(data.blocks||[]).flatMap(b=>(b.paragraphs||[]).flatMap(p=>p.lines||[]));
    const words=lines.flatMap(l=>l.words||[]);
    return {shape:window.__syntheticShapeStats,width:1400,height:1000,blocks:data.blocks?.length,lines:lines.length,words:words.length,boxedWords:words.filter(w=>w.bbox).length,coordinatesInBounds:words.every(w=>!w.bbox||(w.bbox.x0>=0&&w.bbox.x1<=1400&&w.bbox.y0>=0&&w.bbox.y1<=1000)),regions:regions.map(r=>({...r,insideLines:lines.filter(l=>l.bbox&&l.bbox.x0>=r.x0&&l.bbox.x1<=r.x1&&l.bbox.y0>=r.y0&&l.bbox.y1<=r.y1).length,insideWords:words.filter(w=>w.bbox&&w.bbox.x0>=r.x0&&w.bbox.x1<=r.x1&&w.bbox.y0>=r.y0&&w.bbox.y1<=r.y1).length,headers:lines.filter(l=>l.bbox?.y1<r.y0&&/\d{1,2}\s*月\s*\d{1,2}\s*日/.test(l.text.normalize('NFKC'))).map(l=>l.bbox)})),uiCandidates:document.querySelectorAll('.screenshot-import-candidate').length};
  });
  mkdirSync('test-results/card-audit',{recursive:true});writeFileSync(`test-results/card-audit/${brand}.json`,JSON.stringify(audit,null,2));
  const cards=page.locator('.screenshot-import-candidate');await expect(cards).toHaveCount(1);
  await expect(cards.locator('[data-field="selected"]')).not.toBeChecked();
  await expect(cards.locator('[data-field="title"]')).toHaveValue('ソフトウェア 締切');
  await expect(cards.locator('[data-field="start"]')).toHaveValue('20:00');
  await expect(cards.locator('[data-field="end"]')).toHaveValue('21:00');
  await expect(cards.locator('[data-field="date"]')).toHaveValue(brand==='apple'?'':'2026-11-18');
  if(brand==='apple'){
    await cards.locator('input[type="number"]').fill('2025');
    await expect(cards.locator('[data-field="date"]')).toHaveValue('');
    await cards.locator('input[type="number"]').fill('2026');
    await expect(cards.locator('[data-field="date"]')).toHaveValue('2026-11-18');
  }
  await page.screenshot({path:`test-results/card-audit/${brand}-after.png`});
  expect(api.state.outside).toEqual([]);
});
