const rankFormatter = new Intl.NumberFormat('en', {
  style: 'percent',
  maximumFractionDigits: 2,
  useGrouping: false,
});

export function rankGroups(groups, changes) {
  const entries = groups.map((group) => {
    let total = 0;
    let count = 0;
    for (const stock of group.stocks) {
      const change = changes.get(stock.code);
      if (!Number.isFinite(change)) continue;
      total += change;
      count += 1;
    }
    const average = count ? total / count : null;
    const value = Number.isFinite(average) ? average : null;
    const sortValue = value === null ? -Infinity : parseFloat(rankFormatter.format(value / 100));
    return { group, value, count, sortValue };
  });

  // The stable sort preserves watchlist order for equal displayed percentages.
  entries.sort((left, right) => {
    if (left.sortValue === right.sortValue) return 0;
    return left.sortValue > right.sortValue ? -1 : 1;
  });
  return entries.map(({ group, value, count }, index) => ({
    group, value, count, rank: value === null ? null : index + 1,
  }));
}

export function advanceRankHistory(history, updatedAt, rankings) {
  const timestamp = typeof updatedAt === 'string' ? Date.parse(updatedAt) : NaN;
  if (!Number.isFinite(timestamp) || timestamp <= (history?.updatedAt ?? -Infinity)) return history;

  const ranked = rankings.filter(({ rank }) => rank !== null);
  if (ranked.length === 0) return history;
  return {
    updatedAt: timestamp,
    current: Object.fromEntries(ranked.map(({ group, rank }) => [group.id, rank])),
    previous: history?.current ?? {},
  };
}

export function rankMovement(history, groupId) {
  const current = history?.current?.[groupId];
  const previous = history?.previous?.[groupId];
  return Number.isInteger(current) && Number.isInteger(previous) ? previous - current : null;
}
