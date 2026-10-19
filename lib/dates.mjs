export function todayInShanghai(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value && +value.slice(0, 4) >= 1900 && +value.slice(0, 4) <= 2200;
}

export function addDays(date, days) {
  const result = new Date(`${date}T00:00:00.000Z`);
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString().slice(0, 10);
}

export function nextOccurrence(date, frequency, anchorDay) {
  if (frequency === '每周') return addDays(date, 7);
  const months = { '每月': 1, '每季度': 3, '每年': 12 }[frequency];
  const target = new Date(`${date}T00:00:00.000Z`);
  target.setUTCDate(1);
  target.setUTCMonth(target.getUTCMonth() + months);
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(anchorDay, last));
  return target.toISOString().slice(0, 10);
}
