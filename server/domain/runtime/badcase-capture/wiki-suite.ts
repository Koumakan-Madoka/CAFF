// User-confirmed historical case numbering from Goal D10 / approved prototype.
// Import order is NOT the public number. These are display-only projections;
// the grandfathered 13 train / 3 test source records remain byte-for-byte intact.
const goalCaseIds = [
  'text-3ff896480224fea1cde010370be091785529db0b1b18d8b5e0648a0a4f15aa89',
  'text-cf5d9b450b0ddf30a773fa90583962f814e72b25edf3952e232fa8229bcb9928',
  'text-e3170516f93f1e20e53a20442bf238532847c70163891dfd110fead78a28dd34',
  'text-ea8201f3c1ddf0fa73043f88d2ac6e10eb2d3529ed3140e0a2261a63503cc40b',
  'text-e5cc6644102e845bfd5a1714988a85376ddc9e84e9ac5516fdcc4e849f2a47a5',
  'text-cd864c2eb09ede39cd520b18e36a0d8e02b244b6a8dde3db2390bba65e48c940',
  'text-6d9cbd07278d02cc72a12b5a358aad639d802a632679a43de0752e5eff7a3a92',
  'text-fd3b78a0f88504eb0cba8954abdeb578e1eaae408235347962bd00621c7857b9',
  'text-6aefd421e4c3c1d443e6de2ef333d51978d0f2ee26d12f2ce08f6de60ab9e71c',
  'text-26793884ceebb064ff09ebd41f4ce3b88771af2f9a8c0838ea41f52f71f4cb41',
  'text-5354403cede52f033f0b253df526890f793e2c3dbdeec5c2980ed43b91f1172f',
  'text-1ce466e5e480b3e07b7aec0508d3b9b6d2f7d54cfac578cd2ebf3b4cd13fc735',
  'text-ed92813371ff4ecd309ac7e3241ef48b5b9315cc944a7c62a1168a9f25ee11c1',
  'text-1c6e58c2f58ac57383a1910cd01dd96b4b6c2989078d6963b83284a4a8abaa47',
  'text-7d37e38377e026b494041c3892a229051e81ab0d8daff2ba2aee2d4948a55e88',
  'text-7364c69567dcfaa751e631b7dc90ac48f03c9ce3e5d12a0588f7ea93c94338ac',
];
export const wikiGoalCaseNumber = (id: string): number | null => { const n = goalCaseIds.indexOf(id); return n < 0 ? null : n+1; };
export const wikiRoundStage = (id: string): 'gate' | 'test' | null => {
  const n = wikiGoalCaseNumber(id); return [1,2,6,16].includes(n!) ? 'gate' : [4,10,14].includes(n!) ? 'test' : null;
};
export function wikiDisplayCases(cases: any[]): any[] {
  let next = cases.some(c => wikiGoalCaseNumber(c.id) !== null) ? 17 : 1;
  return cases.map(c => ({...c, displayNumber: wikiGoalCaseNumber(c.id) ?? next++, evaluationStage: wikiRoundStage(c.id)}));
}
