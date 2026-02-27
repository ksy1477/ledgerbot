import { TilkoBuildingService } from './tilkoBuildingService';
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
    this.tilkoBuildingService = new TilkoBuildingService();
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
    address: ParsedAddress
  ): Promise<{ detailSeqno: string; detailUntClsfCd: string } | null> {
    const { bun, ji } = this.parseUserJibun(address.jibun);
    console.log(`  사용자 지번 파싱: ${address.jibun} → bun=${bun}, ji=${ji}`);

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
  }> {
    console.log('='.repeat(60));
    console.log('건축물대장(전유부) 조회 시작:', address.fullAddress);
    console.log('='.repeat(60));

    if (!address.dong || !address.ho) {
      throw new Error('전유부 건축물대장은 동/호가 필요합니다.');
    }

    let totalCost = 0;

    try {
      // ────────────────────────────────────────
      // 1단계: 주소로 건축물 등록번호 조회 (20pt)
      // ────────────────────────────────────────
      console.log('\n[1/3] 건축물 주소 조회 (BldRgstMst, 20pt)...');
      const searchResult = await this.tilkoBuildingService.searchBuildingInfo(address);

      if (!searchResult) {
        throw new Error('건축물 등록번호를 찾을 수 없습니다. 주소를 확인해주세요.');
      }

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
        const { sigunguCd, bjdongCd } = searchResult.addrParts;

        const resolved = await this.resolveWithPublicData(sigunguCd, bjdongCd, address);
        if (!resolved) {
          throw new Error('공공데이터에서 건축물 정보를 찾을 수 없습니다. 주소를 확인해주세요.');
        }

        detailSeqno = resolved.detailSeqno;
        detailUntClsfCd = resolved.detailUntClsfCd;
        usedPublicDataFallback = true;
        console.log(`  → 동별 PK: ${detailSeqno}, UntClsfCd: ${detailUntClsfCd}`);
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
      // 2-fallback: BLDG PK로 BldRgstDtl 실패 시 공공데이터 API로 재시도
      // ────────────────────────────────────────
      if (!detailResult && !usedPublicDataFallback) {
        console.log('\n[2-fallback] BLDG PK 실패 → 주소정보 API + 공공데이터 API로 재시도...');

        // 주소정보 API로 법정동코드 조회 (무료)
        const codes = await this.tilkoBuildingService.lookupAddressCodes(address);
        if (codes) {
          const resolved = await this.resolveWithPublicData(codes.sigunguCd, codes.bjdongCd, address);
          if (resolved) {
            console.log(`  → 동별 PK: ${resolved.detailSeqno}, UntClsfCd: ${resolved.detailUntClsfCd}`);
            console.log('\n[2-fallback] 공공데이터 PK로 BldRgstDtl 재시도 (20pt)...');
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
        buildingType: '전유부'
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
