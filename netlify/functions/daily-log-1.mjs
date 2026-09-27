// 매일 오전 9시 06분(KST) 자동 실행: 거래대금 상위 코인 중 1번째 묶음 기록
import { runDailyLog } from '../lib/log.mjs';

export default async () => {
  const r = await runDailyLog(1);
  console.log('daily-log part 1', r.today, r.picks.length, 'picks');
};

export const config = { schedule: '06 0 * * *' }; // UTC 00:06 = KST 09:06
