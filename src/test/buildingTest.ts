import { parseAddress } from '../utils/addressParser';
import { TilkoBuildingService } from '../services/tilkoBuildingService';
import { GeminiService } from '../services/geminiService';
import * as dotenv from 'dotenv';

dotenv.config();

const testAddresses = [
  // === 이전 실패/스킵 사례 (Gemini fallback으로 해결?) ===
  // 1. 이전 실패: 야탑동 353 → 만나교회(393) 잘못 선택됨
  '성남시 분당구 야탑동 353 101동 1502호',
  // 2. 이전 실패: 영통동 498 → 신동 498-3 잘못 선택됨
  '경기도 수원시 영통구 영통동 498 150동 202호',
  // 3. 이전 실패: 불정로 6 → 불정로 195 잘못 선택됨 (도로명)
  '성남시 분당구 불정로 6 101동 301호',
  // 4. 이전 스킵: 올림픽로 135 → 주소코드 반환 (도로명)
  '서울시 송파구 올림픽로 135 101동 501호',

  // === 이전 성공 사례 (회귀 방지) ===
  // 5. 중계동 503 (숫자 PK, 정상)
  '서울시 노원구 중계동 503 108동 401호',
  // 6. 우동 1408 (dong normalization: 주동1 ↔ 101동)
  '부산시 해운대구 우동 1408 101동 1201호',
  // 7. 호계동 912 (숫자 PK 선택)
  '안양시 동안구 호계동 912 102동 805호',

  // === 새로운 테스트 주소 ===
  // 8. 서울 대단지 (지번)
  '서울시 강남구 대치동 922 101동 1501호',
  // 9. 서울 구도심 (가 주소)
  '서울시 중구 만리동2가 288 102동 204호',
  // 10. 대구 (지번)
  '대구시 수성구 범어동 124-3 101동 501호',
  // 11. 도로명 - 서울 트리지움 (잠실로 62)
  '서울시 송파구 잠실로 62 101동 801호',
  // 12. 도로명 - 경기 흰돌마을 (중앙로 1124)
  '고양시 일산동구 중앙로 1124 101동 1201호',
];

async function runTests() {
  const geminiService = process.env.GEMINI_API_KEY ? new GeminiService() : null;
  const service = new TilkoBuildingService(geminiService);

  console.log('='.repeat(80));
  console.log('건축물대장 테스트 (BldRgstMst + BldRgstDtl, Gemini fallback 포함)');
  console.log('Gemini:', geminiService ? 'ON' : 'OFF');
  console.log('='.repeat(80));

  const results: { address: string; step: string; status: string; detail: string; gemini: boolean }[] = [];

  for (let i = 0; i < testAddresses.length; i++) {
    const addr = testAddresses[i];
    console.log(`\n${'─'.repeat(80)}`);
    console.log(`[${i + 1}/${testAddresses.length}] ${addr}`);
    console.log('─'.repeat(80));

    // 1) 주소 파싱
    const parsed = parseAddress(addr);
    if (!parsed) {
      console.log('  ❌ 주소 파싱 실패');
      results.push({ address: addr, step: '파싱', status: '❌', detail: '파싱 실패', gemini: false });
      continue;
    }

    console.log(`  ✅ 파싱: sido=${parsed.sido}, sigungu=${parsed.sigungu}, emd=${parsed.eupmyeondong}, jibun=${parsed.jibun}, road=${parsed.isRoadAddress}, dong=${parsed.dong}, ho=${parsed.ho}`);

    if (!parsed.dong || !parsed.ho) {
      console.log('  ⚠️ 동/호 미인식');
      results.push({ address: addr, step: '파싱', status: '⚠️', detail: `dong=${parsed.dong}, ho=${parsed.ho}`, gemini: false });
      continue;
    }

    // 2) BldRgstMst (20pt)
    let searchResult;
    try {
      searchResult = await service.searchBuildingInfo(parsed);
    } catch (e: any) {
      console.log(`  ❌ BldRgstMst 에러: ${e.message}`);
      results.push({ address: addr, step: 'BldRgstMst', status: '❌', detail: e.message, gemini: false });
      continue;
    }

    // 도로명 검색 실패 시 지번 변환 재검색
    if (!searchResult && parsed.isRoadAddress) {
      console.log('  ⚡ 도로명 검색 실패 → 지번 변환 재검색...');
      const lotParsed = await service.convertRoadToLotAddress(parsed);
      if (lotParsed) {
        try {
          searchResult = await service.searchBuildingInfo(lotParsed);
        } catch (e: any) {
          console.log(`  ❌ 지번 재검색 에러: ${e.message}`);
        }
      }
    }

    if (!searchResult) {
      console.log('  ❌ BldRgstMst 결과 없음');
      results.push({ address: addr, step: 'BldRgstMst', status: '❌', detail: '결과 없음', gemini: false });
      continue;
    }

    const geminiForSearch = searchResult.geminiUsed || false;
    console.log(`  ✅ BldRgstMst: PK=${searchResult.bldRgstSeqno}, isAddr=${searchResult.isAddrFormat}${geminiForSearch ? ' [Gemini]' : ''}`);

    // 3) BldRgstDtl (20pt) - 숫자 PK인 경우만
    if (!searchResult.isAddrFormat) {
      try {
        const detail = await service.searchBuildingDetail(
          searchResult.bldRgstSeqno,
          searchResult.untClsfCd,
          '', '',
          parsed.dong, parsed.ho
        );

        if (detail) {
          const gemini = geminiForSearch;
          console.log(`  ✅ BldRgstDtl: ${detail.bldNm} ${detail.dongNm} ${detail.hoNm} (${detail.totArea}㎡)${gemini ? ' [Gemini]' : ''}`);
          results.push({ address: addr, step: 'BldRgstDtl', status: '✅', detail: `${detail.bldNm} ${detail.dongNm} ${detail.hoNm}`, gemini });
        } else {
          console.log('  ❌ BldRgstDtl 동/호 매칭 실패');
          results.push({ address: addr, step: 'BldRgstDtl', status: '❌', detail: '동/호 매칭 실패', gemini: geminiForSearch });
        }
      } catch (e: any) {
        console.log(`  ❌ BldRgstDtl 에러: ${e.message}`);
        results.push({ address: addr, step: 'BldRgstDtl', status: '❌', detail: e.message, gemini: geminiForSearch });
      }
    } else {
      console.log('  ⏭️ 주소코드 형식 → 공공데이터 API 필요 (테스트 미포함)');
      results.push({ address: addr, step: 'BldRgstMst', status: '⏭️', detail: `주소코드: ${searchResult.bldRgstSeqno}`, gemini: false });
    }

    // API 부하 방지
    await new Promise(r => setTimeout(r, 1500));
  }

  // 요약
  console.log('\n\n' + '='.repeat(80));
  console.log('테스트 결과 요약');
  console.log('='.repeat(80));
  results.forEach((r, i) => {
    const gemTag = r.gemini ? ' [Gemini]' : '';
    console.log(`  [${i + 1}] ${r.status} ${r.address}${gemTag}`);
    console.log(`      ${r.step}: ${r.detail}`);
  });

  const success = results.filter(r => r.status === '✅').length;
  const fail = results.filter(r => r.status === '❌').length;
  const skip = results.filter(r => r.status === '⏭️' || r.status === '⚠️').length;
  const geminiCount = results.filter(r => r.gemini).length;
  console.log(`\n  성공: ${success}, 실패: ${fail}, 스킵: ${skip} / 총 ${results.length}건`);
  console.log(`  Gemini 사용: ${geminiCount}건`);
}

runTests().catch(console.error);
