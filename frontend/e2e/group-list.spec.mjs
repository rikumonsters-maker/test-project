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
