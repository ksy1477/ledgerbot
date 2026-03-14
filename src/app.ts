// 환경 변수를 가장 먼저 로드 (다른 import보다 먼저!)
import * as dotenv from 'dotenv';
dotenv.config();

import { App } from '@slack/bolt';
import { registerCommands } from './handlers/commandHandler';

// Slack App 초기화
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true, // Socket Mode 사용 (로컬 개발에 유용)
  appToken: process.env.SLACK_APP_TOKEN,
  port: parseInt(process.env.PORT || '3000')
});

// 명령어 등록
registerCommands(app);

// 앱 시작
(async () => {
  const port = parseInt(process.env.PORT || '3000');
  await app.start();
  console.log(`⚡️ 슬랙 봇이 시작되었습니다! (포트: ${port})`);
  console.log(`📋 사용 가능한 명령어:`);
  console.log(`   /등기 [주소]`);
  console.log(`   /건축물 [주소]`);
  console.log(`   /전체 [주소]`);
  console.log(`📋 앱 멘션 (스레드 내 사용 가능):`);
  console.log(`   @봇이름 등기 [주소]`);
  console.log(`   @봇이름 건축물 [주소]`);
  console.log(`   @봇이름 전체 [주소]`);
})();

// 에러 핸들링
app.error(async (error) => {
  console.error('앱 에러:', error);
});
