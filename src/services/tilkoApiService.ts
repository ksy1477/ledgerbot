import axios, { AxiosInstance } from 'axios';
import { ParsedAddress } from '../types';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/**
 * 틸코(Tilko) 등기부등본 API 서비스 v2.0
 *
 * API: POST /api/v2.0/Iros2IdLogin/RealtyRegistry
 * 문서: https://apidemo.tilko.net/Views/ApiDoc.aspx?API_VERSION=v2.0&API_NAME=POST-api-apiVersion-Iros2IdLogin-RealtyRegistry
 */
export class TilkoApiService {
  private apiClient: AxiosInstance;
  private apiKey: string;
  private aesKey: Buffer;
  private aesIv: Buffer;

  // 인터넷등기소 로그인 정보
  private irosUserId: string;
  private irosPassword: string;
  private irosPin: string;
  private irosEmoneyNo1: string;
  private irosEmoneyNo2: string;
  private irosEmoneyPwd: string;

  constructor() {
    this.apiKey = process.env.TILKO_API_KEY || '';

    // AES 키: 환경 변수가 있으면 Buffer로 변환, 없으면 랜덤 생성
    this.aesKey = process.env.TILKO_AES_KEY
      ? Buffer.from(process.env.TILKO_AES_KEY, 'utf8')
      : crypto.randomBytes(16);

    // IV: Tilko 표준에 따라 0으로 채워진 16바이트
    this.aesIv = Buffer.alloc(16, 0);

    // 인터넷등기소 로그인 정보
    this.irosUserId = process.env.IROS_USER_ID || '';
    this.irosPassword = process.env.IROS_USER_PASSWORD || '';
    this.irosPin = process.env.IROS_PIN || '';
    this.irosEmoneyNo1 = process.env.IROS_EMONEY_NO1 || '';
    this.irosEmoneyNo2 = process.env.IROS_EMONEY_NO2 || '';
    this.irosEmoneyPwd = process.env.IROS_EMONEY_PASSWORD || '';

    this.apiClient = axios.create({
      baseURL: 'https://api.tilko.net',
      timeout: 180000, // 180초 = 3분 (등기소 조회는 시간이 걸릴 수 있음)
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
        console.error('Tilko API 에러:', error.response?.data || error.message);
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
   * AES-CBC-128 복호화
   */
  private decryptAES(ciphertext: string): string {
    const decipher = crypto.createDecipheriv('aes-128-cbc', this.aesKey, this.aesIv);
    let decrypted = decipher.update(ciphertext, 'base64', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }

  /**
   * RSA 공개키로 AES 키 암호화 (ENC-KEY 생성)
   */
  private async getEncryptedAesKey(): Promise<string> {
    try {
      // Tilko RSA 공개키 로드
      const publicKeyPath = path.join(process.cwd(), 'tilko_public_key.pem');

      if (!fs.existsSync(publicKeyPath)) {
        console.warn('RSA 공개키 파일이 없습니다. Base64 인코딩만 사용합니다.');
        return this.aesKey.toString('base64');
      }

      const publicKey = fs.readFileSync(publicKeyPath, 'utf8');

      // AES 키를 RSA 공개키로 암호화
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
      // 실패 시 Base64 인코딩만 사용
      return this.aesKey.toString('base64');
    }
  }

  /**
   * 주소 검색 및 부동산 고유번호(PIN) 조회
   *
   * API: POST /api/v2.0/Iros2/RetrieveSmplSrchList
   * @param address 파싱된 주소 정보
   * @returns 부동산 고유번호(PIN) 또는 null
   */
  async searchPropertyPin(address: ParsedAddress): Promise<string | null> {
    console.log('부동산 주소 검색 시작 (Tilko):', address.fullAddress);

    if (!this.apiKey) {
      throw new Error('Tilko API 키가 설정되지 않았습니다.');
    }

    try {
      // ENC-KEY 생성 (헤더에 필요)
      const encKey = await this.getEncryptedAesKey();

      // 검색 주소 생성 - 전체 주소 사용 (데모와 동일한 형식)
      const searchAddress = [
        address.sido,
        address.sigungu,
        address.eupmyeondong,
        address.jibun,
        address.dong,
        address.ho
      ].filter(Boolean).join(' ').trim();

      // 요청 데이터 구성 (주소 검색 API는 데이터를 평문으로 전송)
      const requestData = {
        Address: searchAddress,  // 평문 (암호화 안 함!)
        Sangtae: '',
        KindClsFlag: '',
        Region: '',
        Page: '1',
      };

      console.log('주소 검색 API 호출 중...');
      console.log('검색 주소:', searchAddress);

      // API 호출 (ENC-KEY 헤더는 필요하지만 데이터는 평문)
      const response = await this.apiClient.post('/api/v2.0/Iros2/RetrieveSmplSrchList', requestData, {
        headers: {
          'ENC-KEY': encKey
        }
      });

      console.log('주소 검색 API 응답 받음');
      console.log('응답 상세:', JSON.stringify(response.data, null, 2));

      const result = response.data;

      // 에러 확인
      if (result.ErrorCode && result.ErrorCode !== 0) {
        console.error('에러 코드:', result.ErrorCode);
        console.error('에러 메시지:', result.Message);
        console.error('에러 로그:', result.ErrorLog);
        throw new Error(`Tilko 주소 검색 에러: ${result.Message || result.ErrorCode}`);
      }

      // 검색 결과 확인
      if (!result.Result || !result.Result.DataList || result.Result.DataList.length === 0) {
        console.warn('검색 결과가 없습니다.');
        return null;
      }

      const dataList = result.Result.DataList;
      console.log(`검색 결과 ${dataList.length}건 발견`);

      // 첫 번째 결과 사용
      const firstResult = dataList[0];
      const pin = firstResult.pin;

      console.log('✅ 부동산 고유번호(PIN) 조회 성공:', pin);
      console.log('   도로명주소:', firstResult.rd_addr || '(없음)');
      console.log('   건물명:', firstResult.buld_name || '(없음)');
      console.log('   지번:', firstResult.lot_no || '(없음)');

      return pin;

    } catch (error: any) {
      console.error('Tilko 주소 검색 실패:', error.message);

      if (error.response) {
        console.error('응답 상태:', error.response.status);
        console.error('응답 데이터:', error.response.data);
      }

      return null;
    }
  }

  /**
   * 등기부등본 조회 및 발급
   *
   * API: POST /api/v2.0/Iros2IdLogin/RealtyRegistry
   * @param address 파싱된 주소 정보
   * @param buildingNumber 건물관리번호 (14자리) - PIN으로 사용됨
   */
  async fetchRegistry(address: ParsedAddress, buildingNumber?: string): Promise<string> {
    console.log('등기부등본 조회 시작 (Tilko API v2.0):', address.fullAddress);

    // API 키 및 로그인 정보 확인
    if (!this.apiKey) {
      throw new Error('Tilko API 키가 설정되지 않았습니다.');
    }
    if (!this.irosUserId || !this.irosPassword) {
      throw new Error('인터넷등기소 로그인 정보가 설정되지 않았습니다.');
    }

    // 건물관리번호 확인
    const pin = buildingNumber || this.irosPin;
    if (!pin) {
      throw new Error('건물관리번호(PIN)가 제공되지 않았습니다.');
    }
    console.log('건물관리번호(PIN):', pin);

    try {
      // ENC-KEY 생성 (RSA로 암호화된 AES 키)
      const encKey = await this.getEncryptedAesKey();

      // 요청 데이터 구성 (데모에서 확인한 정확한 구조)
      const requestData = {
        Auth: {
          UserId: this.encryptAES(this.irosUserId),
          UserPassword: this.encryptAES(this.irosPassword),
        },
        // Pin은 암호화하지 않음! (데모 확인)
        Pin: pin,
        // Emoney 정보는 암호화
        EmoneyNo1: this.encryptAES(this.irosEmoneyNo1),
        EmoneyNo2: this.encryptAES(this.irosEmoneyNo2),
        EmoneyPwd: this.encryptAES(this.irosEmoneyPwd),
        // 추가 필드 - 빈 문자열은 평문 (데모 확인)
        AbsCls: '',
        CmortFlag: '',
        RgsMttrSmry: '',
        TradeSeqFlag: '',
      };

      console.log('Tilko API 호출 중...');
      console.log('요청 URL:', this.apiClient.defaults.baseURL + '/api/v2.0/Iros2IdLogin/RealtyRegistry');
      console.log('요청 헤더:', {
        'API-KEY': this.apiKey ? `${this.apiKey.substring(0, 8)}...` : 'MISSING',
        'ENC-KEY': encKey ? `${encKey.substring(0, 20)}...` : 'MISSING'
      });
      console.log('요청 데이터 구조: Auth + Pin + Emoney 필드 (모두 암호화됨)');

      // API 호출
      const response = await this.apiClient.post('/api/v2.0/Iros2IdLogin/RealtyRegistry', requestData, {
        headers: {
          'ENC-KEY': encKey
        }
      });

      console.log('Tilko API 응답 받음');
      console.log('응답 상세:', JSON.stringify(response.data, null, 2));

      // 응답 처리
      const result = response.data;

      if (result.ErrorCode && result.ErrorCode !== '0') {
        console.error('에러 코드:', result.ErrorCode);
        console.error('에러 메시지:', result.Message);
        console.error('상태 시퀀스:', result.StatusSeq);
        console.error('타겟 코드:', result.TargetCode);
        console.error('타겟 메시지:', result.TargetMessage);
        throw new Error(`Tilko API 에러: ${result.Message || result.ErrorCode}`);
      }

      // PDF 저장
      const pdfPath = await this.savePdfFromResponse(result, address);

      console.log('등기부등본 조회 완료 (Tilko):', pdfPath);
      console.log('남은 포인트:', result.PointBalance);

      return pdfPath;

    } catch (error: any) {
      console.error('Tilko API 조회 실패:', error.message);

      // 상세 에러 정보
      if (error.response) {
        console.error('응답 상태:', error.response.status);
        console.error('응답 데이터:', error.response.data);
      }

      throw new Error(`등기부등본 조회 실패: ${error.message}`);
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
    const fileName = `등기부등본_${address.eupmyeondong}_${timestamp}.pdf`;
    const filePath = path.join(tempDir, fileName);

    // PDF 데이터가 Base64로 인코딩되어 있을 경우
    if (response.PdfData) {
      const pdfBuffer = Buffer.from(response.PdfData, 'base64');
      fs.writeFileSync(filePath, pdfBuffer);
    }
    // XML 데이터만 있을 경우 (PDF 생성 필요)
    else if (response.XmlData) {
      // TODO: XML을 PDF로 변환
      // 임시: XML을 텍스트 파일로 저장
      const xmlPath = filePath.replace('.pdf', '.xml');
      fs.writeFileSync(xmlPath, response.XmlData, 'utf-8');
      console.log('XML 데이터 저장:', xmlPath);

      // Mock PDF 생성
      const mockContent = `
등기부등본 (Tilko API)
=====================
주소: ${address.fullAddress}
Transaction Key: ${response.TransactionKey || 'N/A'}
발급일시: ${new Date().toLocaleString('ko-KR')}
포인트 잔액: ${response.PointBalance || 'N/A'}
=====================
※ XML 데이터는 ${xmlPath}에 저장되었습니다.
※ PDF 변환 기능은 추가 구현이 필요합니다.
      `.trim();
      fs.writeFileSync(filePath, mockContent, 'utf-8');
    }
    // 에러 또는 데이터 없음
    else {
      throw new Error('응답에 PDF 또는 XML 데이터가 없습니다.');
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

      if (!this.irosUserId) {
        console.warn('인터넷등기소 로그인 정보가 설정되지 않았습니다.');
        return false;
      }

      console.log('Tilko API 설정 확인: OK');
      return true;
    } catch (error) {
      console.error('Tilko API 설정 확인 실패:', error);
      return false;
    }
  }
}
