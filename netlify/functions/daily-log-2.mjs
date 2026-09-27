// 매일 오전 9시 07분(KST) 자동 실행: 거래대금 상위 코인 중 2번째 묶음 기록
import { runDailyLog } from '../lib/log.mjs';

export default async () => {
  const r = await runDailyLog(2);
  console.log('daily-log part 2', r.today, r.picks.length, 'picks');
};

export const config = { schedule: '07 0 * * *' }; // UTC 00:07 = KST 09:07
