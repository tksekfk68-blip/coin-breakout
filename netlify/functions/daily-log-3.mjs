// 매일 오전 9시 08분(KST) 자동 실행: 거래대금 상위 코인 중 3번째 묶음 기록
import { runDailyLog } from '../lib/log.mjs';

export default async () => {
  const r = await runDailyLog(3);
  console.log('daily-log part 3', r.today, r.picks.length, 'picks');
};

export const config = { schedule: '08 0 * * *' }; // UTC 00:08 = KST 09:08
