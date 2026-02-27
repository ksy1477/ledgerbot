import axios, { AxiosInstance } from 'axios';
import { ParsedAddress } from '../types';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Tilko 건축물대장 API 서비스
 *
 * 플로우 A (BldRgstMst가 순수 숫자 PK 반환 시):
 *   1. BldRgstMst (20pt) → 건축물등록번호 PK
 *   2. BldRgstDtl (20pt) → 동/호 매칭
 *   3. RPTCAA02R01 (100pt) → PDF 발급
 *
 * 플로우 B (BldRgstMst가 주소코드 반환 시):
 *   1. BldRgstMst (20pt) → 주소코드 (11530_10700_0_0481_0000)
 *   1-2. 공공데이터 API (무료) → 동별 표제부 PK 조회
 *   2. BldRgstDtl (20pt) → 동/호 매칭
 *   3. RPTCAA02R01 (100pt) → PDF 발급
 */
export class TilkoBuildingService {
  private apiClient: AxiosInstance;
  private apiKey: string;
  private aesKey: Buffer;
  private aesIv: Buffer;

  private eaisUserId: string;
  private eaisPassword: string;
  private publicDataApiKey: string;

  constructor() {
    this.apiKey = process.env.TILKO_API_KEY || '';

    this.aesKey = process.env.TILKO_AES_KEY
      ? Buffer.from(process.env.TILKO_AES_KEY, 'utf8')
      : crypto.randomBytes(16);

    this.aesIv = Buffer.alloc(16, 0);

    this.eaisUserId = process.env.EAIS_USER_ID || '';
    this.eaisPassword = process.env.EAIS_USER_PASSWORD || '';
    this.publicDataApiKey = process.env.PUBLIC_DATA_API_KEY || '';

    this.apiClient = axios.create({
      baseURL: 'https://api.tilko.net',
      timeout: 180000,
      headers: {
        'Content-Type': 'application/json',
      }
    });

    this.apiClient.interceptors.request.use((config) => {
      if (this.apiKey) {
        config.headers['API-KEY'] = this.apiKey;
      }
      return config;
    });

    this.apiClient.interceptors.response.use(
      (response) => response,
      (error) => {
        console.error('Tilko Building API 에러:', error.response?.data || error.message);
        throw error;
      }
    );
  }

  private encryptAES(plaintext: string): string {
    const cipher = crypto.createCipheriv('aes-128-cbc', this.aesKey, this.aesIv);
    let encrypted = cipher.update(plaintext, 'utf8', 'base64');
    encrypted += cipher.final('base64');
    return encrypted;
  }

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
   * 1단계: 건축물 주소 조회 (주소 → 건축물등록번호)
   *
   * API: POST /api/v2.0/EaisIdLogin/BldRgstMst
   * 비용: 20 포인트
   *
   * 반환되는 bldRgstSeqno 형식:
   * - 순수 숫자 (예: "1008149") → BldRgstDtl에 직접 사용 가능
   * - 주소 코드 (예: "11530_10700_0_0481_0000") → 공공데이터 API 필요
   */
  async searchBuildingInfo(address: ParsedAddress): Promise<{
    bldRgstSeqno: string;
    untClsfCd: string;
    isAddrFormat: boolean;
    addrParts?: { sigunguCd: string; bjdongCd: string; bun: string; ji: string };
    pointBalance?: string;
  } | null> {
    console.log('건축물 주소 조회 시작 (Tilko BldRgstMst):', address.fullAddress);

    if (!this.apiKey) {
      throw new Error('Tilko API 키가 설정되지 않았습니다.');
    }

    try {
      const encKey = await this.getEncryptedAesKey();

      // 검색 주소 생성 (건물 단위 조회이므로 동/호 제외)
      const searchAddress = [
        address.sido,
        address.sigungu,
        address.eupmyeondong,
        address.jibun
      ].filter(Boolean).join(' ').trim();

      const requestData = {
        AddressType: '0',
        QueryAddress: searchAddress
      };

      console.log('검색 주소:', searchAddress);
      console.log('BldRgstMst API 호출 중...');

      const response = await this.apiClient.post('/api/v2.0/EaisIdLogin/BldRgstMst', requestData, {
        headers: { 'ENC-KEY': encKey }
      });

      const result = response.data;

      if (result.ErrorCode && result.ErrorCode !== 0 && result.ErrorCode !== '0') {
        throw new Error(`BldRgstMst 에러: ${result.Message || result.ErrorCode}`);
      }

      const resultList = result.Juso?.Result || result.Result;

      if (!resultList || resultList.length === 0) {
        console.warn('건축물 정보를 찾을 수 없습니다.');
        return null;
      }

      const buildingInfo = resultList[0];
      const seqNum = buildingInfo.BldRgstSeqNumber;
      const isAddrFormat = seqNum.includes('_');

      console.log('건축물 주소 조회 성공');
      console.log('  건축물등록번호:', seqNum);
      console.log('  형식:', isAddrFormat ? 'ADDR (주소코드) → 공공데이터 API 필요' : 'BLDG (건축물PK) → 직접 사용');
      console.log('  유닛클래스코드:', buildingInfo.UntClsfCd);
      console.log('  지번주소:', buildingInfo.JibunAddr);
      console.log('  남은 포인트:', result.PointBalance);

      // 주소 코드 형식이면 파싱해서 반환
      let addrParts: { sigunguCd: string; bjdongCd: string; bun: string; ji: string } | undefined;
      if (isAddrFormat) {
        const parts = seqNum.split('_');
        if (parts.length >= 5) {
          addrParts = {
            sigunguCd: parts[0],
            bjdongCd: parts[1],
            bun: parts[3],
            ji: parts[4],
          };
          console.log('  주소코드 파싱:', addrParts);
        }
      }

      return {
        bldRgstSeqno: seqNum,
        untClsfCd: buildingInfo.UntClsfCd,
        isAddrFormat,
        addrParts,
        pointBalance: result.PointBalance,
      };

    } catch (error: any) {
      console.error('BldRgstMst 조회 실패:', error.message);
      if (error.response) {
        console.error('응답 상태:', error.response.status);
        console.error('응답 데이터:', JSON.stringify(error.response.data, null, 2));
      }
      return null;
    }
  }

  /**
   * 공공데이터 API로 특정 동의 표제부 PK 조회
   *
   * BldRgstMst가 주소코드를 반환할 때 사용
   * API: 국토교통부_건축물대장 표제부 조회 (무료)
   */
  async resolveBuildingPkFromPublicData(
    sigunguCd: string,
    bjdongCd: string,
    bun: string,
    ji: string,
    dongFilter: string
  ): Promise<{ bldRgstSeqno: string; untClsfCd: string } | null> {
    console.log('공공데이터 API로 건축물 PK 조회...');
    console.log(`  시군구: ${sigunguCd}, 법정동: ${bjdongCd}, 본번: ${bun}, 부번: ${ji}, 동: ${dongFilter}`);

    if (!this.publicDataApiKey) {
      throw new Error('공공데이터 API 키가 설정되지 않았습니다. (PUBLIC_DATA_API_KEY)');
    }

    try {
      const response = await axios.get('https://apis.data.go.kr/1613000/BldRgstHubService/getBrTitleInfo', {
        params: {
          serviceKey: this.publicDataApiKey,
          sigunguCd,
          bjdongCd,
          bun,
          ji,
          numOfRows: 100,
          pageNo: 1,
          _type: 'json',
        },
        timeout: 30000,
      });

      const items = response.data?.response?.body?.items?.item;
      if (!items) {
        console.warn('공공데이터에서 건축물 정보를 찾을 수 없습니다.');
        return null;
      }

      const itemList = Array.isArray(items) ? items : [items];
      console.log(`  표제부 ${itemList.length}건 조회됨`);

      // dongFilter와 매칭되는 동 찾기
      // dongFilter: "115동" → dongNm: "115동" 또는 "115"
      const dongKey = dongFilter.replace(/동$/, '');
      const matched = itemList.find((item: any) => {
        const itemDong = (item.dongNm || '').replace(/동$/, '');
        return itemDong === dongKey;
      });

      if (matched) {
        console.log(`  매칭 성공: ${matched.dongNm} (PK: ${matched.mgmBldrgstPk})`);
        // UntClsfCd는 PK의 앞 4자리
        const pk = String(matched.mgmBldrgstPk);
        const untClsfCd = pk.substring(0, 4);
        return {
          bldRgstSeqno: pk,
          untClsfCd,
        };
      }

      if (itemList.length === 0) {
        console.warn('  공공데이터에서 건축물 정보를 찾을 수 없습니다. (0건)');
        return null;
      }

      // 정확한 매칭 실패 시 첫 번째 표제부 사용
      console.warn(`  동 매칭 실패: "${dongFilter}" → 첫 번째 표제부 사용`);
      const first = itemList[0];
      const pk = String(first.mgmBldrgstPk);
      return {
        bldRgstSeqno: pk,
        untClsfCd: pk.substring(0, 4),
      };

    } catch (error: any) {
      console.error('공공데이터 API 조회 실패:', error.message);
      return null;
    }
  }

  /**
   * 2단계: 건축물 상세정보 조회 (건축물등록번호 → 특정 동/호 매칭)
   *
   * API: POST /api/v2.0/EaisIdLogin/BldRgstDtl
   * 비용: 20 포인트
   */
  async searchBuildingDetail(
    bldRgstSeqno: string,
    untClsfCd: string,
    bldMnnm: string = '',
    bldSlno: string = '',
    dongFilter: string = '',
    hoFilter: string = ''
  ): Promise<{
    regstrKindCd: string;
    regstrKindNm: string;
    upperBldRgstSeqno: string;
    bldRgstSeqno: string;
    untClsfCd: string;
    dongNm: string;
    hoNm: string;
    bldNm: string;
    totArea: string;
    pointBalance?: string;
    details: any[];
  } | null> {
    console.log('건축물 상세 조회 시작 (Tilko BldRgstDtl)');
    console.log('  건축물등록번호:', bldRgstSeqno);
    console.log('  유닛클래스코드:', untClsfCd);
    console.log('  동 필터:', dongFilter || '없음');
    console.log('  호 필터:', hoFilter || '없음');

    if (!this.apiKey || !this.eaisUserId || !this.eaisPassword) {
      throw new Error('Tilko API 키 또는 세움터 로그인 정보가 설정되지 않았습니다.');
    }

    try {
      const encKey = await this.getEncryptedAesKey();

      const requestData: any = {
        Auth: {
          UserId: this.encryptAES(this.eaisUserId),
          UserPassword: this.encryptAES(this.eaisPassword),
        },
        BldRgstSeqNumber: bldRgstSeqno,
        UntClsfCd: untClsfCd,
        BldMnnm: bldMnnm || '',
        BldSlno: bldSlno || '',
      };

      console.log('BldRgstDtl API 호출 중...');

      const response = await this.apiClient.post('/api/v2.0/EaisIdLogin/BldRgstDtl', requestData, {
        headers: { 'ENC-KEY': encKey }
      });

      const result = response.data;

      if (result.ErrorCode && result.ErrorCode !== 0 && result.ErrorCode !== '0') {
        throw new Error(`BldRgstDtl 에러: ${result.Message || result.ErrorCode}`);
      }

      const resultList = result.Result;
      if (!resultList || resultList.length === 0) {
        console.warn('건축물 상세 정보를 찾을 수 없습니다.');
        return null;
      }

      console.log(`  전체 결과 수: ${resultList.length}건`);

      // dong+ho 필터가 있으면 매칭되는 전유부를 찾음
      let matchedItem = resultList[0];

      if (dongFilter || hoFilter) {
        // 동/호에서 숫자만 추출
        // DongNm: "101동", "제103동" → "101", "103"
        // HoNm: "10층 1005호", "1층 101호", "1005호" → "1005", "101", "1005"
        const extractNumber = (s: string): string =>
          (s || '').trim().replace(/^제/, '').replace(/^\d+층\s*/, '').replace(/[동호]$/, '').replace(/^0+/, '') || '0';

        const dongNum = extractNumber(dongFilter);
        const hoNum = extractNumber(hoFilter);

        const found = resultList.find((item: any) => {
          const dongMatch = !dongFilter || extractNumber(item.DongNm) === dongNum;
          const hoMatch = !hoFilter || extractNumber(item.HoNm) === hoNum;
          return dongMatch && hoMatch && item.RegstrKindCd === '4'; // 전유부만
        });

        if (found) {
          matchedItem = found;
          console.log(`  매칭 성공: ${found.DongNm} ${found.HoNm}`);
        } else {
          // 디버그: 매칭 실패 시 상세 분석
          const allDongs = [...new Set(resultList.map((item: any) => item.DongNm))];
          const kindCodes = [...new Set(resultList.map((item: any) => item.RegstrKindCd))];
          const jeonyu = resultList.filter((item: any) => item.RegstrKindCd === '4');
          const dongMatched = resultList.filter((item: any) => extractNumber(item.DongNm) === dongNum);
          const dongMatchedSample = dongMatched.slice(0, 5).map((item: any) =>
            `${item.DongNm}/${item.HoNm}(종류:${item.RegstrKindCd})`);
          console.warn(`  매칭 실패: ${dongFilter} ${hoFilter} (추출: dong=${dongNum}, ho=${hoNum})`);
          console.warn(`  전체 동 목록:`, allDongs);
          console.warn(`  RegstrKindCd 종류:`, kindCodes);
          console.warn(`  전유부(4) 건수: ${jeonyu.length}건`);
          console.warn(`  동(${dongNum}) 매칭 건수: ${dongMatched.length}건, 샘플:`, dongMatchedSample);
          return null;
        }
      }

      console.log('건축물 상세 조회 성공');
      console.log('  대장구분코드:', matchedItem.RegstrKindCd, `(${matchedItem.RegstrKindNm})`);
      console.log('  건축물등록번호:', matchedItem.BldRgstSeqno);
      console.log('  상위건축물등록번호:', matchedItem.UpperBldRgstSeqno);
      console.log('  동명:', matchedItem.DongNm);
      console.log('  호명:', matchedItem.HoNm);
      console.log('  건물명:', matchedItem.BldNm);
      console.log('  면적:', matchedItem.TotArea, '㎡');
      console.log('  남은 포인트:', result.PointBalance);

      return {
        regstrKindCd: matchedItem.RegstrKindCd,
        regstrKindNm: matchedItem.RegstrKindNm || '',
        upperBldRgstSeqno: matchedItem.UpperBldRgstSeqno || '',
        bldRgstSeqno: matchedItem.BldRgstSeqno || '',
        untClsfCd: matchedItem.UntClsfCd || '',
        dongNm: matchedItem.DongNm || '',
        hoNm: matchedItem.HoNm || '',
        bldNm: matchedItem.BldNm || '',
        totArea: matchedItem.TotArea || '',
        pointBalance: result.PointBalance,
        details: resultList
      };

    } catch (error: any) {
      console.error('BldRgstDtl 조회 실패:', error.message);
      if (error.response) {
        console.error('응답 상태:', error.response.status);
        console.error('응답 데이터:', JSON.stringify(error.response.data, null, 2));
      }
      return null;
    }
  }

  /**
   * 3단계: 건축물대장 PDF 발급
   *
   * API: POST /api/v2.0/EaisIdLogin/RPTCAA02R01
   * 비용: 100 포인트
   */
  async fetchBuildingLedger(
    address: ParsedAddress,
    regstrKindCd: string,
    bldRgstSeqno: string,
    untClsfCd: string,
    upperBldRgstSeqno: string = ''
  ): Promise<{ filePath: string; pointBalance?: number }> {
    console.log('건축물대장 발급 시작 (Tilko RPTCAA02R01):', address.fullAddress);

    if (!this.apiKey) {
      throw new Error('Tilko API 키가 설정되지 않았습니다.');
    }
    if (!this.eaisUserId || !this.eaisPassword) {
      throw new Error('세움터 로그인 정보가 설정되지 않았습니다.');
    }

    console.log('파라미터:', {
      regstrKindCd,
      bldRgstSeqno,
      untClsfCd,
      upperBldRgstSeqno: upperBldRgstSeqno || '(없음)'
    });

    try {
      const encKey = await this.getEncryptedAesKey();

      const requestData = {
        Auth: {
          UserId: this.encryptAES(this.eaisUserId),
          UserPassword: this.encryptAES(this.eaisPassword),
        },
        PublishType: '1',
        RegstrKindCd: regstrKindCd,
        BldRgstSeqno: bldRgstSeqno,
        UntClsfCd: untClsfCd,
        MjrFmlyYn: 'n',
        UpperBldRgstSeqno: upperBldRgstSeqno,
      };

      console.log('RPTCAA02R01 API 호출 중...');

      const response = await this.apiClient.post('/api/v2.0/EaisIdLogin/RPTCAA02R01', requestData, {
        headers: { 'ENC-KEY': encKey }
      });

      console.log('RPTCAA02R01 응답 받음');

      const result = response.data;

      if (result.ErrorCode && result.ErrorCode !== '0' && result.ErrorCode !== 0) {
        console.error('에러 코드:', result.ErrorCode);
        console.error('에러 메시지:', result.Message);
        console.error('에러 로그:', result.ErrorLog);
        throw new Error(`RPTCAA02R01 에러: ${result.Message || result.ErrorCode}`);
      }

      const filePath = await this.savePdfFromResponse(result, address);
      const pointBalance = result.PointBalance ? parseInt(result.PointBalance, 10) : undefined;

      console.log('건축물대장 발급 완료:', filePath);
      console.log('남은 포인트:', result.PointBalance);

      return { filePath, pointBalance };

    } catch (error: any) {
      console.error('RPTCAA02R01 발급 실패:', error.message);
      if (error.response) {
        console.error('응답 상태:', error.response.status);
        console.error('응답 데이터:', JSON.stringify(error.response.data, null, 2));
      }
      throw new Error(`건축물대장 발급 실패: ${error.message}`);
    }
  }

  private async savePdfFromResponse(response: any, address: ParsedAddress): Promise<string> {
    const tempDir = process.env.TEMP_FILE_PATH || './temp';

    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '_').split('.')[0];
    const fileName = `건축물대장_${address.eupmyeondong}_${timestamp}.pdf`;
    const filePath = path.join(tempDir, fileName);

    const pdfData = response.PdfData || response.Result?.PdfData;

    if (pdfData) {
      const pdfBuffer = Buffer.from(pdfData, 'base64');
      fs.writeFileSync(filePath, pdfBuffer);
    } else {
      console.error('응답 전체:', JSON.stringify(response, null, 2));
      throw new Error('응답에 PDF 데이터가 없습니다.');
    }

    return filePath;
  }

  /**
   * 주소정보 API(JUSO)로 법정동코드 조회
   *
   * 주소 텍스트 → sigunguCd(5자리) + bjdongCd(5자리)
   * API: https://business.juso.go.kr/addrlink/addrLinkApi.do (무료)
   */
  async lookupAddressCodes(address: ParsedAddress): Promise<{
    sigunguCd: string;
    bjdongCd: string;
  } | null> {
    const jusoApiKey = process.env.JUSO_API_KEY;
    if (!jusoApiKey) {
      console.warn('JUSO_API_KEY가 설정되지 않았습니다.');
      return null;
    }

    const keyword = [address.sido, address.sigungu, address.eupmyeondong, address.jibun]
      .filter(Boolean).join(' ');

    console.log('주소정보 API로 법정동코드 조회:', keyword);

    try {
      const response = await axios.get('https://business.juso.go.kr/addrlink/addrLinkApi.do', {
        params: {
          confmKey: jusoApiKey,
          currentPage: 1,
          countPerPage: 1,
          keyword,
          resultType: 'json',
        },
        timeout: 10000,
      });

      const results = response.data?.results?.juso;
      if (!results || results.length === 0) {
        console.warn('주소정보 API에서 결과를 찾을 수 없습니다.');
        return null;
      }

      const juso = results[0];
      // bdMgtSn (건물관리번호, 25자리): 법정동코드(10) + 산여부(1) + 본번(4) + 부번(4) + ...
      const bdMgtSn = juso.bdMgtSn || '';
      if (bdMgtSn.length >= 10) {
        const sigunguCd = bdMgtSn.substring(0, 5);
        const bjdongCd = bdMgtSn.substring(5, 10);
        console.log(`  법정동코드: sigunguCd=${sigunguCd}, bjdongCd=${bjdongCd}`);
        return { sigunguCd, bjdongCd };
      }

      // admCd 사용 (행정동코드) - bdMgtSn이 없을 경우 fallback
      const admCd = juso.admCd || '';
      if (admCd.length >= 10) {
        const sigunguCd = admCd.substring(0, 5);
        const bjdongCd = admCd.substring(5, 10);
        console.log(`  행정동코드(fallback): sigunguCd=${sigunguCd}, bjdongCd=${bjdongCd}`);
        return { sigunguCd, bjdongCd };
      }

      console.warn('법정동코드를 추출할 수 없습니다.');
      return null;
    } catch (error: any) {
      console.error('주소정보 API 조회 실패:', error.message);
      return null;
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      if (!this.apiKey) {
        console.warn('Tilko API 키가 설정되지 않았습니다.');
        return false;
      }
      if (!this.eaisUserId) {
        console.warn('세움터 로그인 정보가 설정되지 않았습니다.');
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
