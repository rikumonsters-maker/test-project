export function activateMoneyView(document,viewName,{onBudget=()=>{},onShift=()=>{}}={}) {
  if(viewName!=='budget'&&viewName!=='shift')return false;
  for(const button of document.querySelectorAll('[data-money-view]')) {
    const selected=button.dataset.moneyView===viewName;
    button.setAttribute('aria-selected',String(selected));
    button.tabIndex=selected?0:-1;
  }
  document.getElementById('page-budget').hidden=viewName!=='budget';
  document.getElementById('page-shift').hidden=viewName!=='shift';
  if(viewName==='budget')onBudget();else onShift();
  return true;
}

export function activateMainPage(document,pageName,{onPlan=()=>{},onMoney=()=>{},onProfile=()=>{}}={}) {
  if(!['my','group','money','profile'].includes(pageName))return false;
  for(const panel of document.querySelectorAll('.page-panel'))panel.hidden=panel.id!==`page-${pageName}`;
  for(const button of document.querySelectorAll('.nav-button')){
    if(button.dataset.page===pageName)button.setAttribute('aria-current','page');
    else button.removeAttribute('aria-current');
  }
  if(pageName==='my')onPlan();
  if(pageName==='money')onMoney();
  if(pageName==='profile')onProfile();
  return true;
}

const navResizeObservers = new WeakMap();

export function updateNavIndicator(document) {
  const nav = document.querySelector?.('.page-nav');
  const indicator = nav?.querySelector?.('.page-nav-indicator');
  if (!nav || !indicator) return false;
  const button = nav.querySelector('.nav-button[aria-current="page"]');
  if (!button) {
    nav.dataset.indicatorActive = 'false';
    return true;
  }
  const navRect = nav.getBoundingClientRect();
  const buttonRect = button.getBoundingClientRect();
  if (!buttonRect.width || !navRect.width) return false;
  const borderLeft = Number.parseFloat(document.defaultView?.getComputedStyle(nav).borderLeftWidth) || 0;
  const firstPosition = nav.dataset.indicatorInitialized !== 'true';
  if (firstPosition) indicator.style.transition = 'none';
  indicator.style.width = `${buttonRect.width}px`;
  indicator.style.setProperty('--nav-indicator-x', `${buttonRect.left - navRect.left - borderLeft}px`);
  nav.dataset.indicatorActive = 'true';
  if (firstPosition) {
    nav.dataset.indicatorInitialized = 'true';
    const raf = document.defaultView?.requestAnimationFrame?.bind(document.defaultView) || globalThis.requestAnimationFrame;
    if (raf) raf(() => raf(() => indicator.style.removeProperty('transition')));
    else indicator.style.removeProperty('transition');
  }
  return true;
}

export function observeNavIndicator(document) {
  const nav = document.querySelector?.('.page-nav');
  if (!nav || navResizeObservers.has(document)) return false;
  const window = document.defaultView;
  let frame = 0;
  const update = () => {
    if (frame) window?.cancelAnimationFrame?.(frame);
    frame = window?.requestAnimationFrame?.(() => {
      frame = 0;
      updateNavIndicator(document);
    }) || 0;
  };
  const ResizeObserver = window?.ResizeObserver;
  const observer = ResizeObserver ? new ResizeObserver(update) : null;
  observer?.observe(nav);
  window?.addEventListener('resize', update, { passive:true });
  window?.visualViewport?.addEventListener('resize', update, { passive:true });
  navResizeObservers.set(document, { observer, update });
  updateNavIndicator(document);
  return true;
}
