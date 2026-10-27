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
