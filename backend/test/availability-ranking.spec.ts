import {describe,expect,it} from 'vitest';
import {candidateSlots,rankAvailability,type BusyDays} from '../src/availability';

const busy=(entries:Record<string,[number,number][]>):BusyDays=>new Map(
  Object.entries(entries).map(([id,intervals])=>[id,new Map([['2030-10-21',intervals]])]));

describe('deterministic common time recommendations',()=>{
  it('limits optional search hours and excludes elapsed slots without changing defaults',()=>{
    const dates=['2030-10-21'];
    expect(candidateSlots(new Map(),['a','b'],dates[0],120)[0]).toEqual([540,660]);
    expect(candidateSlots(new Map(),['a','b'],dates[0],120,600,780,650)).toEqual([[660,780]]);
    const ranked=rankAvailability(new Map(),new Map(),['a','b'],dates,120,2,new Map(),5,600,780,dates[0],650);
    expect(ranked.map(slot=>slot.start)).toEqual(['11:00']);
  });
  it('puts slots clear for all registered members before tentative and hard conflicts',()=>{
    const hard=busy({a:[[540,600]]}),tentative=busy({b:[[600,660]]});
    const first=rankAvailability(hard,tentative,['a','b'],['2030-10-21'],60,2,new Map(),5);
    expect(first[0]).toMatchObject({start:'11:00',allRegisteredClear:true,hardConflictCount:0,
      tentativeConflictCount:0,unconfirmedCount:0});
    expect(first[0].reason).toContain('回答は別途必要');
    expect(rankAvailability(hard,tentative,['a','b'],['2030-10-21'],60,2,new Map(),5)).toEqual(first);
  });
  it('never counts an unconfirmed member as a known available attendee',()=>{
    const unknown=new Map([['2030-10-21',new Set(['b'])]]);
    const result=rankAvailability(new Map(),new Map(),['a','b'],['2030-10-21'],60,2,unknown,3);
    expect(result).toHaveLength(3);
    expect(result.every(slot=>slot.registeredClearCount===1&&!slot.meetsMinimum&&slot.unconfirmedCount===1)).toBe(true);
    expect(result[0].reason).toContain('未確認1人');
    const conflicted=rankAvailability(busy({b:[[540,600]]}),new Map(),['a','b'],['2030-10-21'],60,2,unknown,1);
    expect(conflicted[0].unconfirmedCount).toBe(1);
  });
});
