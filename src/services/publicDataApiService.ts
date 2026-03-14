import axios, { AxiosInstance } from 'axios';
import { ParsedAddress } from '../types';

/**
 * 공공데이터포털 건축물대장 API 서비스
 *
 * API: 국토교통부_건축물대장 표제부 조회
 * 문서: https://www.data.go.kr/data/15044713/openapi.do
 */
export class PublicDataApiService {
  private apiClient: AxiosInstance;
  private serviceKey: string;

  // 시군구 코드 매핑 (주요 지역만 우선 구현)
  private sigunguCodeMap: { [key: string]: string } = {
    '서울시_중랑구': '11260',
    '경기도_수원시': '41110',
    // TODO: 필요한 지역 추가
  };

  // 법정동 코드 매핑 (주요 동만 우선 구현)
  private bdongCodeMap: { [key: string]: string } = {
    '서울시_중랑구_중화동': '10900',
    '경기도_수원시_영통동': '11300',
    // TODO: 필요한 동 추가
  };

  constructor() {
    this.serviceKey = process.env.PUBLIC_DATA_API_KEY || '';

    this.apiClient = axios.create({
      baseURL: 'https://apis.data.go.kr/1613000',
      timeout: 30000,
      headers: {
        'Accept': 'application/json',
      }
    });
  }

  /**
   * 건축물대장 표제부 조회
   *
   * @param address 파싱된 주소 정보
   * @returns 건축물 정보 (대장구분코드 등)
   */
  async getBuildingInfo(address: ParsedAddress): Promise<any> {
    console.log('공공데이터 건축물 정보 조회:', address.fullAddress);

    if (!this.serviceKey) {
      throw new Error('공공데이터 API 키가 설정되지 않았습니다.');
    }

    try {
      // 시군구 코드 조회
      const sigunguKey = `${address.sido}_${address.sigungu}`;
      const sigunguCode = this.sigunguCodeMap[sigunguKey];

      if (!sigunguCode) {
        console.warn(`시군구 코드를 찾을 수 없습니다: ${sigunguKey}`);
        // 기본값으로 일반건축물 사용
        return {
          regstrKindCd: '1',
          buildingType: '일반건축물'
        };
      }

      // 법정동 코드 조회
      const bdongKey = `${address.sido}_${address.sigungu}_${address.eupmyeondong}`;
      const bdongCode = this.bdongCodeMap[bdongKey];

      if (!bdongCode) {
        console.warn(`법정동 코드를 찾을 수 없습니다: ${bdongKey}`);
        // 기본값으로 일반건축물 사용
        return {
          regstrKindCd: '1',
          buildingType: '일반건축물'
        };
      }

      // 지번 파싱 (예: "450" → bun: "450", ji: "0")
      const jibunParts = address.jibun?.split('-') || ['0', '0'];
      const bun = jibunParts[0] || '0';
      const ji = jibunParts[1] || '0';

      console.log('API 호출 파라미터:', {
        sigunguCode,
        bdongCode,
        bun,
        ji
      });

      // 건축물대장 표제부 조회
      const response = await this.apiClient.get('/BldRgstHubService/getBrTitleInfo', {
        params: {
          serviceKey: this.serviceKey,
          sigunguCd: sigunguCode,
          bjdongCd: bdongCode,
          bun,
          ji,
          numOfRows: 10,
          pageNo: 1,
          _type: 'json'
        }
      });

      console.log('공공데이터 API 응답:', JSON.stringify(response.data, null, 2));

      // 응답 파싱
      const items = response.data?.response?.body?.items?.item;

      if (!items || items.length === 0) {
        console.warn('건축물 정보를 찾을 수 없습니다. 주소 기반으로 판단합니다.');
        // 공공데이터에서 못 찾았어도, 주소 구조로 판단
        const regstrKindCd = this.determineRegstrKindCd(null, address);
        return {
          regstrKindCd,
          buildingType: this.getRegstrKindName(regstrKindCd)
        };
      }

      const buildingInfo = Array.isArray(items) ? items[0] : items;

      // 대장구분코드 결정 (아파트 등 집합건물의 경우 전유부 사용)
      const regstrKindCd = this.determineRegstrKindCd(buildingInfo, address);

      console.log('✅ 건축물 정보 조회 성공');
      console.log('   대장구분코드:', regstrKindCd);
      console.log('   건축물명:', buildingInfo.bldNm || '(없음)');

      return {
        regstrKindCd,
        buildingInfo,
        buildingType: this.getRegstrKindName(regstrKindCd)
      };

    } catch (error: any) {
      console.error('공공데이터 API 조회 실패:', error.message);

      if (error.response) {
        console.error('응답 상태:', error.response.status);
        console.error('응답 데이터:', error.response.data);
      }

      // 실패 시 주소 기반으로 판단
      const regstrKindCd = this.determineRegstrKindCd(null, address);
      console.warn(`주소 기반 판단: ${this.getRegstrKindName(regstrKindCd)}`);
      return {
        regstrKindCd,
        buildingType: this.getRegstrKindName(regstrKindCd)
      };
    }
  }

  /**
   * 건축물 정보를 바탕으로 대장구분코드 결정
   */
  private determineRegstrKindCd(buildingInfo: any, address: ParsedAddress): string {
    // 동/호가 모두 있으면 아파트 등 집합건물 개별 호수 → 전유부
    if (address.dong && address.ho) {
      console.log('→ 아파트 호수 감지: 전유부(4) 사용');
      return '4'; // 전유부
    }

    // 동만 있고 호가 없으면 → 일반건축물 (동 전체)
    if (address.dong && !address.ho) {
      console.log('→ 건물 동 전체: 일반건축물(1) 사용');
      return '1';
    }

    // 그 외는 일반건축물
    console.log('→ 기본값: 일반건축물(1) 사용');
    return '1';
  }

  /**
   * 대장구분코드 명칭 반환
   */
  private getRegstrKindName(code: string): string {
    const names: { [key: string]: string } = {
      '1': '일반건축물',
      '2': '일반건축물(총괄표제부)',
      '4': '전유부'
    };
    return names[code] || '일반건축물';
  }

  /**
   * API 연결 상태 확인
   */
  async healthCheck(): Promise<boolean> {
    try {
      if (!this.serviceKey) {
        console.warn('공공데이터 API 키가 설정되지 않았습니다.');
        return false;
      }

      console.log('공공데이터 API 설정 확인: OK');
      return true;
    } catch (error) {
      console.error('공공데이터 API 설정 확인 실패:', error);
      return false;
    }
  }
}
