// 오늘의 신호를 저장하는 공용 로직 (추세 돌파 + 눌림목)
import { getStore } from '@netlify/blobs';
import { DEFAULT_PARAMS, signalIndexes, splitClosed, todayKST } from '../../public/lib/strategy.js';
import { topMarkets, candlesFor } from './upbit.mjs';

export const PARTS = 4;
const PER_PART = 40;

/** part: 0~3. 함수 실행 시간 제한(10~30초) 때문에 40개씩 나눠서 기록 */
export async function runDailyLog(part = 0) {
  const p = DEFAULT_PARAMS;
  // 상위 30개만 보면 SOON처럼 조용하던 코인의 돌파를 놓쳐서,
  // 하루 거래대금 10억 원 이상인 코인 전체(최대 150개)를 봅니다.
  const tops = (await topMarkets(PARTS * PER_PART, 1e9)).slice(part * PER_PART, (part + 1) * PER_PART);
  const data = await candlesFor(tops.map((t) => t.market), 90, 8, 700);
  const today = todayKST();
  const picks = [];
  for (const [market, candles] of Object.entries(data)) {
    const { closed } = splitClosed(candles, today);
    if (closed.length < p.maSlow + 10) continue;
    const last = closed.length - 1;
    for (const strategy of ['breakout', 'pullback']) {
      const { idx, ev } = signalIndexes(closed, { ...p, strategy });
      if (idx.includes(last)) {
        picks.push({ market, strategy, date: closed[last].t, entry: closed[last].c, volRatio: ev[last].volRatio });
      }
    }
  }
  const record = { loggedAt: new Date().toISOString(), today, part, params: p, universe: Object.keys(data).length, picks };
  await getStore('picks').setJSON(part ? `${today}-p${part}` : today, record);
  return record;
}
