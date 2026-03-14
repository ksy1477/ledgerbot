import { App } from '@slack/bolt';
import axios from 'axios';
import { parseAddress, generateFileName, summarizeParsed } from '../utils/addressParser';
import { UnifiedRegistryService, UnifiedBuildingService } from '../services';
import { ParsedAddress } from '../types';
import * as fs from 'fs';

const registryService = new UnifiedRegistryService();
const buildingService = new UnifiedBuildingService();

/**
 * JUSO API로 주소 유효성 사전 검증 (무료)
 * 유료 API 호출 전에 주소가 실제 존재하는지 확인하여 포인트 낭비 방지
 */
async function validateAddressWithJuso(address: ParsedAddress): Promise<{
  valid: boolean;
  errorReason?: string;
}> {
  const jusoApiKey = process.env.JUSO_API_KEY;
  if (!jusoApiKey) return { valid: true }; // 키 없으면 검증 스킵

  const keyword = [address.sido, address.sigungu, address.eupmyeondong, address.jibun]
    .filter(Boolean).join(' ');

  try {
    const response = await axios.get('https://business.juso.go.kr/addrlink/addrLinkApi.do', {
      params: {
        confmKey: jusoApiKey,
        currentPage: 1,
        countPerPage: 10,
        keyword,
        resultType: 'json',
      },
      timeout: 10000,
    });

    const common = response.data?.results?.common;
    const results = response.data?.results?.juso;

    if (common?.errorCode !== '0') return { valid: true }; // API 에러 시 스킵

    if (!results || results.length === 0) {
      return {
        valid: false,
        errorReason: `"${keyword}" 주소를 찾을 수 없습니다. 주소를 다시 확인해주세요.`,
      };
    }

    return { valid: true };
  } catch {
    return { valid: true }; // 네트워크 에러 시 스킵
  }
}

/**
 * 스레드에 메시지를 보내는 헬퍼
 */
async function replyInThread(
  client: any,
  channelId: string,
  threadTs: string,
  text: string
): Promise<void> {
  await client.chat.postMessage({
    channel: channelId,
    thread_ts: threadTs,
    text,
  });
}

/**
 * 앱 멘션 메시지에서 명령어와 주소를 파싱
 * "@봇 등기 서울시 중랑구..." → { command: '등기', addressText: '서울시 중랑구...' }
 */
function parseMentionCommand(text: string): { command: string; addressText: string } | null {
  // 멘션 태그 제거 후 트림
  const cleaned = text.replace(/<@[A-Z0-9]+>/g, '').trim();
  if (!cleaned) return null;

  // 첫 토큰이 명령어
  const spaceIdx = cleaned.indexOf(' ');
  if (spaceIdx === -1) {
    // 명령어만 있고 주소 없음
    return { command: cleaned, addressText: '' };
  }

  const command = cleaned.substring(0, spaceIdx).trim();
  const addressText = cleaned.substring(spaceIdx + 1).trim();
  return { command, addressText };
}

/**
 * 명령어 등록
 *
 * 1) 슬래시 명령어: /등기, /건축물, /건축물대장, /전체
 *    → 채널에 부모 메시지 + 스레드에 결과 (방법 B)
 *
 * 2) 앱 멘션: @봇 등기 주소, @봇 건축물 주소, @봇 전체 주소
 *    → 스레드 안에서 요청하면 해당 스레드에 결과 (방법 A)
 *    → 채널 본문에서 요청하면 방법 B와 동일
 */
export function registerCommands(app: App): void {

  // ============================================================
  // 공통 처리 함수
  // ============================================================

  /**
   * 등기부등본 조회 처리
   */
  async function handleRegistry(
    client: any,
    channelId: string,
    threadTs: string,
    rawInput: string,
    replyError: (text: string) => Promise<void>,
    notifyChannel: boolean = false,
    userId?: string
  ): Promise<void> {
    const parsedAddress = parseAddress(rawInput);

    if (!parsedAddress) {
      await replyError(
        '❌ 주소를 인식할 수 없습니다.\n형식: [시/도] [시/군/구] [읍/면/동] [번지] [건물명] [동] [호]'
      );
      return;
    }

    // 주소 유효성 사전 검증 (무료)
    const validation = await validateAddressWithJuso(parsedAddress);
    if (!validation.valid) {
      await replyError(`❌ 유효하지 않은 주소입니다.\n${validation.errorReason}`);
      return;
    }

    await replyInThread(client, channelId, threadTs,
      `🔍 등기부등본 조회 중...\n주소: ${parsedAddress.fullAddress}`
    );

    try {
      const result = await registryService.fetchRegistry(parsedAddress);
      const fileName = generateFileName('등기부등본', parsedAddress);

      const balanceText = result.pointBalance != null ? `\n💰 잔여 포인트: ${result.pointBalance.toLocaleString()}pt` : '';
      const userTag = userId ? `\n👤 요청자: <@${userId}>` : '';

      await client.files.uploadV2({
        channel_id: channelId,
        thread_ts: threadTs,
        file: fs.createReadStream(result.filePath),
        filename: fileName,
        initial_comment: `✅ 등기부등본 발급 완료${balanceText}${userTag}`
      });

      if (notifyChannel) {
        await client.chat.postMessage({
          channel: channelId,
          text: `✅ ${parsedAddress.fullAddress}의 등기부등본이 발급되었습니다.${userTag}`
        });
      }

    } catch (error: any) {
      console.error('등기부등본 조회 실패:', error);
      const errorMsg = error.message || '알 수 없는 오류';

      if (String(errorMsg).includes('통신')) {
        const retryMinutes = 5;
        await replyInThread(client, channelId, threadTs,
          `⚠️ 서버 일시 장애가 감지되었습니다.\n${retryMinutes}분 후 자동으로 재시도합니다.\n(사유: ${errorMsg})`
        );

        setTimeout(async () => {
          try {
            console.log(`[자동 재시도] 등기부등본: ${parsedAddress.fullAddress}`);
            await replyInThread(client, channelId, threadTs,
              `🔄 등기부등본 자동 재시도 중...\n주소: ${parsedAddress.fullAddress}`
            );

            const retryResult = await registryService.fetchRegistry(parsedAddress);
            const retryFileName = generateFileName('등기부등본', parsedAddress);
            const balText = retryResult.pointBalance != null ? `\n💰 잔여 포인트: ${retryResult.pointBalance.toLocaleString()}pt` : '';
            const uTag = userId ? `\n👤 요청자: <@${userId}>` : '';

            await client.files.uploadV2({
              channel_id: channelId,
              thread_ts: threadTs,
              file: fs.createReadStream(retryResult.filePath),
              filename: retryFileName,
              initial_comment: `✅ 등기부등본 발급 완료 (자동 재시도 성공)${balText}${uTag}`
            });
          } catch (retryError: any) {
            console.error('[자동 재시도] 등기부등본 재시도 실패:', retryError.message);
            await replyInThread(client, channelId, threadTs,
              `❌ 자동 재시도도 실패했습니다.\n사유: ${retryError.message}\n서버 장애가 지속되고 있습니다. 잠시 후 수동으로 다시 시도해주세요.`
            );
          }
        }, retryMinutes * 60 * 1000);
      } else {
        await replyInThread(client, channelId, threadTs,
          `⚠️ 등기부등본 조회 중 오류가 발생했습니다.\n사유: ${errorMsg}\n잠시 후 다시 시도해주세요.`
        );
      }
    }
  }

  /**
   * 건축물대장 조회 처리
   */
  async function handleBuilding(
    client: any,
    channelId: string,
    threadTs: string,
    rawInput: string,
    replyError: (text: string) => Promise<void>,
    notifyChannel: boolean = false,
    userId?: string
  ): Promise<void> {
    const parsedAddress = parseAddress(rawInput);

    if (!parsedAddress) {
      await replyError(
        '❌ 주소를 인식할 수 없습니다.\n형식: [시/도] [시/군/구] [읍/면/동] [번지] [동] [호]'
      );
      return;
    }

    // 동/호 유무에 따라 표제부/전유부 자동 결정
    const ledgerType: '전유부' | '표제부' = (parsedAddress.dong && parsedAddress.ho) ? '전유부' : '표제부';

    // 주소 유효성 사전 검증 (무료)
    const validation = await validateAddressWithJuso(parsedAddress);
    if (!validation.valid) {
      await replyError(`❌ 유효하지 않은 주소입니다.\n${validation.errorReason}`);
      return;
    }

    await replyInThread(client, channelId, threadTs,
      `🔍 건축물대장(${ledgerType}) 조회 중...\n주소: ${parsedAddress.fullAddress}`
    );

    try {
      const result = await buildingService.fetchBuildingLedger(parsedAddress, ledgerType);
      const fileName = generateFileName('건축물대장', parsedAddress);

      const balanceText = result.pointBalance != null ? `\n💰 잔여 포인트: ${result.pointBalance.toLocaleString()}pt` : '';
      const userTag = userId ? `\n👤 요청자: <@${userId}>` : '';
      const geminiText = result.geminiUsed ? '\n🤖 AI 보정을 통해 올바른 결과물이 추출되었습니다.' : '';

      await client.files.uploadV2({
        channel_id: channelId,
        thread_ts: threadTs,
        file: fs.createReadStream(result.filePath),
        filename: fileName,
        initial_comment: `✅ 건축물대장 발급 완료${geminiText}${balanceText}${userTag}`
      });

      if (notifyChannel) {
        await client.chat.postMessage({
          channel: channelId,
          text: `✅ ${parsedAddress.fullAddress}의 건축물대장이 발급되었습니다.${userTag}`
        });
      }

    } catch (error: any) {
      console.error('건축물대장 조회 실패:', error);
      const errorMsg = error.message || '알 수 없는 오류';

      // 세움터 서버 통신 오류 감지 → 5분 후 자동 재시도 (1회)
      if (String(errorMsg).includes('통신') && !(error as any)._retried) {
        const retryMinutes = 5;
        await replyInThread(client, channelId, threadTs,
          `⚠️ 세움터 서버 일시 장애가 감지되었습니다.\n${retryMinutes}분 후 자동으로 재시도합니다.\n(사유: ${errorMsg})`
        );

        setTimeout(async () => {
          try {
            console.log(`[자동 재시도] 건축물대장: ${parsedAddress.fullAddress}`);
            await replyInThread(client, channelId, threadTs,
              `🔄 건축물대장 자동 재시도 중...\n주소: ${parsedAddress.fullAddress}`
            );

            const retryResult = await buildingService.fetchBuildingLedger(parsedAddress, ledgerType);
            const retryFileName = generateFileName('건축물대장', parsedAddress);
            const balText = retryResult.pointBalance != null ? `\n💰 잔여 포인트: ${retryResult.pointBalance.toLocaleString()}pt` : '';
            const uTag = userId ? `\n👤 요청자: <@${userId}>` : '';
            const gText = retryResult.geminiUsed ? '\n🤖 AI 보정을 통해 올바른 결과물이 추출되었습니다.' : '';

            await client.files.uploadV2({
              channel_id: channelId,
              thread_ts: threadTs,
              file: fs.createReadStream(retryResult.filePath),
              filename: retryFileName,
              initial_comment: `✅ 건축물대장(${ledgerType}) 발급 완료 (자동 재시도 성공)${gText}${balText}${uTag}`
            });
          } catch (retryError: any) {
            console.error('[자동 재시도] 건축물대장 재시도 실패:', retryError.message);
            await replyInThread(client, channelId, threadTs,
              `❌ 자동 재시도도 실패했습니다.\n사유: ${retryError.message}\n세움터 서버 장애가 지속되고 있습니다. 잠시 후 수동으로 다시 시도해주세요.`
            );
          }
        }, retryMinutes * 60 * 1000);
      } else {
        await replyInThread(client, channelId, threadTs,
          `⚠️ 건축물대장 조회 중 오류가 발생했습니다.\n사유: ${errorMsg}\n잠시 후 다시 시도해주세요.`
        );
      }
    }
  }

  /**
   * 전체(등기+건축물) 동시 조회 처리
   *
   * 슬래시 명령어: 등기/건축물 각각 별도 부모 메시지+스레드 생성
   * 앱 멘션: 기존 스레드에 결과 출력
   */
  async function handleAll(
    client: any,
    channelId: string,
    existingThreadTs: string,
    rawInput: string,
    replyError: (text: string) => Promise<void>,
    notifyChannel: boolean = false,
    userId?: string
  ): Promise<void> {
    const parsedAddress = parseAddress(rawInput);

    if (!parsedAddress) {
      await replyError(
        '❌ 주소를 인식할 수 없습니다.\n형식: [시/도] [시/군/구] [읍/면/동] [번지] [동] [호]'
      );
      return;
    }

    const allLedgerType: '전유부' | '표제부' = (parsedAddress.dong && parsedAddress.ho) ? '전유부' : '표제부';

    // 주소 유효성 사전 검증 (무료)
    const validation = await validateAddressWithJuso(parsedAddress);
    if (!validation.valid) {
      await replyError(`❌ 유효하지 않은 주소입니다.\n${validation.errorReason}`);
      return;
    }

    let registryThreadTs: string;
    let buildingThreadTs: string;

    if (existingThreadTs) {
      // 앱 멘션: 기존 스레드에 결과 출력
      registryThreadTs = existingThreadTs;
      buildingThreadTs = existingThreadTs;

      await replyInThread(client, channelId, existingThreadTs,
        `🔍 등기부등본 + 건축물대장 동시 조회 중...\n주소: ${parsedAddress.fullAddress}\n⏳ 잠시만 기다려주세요 (약 30초~1분 소요)`
      );
    } else {
      // 슬래시 명령어: 각각 별도 부모 메시지+스레드 생성
      const byText = userId ? ` (by <@${userId}>)` : '';
      registryThreadTs = (await client.chat.postMessage({
        channel: channelId,
        text: `📋 등기부등본 요청: ${rawInput}${byText}`,
      })).ts as string;

      buildingThreadTs = (await client.chat.postMessage({
        channel: channelId,
        text: `📋 건축물대장 요청: ${rawInput}${byText}`,
      })).ts as string;

      await replyInThread(client, channelId, registryThreadTs,
        `🔍 등기부등본 조회 중...\n주소: ${parsedAddress.fullAddress}`
      );
      await replyInThread(client, channelId, buildingThreadTs,
        `🔍 건축물대장(${allLedgerType}) 조회 중...\n주소: ${parsedAddress.fullAddress}\n⏳ 잠시만 기다려주세요`
      );
    }

    // 동시 조회
    const [registryResult, buildingResult] = await Promise.allSettled([
      registryService.fetchRegistry(parsedAddress),
      buildingService.fetchBuildingLedger(parsedAddress, allLedgerType)
    ]);

    const issued: string[] = [];

    const userTag = userId ? `\n👤 요청자: <@${userId}>` : '';

    // 등기부등본 → 등기 스레드에 결과
    if (registryResult.status === 'fulfilled') {
      try {
        const registry = registryResult.value;
        const fileName = generateFileName('등기부등본', parsedAddress);
        const balanceText = registry.pointBalance != null ? `\n💰 잔여 포인트: ${registry.pointBalance.toLocaleString()}pt` : '';

        await client.files.uploadV2({
          channel_id: channelId,
          thread_ts: registryThreadTs,
          file: fs.createReadStream(registry.filePath),
          filename: fileName,
          initial_comment: `✅ 등기부등본 발급 완료${balanceText}${userTag}`
        });
        issued.push('등기부등본');
      } catch (uploadError) {
        console.error('등기부등본 업로드 실패:', uploadError);
        await replyInThread(client, channelId, registryThreadTs,
          '⚠️ 등기부등본은 조회되었으나 업로드에 실패했습니다.'
        );
      }
    } else {
      const regErrMsg = registryResult.reason?.message || '알 수 없는 오류';
      console.error('등기부등본 조회 실패:', registryResult.reason);

      if (String(regErrMsg).includes('통신')) {
        await replyInThread(client, channelId, registryThreadTs,
          `⚠️ 서버 일시 장애가 감지되었습니다. 5분 후 자동 재시도합니다.`
        );
        setTimeout(async () => {
          try {
            await replyInThread(client, channelId, registryThreadTs, `🔄 등기부등본 자동 재시도 중...`);
            const r = await registryService.fetchRegistry(parsedAddress);
            const fn = generateFileName('등기부등본', parsedAddress);
            const bt = r.pointBalance != null ? `\n💰 잔여 포인트: ${r.pointBalance.toLocaleString()}pt` : '';
            await client.files.uploadV2({
              channel_id: channelId, thread_ts: registryThreadTs,
              file: fs.createReadStream(r.filePath), filename: fn,
              initial_comment: `✅ 등기부등본 발급 완료 (자동 재시도 성공)${bt}${userTag}`
            });
          } catch (e: any) {
            await replyInThread(client, channelId, registryThreadTs, `❌ 자동 재시도도 실패했습니다.\n사유: ${e.message}`);
          }
        }, 5 * 60 * 1000);
      } else {
        await replyInThread(client, channelId, registryThreadTs, `⚠️ 등기부등본 조회 실패\n사유: ${regErrMsg}`);
      }
    }

    // 건축물대장 → 건축물 스레드에 결과
    if (buildingResult.status === 'fulfilled') {
      try {
        const building = buildingResult.value;
        const fileName = generateFileName('건축물대장', parsedAddress);
        const balanceText = building.pointBalance != null ? `\n💰 잔여 포인트: ${building.pointBalance.toLocaleString()}pt` : '';
        const geminiText2 = building.geminiUsed ? '\n🤖 AI 보정을 통해 올바른 결과물이 추출되었습니다.' : '';

        await client.files.uploadV2({
          channel_id: channelId,
          thread_ts: buildingThreadTs,
          file: fs.createReadStream(building.filePath),
          filename: fileName,
          initial_comment: `✅ 건축물대장 발급 완료${geminiText2}${balanceText}${userTag}`
        });
        issued.push('건축물대장');
      } catch (uploadError) {
        console.error('건축물대장 업로드 실패:', uploadError);
        await replyInThread(client, channelId, buildingThreadTs,
          '⚠️ 건축물대장은 조회되었으나 업로드에 실패했습니다.'
        );
      }
    } else {
      const bldErrMsg = buildingResult.reason?.message || '알 수 없는 오류';
      console.error('건축물대장 조회 실패:', buildingResult.reason);

      if (String(bldErrMsg).includes('통신')) {
        await replyInThread(client, channelId, buildingThreadTs,
          `⚠️ 세움터 서버 일시 장애가 감지되었습니다. 5분 후 자동 재시도합니다.`
        );
        setTimeout(async () => {
          try {
            await replyInThread(client, channelId, buildingThreadTs, `🔄 건축물대장 자동 재시도 중...`);
            const r = await buildingService.fetchBuildingLedger(parsedAddress, allLedgerType);
            const fn = generateFileName('건축물대장', parsedAddress);
            const bt = r.pointBalance != null ? `\n💰 잔여 포인트: ${r.pointBalance.toLocaleString()}pt` : '';
            const gt = r.geminiUsed ? '\n🤖 AI 보정을 통해 올바른 결과물이 추출되었습니다.' : '';
            await client.files.uploadV2({
              channel_id: channelId, thread_ts: buildingThreadTs,
              file: fs.createReadStream(r.filePath), filename: fn,
              initial_comment: `✅ 건축물대장 발급 완료 (자동 재시도 성공)${gt}${bt}${userTag}`
            });
          } catch (e: any) {
            await replyInThread(client, channelId, buildingThreadTs, `❌ 자동 재시도도 실패했습니다.\n사유: ${e.message}`);
          }
        }, 5 * 60 * 1000);
      } else {
        await replyInThread(client, channelId, buildingThreadTs, `⚠️ 건축물대장 조회 실패\n사유: ${bldErrMsg}`);
      }
    }

    // 채널 본문에 발급 사실 알림 (앱 멘션일 때만)
    if (issued.length > 0 && notifyChannel) {
      await client.chat.postMessage({
        channel: channelId,
        text: `✅ ${parsedAddress.fullAddress}의 ${issued.join(' / ')}이(가) 발급되었습니다.${userTag}`
      });
    } else if (issued.length === 0) {
      await replyInThread(client, channelId, registryThreadTs,
        '❌ 등기부등본과 건축물대장 모두 조회에 실패했습니다.\n잠시 후 다시 시도해주세요.'
      );
    }
  }

  // ============================================================
  // 슬래시 명령어 (방법 B: 채널에 부모 메시지 → 스레드에 결과)
  // ============================================================

  app.command('/등기', async ({ command, ack, say, client }) => {
    await ack();
    const rawInput = command.text.trim();
    const channelId = command.channel_id;
    const userId = command.user_id;

    if (!rawInput) {
      await say({ text: '❌ 주소를 입력해주세요.\n사용법: `/등기 서울시 중랑구 중화동 450 103동 904호`' });
      return;
    }

    const threadTs = (await client.chat.postMessage({
      channel: channelId,
      text: `📋 등기부등본 요청: ${rawInput} (by <@${userId}>)`,
    })).ts as string;

    await handleRegistry(client, channelId, threadTs, rawInput, (text) =>
      replyInThread(client, channelId, threadTs, text),
      false, userId
    );
  });

  const buildingSlashHandler = async ({ command, ack, say, client }: any) => {
    await ack();
    const rawInput = command.text.trim();
    const channelId = command.channel_id;
    const userId = command.user_id;

    if (!rawInput) {
      await say({ text: '❌ 주소를 입력해주세요.\n사용법: `/건축물 서울시 중랑구 중화동 450 103동 904호`\n\n동과 호수를 반드시 포함해주세요.' });
      return;
    }

    const threadTs = (await client.chat.postMessage({
      channel: channelId,
      text: `📋 건축물대장 요청: ${rawInput} (by <@${userId}>)`,
    })).ts as string;

    await handleBuilding(client, channelId, threadTs, rawInput, (text) =>
      replyInThread(client, channelId, threadTs, text),
      false, userId
    );
  };
  app.command('/건축물', buildingSlashHandler);
  app.command('/건축물대장', buildingSlashHandler);

  app.command('/전체', async ({ command, ack, say, client }) => {
    await ack();
    const rawInput = command.text.trim();
    const channelId = command.channel_id;
    const userId = command.user_id;

    if (!rawInput) {
      await say({ text: '❌ 주소를 입력해주세요.\n사용법: `/전체 서울시 중랑구 중화동 450 103동 904호`\n\n동과 호수를 반드시 포함해주세요.' });
      return;
    }

    // handleAll이 내부에서 등기/건축물 각각 부모 메시지를 생성
    await handleAll(client, channelId, '', rawInput, async (text) => {
      await say({ text });
    }, false, userId);
  });

  // ============================================================
  // 앱 멘션 (방법 A: 스레드 안에서 요청 → 해당 스레드에 결과)
  //
  // 사용법:
  //   @봇이름 등기 서울시 중랑구 중화동 450 103동 904호
  //   @봇이름 건축물 서울시 중랑구 중화동 450 103동 904호
  //   @봇이름 전체 서울시 중랑구 중화동 450 103동 904호
  // ============================================================

  app.event('app_mention', async ({ event, client }) => {
    const channelId = event.channel;
    const userId = event.user;
    // 스레드 안이면 해당 스레드, 아니면 이 메시지 자체를 스레드 부모로
    const threadTs = event.thread_ts || event.ts;

    const parsed = parseMentionCommand(event.text);
    if (!parsed) {
      await replyInThread(client, channelId, threadTs,
        '❌ 명령어를 입력해주세요.\n사용법: `@봇이름 등기 서울시 중랑구 중화동 450 103동 904호`\n명령어: 등기, 건축물, 전체'
      );
      return;
    }

    const { command, addressText } = parsed;

    if (!addressText) {
      await replyInThread(client, channelId, threadTs,
        `❌ 주소를 입력해주세요.\n사용법: \`@봇이름 ${command} 서울시 중랑구 중화동 450 103동 904호\``
      );
      return;
    }

    const replyError = (text: string) => replyInThread(client, channelId, threadTs, text);

    switch (command) {
      case '등기':
      case '등기부등본':
        await handleRegistry(client, channelId, threadTs, addressText, replyError, true, userId);
        break;
      case '건축물':
      case '건축물대장':
        await handleBuilding(client, channelId, threadTs, addressText, replyError, true, userId);
        break;
      case '전체':
        await handleAll(client, channelId, threadTs, addressText, replyError, true, userId);
        break;
      default:
        await replyInThread(client, channelId, threadTs,
          `❌ 알 수 없는 명령어: ${command}\n사용 가능한 명령어: 등기, 건축물, 전체`
        );
    }
  });
}
