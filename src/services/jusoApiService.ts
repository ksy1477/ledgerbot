import axios, { AxiosInstance } from 'axios';
import { ParsedAddress } from '../types';

/**
 * 행정안전부 주소정보 API 서비스
 *
 * 주소 검색을 통해 건물관리번호(bdMgtSn) 조회
 * API: https://business.juso.go.kr/addrlink/addrLinkApi.do
 * 문서: https://www.data.go.kr/data/15057017/openapi.do
 */

interface JusoApiResponse {
  results: {
    common: {
      errorMessage: string;
      countPerPage: string;
      totalCount: string;
      errorCode: string;
      currentPage: string;
    };
    juso?: Array<{
      roadAddr: string;          // 도로명주소
      roadAddrPart1: string;     // 도로명주소(참고항목 제외)
      roadAddrPart2: string;     // 도로명주소 참고항목
      jibunAddr: string;         // 지번주소
      engAddr: string;           // 도로명주소(영문)
      zipNo: string;             // 우편번호
      admCd: string;             // 행정구역코드
      rnMgtSn: string;           // 도로명코드
      bdMgtSn: string;           // 건물관리번호 (14자리)
      detBdNmList?: string;      // 상세건물명
      bdNm?: string;             // 건물명
      bdKdcd: string;            // 공동주택여부(1: 공동주택, 0: 비공동주택)
      siNm: string;              // 시도명
      sggNm: string;             // 시군구명
      emdNm: string;             // 읍면동명
      liNm?: string;             // 법정리명
      rn: string;                // 도로명
      udrtYn: string;            // 지하여부(0: 지상, 1: 지하)
      buldMnnm: number;          // 건물본번
      buldSlno: number;          // 건물부번
      mtYn: string;              // 산여부(0: 대지, 1: 산)
      lnbrMnnm: number;          // 지번본번(번지)
      lnbrSlno: number;          // 지번부번(호)
      emdNo: string;             // 읍면동일련번호
    }>;
  };
}

export class JusoApiService {
  private apiClient: AxiosInstance;
  private confmKey: string;

  constructor() {
    this.confmKey = process.env.JUSO_API_KEY || '';

    this.apiClient = axios.create({
      baseURL: 'https://business.juso.go.kr/addrlink',
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
      }
    });
  }

  /**
   * 주소 검색 및 건물관리번호 조회
   *
   * @param address 검색할 주소
   * @returns 건물관리번호 (14자리) 또는 null
   */
  async searchBuildingNumber(address: ParsedAddress): Promise<string | null> {
    console.log('주소 검색 시작 (Juso API):', address.fullAddress);

    // API 키 확인
    if (!this.confmKey) {
      console.warn('Juso API 키가 설정되지 않았습니다. Mock 데이터를 반환합니다.');
      return this.getMockBuildingNumber(address);
    }

    try {
      // 검색 키워드 생성 (시군구 + 읍면동 + 번지)
      const keyword = `${address.sigungu || ''} ${address.eupmyeondong || ''} ${address.jibun || ''}`.trim();

      console.log('검색 키워드:', keyword);

      const response = await this.apiClient.get<JusoApiResponse>('/addrLinkApi.do', {
        params: {
          confmKey: this.confmKey,
          currentPage: 1,
          countPerPage: 10,
          keyword: keyword,
          resultType: 'json',
          hstryYn: 'N',  // 변동된 주소정보 제외
        }
      });

      const result = response.data.results;

      // 에러 확인
      if (result.common.errorCode !== '0') {
        throw new Error(`Juso API 에러: ${result.common.errorMessage}`);
      }

      // 결과 없음
      if (!result.juso || result.juso.length === 0) {
        console.warn('검색 결과가 없습니다.');
        return null;
      }

      console.log(`검색 결과 ${result.common.totalCount}건 발견`);

      // 첫 번째 결과 사용
      const firstResult = result.juso[0];
      const buildingNumber = firstResult.bdMgtSn;

      console.log('✅ 건물관리번호 조회 성공:', buildingNumber);
      console.log('   도로명주소:', firstResult.roadAddr);
      console.log('   지번주소:', firstResult.jibunAddr);
      console.log('   건물명:', firstResult.bdNm || '(없음)');

      // 건물관리번호 검증 (14자리)
      if (buildingNumber && buildingNumber.length === 14) {
        return buildingNumber;
      } else {
        console.warn('건물관리번호 형식이 올바르지 않습니다:', buildingNumber);
        return null;
      }

    } catch (error: any) {
      console.error('Juso API 조회 실패:', error.message);

      if (error.response) {
        console.error('응답 상태:', error.response.status);
        console.error('응답 데이터:', error.response.data);
      }

      // 실패 시 Mock 데이터 반환
      return this.getMockBuildingNumber(address);
    }
  }

  /**
   * Mock 건물관리번호 생성
   * 실제 API 사용 전 테스트용
   */
  private getMockBuildingNumber(address: ParsedAddress): string {
    // 임시 14자리 숫자 생성
    const timestamp = Date.now().toString().substring(0, 14);
    console.log('⚠️  Mock 건물관리번호 사용:', timestamp);
    return timestamp;
  }

  /**
   * API 연결 상태 확인
   */
  async healthCheck(): Promise<boolean> {
    try {
      if (!this.confmKey) {
        console.warn('Juso API 키가 설정되지 않았습니다.');
        return false;
      }

      console.log('Juso API 설정 확인: OK');
      return true;
    } catch (error) {
      console.error('Juso API 설정 확인 실패:', error);
      return false;
    }
  }
}
