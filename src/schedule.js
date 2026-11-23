const minuteMs = 60_000;
const dayMs = 24 * 60 * minuteMs;
const shanghaiOffsetMs = 8 * 60 * minuteMs;
const snapshotDelayMs = 30_000;
const intervalMinutes = 15;

// Weekday closures published by the Shanghai Stock Exchange. Weekends are handled separately.
// https://www.sse.com.cn/disclosure/dealinstruc/closed/
const weekdayClosures = {
  2026: new Set([
    '2026-01-01', '2026-01-02',
    '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20', '2026-02-23',
    '2026-04-06',
    '2026-05-01', '2026-05-04', '2026-05-05',
    '2026-06-19',
    '2026-09-25',
    '2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07',
  ]),
};

const sessions = [
  [9 * 60 + 26, 11 * 60 + 30],
  [13 * 60 + 1, 15 * 60],
];
const dailySlots = sessions.flatMap(([start, end]) => {
  const slots = [];
  for (let minute = start; minute < end; minute += intervalMinutes) {
    slots.push(minute * minuteMs + snapshotDelayMs);
  }
  return slots;
});

export function refreshSchedule(now = Date.now()) {
  if (!Number.isFinite(now)) return { slot: null, next: null };

  let slot = null;
  // Shanghai is UTC+08:00 throughout the published calendar. UTC date methods on the
  // shifted date keep the schedule independent of the desktop's local time zone.
  const today = Math.floor((now + shanghaiOffsetMs) / dayMs) * dayMs;
  for (let day = today; ; day += dayMs) {
    const date = new Date(day);
    const closures = weekdayClosures[date.getUTCFullYear()];
    if (!closures) return { slot, next: null };

    const weekday = date.getUTCDay();
    if (weekday === 0 || weekday === 6 || closures.has(date.toISOString().slice(0, 10))) continue;

    for (const time of dailySlots) {
      const scheduled = day - shanghaiOffsetMs + time;
      if (scheduled > now) return { slot, next: scheduled };
      if (now < scheduled + minuteMs - snapshotDelayMs) slot = scheduled;
    }
  }
}
