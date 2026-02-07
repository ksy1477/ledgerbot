import { App } from '@slack/bolt';
import { parseAddress, generateFileName } from '../utils/addressParser';
import { UnifiedRegistryService, UnifiedBuildingService } from '../services';
import * as fs from 'fs';

const registryService = new UnifiedRegistryService();
const buildingService = new UnifiedBuildingService();

/**
 * 명령어 등록
 */
export function registerCommands(app: App): void {
  // /등기 명령어
  app.command('/등기', async ({ command, ack, say, client }) => {
    // 즉시 응답 (Slack 3초 제한)
    await ack();

    const rawInput = command.text.trim();
    const channelId = command.channel_id;

    // 입력 검증
    if (!rawInput) {
      await say({
        text: '❌ 주소를 입력해주세요.\n사용법: `/등기 서울시 중랑구 중화동 450 중화한신아파트 103동 904호`'
      });
      return;
    }

    // 주소 파싱
    const parsedAddress = parseAddress(rawInput);

    if (!parsedAddress) {
      await say({
        text: '❌ 주소를 인식할 수 없습니다.\n다음 형식으로 입력해주세요:\n[시/도] [시/군/구] [읍/면/동] [번지] [건물명] [동] [호]'
      });
      return;
    }

    // 조회 시작 메시지
    await say({
      text: `🔍 조회 중입니다...\n주소: ${parsedAddress.fullAddress}`
    });

    try {
      // 등기부등본 조회
      const filePath = await registryService.fetchRegistry(parsedAddress);

      // 파일을 Slack에 업로드
      const fileName = generateFileName('등기부등본', parsedAddress);

      await client.files.uploadV2({
        channel_id: channelId,
        file: fs.createReadStream(filePath),
        filename: fileName,
        initial_comment: `✅ 등기부등본 발급 완료\n주소: ${parsedAddress.fullAddress}\n발급일시: ${new Date().toLocaleString('ko-KR')}\n비용: 1,000원 (Mock)`
      });

    } catch (error) {
      console.error('등기부등본 조회 실패:', error);
      await say({
        text: '⚠️ 등기부등본 조회 중 오류가 발생했습니다.\n잠시 후 다시 시도해주세요.'
      });
    }
  });

  // /건축물 명령어
  app.command('/건축물', async ({ command, ack, say, client }) => {
    // 즉시 응답
    await ack();

    const rawInput = command.text.trim();
    const channelId = command.channel_id;

    // 입력 검증
    if (!rawInput) {
      await say({
        text: '❌ 주소를 입력해주세요.\n사용법: `/건축물 서울시 중랑구 중화동 450 103동 904호`'
      });
      return;
    }

    // 주소 파싱
    const parsedAddress = parseAddress(rawInput);

    if (!parsedAddress) {
      await say({
        text: '❌ 주소를 인식할 수 없습니다.\n다음 형식으로 입력해주세요:\n[시/도] [시/군/구] [읍/면/동] [번지] [건물명] [동] [호]'
      });
      return;
    }

    // 조회 시작 메시지
    await say({
      text: `🔍 건축물대장 조회 중입니다...\n주소: ${parsedAddress.fullAddress}`
    });

    try {
      // 건축물대장 조회
      const filePath = await buildingService.fetchBuildingLedger(parsedAddress);

      // 파일을 Slack에 업로드
      const fileName = generateFileName('건축물대장', parsedAddress);

      await client.files.uploadV2({
        channel_id: channelId,
        file: fs.createReadStream(filePath),
        filename: fileName,
        initial_comment: `✅ 건축물대장 발급 완료\n주소: ${parsedAddress.fullAddress}\n발급일시: ${new Date().toLocaleString('ko-KR')}`
      });

    } catch (error) {
      console.error('건축물대장 조회 실패:', error);
      await say({
        text: '⚠️ 건축물대장 조회 중 오류가 발생했습니다.\n잠시 후 다시 시도해주세요.'
      });
    }
  });

  // /전체 명령어 (Phase 2 예정)
  app.command('/전체', async ({ ack, say }) => {
    await ack();
    await say('⚙️ 전체 조회 기능은 Phase 2에서 구현 예정입니다.');
  });
}
