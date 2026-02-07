import axios, { AxiosInstance } from 'axios';
import { ParsedAddress } from '../types';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Tilko 건축물대장 API 서비스
 *
 * API: POST /api/v2.0/EaisIdLogin/RPTCAA02R01 (건축물대장 발급)
 * 검색: POST /api/v2.0/EaisIdLogin/BldRgstMst (건축물 기본정보 조회)
 */
export class TilkoBuildingService {
  private apiClient: AxiosInstance;
  private apiKey: string;
  private aesKey: Buffer;
  private aesIv: Buffer;

  // 정부24 로그인 정보
  private eaisUserId: string;
  private eaisPassword: string;

  constructor() {
    this.apiKey = process.env.TILKO_API_KEY || '';

    // AES 키: 등기부등본과 동일한 키 사용
    this.aesKey = process.env.TILKO_AES_KEY
      ? Buffer.from(process.env.TILKO_AES_KEY, 'utf8')
      : crypto.randomBytes(16);

    // IV: Tilko 표준에 따라 0으로 채워진 16바이트
    this.aesIv = Buffer.alloc(16, 0);

    // 정부24 로그인 정보 (환경변수에서 로드)
    this.eaisUserId = process.env.EAIS_USER_ID || '';
    this.eaisPassword = process.env.EAIS_USER_PASSWORD || '';

    this.apiClient = axios.create({
      baseURL: 'https://api.tilko.net',
      timeout: 180000, // 180초
      headers: {
        'Content-Type': 'application/json',
      }
    });

    // 요청 인터셉터
    this.apiClient.interceptors.request.use((config) => {
      if (this.apiKey) {
        config.headers['API-KEY'] = this.apiKey;
      }
      return config;
    });

    // 응답 인터셉터
    this.apiClient.interceptors.response.use(
      (response) => response,
      (error) => {
        console.error('Tilko Building API 에러:', error.response?.data || error.message);
        throw error;
      }
    );
  }

  /**
   * AES-CBC-128 암호화
   */
  private encryptAES(plaintext: string): string {
    const cipher = crypto.createCipheriv('aes-128-cbc', this.aesKey, this.aesIv);
    let encrypted = cipher.update(plaintext, 'utf8', 'base64');
    encrypted += cipher.final('base64');
    return encrypted;
  }

  /**
   * RSA 공개키로 AES 키 암호화 (ENC-KEY 생성)
   */
  private async getEncryptedAesKey(): Promise<string> {
    try {
      const publicKeyPath = path.join(process.cwd(), 'tilko_public_key.pem');

      if (!fs.existsSync(publicKeyPath)) {
        console.warn('RSA 공개키 파일이 없습니다. Base64 인코딩만 사용합니다.');
        return this.aesKey.toString('base64');
      }

      const publicKey = fs.readFileSync(publicKeyPath, 'utf8');

      const encrypted = crypto.publicEncrypt(
        {
          key: publicKey,
          padding: crypto.constants.RSA_PKCS1_PADDING,
        },
        this.aesKey
      );

      return encrypted.toString('base64');
    } catch (error) {
      console.error('RSA 암호화 실패:', error);
      return this.aesKey.toString('base64');
    }
  }

  /**
   * 건축물 기본정보 조회 (주소 → 건축물등록번호)
   *
   * API: POST /api/v2.0/EaisIdLogin/BldRgstMst
   * @param address 파싱된 주소
   * @returns 건축물 등록번호 및 유닛클래스코드
   */
  async searchBuildingInfo(address: ParsedAddress): Promise<{
    bldRgstSeqno: string;
    untClsfCd: string;
  } | null> {
    console.log('건축물 정보 조회 시작 (Tilko):', address.fullAddress);

    if (!this.apiKey) {
      throw new Error('Tilko API 키가 설정되지 않았습니다.');
    }

    try {
      // ENC-KEY 생성
      const encKey = await this.getEncryptedAesKey();

      // 검색 주소 생성
      const searchAddress = [
        address.eupmyeondong,
        address.jibun,
        address.dong,
        address.ho
      ].filter(Boolean).join(' ').trim();

      // 요청 데이터 (평문)
      const requestData = {
        AddressType: '0',
        QueryAddress: searchAddress
      };

      console.log('건축물 정보 API 호출 중...');
      console.log('검색 주소:', searchAddress);

      // API 호출
      const response = await this.apiClient.post('/api/v2.0/EaisIdLogin/BldRgstMst', requestData, {
        headers: {
          'ENC-KEY': encKey
        }
      });

      console.log('건축물 정보 API 응답:', JSON.stringify(response.data, null, 2));

      const result = response.data;

      // 에러 확인
      if (result.ErrorCode && result.ErrorCode !== 0) {
        console.error('에러 코드:', result.ErrorCode);
        console.error('에러 메시지:', result.Message);
        throw new Error(`Tilko 건축물 정보 조회 에러: ${result.Message || result.ErrorCode}`);
      }

      // 결과 확인
      if (!result.Result || result.Result.length === 0) {
        console.warn('건축물 정보를 찾을 수 없습니다.');
        return null;
      }

      const buildingInfo = result.Result[0];

      console.log('✅ 건축물 정보 조회 성공');
      console.log('   건축물등록번호:', buildingInfo.BldRgstSeqNumber);
      console.log('   유닛클래스코드:', buildingInfo.UntClsfCd);

      return {
        bldRgstSeqno: buildingInfo.BldRgstSeqNumber,
        untClsfCd: buildingInfo.UntClsfCd
      };

    } catch (error: any) {
      console.error('Tilko 건축물 정보 조회 실패:', error.message);

      if (error.response) {
        console.error('응답 상태:', error.response.status);
        console.error('응답 데이터:', error.response.data);
      }

      return null;
    }
  }

  /**
   * 건축물대장 발급
   *
   * API: POST /api/v2.0/EaisIdLogin/RPTCAA02R01
   * @param address 파싱된 주소
   * @param regstrKindCd 대장구분코드 (1: 일반건축물, 4: 전유부)
   * @param bldRgstSeqno 건축물등록번호
   * @param untClsfCd 유닛클래스코드
   */
  async fetchBuildingLedger(
    address: ParsedAddress,
    regstrKindCd: string,
    bldRgstSeqno: string,
    untClsfCd: string,
    upperBldRgstSeqno: string = ''
  ): Promise<string> {
    console.log('건축물대장 발급 시작 (Tilko):', address.fullAddress);

    // API 키 및 로그인 정보 확인
    if (!this.apiKey) {
      throw new Error('Tilko API 키가 설정되지 않았습니다.');
    }
    if (!this.eaisUserId || !this.eaisPassword) {
      throw new Error('정부24 로그인 정보가 설정되지 않았습니다.');
    }

    console.log('파라미터:', {
      regstrKindCd,
      bldRgstSeqno,
      untClsfCd
    });

    try {
      // ENC-KEY 생성
      const encKey = await this.getEncryptedAesKey();

      // 요청 데이터 구성 (Auth만 암호화, 나머지 평문)
      const requestData = {
        Auth: {
          UserId: this.encryptAES(this.eaisUserId),
          UserPassword: this.encryptAES(this.eaisPassword),
        },
        PublishType: '1',                        // 열람 (평문)
        RegstrKindCd: regstrKindCd,              // 대장구분 (평문)
        BldRgstSeqno: bldRgstSeqno,              // 건축물등록번호 (평문)
        UntClsfCd: untClsfCd,                    // 유닛클래스코드 (평문)
        MjrFmlyYn: 'n',                          // 다가구여부 (소문자 평문)
        UpperBldRgstSeqno: upperBldRgstSeqno,    // 상위건축물등록번호 (평문)
      };

      console.log('요청 데이터:', {
        ...requestData,
        Auth: { UserId: '***', UserPassword: '***' }
      });

      console.log('Tilko 건축물대장 API 호출 중...');

      // API 호출
      const response = await this.apiClient.post('/api/v2.0/EaisIdLogin/RPTCAA02R01', requestData, {
        headers: {
          'ENC-KEY': encKey
        }
      });

      console.log('Tilko API 응답 받음');
      console.log('응답 상세:', JSON.stringify(response.data, null, 2));

      const result = response.data;

      // 에러 확인
      if (result.ErrorCode && result.ErrorCode !== '0' && result.ErrorCode !== 0) {
        console.error('에러 코드:', result.ErrorCode);
        console.error('에러 메시지:', result.Message);
        console.error('에러 로그:', result.ErrorLog);
        throw new Error(`Tilko API 에러: ${result.Message || result.ErrorCode}`);
      }

      // PDF 저장
      const pdfPath = await this.savePdfFromResponse(result, address);

      console.log('건축물대장 발급 완료 (Tilko):', pdfPath);
      console.log('남은 포인트:', result.PointBalance);

      return pdfPath;

    } catch (error: any) {
      console.error('Tilko 건축물대장 발급 실패:', error.message);

      if (error.response) {
        console.error('응답 상태:', error.response.status);
        console.error('응답 데이터:', error.response.data);
      }

      throw new Error(`건축물대장 발급 실패: ${error.message}`);
    }
  }

  /**
   * 응답에서 PDF 저장
   */
  private async savePdfFromResponse(response: any, address: ParsedAddress): Promise<string> {
    const tempDir = process.env.TEMP_FILE_PATH || './temp';

    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '_').split('.')[0];
    const fileName = `건축물대장_${address.eupmyeondong}_${timestamp}.pdf`;
    const filePath = path.join(tempDir, fileName);

    // PDF 데이터가 Base64로 인코딩되어 있을 경우
    if (response.PdfData) {
      const pdfBuffer = Buffer.from(response.PdfData, 'base64');
      fs.writeFileSync(filePath, pdfBuffer);
    } else {
      throw new Error('응답에 PDF 데이터가 없습니다.');
    }

    return filePath;
  }

  /**
   * API 연결 상태 확인
   */
  async healthCheck(): Promise<boolean> {
    try {
      if (!this.apiKey) {
        console.warn('Tilko API 키가 설정되지 않았습니다.');
        return false;
      }

      if (!this.eaisUserId) {
        console.warn('정부24 로그인 정보가 설정되지 않았습니다.');
        return false;
      }

      console.log('Tilko Building API 설정 확인: OK');
      return true;
    } catch (error) {
      console.error('Tilko Building API 설정 확인 실패:', error);
      return false;
    }
  }
}
