import test from 'node:test';
import assert from 'node:assert/strict';
import {initShift} from './shift.js';
test('shift drafts survive same-user redraws but never an account change',()=>{
 const elements=new Map();const $=id=>{if(!elements.has(id))elements.set(id,{value:'',hidden:false,textContent:''});return elements.get(id);};
 let user='synthetic-a';
 const app={$ ,state:{shifts:{}},view:{shiftDate:'2027-01-01'},getCurrentUserId:()=>user,
 parseDate:key=>new Date(`${key}T00:00:00`),dateLabel:new Intl.DateTimeFormat('ja-JP')};
 const shift=initShift(app);shift.renderForm();$('shift-start').value='09:00';
 shift.renderForm();assert.equal($('shift-start').value,'09:00');
 user='synthetic-b';shift.renderForm();assert.equal($('shift-start').value,'');assert.equal($('shift-work-date').value,'2027-01-01');
});
