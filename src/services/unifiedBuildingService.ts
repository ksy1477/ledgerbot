import { TilkoBuildingService } from './tilkoBuildingService';
import { GeminiService } from './geminiService';
import { ParsedAddress } from '../types';

/**
 * 통합 건축물대장 서비스 (전유부 전용)
 *
 * 플로우 A (BldRgstMst → 숫자 PK):
 *   1. BldRgstMst: 주소 → 건축물등록번호 (20pt)
 *   2. BldRgstDtl: 상세정보 → 동/호 매칭 (20pt)
 *   3. RPTCAA02R01: PDF 발급 (100pt)
 *
 * 플로우 B (BldRgstMst → 주소코드 또는 BLDG PK 실패):
 *   1. BldRgstMst: 주소 → 주소코드 (20pt) 또는 실패한 BLDG PK
 *   1-2. 공공데이터 API: 주소코드 → 동별 표제부 PK (무료)
 *   2. BldRgstDtl: 상세정보 → 동/호 매칭 (20pt)
 *   3. RPTCAA02R01: PDF 발급 (100pt)
 *
 * 총 비용: 140~160pt/건
 */
export class UnifiedBuildingService {
  private tilkoBuildingService: TilkoBuildingService;

  constructor() {
    const geminiService = process.env.GEMINI_API_KEY ? new GeminiService() : null;
    this.tilkoBuildingService = new TilkoBuildingService(geminiService);
  }

  /**
   * 사용자 지번에서 본번/부번 파싱
   * "1718" → { bun: "1718", ji: "0000" }
   * "1718-4" → { bun: "1718", ji: "0004" }
   */
  private parseUserJibun(jibun: string): { bun: string; ji: string } {
    const parts = jibun.split('-');
    return {
      bun: parts[0].padStart(4, '0'),
      ji: parts.length > 1 ? parts[1].padStart(4, '0') : '0000',
    };
  }

  /**
   * 공공데이터 API로 동별 PK 조회 (sigunguCd, bjdongCd 필요)
   */
  private async resolveWithPublicData(
    sigunguCd: string,
    bjdongCd: string,
    address: ParsedAddress,
    overrideBun?: string,
    overrideJi?: string
  ): Promise<{ detailSeqno: string; detailUntClsfCd: string } | null> {
    const userParsed = this.parseUserJibun(address.jibun);
    const bun = overrideBun || userParsed.bun;
    const ji = overrideJi || userParsed.ji;
    console.log(`  지번 파싱: bun=${bun}, ji=${ji}${overrideBun ? ' (BldRgstMst 주소코드 사용)' : ' (사용자 입력)'}`);

    const resolved = await this.tilkoBuildingService.resolveBuildingPkFromPublicData(
      sigunguCd, bjdongCd, bun, ji, address.dong!
    );

    if (!resolved) return null;

    return {
      detailSeqno: resolved.bldRgstSeqno,
      detailUntClsfCd: resolved.untClsfCd,
    };
  }

  async fetchBuildingLedger(address: ParsedAddress): Promise<{
    filePath: string;
    pointBalance?: number;
    cost: number;
    buildingType: string;
    geminiUsed?: boolean;
  }> {
    console.log('='.repeat(60));
    console.log('건축물대장(전유부) 조회 시작:', address.fullAddress);
    console.log('='.repeat(60));

    if (!address.dong || !address.ho) {
      throw new Error('전유부 건축물대장은 동/호가 필요합니다.');
    }

    let totalCost = 0;
    let geminiUsed = false;

    try {
      // ────────────────────────────────────────
      // 0단계: 주소 유효성 사전 검증 (JUSO API, 무료)
      // ────────────────────────────────────────
      console.log('\n[0] 주소 유효성 검증 (JUSO API, 무료)...');
      const validation = await this.tilkoBuildingService.validateAddress(address);
      if (!validation.valid) {
        throw new Error(`유효하지 않은 주소입니다. ${validation.errorReason || '주소를 다시 확인해주세요.'}`);
      }

      // ────────────────────────────────────────
      // 1단계: 주소로 건축물 등록번호 조회 (20pt)
      // ────────────────────────────────────────
      console.log('\n[1/3] 건축물 주소 조회 (BldRgstMst, 20pt)...');
      let searchResult = await this.tilkoBuildingService.searchBuildingInfo(address);

      // 도로명 주소로 검색 실패 시 → JUSO API로 지번 변환 후 재검색
      if (!searchResult && address.isRoadAddress) {
        console.log('\n[1-fallback] 도로명 검색 실패 → 지번 변환 후 재검색...');
        const lotAddress = await this.tilkoBuildingService.convertRoadToLotAddress(address);
        if (lotAddress) {
          searchResult = await this.tilkoBuildingService.searchBuildingInfo(lotAddress);
          if (searchResult) {
            totalCost += 20; // 재검색 비용
            console.log('  → 지번 변환 재검색 성공!');
            // 이후 과정에서 원래 address 대신 lotAddress 사용할 필요 없음 (dong/ho는 원래 address에서 가져옴)
          }
        }
      }

      if (!searchResult) {
        throw new Error('건축물 등록번호를 찾을 수 없습니다. 주소를 확인해주세요.');
      }

      if (searchResult.geminiUsed) geminiUsed = true;
      totalCost += 20;

      // BldRgstDtl에 사용할 PK와 UntClsfCd 결정
      let detailSeqno = searchResult.bldRgstSeqno;
      let detailUntClsfCd = searchResult.untClsfCd;
      let usedPublicDataFallback = false;

      // ────────────────────────────────────────
      // 1-2단계: 주소코드 → 공공데이터 API로 동별 PK 조회 (무료)
      // ────────────────────────────────────────
      if (searchResult.isAddrFormat && searchResult.addrParts) {
        console.log('\n[1-2] 주소코드 형식 감지 → 공공데이터 API로 동별 PK 조회 (무료)...');
        const { sigunguCd, bjdongCd, bun, ji } = searchResult.addrParts;

        // BldRgstMst 주소코드의 bun/ji 사용 (사용자 입력과 다를 수 있음)
        const userParsed = this.parseUserJibun(address.jibun);
        let resolved = await this.resolveWithPublicData(sigunguCd, bjdongCd, address, bun, ji);

        // 실패 시 사용자 입력 bun/ji로 재시도 (BldRgstMst가 부필지를 반환한 경우)
        if (!resolved && (userParsed.bun !== bun || userParsed.ji !== ji)) {
          console.log(`  BldRgstMst bun/ji(${bun}/${ji})로 실패 → 사용자 입력(${userParsed.bun}/${userParsed.ji})으로 재시도...`);
          resolved = await this.resolveWithPublicData(sigunguCd, bjdongCd, address);
        }

        if (resolved) {
          detailSeqno = resolved.detailSeqno;
          detailUntClsfCd = resolved.detailUntClsfCd;
          usedPublicDataFallback = true;
          console.log(`  → 동별 PK: ${detailSeqno}, UntClsfCd: ${detailUntClsfCd}`);
        } else {
          throw new Error('공공데이터에서 건축물 정보를 찾을 수 없습니다. 주소를 확인해주세요.');
        }
      }

      // ────────────────────────────────────────
      // 2단계: 상세정보 조회 → 특정 동/호 매칭 (20pt)
      // ────────────────────────────────────────
      console.log('\n[2/3] 상세정보 조회 (BldRgstDtl, 20pt)...');
      let detailResult = await this.tilkoBuildingService.searchBuildingDetail(
        detailSeqno,
        detailUntClsfCd,
        '',
        '',
        address.dong,
        address.ho
      );

      // ────────────────────────────────────────
      // 2-fallback A: 공공데이터 PK 실패 시 주소코드 직접 사용
      // ────────────────────────────────────────
      if (!detailResult && usedPublicDataFallback && searchResult.isAddrFormat && searchResult.addrParts) {
        const { sigunguCd, bjdongCd, bun, ji } = searchResult.addrParts;
        const userParsed = this.parseUserJibun(address.jibun);

        // 1) BldRgstMst 주소코드 그대로 시도
        console.log('\n[2-fallback-A1] BldRgstMst 주소코드로 BldRgstDtl 재시도 (20pt)...');
        console.log(`  주소코드: ${searchResult.bldRgstSeqno}, UntClsfCd: ${searchResult.untClsfCd}`);
        detailResult = await this.tilkoBuildingService.searchBuildingDetail(
          searchResult.bldRgstSeqno,
          searchResult.untClsfCd,
          '',
          '',
          address.dong,
          address.ho
        );
        if (detailResult) {
          totalCost += 20;
        }

        // 2) 사용자 입력 bun/ji로 주소코드 조합하여 시도
        if (!detailResult && (userParsed.bun !== bun || userParsed.ji !== ji)) {
          const userAddrCode = `${sigunguCd}_${bjdongCd}_0_${userParsed.bun}_${userParsed.ji}`;
          console.log(`\n[2-fallback-A2] 사용자 지번 주소코드로 BldRgstDtl 재시도 (20pt)...`);
          console.log(`  주소코드: ${userAddrCode}, UntClsfCd: ${searchResult.untClsfCd}`);
          detailResult = await this.tilkoBuildingService.searchBuildingDetail(
            userAddrCode,
            searchResult.untClsfCd,
            '',
            '',
            address.dong,
            address.ho
          );
          if (detailResult) {
            totalCost += 20;
          }
        }
      }

      // ────────────────────────────────────────
      // 2-fallback B: BLDG PK로 BldRgstDtl 실패 시 공공데이터 API로 재시도
      // ────────────────────────────────────────
      if (!detailResult && !usedPublicDataFallback) {
        console.log('\n[2-fallback-B] BLDG PK 실패 → 주소정보 API + 공공데이터 API로 재시도...');

        // 주소정보 API로 법정동코드 조회 (무료)
        const codes = await this.tilkoBuildingService.lookupAddressCodes(address);
        if (codes) {
          const resolved = await this.resolveWithPublicData(codes.sigunguCd, codes.bjdongCd, address);
          if (resolved) {
            console.log(`  → 동별 PK: ${resolved.detailSeqno}, UntClsfCd: ${resolved.detailUntClsfCd}`);
            console.log('\n[2-fallback-B] 공공데이터 PK로 BldRgstDtl 재시도 (20pt)...');
            detailResult = await this.tilkoBuildingService.searchBuildingDetail(
              resolved.detailSeqno,
              resolved.detailUntClsfCd,
              '',
              '',
              address.dong,
              address.ho
            );
            if (detailResult) {
              totalCost += 20; // 재시도 BldRgstDtl 비용
            }
          }
        }
      }

      if (!detailResult || !detailResult.bldRgstSeqno) {
        throw new Error(`${address.dong} ${address.ho}를 찾을 수 없습니다. 동/호를 확인해주세요.`);
      }

      totalCost += 20;

      const regstrKindCd = detailResult.regstrKindCd || '4';
      const bldRgstSeqno = detailResult.bldRgstSeqno;
      const untClsfCd = detailResult.untClsfCd;
      const upperBldRgstSeqno = detailResult.upperBldRgstSeqno || '';

      console.log(`  ${detailResult.bldNm} ${detailResult.dongNm} ${detailResult.hoNm} (${detailResult.totArea}㎡)`);

      // ────────────────────────────────────────
      // 3단계: 건축물대장 PDF 발급 (100pt)
      // ────────────────────────────────────────
      console.log('\n[3/3] 건축물대장 PDF 발급 (RPTCAA02R01, 100pt)...');
      const pdfResult = await this.tilkoBuildingService.fetchBuildingLedger(
        address,
        regstrKindCd,
        bldRgstSeqno,
        untClsfCd,
        upperBldRgstSeqno
      );

      totalCost += 100;

      console.log('\n' + '='.repeat(60));
      console.log('건축물대장(전유부) 조회 완료!');
      console.log(`  ${detailResult.bldNm} ${detailResult.dongNm} ${detailResult.hoNm}`);
      console.log(`  비용: ${totalCost}pt`);
      console.log(`  잔액: ${pdfResult.pointBalance?.toLocaleString() || '확인불가'}pt`);
      console.log('='.repeat(60));

      return {
        filePath: pdfResult.filePath,
        pointBalance: pdfResult.pointBalance,
        cost: totalCost,
        buildingType: '전유부',
        geminiUsed,
      };

    } catch (error: any) {
      console.error('\n' + '='.repeat(60));
      console.error('건축물대장 조회 실패');
      console.error('='.repeat(60));
      console.error('에러:', error.message);
      throw error;
    }
  }
}
