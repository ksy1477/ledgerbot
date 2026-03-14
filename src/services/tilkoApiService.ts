import axios, { AxiosInstance } from 'axios';
import { ParsedAddress } from '../types';
import { GeminiService } from './geminiService';
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
  private geminiService: GeminiService | null;

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

    // Gemini AI 보정 서비스
    this.geminiService = process.env.GEMINI_API_KEY ? new GeminiService() : null;

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
   * 아이템의 모든 문자열 값을 합쳐서 검색용 텍스트를 만드는 헬퍼
   */
  private getAllText(item: any): string {
    return Object.values(item)
      .filter((v): v is string => typeof v === 'string')
      .join(' ');
  }

  /**
   * 검색 결과 한 페이지를 가져오는 내부 메서드
   */
  private async fetchSearchPage(searchAddress: string, encKey: string, page: number): Promise<{
    dataList: any[];
    totalPageCount: number;
  }> {
    const requestData = {
      Address: searchAddress,
      Sangtae: '',
      KindClsFlag: '',
      Region: '',
      Page: String(page),
    };

    const response = await this.apiClient.post('/api/v2.0/Iros2/RetrieveSmplSrchList', requestData, {
      headers: { 'ENC-KEY': encKey }
    });

    const result = response.data;

    if (result.ErrorCode && result.ErrorCode !== 0) {
      throw new Error(`Tilko 주소 검색 에러: ${result.Message || result.ErrorCode}`);
    }

    const dataList = result.Result?.DataList || [];
    const totalPageCount = result.Result?.PaginationInfo?.totalPageCount || 1;

    return { dataList, totalPageCount };
  }

  /**
   * HTML 태그 제거 헬퍼
   */
  private stripHtml(html: string): string {
    return (html || '').replace(/<[^>]+>/g, '');
  }

  /**
   * 검색 결과에서 동/호에 매칭되는 아이템을 찾는 메서드
   *
   * rd_addr_detail (HTML 제거 후)에서 "제103동 제16층 제1603호" 패턴으로 매칭
   */
  private findUnitMatch(dataList: any[], dong: string, ho: string): any | null {
    // "103동" → "103", "1603호" → "1603"
    const dongNum = dong.replace(/동$/, '');
    const hoNum = ho.replace(/호$/, '');

    for (const item of dataList) {
      if (item.real_cls_cd !== '집합건물') continue;

      const roomMatch = item.buld_no_room === hoNum;
      if (!roomMatch) continue;

      // 동 매칭: rd_addr_detail에서 HTML 제거 후 "제103동" 또는 "103동" 패턴 검색
      const cleanDetail = this.stripHtml(item.rd_addr_detail);
      const buldNum = item.buld_no_buld || '';
      const buldName = item.buld_name || '';

      const dongMatch =
        buldNum === dongNum ||
        buldName.includes(dongNum + '동') ||
        cleanDetail.includes(dongNum + '동');

      if (dongMatch) {
        return item;
      }
    }
    return null;
  }

  /**
   * 주소 검색 및 부동산 고유번호(PIN) 조회
   *
   * API: POST /api/v2.0/Iros2/RetrieveSmplSrchList
   * @param address 파싱된 주소 정보
   * @returns 부동산 고유번호(PIN) 또는 null
   */
  /**
   * JUSO API로 도로명 주소 목록 조회 (무료)
   * 건물명 매칭된 결과를 우선 반환, 중복 도로명 주소 제거
   */
  private async getJusoRoadAddresses(address: ParsedAddress): Promise<Array<{
    roadAddr: string;
    bdNm: string;
  }>> {
    const jusoApiKey = process.env.JUSO_API_KEY;
    if (!jusoApiKey) return [];

    const keyword = [address.sido, address.sigungu, address.eupmyeondong, address.jibun]
      .filter(Boolean).join(' ');

    try {
      const response = await axios.get('https://business.juso.go.kr/addrlink/addrLinkApi.do', {
        params: {
          confmKey: jusoApiKey,
          currentPage: 1,
          countPerPage: 20,
          keyword,
          resultType: 'json',
        },
        timeout: 10000,
      });

      const results = response.data?.results?.juso;
      if (!results || results.length === 0) return [];

      // 건물명이 있으면 매칭된 결과를 우선 정렬
      const bdName = (address as any).buildingName || '';
      const bdNameNorm = bdName.replace(/\s+/g, '').toLowerCase();

      let filtered = results;
      if (bdNameNorm) {
        // 건물명 매칭되는 결과만 필터
        const matched = results.filter((r: any) => {
          const nm = (r.bdNm || '').replace(/\s+/g, '').toLowerCase();
          return nm.includes(bdNameNorm) || bdNameNorm.includes(nm);
        });
        if (matched.length > 0) filtered = matched;
      }

      // 중복 도로명 주소 제거 (괄호 전 부분 기준)
      const seen = new Set<string>();
      const unique: Array<{ roadAddr: string; bdNm: string }> = [];

      for (const r of filtered) {
        const cleanAddr = (r.roadAddr || '').replace(/\s*\([^)]*\)\s*$/, '').trim();
        if (!cleanAddr || seen.has(cleanAddr)) continue;
        seen.add(cleanAddr);
        unique.push({ roadAddr: r.roadAddr, bdNm: r.bdNm || '' });
      }

      return unique;
    } catch {
      return [];
    }
  }

  /**
   * 검색 & 매칭을 수행하는 내부 메서드
   * 주어진 searchAddress로 Tilko 검색 후, 동/호 또는 주소 매칭
   */
  private async searchAndMatch(
    searchAddress: string,
    encKey: string,
    address: ParsedAddress,
    label: string
  ): Promise<{ pin: string } | null> {
    console.log(`\n[${label}] 검색 주소: "${searchAddress}"`);

    let dataList: any[];
    let totalPageCount: number;
    try {
      const result = await this.fetchSearchPage(searchAddress, encKey, 1);
      dataList = result.dataList;
      totalPageCount = result.totalPageCount;
    } catch (err: any) {
      console.warn(`  ⚠️ 검색 실패: ${err.message} → 스킵`);
      return null;
    }
    console.log(`  결과: ${dataList.length}건 (총 ${totalPageCount}페이지)`);

    // 검색 결과 로깅 (첫 3건만)
    dataList.slice(0, 3).forEach((item: any, i: number) => {
      console.log(`  [${i}] pin=${item.pin}, type=${item.real_cls_cd}, room=${item.buld_no_room}, name=${item.buld_name}, dong=${item.buld_no_buld}`);
    });

    if (dataList.length === 0) return null;

    // ─── 동/호 매칭 ───
    if (address.dong && address.ho) {
      let unitMatch = this.findUnitMatch(dataList, address.dong, address.ho);

      if (!unitMatch && totalPageCount > 1) {
        // 1페이지에서 동 번호 일치 여부 확인
        const dongNum = address.dong.replace(/동$/, '');
        const hasDongInPage1 = dataList.some((item: any) =>
          item.real_cls_cd === '집합건물' && (item.buld_no_buld === dongNum || (item.buld_name || '').includes(dongNum + '동'))
        );

        if (!hasDongInPage1) {
          // 이 검색 결과에 해당 동이 없음 → 바로 스킵 (포인트 절약)
          console.log(`  ❌ 1페이지에 ${address.dong} 없음 → 스킵`);
          return null;
        }

        // 동이 있으면 페이지 한도 늘려서 호수 탐색 (최대 30페이지 = 600pt)
        const PAGE_LIMIT = 30;
        const maxPages = Math.min(totalPageCount, PAGE_LIMIT);
        console.log(`  ✅ ${address.dong} 감지 → ${maxPages}페이지까지 호수 탐색`);

        for (let page = 2; page <= maxPages; page++) {
          console.log(`  📄 ${page}/${maxPages}페이지 조회 중...`);
          const pageResult = await this.fetchSearchPage(searchAddress, encKey, page);
          unitMatch = this.findUnitMatch(pageResult.dataList, address.dong, address.ho);
          if (unitMatch) {
            console.log(`  ✅ ${page}페이지에서 매칭!`);
            break;
          }
        }
      }

      if (unitMatch) {
        console.log(`  ✅ 유닛 PIN: ${unitMatch.pin} (${unitMatch.buld_name} ${unitMatch.buld_no_room}호)`);
        return { pin: unitMatch.pin };
      }

      // 동/호 매칭 실패 → null 반환하여 다음 검색 전략으로 넘어감
      console.log(`  ❌ ${address.dong} ${address.ho} 매칭 실패`);
      return null;
    }

    // ─── 동/호 없는 경우: 주소 매칭 ───
    const emd = address.eupmyeondong || '';
    const jibun = address.jibun || '';
    let matched: any = null;

    // 1차: 읍면동+지번
    for (const item of dataList) {
      const text = this.getAllText(item);
      if (emd && jibun && text.includes(emd) && text.includes(jibun)) {
        matched = item;
        console.log(`  ✅ 읍면동+지번 매칭: ${emd} ${jibun}`);
        break;
      }
    }

    // 2차: 읍면동만
    if (!matched && emd) {
      for (const item of dataList) {
        if (this.getAllText(item).includes(emd)) {
          matched = item;
          console.log(`  ✅ 읍면동 매칭: ${emd}`);
          break;
        }
      }
    }

    // 3차: 시군구+지번
    if (!matched && address.sigungu && jibun) {
      for (const item of dataList) {
        const text = this.getAllText(item);
        if (text.includes(address.sigungu) && text.includes(jibun)) {
          matched = item;
          console.log(`  ✅ 시군구+지번 매칭`);
          break;
        }
      }
    }

    if (matched?.pin) {
      console.log(`  ✅ PIN: ${matched.pin}`);
      return { pin: matched.pin };
    }

    return null;
  }

  async searchPropertyPin(address: ParsedAddress): Promise<string | null> {
    console.log('부동산 주소 검색 시작 (Tilko):', address.fullAddress);

    if (!this.apiKey) {
      throw new Error('Tilko API 키가 설정되지 않았습니다.');
    }

    try {
      const encKey = await this.getEncryptedAesKey();
      let bdName = (address as any).buildingName || '';

      // ─────────────────────────────────────────
      // JUSO API로 도로명 주소 + 건물명 조회 (무료)
      // ─────────────────────────────────────────
      console.log('\n📍 JUSO API로 도로명 주소 목록 조회 (무료)...');
      const jusoResults = await this.getJusoRoadAddresses(address);

      if (jusoResults.length > 0) {
        console.log(`  JUSO 결과 ${jusoResults.length}건:`);
        jusoResults.forEach((r, i) => console.log(`    [${i}] ${r.roadAddr} (${r.bdNm})`));

        // 건물명이 없으면 JUSO에서 가져옴
        if (!bdName && jusoResults[0].bdNm) {
          bdName = jusoResults[0].bdNm;
          console.log(`  건물명 보완: ${bdName}`);
        }
      }

      // ─────────────────────────────────────────
      // 전략 0 (최우선): 동+호 포함 직접 검색 → 1건 반환 (20pt)
      // ─────────────────────────────────────────
      if (address.dong && address.ho) {
        // 0-a: 건물명+동+호 ("비산삼성래미안 118동 1502호")
        if (bdName) {
          const result = await this.searchAndMatch(
            `${bdName} ${address.dong} ${address.ho}`, encKey, address, '건물명+동+호');
          if (result) return result.pin;
        }

        // 0-b: 지번주소+동+호 ("용인시 수지구 풍덕천동 691 106동 1506호")
        const jibunWithUnit = [address.sido, address.sigungu, address.eupmyeondong, address.jibun,
          address.dong, address.ho].filter(Boolean).join(' ');
        const result0b = await this.searchAndMatch(jibunWithUnit, encKey, address, '지번+동+호');
        if (result0b) return result0b.pin;

        // 0-c: 도로명+동+호 (JUSO 1건만)
        if (jusoResults.length > 0) {
          const cleanAddr = jusoResults[0].roadAddr.replace(/\s*\([^)]*\)\s*$/, '').trim();
          const result0c = await this.searchAndMatch(
            `${cleanAddr} ${address.dong} ${address.ho}`, encKey, address, '도로명+동+호');
          if (result0c) return result0c.pin;
        }
      }

      // ─────────────────────────────────────────
      // 전략 1: 도로명 순회 검색 (동/호 없거나 직접검색 실패 시)
      // ─────────────────────────────────────────
      if (jusoResults.length > 0) {

        // 1-b: 도로명만으로 검색 (동/호 없거나 직접검색 실패 시)
        for (let i = 0; i < jusoResults.length; i++) {
          const cleanAddr = jusoResults[i].roadAddr.replace(/\s*\([^)]*\)\s*$/, '').trim();
          const result = await this.searchAndMatch(cleanAddr, encKey, address, `도로명 ${i + 1}/${jusoResults.length}`);
          if (result) return result.pin;
        }
      }

      // ─────────────────────────────────────────
      // 전략 2: 지번 주소로 검색 (폴백)
      // ─────────────────────────────────────────
      const searchAddress = [
        address.sido,
        address.sigungu,
        address.eupmyeondong,
        address.jibun,
      ].filter(Boolean).join(' ').trim();

      const result = await this.searchAndMatch(searchAddress, encKey, address, '지번 검색');
      if (result) return result.pin;

      // ─────────────────────────────────────────
      // 전략 3 (AI 보정): Gemini로 검색어 최적화 후 재시도
      // ─────────────────────────────────────────
      if (this.geminiService) {
        console.log('\n🤖 AI 보정: Gemini로 최적 검색어 추천 요청...');

        // 지번 검색 1페이지 결과를 Gemini에 전달
        try {
          const { dataList: aiDataList, totalPageCount: aiTotalPages } =
            await this.fetchSearchPage(searchAddress, encKey, 1);

          if (aiDataList.length > 0) {
            // 3-a: Gemini로 검색어 최적화
            const suggestion = await this.geminiService.suggestBetterSearchTerm(
              address, searchAddress, aiDataList, aiTotalPages
            );

            if (suggestion?.searchTerm && suggestion.searchTerm !== searchAddress) {
              const aiResult = await this.searchAndMatch(
                suggestion.searchTerm, encKey, address, 'AI 추천 검색'
              );
              if (aiResult) return aiResult.pin;
            }

            // 3-b: Gemini로 1페이지 결과 중 최적 PIN 직접 선택
            if (address.dong && address.ho) {
              const aiSelection = await this.geminiService.selectRegistryPin(address, aiDataList);
              if (aiSelection && aiSelection.pin) {
                console.log(`  🤖 AI PIN 선택: ${aiSelection.pin} (${aiSelection.reason})`);
                return aiSelection.pin;
              }
            }
          }
        } catch (err: any) {
          console.warn(`  AI 보정 실패: ${err.message}`);
        }
      }

      // ─────────────────────────────────────────
      // 최종 폴백: 집합건물 아무거나 사용
      // ─────────────────────────────────────────
      if (address.dong && address.ho) {
        console.warn('⚠️ 모든 전략 실패 → 집합건물 폴백');
        try {
          const { dataList: fallbackList } = await this.fetchSearchPage(searchAddress, encKey, 1);
          const buildingFallback = fallbackList.find((item: any) => item.real_cls_cd === '집합건물');
          if (buildingFallback) {
            console.log(`  📌 집합건물 폴백: ${buildingFallback.pin} (${buildingFallback.buld_name})`);
            return buildingFallback.pin;
          }
        } catch {}
      }

      console.warn('⚠️ 모든 검색 전략 실패');
      return null;

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
  async fetchRegistry(address: ParsedAddress, buildingNumber?: string): Promise<{ filePath: string; pointBalance: number | null }> {
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
        // 추가 필드 - 평문 (데모 확인)
        AbsCls: '',
        CmortFlag: '',
        RgsMttrSmry: '1',  // 등기사항요약 페이지 포함
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

      return { filePath: pdfPath, pointBalance: result.PointBalance ?? null };

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


