/* Fictional sample portfolio used across all four concepts. Not real accounts or advice. */
const POS = [
  { id: 'fedk', m: 'Fed cuts rates at Dec 2026 FOMC', ev: 'Dec 2026 FOMC decision', cat: 'Economics', p: 'ks', side: 'YES', sh: 4200, avg: 0.58, mark: 0.64, res: 'Dec 16', days: 22 },
  { id: 'fedp', m: 'Fed rate cut in December?', ev: 'Dec 2026 FOMC decision', cat: 'Economics', p: 'pm', side: 'YES', sh: 3000, avg: 0.61, mark: 0.64, res: 'Dec 16', days: 22 },
  { id: 'cpi', m: 'Nov CPI YoY above 3.0%', ev: 'Nov 2026 CPI print', cat: 'Economics', p: 'ks', side: 'NO', sh: 3000, avg: 0.71, mark: 0.66, res: 'Dec 10', days: 16 },
  { id: 'rec', m: 'US recession declared in 2027', ev: 'NBER recession call', cat: 'Economics', p: 'pm', side: 'NO', sh: 5000, avg: 0.79, mark: 0.82, res: 'Dec 31 ’27', days: 402 },
  { id: 'hot', m: '2026 hottest year on record', ev: 'NOAA annual report', cat: 'Climate', p: 'ks', side: 'YES', sh: 9000, avg: 0.88, mark: 0.93, res: 'Jan 14', days: 51 },
  { id: 'shut', m: 'Government shutdown before Feb 1', ev: 'FY27 appropriations', cat: 'Politics', p: 'pm', side: 'YES', sh: 7000, avg: 0.38, mark: 0.47, res: 'Feb 1', days: 69 },
  { id: 'btc', m: 'Bitcoin above $150k on Dec 31', ev: 'BTC year-end close', cat: 'Crypto', p: 'pm', side: 'YES', sh: 8000, avg: 0.34, mark: 0.29, res: 'Dec 31', days: 37 },
  { id: 'eth', m: 'ETH ETFs net inflows > $1B in Nov', ev: 'Nov ETF flows', cat: 'Crypto', p: 'ks', side: 'YES', sh: 3500, avg: 0.45, mark: 0.52, res: 'Dec 2', days: 8 },
  { id: 'cel', m: 'Celtics win 2027 NBA Finals', ev: '2027 NBA Finals', cat: 'Sports', p: 'pm', side: 'YES', sh: 6500, avg: 0.21, mark: 0.26, res: 'Jun ’27', days: 205 },
  { id: 'chf', m: 'Chiefs win Super Bowl LXI', ev: 'Super Bowl LXI', cat: 'Sports', p: 'pm', side: 'YES', sh: 4000, avg: 0.17, mark: 0.12, res: 'Feb 14', days: 82 },
];
POS.forEach(p => { p.cost = p.sh * p.avg; p.val = p.sh * p.mark; p.upl = p.val - p.cost; p.ifWin = p.sh - p.cost; p.ifLose = -p.cost; });
const PLAT = { pm: ['P', 'Polymarket'], ks: ['K', 'Kalshi'] };
const CAT_COLORS = { Economics: 'var(--color-data-1)', Climate: 'var(--color-data-3)', Crypto: 'var(--color-data-2)', Politics: 'var(--color-data-4)', Sports: 'var(--color-data-5)' };
