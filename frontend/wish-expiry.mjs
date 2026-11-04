export function tokyoToday(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone:'Asia/Tokyo', year:'numeric', month:'2-digit', day:'2-digit',
  }).format(now);
}

export function visibleWishes(wishes, today = tokyoToday()) {
  return wishes.filter(wish => typeof wish.wishDate === 'string' && wish.wishDate >= today);
}

export function millisUntilNextTokyoDay(now = new Date()) {
  const nextMidnight = Date.parse(`${tokyoToday(now)}T15:00:00Z`);
  return Math.max(1, nextMidnight - now.getTime() + 50);
}
