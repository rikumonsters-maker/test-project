import {test,expect} from '@playwright/test';
import {syntheticApi} from './synthetic-api.mjs';

const groups=[
  {groupId:'synthetic-group-a',memberId:'member-a',memberName:'テスト利用者',groupName:'家族',inviteCode:'MP-GROUP-A',memberCount:3},
  {groupId:'synthetic-group-b',memberId:'member-b',memberName:'テスト利用者',groupName:'とても長いグループ名でスマートフォン幅の表示を確かめる',inviteCode:'MP-GROUP-B',memberCount:12},
];

async function openGroupHome(page,viewport={width:390,height:844}) {
  const api=syntheticApi({groups});
  await api.attach(page.context());
  await page.addInitScript(() => {
    window.__clipboardWrites=[];
    Object.defineProperty(navigator,'clipboard',{configurable:true,value:{
      writeText:async value=>window.__clipboardWrites.push(value),
    }});
  });
  await page.setViewportSize(viewport);
  await page.goto('/');
  await expect(page.locator('#app-root')).toBeVisible();
  await page.locator('.nav-button[data-page="group"]').click();
  await expect(page.locator('#group-home')).toBeVisible();
  await expect(page.locator('#group-list .group-card')).toHaveCount(groups.length);
  return api;
}

test('group cards show the correct group, current member count and independent invite flow',async({page})=>{
  const api=await openGroupHome(page);
  const cards=page.locator('#group-list .group-card');
  await expect(cards.nth(0)).toContainText('家族');
  await expect(cards.nth(0)).toContainText('3人');
  await expect(cards.nth(1)).toContainText('12人');
  await expect(cards.nth(1)).toContainText('とても長いグループ名');
  await expect(page.locator('#group-list')).not.toContainText('MP-GROUP-A');
  await expect(page.locator('#group-list')).not.toContainText('MP-GROUP-B');

  const inviteB=page.getByRole('button',{name:`${groups[1].groupName}にメンバーを招待`});
  await inviteB.focus();
  await page.keyboard.press('Enter');
  const dialog=page.locator('#group-invite-qr-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAccessibleName('グループに招待');
  await expect(page.locator('#group-invite-qr-name')).toHaveText(groups[1].groupName);
  await expect(page.locator('#group-invite-qr-code')).toHaveValue(groups[1].inviteCode);
  const inviteUrl=await page.locator('#group-invite-qr-url').textContent();
  expect(new URL(inviteUrl).searchParams.get('invite')).toBe(groups[1].inviteCode);
  const qrImage=page.locator('#group-invite-qr-image');
  await expect(qrImage).toHaveAttribute('src',/^data:image\/(?:gif|png);base64,/);
  const groupBQr=await qrImage.getAttribute('src');
  const decodedInvite=await page.evaluate(async()=>{
    const QrScanner=(await import('/vendor/qr-scanner.min.js')).default;
    return (await QrScanner.scanImage(document.getElementById('group-invite-qr-image'),{returnDetailedScanResult:true})).data;
  });
  expect(decodedInvite).toBe(inviteUrl);

  const copy=page.getByRole('button',{name:'招待コードをコピー'});
  await copy.focus();
  await page.keyboard.press('Space');
  await expect(page.locator('#group-invite-qr-copy-status')).toHaveText('招待コードをコピーしました。');
  expect(await page.evaluate(()=>window.__clipboardWrites)).toEqual([groups[1].inviteCode]);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.locator('#group-invite-qr-code')).toHaveValue('');
  await expect(qrImage).not.toHaveAttribute('src');

  await page.getByRole('button',{name:`${groups[0].groupName}にメンバーを招待`}).click();
  await expect(page.locator('#group-invite-qr-code')).toHaveValue(groups[0].inviteCode);
  await expect(qrImage).not.toHaveAttribute('src',groupBQr);
  await dialog.evaluate(element=>element.dispatchEvent(new MouseEvent('click',{bubbles:true})));
  await expect(dialog).toBeHidden();
  await expect(page.locator('#group-invite-qr-name')).toHaveText('');
  expect(api.state.outside).toEqual([]);
});

test('group cards retain calendar and management actions without showing an unknown count as one',async({page})=>{
  const api=syntheticApi({groups:[{...groups[0],memberCount:undefined}]});
  await api.attach(page.context());
  await page.goto('/');
  await expect(page.locator('#app-root')).toBeVisible();
  await page.locator('.nav-button[data-page="group"]').click();
  const card=page.locator('#group-list .group-card');
  await expect(card).toContainText('人数未取得');
  await card.getByRole('button',{name:'家族の管理'}).click();
  await expect(page.locator('#group-manage-dialog')).toBeVisible();
  await page.locator('#close-group-manage').click();
  await card.getByRole('button',{name:'家族の共有カレンダーを表示'}).click();
  await expect(page.locator('#group-calendar-view')).toBeVisible();
  expect(api.state.outside).toEqual([]);
});

for(const width of [320,375,390,430,768,1280]) {
  test(`group card and invite dialog fit a ${width}px viewport`,async({page})=>{
    await openGroupHome(page,{width,height:844});
    const before=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));
    expect(before.scroll).toBeLessThanOrEqual(before.width);
    const invite=page.getByRole('button',{name:`${groups[1].groupName}にメンバーを招待`});
    const size=await invite.boundingBox();
    expect(size?.height).toBeGreaterThanOrEqual(44);
    await invite.click();
    const dialog=page.locator('#group-invite-qr-dialog');
    await expect(dialog).toBeInViewport();
    await expect(page.getByRole('button',{name:'招待コードをコピー'})).toBeInViewport();
    const after=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));
    expect(after.scroll).toBeLessThanOrEqual(after.width);
    await page.locator('#close-group-invite-qr').click();
  });
}

test('interactive group cards lift on mouse hover and return without changing document flow',async({page})=>{
  await openGroupHome(page,{width:1280,height:900});
  const card=page.locator('#group-list .group-card').first();
  const nextCard=page.locator('#group-list .group-card').nth(1);
  const initial=await card.boundingBox();
  const nextTop= (await nextCard.boundingBox()).y;
  expect(await card.evaluate(el=>el.classList.contains('interactive-card'))).toBe(true);

  const box=await card.boundingBox();
  await page.mouse.move(box.x+box.width/2,box.y+box.height/2);
  await page.waitForTimeout(250);
  const hovered=await card.evaluate(el=>{
    const style=getComputedStyle(el);
    return {transformY:style.transform==='none'?0:new DOMMatrixReadOnly(style.transform).m42,
      shadow:style.boxShadow,border:style.borderTopColor,rect:el.getBoundingClientRect().top};
  });
  expect(hovered.transformY).toBeCloseTo(-4,0);
  expect(hovered.shadow).not.toBe('none');
  expect(hovered.border).toBe('rgb(147, 197, 253)');
  expect(hovered.rect).toBeCloseTo(initial.y-4,0);
  expect((await nextCard.boundingBox()).y).toBe(nextTop);

  await page.mouse.move(1,1);
  await page.waitForTimeout(250);
  const restored=await card.evaluate(el=>({
    transform:getComputedStyle(el).transform,
    top:el.getBoundingClientRect().top,
  }));
  expect(restored.transform==='none'?0:new DOMMatrixReadOnly(restored.transform).m42).toBe(0);
  expect(restored.top).toBeCloseTo(initial.y,0);
});

test('3D tilt defaults on, follows the pointer within seven degrees and preserves the group action',async({page})=>{
  const api=await openGroupHome(page,{width:1280,height:900});
  const card=page.locator('#group-list .group-card').first();
  expect(await page.evaluate(()=>document.documentElement.dataset.cardTilt)).toBe('on');
  const box=await card.boundingBox();
  await page.mouse.move(box.x+Math.min(4,box.width*.05),box.y+box.height/2);
  await expect.poll(()=>card.evaluate(el=>el.style.getPropertyValue('--card-rotate-y'))).not.toBe('');
  const state=await card.evaluate(el=>({
    x:parseFloat(el.style.getPropertyValue('--card-rotate-x')),
    y:parseFloat(el.style.getPropertyValue('--card-rotate-y')),
    highlightX:el.style.getPropertyValue('--card-highlight-x'),
    highlightY:el.style.getPropertyValue('--card-highlight-y'),
    background:getComputedStyle(el).backgroundImage,
  }));
  expect(Math.abs(state.x)).toBeLessThanOrEqual(7);
  expect(Math.abs(state.y)).toBeLessThanOrEqual(7);
  expect(state.highlightX).not.toBe('');
  expect(state.highlightY).not.toBe('');
  expect(state.background).toContain('radial-gradient');

  const requests=[];
  page.on('request',request=>requests.push({url:request.url(),method:request.method()}));
  await page.locator('#account-open').click();
  await expect(page.locator('#page-profile')).toBeVisible();
  const toggle=page.locator('#card-tilt-toggle');
  await expect(toggle).toBeChecked();
  requests.length=0;
  await toggle.uncheck();
  await expect(page.locator('html')).toHaveAttribute('data-card-tilt','off');
  expect(await page.evaluate(()=>localStorage.getItem('daysync-card-3d-tilt'))).toBe('off');
  expect(requests).toEqual([]);

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-card-tilt','off');
  await page.locator('.nav-button[data-page="group"]').click();
  await expect(page.locator('#group-home')).toBeVisible();
  await expect(page.locator('#group-list .group-card')).toHaveCount(groups.length);
  const offCard=page.locator('#group-list .group-card').first();
  const offBox=await offCard.boundingBox();
  await page.mouse.move(offBox.x+1,offBox.y+1);
  const offState=await offCard.evaluate(el=>({
    transform:getComputedStyle(el).transform,
    background:getComputedStyle(el).backgroundImage,
    rotation:el.style.getPropertyValue('--card-rotate-x'),
    highlight:el.style.getPropertyValue('--card-highlight-x'),
  }));
  expect(offState.transform).toBe('none');
  expect(offState.background).toBe('none');
  expect(offState.rotation).toBe('');
  expect(offState.highlight).toBe('');
  await offCard.locator('.group-name-button').click();
  await expect(page.locator('#group-calendar-view')).toBeVisible();
  expect(api.state.outside).toEqual([]);
});

test('3D tilt can be enabled again and preference survives reload without a server setting',async({page})=>{
  await openGroupHome(page);
  await page.evaluate(()=>localStorage.setItem('daysync-card-3d-tilt','off'));
  await page.reload();
  await page.locator('#account-open').click();
  const toggle=page.locator('#card-tilt-toggle');
  await expect(toggle).not.toBeChecked();
  const requests=[];
  page.on('request',request=>requests.push({url:request.url(),method:request.method()}));
  await toggle.check();
  await expect(page.locator('html')).toHaveAttribute('data-card-tilt','on');
  expect(await page.evaluate(()=>localStorage.getItem('daysync-card-3d-tilt'))).toBe('on');
  expect(requests).toEqual([]);
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-card-tilt','on');
  await page.locator('#account-open').click();
  await expect(page.locator('#card-tilt-toggle')).toBeChecked();
});

test('interactive card hover supports dark theme, keyboard focus and reduced motion',async({page})=>{
  await openGroupHome(page,{width:390,height:844});
  const card=page.locator('#group-list .group-card').first();
  await page.evaluate(()=>document.documentElement.dataset.theme='dark');
  const box=await card.boundingBox();
  await page.mouse.move(box.x+box.width/2,box.y+box.height/2);
  await page.waitForTimeout(250);
  const dark=await card.evaluate(el=>({
    border:getComputedStyle(el).borderTopColor,
    shadow:getComputedStyle(el).boxShadow,
  }));
  expect(dark.border).toBe('rgb(120, 169, 214)');
  expect(dark.shadow).toContain('rgba(0, 0, 0, 0.38)');

  await page.mouse.move(1,1);
  await page.evaluate(()=>document.documentElement.dataset.theme='light');
  const target=card.getByRole('button',{name:'家族の共有カレンダーを表示'});
  for(let i=0;i<24;i++) {
    if(await target.evaluate(el=>el===document.activeElement)) break;
    await page.keyboard.press('Tab');
  }
  await expect(target).toBeFocused();
  expect(await target.evaluate(el=>el.matches(':focus-visible'))).toBe(true);
  expect(await target.evaluate(el=>getComputedStyle(el).outlineStyle)).not.toBe('none');

  await page.emulateMedia({reducedMotion:'reduce'});
  const reducedBox=await card.boundingBox();
  await page.mouse.move(reducedBox.x+reducedBox.width/2,reducedBox.y+reducedBox.height/2);
  await page.waitForTimeout(30);
  const reduced=await card.evaluate(el=>({
    transform:getComputedStyle(el).transform,
    transition:getComputedStyle(el).transitionDuration,
  }));
  expect(reduced.transform==='none'?0:new DOMMatrixReadOnly(reduced.transform).m42).toBe(0);
  expect(await card.evaluate(el=>el.style.getPropertyValue('--card-rotate-x'))).toBe('');
  expect(await card.evaluate(el=>getComputedStyle(el).backgroundImage)).toBe('none');
  expect(reduced.transition.split(',').every(value=>parseFloat(value)===0)).toBe(true);
});

test('touch input suppresses hover motion and still opens the selected group',async({browser})=>{
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  try {
    await syntheticApi({groups}).attach(context);
    const page=await context.newPage();
    await page.goto('http://127.0.0.1:5517/');
    await expect(page.locator('#app-root')).toBeVisible();
    await page.locator('.nav-button[data-page="group"]').click();
    const card=page.locator('#group-list .group-card').first();
    expect(await page.evaluate(()=>matchMedia('(hover:hover) and (pointer:fine)').matches)).toBe(false);
    const box=await card.boundingBox();
    await page.mouse.move(box.x+box.width/2,box.y+box.height/2);
    expect(await card.evaluate(el=>getComputedStyle(el).transform)).toBe('none');
    const select=card.getByRole('button',{name:'家族の共有カレンダーを表示'});
    const selectBox=await select.boundingBox();
    await page.touchscreen.tap(selectBox.x+selectBox.width/2,selectBox.y+selectBox.height/2);
    await expect(page.locator('#group-calendar-view')).toBeVisible();
  } finally {
    await context.close();
  }
});

test('selectable icon and budget rows share the effect without changing their actions',async({page})=>{
  const api=await openGroupHome(page);
  const card=page.locator('#group-list .group-card').first();
  await card.getByRole('button',{name:'家族の管理'}).click();
  await page.locator('#group-icon-change').click();
  const icon=page.locator('#group-icon-options .group-icon-option').first();
  await expect(icon).toHaveClass(/interactive-card/);
  await icon.click();
  await expect(icon).toHaveAttribute('aria-pressed','true');
  await page.locator('#group-icon-cancel').click();
  await page.locator('#close-group-manage').click();

  await page.locator('.nav-button[data-page="money"]').click();
  const category=page.locator('#expense-category-chart-list .chart-category').first();
  await expect(category).toHaveClass(/interactive-card/);
  await category.click();
  await expect(category).toHaveAttribute('aria-pressed','true');
  expect(api.state.outside).toEqual([]);
});
