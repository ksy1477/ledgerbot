import { PublicDataApiService } from './publicDataApiService';
import { TilkoBuildingService } from './tilkoBuildingService';
import { ParsedAddress } from '../types';

/**
 * 통합 건축물대장 서비스
 *
 * 3단계 프로세스:
 * 1. 공공데이터 API: 건축물 정보 조회 (대장구분코드) - 무료
 * 2. Tilko BldRgstMst: 건축물등록번호 조회 - 80포인트
 * 3. Tilko RPTCAA02R01: 건축물대장 PDF 발급 - ???포인트
 */
export class UnifiedBuildingService {
  private publicDataService: PublicDataApiService;
  private tilkoBuildingService: TilkoBuildingService;

  constructor() {
    this.publicDataService = new PublicDataApiService();
    this.tilkoBuildingService = new TilkoBuildingService();
  }

  /**
   * 건축물대장 조회 (3단계 프로세스)
   */
  async fetchBuildingLedger(address: ParsedAddress): Promise<string> {
    console.log('='.repeat(60));
    console.log('건축물대장 조회 시작:', address.fullAddress);
    console.log('='.repeat(60));

    try {
      // 1단계: 공공데이터 API로 건축물 정보 조회 (무료)
      console.log('\n📋 1단계: 공공데이터에서 건축물 정보 조회 중...');
      const publicDataInfo = await this.publicDataService.getBuildingInfo(address);

      const regstrKindCd = publicDataInfo.regstrKindCd;
      console.log(`✅ 대장구분코드 확인: ${regstrKindCd} (${publicDataInfo.buildingType})`);

      // 2단계: Tilko로 건축물 등록번호 조회
      let upperBldRgstSeqno = '';
      let bldRgstSeqno = '';
      let untClsfCd = '';

      // 2-1: 전유부(아파트 호수)인 경우, 상위 건축물 먼저 조회
      if (regstrKindCd === '4' && address.dong && address.ho) {
        console.log('\n🏢 2-1단계: 상위 건축물 등록번호 조회 (동/호 제외)...');

        // 동/호를 제외한 주소로 검색
        const parentAddress = { ...address, dong: undefined, ho: undefined };
        const parentInfo = await this.tilkoBuildingService.searchBuildingInfo(parentAddress);

        if (parentInfo) {
          upperBldRgstSeqno = parentInfo.bldRgstSeqno;
          console.log(`✅ 상위 건축물 등록번호: ${upperBldRgstSeqno}`);
        } else {
          console.warn('⚠️  상위 건축물을 찾을 수 없습니다. 빈 값 사용.');
        }
      }

      // 2-2: 개별 호수 정보 조회
      console.log('\n🏢 2-2단계: 건축물 등록번호 조회...');
      const buildingInfo = await this.tilkoBuildingService.searchBuildingInfo(address);

      if (!buildingInfo) {
        throw new Error('건축물 등록번호를 찾을 수 없습니다.');
      }

      bldRgstSeqno = buildingInfo.bldRgstSeqno;
      untClsfCd = buildingInfo.untClsfCd;
      console.log(`✅ 건축물 등록번호: ${bldRgstSeqno}`);
      console.log(`✅ 유닛 클래스 코드: ${untClsfCd}`);

      // 3단계: Tilko로 건축물대장 PDF 발급
      console.log('\n📄 3단계: 건축물대장 PDF 발급 중...');
      const pdfPath = await this.tilkoBuildingService.fetchBuildingLedger(
        address,
        regstrKindCd,
        bldRgstSeqno,
        untClsfCd,
        upperBldRgstSeqno
      );

      console.log('\n' + '='.repeat(60));
      console.log('✅ 건축물대장 조회 완료!');
      console.log('='.repeat(60));

      return pdfPath;

    } catch (error: any) {
      console.error('\n' + '='.repeat(60));
      console.error('❌ 건축물대장 조회 실패');
      console.error('='.repeat(60));
      console.error('에러:', error.message);
      throw error;
    }
  }

  /**
   * 서비스 타입 확인
   */
  getServiceType(): string {
    return '공공데이터 + Tilko (3-step)';
  }
}
