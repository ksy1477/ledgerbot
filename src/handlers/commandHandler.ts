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
      const result = await registryService.fetchRegistry(parsedAddress);

      // 파일을 Slack에 업로드
      const fileName = generateFileName('등기부등본', parsedAddress);
      const balanceText = result.pointBalance != null ? `\nTilko 잔액: ${result.pointBalance.toLocaleString()}pt` : '';

      await client.files.uploadV2({
        channel_id: channelId,
        file: fs.createReadStream(result.filePath),
        filename: fileName,
        initial_comment: `✅ 등기부등본 발급 완료\n주소: ${parsedAddress.fullAddress}\n발급일시: ${new Date().toLocaleString('ko-KR')}\n비용: 120pt (주소검색 20 + 등기 100)${balanceText}`
      });

    } catch (error) {
      console.error('등기부등본 조회 실패:', error);
      await say({
        text: '⚠️ 등기부등본 조회 중 오류가 발생했습니다.\n잠시 후 다시 시도해주세요.'
      });
    }
  });

  // /건축물 및 /건축물대장 명령어 (동일 핸들러)
  const buildingHandler = async ({ command, ack, say, client }: any) => {
    // 즉시 응답
    await ack();

    const rawInput = command.text.trim();
    const channelId = command.channel_id;

    // 입력 검증
    if (!rawInput) {
      await say({
        text: '❌ 주소를 입력해주세요.\n사용법: `/건축물 서울시 중랑구 중화동 450 103동 904호`\n\n동과 호수를 반드시 포함해주세요.'
      });
      return;
    }

    // 주소 파싱
    const parsedAddress = parseAddress(rawInput);

    if (!parsedAddress) {
      await say({
        text: '❌ 주소를 인식할 수 없습니다.\n다음 형식으로 입력해주세요:\n`/건축물 [시/도] [시/군/구] [읍/면/동] [번지] [동] [호]`'
      });
      return;
    }

    // 전유부 전용: 동+호 필수
    if (!parsedAddress.dong || !parsedAddress.ho) {
      await say({
        text: '❌ 동과 호수를 입력해주세요.\n전유부 건축물대장은 동/호가 필요합니다.\n\n사용법: `/건축물 서울시 중랑구 중화동 450 103동 904호`'
      });
      return;
    }

    // 조회 시작 메시지
    await say({
      text: `🔍 건축물대장(전유부) 조회 중입니다...\n주소: ${parsedAddress.fullAddress}`
    });

    try {
      // 건축물대장 조회
      const result = await buildingService.fetchBuildingLedger(parsedAddress);

      // 파일을 Slack에 업로드
      const fileName = generateFileName('건축물대장', parsedAddress);
      const balanceText = result.pointBalance != null ? `\nTilko 잔액: ${result.pointBalance.toLocaleString()}pt` : '';

      await client.files.uploadV2({
        channel_id: channelId,
        file: fs.createReadStream(result.filePath),
        filename: fileName,
        initial_comment: `✅ 건축물대장 발급 완료\n주소: ${parsedAddress.fullAddress}\n유형: ${result.buildingType}\n발급일시: ${new Date().toLocaleString('ko-KR')}\n비용: ${result.cost}pt${balanceText}`
      });

    } catch (error: any) {
      console.error('건축물대장 조회 실패:', error);
      const errorMsg = error.message || '알 수 없는 오류';
      await say({
        text: `⚠️ 건축물대장 조회 중 오류가 발생했습니다.\n사유: ${errorMsg}\n잠시 후 다시 시도해주세요.`
      });
    }
  };
  app.command('/건축물', buildingHandler);
  app.command('/건축물대장', buildingHandler);

  // /전체 명령어 - 등기부등본 + 건축물대장 동시 조회
  app.command('/전체', async ({ command, ack, say, client }) => {
    await ack();

    const rawInput = command.text.trim();
    const channelId = command.channel_id;

    // 입력 검증
    if (!rawInput) {
      await say({
        text: '❌ 주소를 입력해주세요.\n사용법: `/전체 서울시 중랑구 중화동 450 103동 904호`\n\n등기부등본과 건축물대장을 동시에 조회합니다.\n동과 호수를 반드시 포함해주세요.'
      });
      return;
    }

    // 주소 파싱
    const parsedAddress = parseAddress(rawInput);

    if (!parsedAddress) {
      await say({
        text: '❌ 주소를 인식할 수 없습니다.\n다음 형식으로 입력해주세요:\n`/전체 [시/도] [시/군/구] [읍/면/동] [번지] [동] [호]`'
      });
      return;
    }

    // 전유부 전용: 동+호 필수 (건축물대장에 필요)
    if (!parsedAddress.dong || !parsedAddress.ho) {
      await say({
        text: '❌ 동과 호수를 입력해주세요.\n건축물대장(전유부) 조회에는 동/호가 필요합니다.\n\n사용법: `/전체 서울시 중랑구 중화동 450 103동 904호`'
      });
      return;
    }

    // 조회 시작 메시지
    await say({
      text: `🔍 등기부등본 + 건축물대장 동시 조회 중입니다...\n주소: ${parsedAddress.fullAddress}\n⏳ 잠시만 기다려주세요 (약 30초~1분 소요)`
    });

    // 등기부등본 & 건축물대장 동시 조회
    const [registryResult, buildingResult] = await Promise.allSettled([
      registryService.fetchRegistry(parsedAddress),
      buildingService.fetchBuildingLedger(parsedAddress)
    ]);

    let totalCost = 0;
    let successCount = 0;
    let lastBalance: number | null = null;

    // 등기부등본 결과 처리
    if (registryResult.status === 'fulfilled') {
      try {
        const registry = registryResult.value;
        const fileName = generateFileName('등기부등본', parsedAddress);
        totalCost += 120; // 주소검색 20 + 등기 100
        successCount++;
        if (registry.pointBalance != null) lastBalance = registry.pointBalance;

        await client.files.uploadV2({
          channel_id: channelId,
          file: fs.createReadStream(registry.filePath),
          filename: fileName,
          initial_comment: `✅ 등기부등본 발급 완료\n주소: ${parsedAddress.fullAddress}\n발급일시: ${new Date().toLocaleString('ko-KR')}\n비용: 120pt (주소검색 20 + 등기 100)`
        });
      } catch (uploadError) {
        console.error('등기부등본 업로드 실패:', uploadError);
        await say({ text: '⚠️ 등기부등본은 조회되었으나 업로드에 실패했습니다.' });
      }
    } else {
      console.error('등기부등본 조회 실패:', registryResult.reason);
      await say({
        text: `⚠️ 등기부등본 조회 실패\n사유: ${registryResult.reason?.message || '알 수 없는 오류'}`
      });
    }

    // 건축물대장 결과 처리
    if (buildingResult.status === 'fulfilled') {
      try {
        const building = buildingResult.value;
        const fileName = generateFileName('건축물대장', parsedAddress);
        totalCost += building.cost;
        successCount++;
        if (building.pointBalance != null) lastBalance = building.pointBalance;

        await client.files.uploadV2({
          channel_id: channelId,
          file: fs.createReadStream(building.filePath),
          filename: fileName,
          initial_comment: `✅ 건축물대장 발급 완료\n주소: ${parsedAddress.fullAddress}\n유형: ${building.buildingType}\n발급일시: ${new Date().toLocaleString('ko-KR')}\n비용: ${building.cost}pt`
        });
      } catch (uploadError) {
        console.error('건축물대장 업로드 실패:', uploadError);
        await say({ text: '⚠️ 건축물대장은 조회되었으나 업로드에 실패했습니다.' });
      }
    } else {
      console.error('건축물대장 조회 실패:', buildingResult.reason);
      await say({
        text: `⚠️ 건축물대장 조회 실패\n사유: ${buildingResult.reason?.message || '알 수 없는 오류'}`
      });
    }

    // 최종 요약 메시지
    const balanceText = lastBalance != null ? `\nTilko 잔액: ${lastBalance.toLocaleString()}pt` : '';
    if (successCount === 2) {
      await say({
        text: `📋 전체 조회 완료 (${successCount}/2건 성공)\n총 비용: ${totalCost}pt${balanceText}`
      });
    } else if (successCount === 1) {
      await say({
        text: `📋 전체 조회 부분 완료 (${successCount}/2건 성공)\n총 비용: ${totalCost}pt${balanceText}\n⚠️ 실패한 항목은 개별 명령어로 다시 시도해주세요.`
      });
    } else {
      await say({
        text: '❌ 등기부등본과 건축물대장 모두 조회에 실패했습니다.\n잠시 후 다시 시도해주세요.'
      });
    }
  });
}
