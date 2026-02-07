import axios, { AxiosInstance } from 'axios';
import { ParsedAddress } from '../types';
import * as fs from 'fs';
import * as path from 'path';

/**
 * 대법원 인터넷등기소 Open API 서비스
 *
 * API 문서: https://data.iros.go.kr/rp/oa/openOapiIntro.do
 */
export class IrosApiService {
  private apiClient: AxiosInstance;
  private apiKey: string;
  private baseUrl: string;

  constructor() {
    this.apiKey = process.env.IROS_API_KEY || '';
    this.baseUrl = process.env.IROS_API_URL || 'https://data.iros.go.kr';

    this.apiClient = axios.create({
      baseURL: this.baseUrl,
      timeout: 30000, // 30초 타임아웃
      headers: {
        'Content-Type': 'application/json',
      }
    });

    // 요청 인터셉터: 인증키 자동 추가
    this.apiClient.interceptors.request.use((config) => {
      if (this.apiKey) {
        config.params = {
          ...config.params,
          authKey: this.apiKey
        };
      }
      return config;
    });

    // 응답 인터셉터: 에러 로깅
    this.apiClient.interceptors.response.use(
      (response) => response,
      (error) => {
        console.error('IROS API 에러:', error.response?.data || error.message);
        throw error;
      }
    );
  }

  /**
   * 등기부등본 조회
   *
   * @param address 파싱된 주소 정보
   * @returns PDF 파일 경로
   */
  async fetchRegistry(address: ParsedAddress): Promise<string> {
    console.log('등기부등본 조회 시작 (IROS API):', address.fullAddress);

    // API 키 확인
    if (!this.apiKey) {
      throw new Error('IROS API 키가 설정되지 않았습니다. .env 파일의 IROS_API_KEY를 확인해주세요.');
    }

    try {
      // 1. 주소로 고유번호(PNU) 검색
      const pnu = await this.searchPropertyByAddress(address);

      // 2. 고유번호로 등기부등본 조회
      const registryData = await this.getRegistryData(pnu);

      // 3. PDF 생성 및 저장
      const pdfPath = await this.saveToPdf(registryData, address);

      console.log('등기부등본 조회 완료:', pdfPath);
      return pdfPath;

    } catch (error: any) {
      console.error('등기부등본 조회 실패:', error.message);
      throw new Error(`등기부등본 조회 실패: ${error.message}`);
    }
  }

  /**
   * 주소로 부동산 고유번호(PNU) 검색
   *
   * TODO: 실제 IROS API 엔드포인트로 교체 필요
   */
  private async searchPropertyByAddress(address: ParsedAddress): Promise<string> {
    console.log('주소 검색:', address);

    // TODO: 실제 API 호출
    // const response = await this.apiClient.get('/api/search', {
    //   params: {
    //     sido: address.sido,
    //     sigungu: address.sigungu,
    //     dong: address.eupmyeondong,
    //     jibun: address.jibun,
    //   }
    // });

    // 임시 Mock PNU (실제로는 API 응답에서 추출)
    const mockPnu = '1111011100100450000';
    return mockPnu;
  }

  /**
   * 고유번호로 등기부등본 데이터 조회
   *
   * TODO: 실제 IROS API 엔드포인트로 교체 필요
   */
  private async getRegistryData(pnu: string): Promise<any> {
    console.log('등기부등본 데이터 조회:', pnu);

    // TODO: 실제 API 호출
    // const response = await this.apiClient.get('/api/registry', {
    //   params: {
    //     pnu: pnu,
    //     type: 'full', // 전부 (표제부 + 갑구 + 을구)
    //   }
    // });
    // return response.data;

    // 임시 Mock 데이터
    return {
      pnu,
      address: '서울시 중랑구 중화동 450',
      buildingName: '중화한신아파트',
      owner: '홍길동',
      registrationDate: new Date().toISOString(),
    };
  }

  /**
   * 등기부등본 데이터를 PDF로 저장
   */
  private async saveToPdf(data: any, address: ParsedAddress): Promise<string> {
    const tempDir = process.env.TEMP_FILE_PATH || './temp';

    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '_').split('.')[0];
    const fileName = `등기부등본_${address.eupmyeondong}_${timestamp}.pdf`;
    const filePath = path.join(tempDir, fileName);

    // TODO: 실제 PDF 생성 라이브러리 사용 (예: pdfkit, puppeteer)
    // 현재는 Mock 텍스트 파일 생성
    const content = `
등기부등본 (IROS API)
=====================
주소: ${address.fullAddress}
PNU: ${data.pnu}
소유자: ${data.owner || 'N/A'}
등기일: ${data.registrationDate || 'N/A'}
발급일시: ${new Date().toLocaleString('ko-KR')}
=====================
※ 실제 IROS API 연동 후 실제 데이터로 대체됩니다.
    `.trim();

    fs.writeFileSync(filePath, content, 'utf-8');

    return filePath;
  }

  /**
   * API 연결 상태 확인
   */
  async healthCheck(): Promise<boolean> {
    try {
      if (!this.apiKey) {
        console.warn('IROS API 키가 설정되지 않았습니다.');
        return false;
      }

      // TODO: 실제 health check 엔드포인트 호출
      // const response = await this.apiClient.get('/api/health');
      // return response.status === 200;

      console.log('IROS API 연결 확인 (Mock): OK');
      return true;
    } catch (error) {
      console.error('IROS API 연결 실패:', error);
      return false;
    }
  }
}
