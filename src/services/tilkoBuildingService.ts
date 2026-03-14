import axios, { AxiosInstance } from 'axios';
import { ParsedAddress } from '../types';
import { GeminiService } from './geminiService';
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
  private geminiService: GeminiService | null;

  constructor(geminiService?: GeminiService | null) {
    this.geminiService = geminiService || null;
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
    geminiUsed?: boolean;
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
        AddressType: address.isRoadAddress ? '1' : '0',
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

      // 전체 결과 로깅
      console.log(`건축물 주소 조회 성공 (${resultList.length}건)`);
      resultList.forEach((item: any, i: number) => {
        console.log(`  [${i}] PK: ${item.BldRgstSeqNumber}, UntClsfCd: ${item.UntClsfCd}, 지번: ${item.JibunAddr}, 도로명: ${item.RoadAddr || ''}`);
      });

      // 결과 선택: 숫자 PK 우선, 지번/도로명 매칭으로 정확도 향상
      let buildingInfo = resultList[0];

      // 숫자 PK 결과만 필터
      const numericPkResults = resultList.filter((item: any) => !String(item.BldRgstSeqNumber).includes('_'));

      if (numericPkResults.length > 0) {
        // 지번/도로명으로 점수 매겨서 가장 일치하는 것 선택
        const searchEmd = address.eupmyeondong || '';
        const searchJibun = address.jibun || '';

        const scored = numericPkResults.map((item: any) => {
          let score = 0;
          const jibunAddr = item.JibunAddr || '';
          const roadAddr = item.RoadAddr || '';

          // 읍면동/도로명 매칭
          if (searchEmd && (jibunAddr.includes(searchEmd) || roadAddr.includes(searchEmd))) score += 10;

          // 지번(본번) 정확 매칭
          if (searchJibun) {
            const mainJibun = searchJibun.split('-')[0];
            // 지번 주소에서 정확한 번지 매칭 (앞뒤 공백/하이픈 경계)
            const jibunRegex = new RegExp(`(^|\\s)${mainJibun}(\\s|-|$)`);
            if (jibunRegex.test(jibunAddr)) score += 20;
            // 부번까지 정확히 매칭
            if (searchJibun.includes('-') && jibunAddr.includes(searchJibun)) score += 5;
          }

          return { item, score };
        });

        scored.sort((a: any, b: any) => b.score - a.score);
        buildingInfo = scored[0].item;
        console.log(`  → 숫자 PK 결과 선택 (score=${scored[0].score}): ${buildingInfo.BldRgstSeqNumber}, 지번: ${buildingInfo.JibunAddr}`);
        if (scored.length > 1) {
          console.log(`     후보 ${scored.length}건:`, scored.slice(0, 3).map((s: any) => `PK=${s.item.BldRgstSeqNumber}(${s.score}점)`).join(', '));
        }
      }

      // Gemini fallback: 스코어가 낮거나 숫자 PK가 없을 때
      let geminiUsed = false;
      const topScore = numericPkResults.length > 0 ?
        numericPkResults.reduce((max: number, item: any) => {
          let score = 0;
          const jibunAddr = item.JibunAddr || '';
          const searchEmd2 = address.eupmyeondong || '';
          const searchJibun2 = address.jibun || '';
          if (searchEmd2 && jibunAddr.includes(searchEmd2)) score += 10;
          if (searchJibun2) {
            const jibunRegex2 = new RegExp(`(^|\\s)${searchJibun2.split('-')[0]}(\\s|-|$)`);
            if (jibunRegex2.test(jibunAddr)) score += 20;
          }
          return Math.max(max, score);
        }, 0) : 0;

      if (this.geminiService && resultList.length > 1 && topScore < 20) {
        const geminiResult = await this.geminiService.selectBuildingFromResults(address, resultList);
        if (geminiResult && geminiResult.selectedIndex >= 0 && geminiResult.selectedIndex < resultList.length) {
          buildingInfo = resultList[geminiResult.selectedIndex];
          geminiUsed = true;
          console.log(`  → Gemini 건물 선택: [${geminiResult.selectedIndex}] ${buildingInfo.BldRgstSeqNumber} (${geminiResult.reason})`);
        }
      }

      const seqNum = buildingInfo.BldRgstSeqNumber;
      const isAddrFormat = seqNum.includes('_');

      console.log('  선택된 건축물등록번호:', seqNum);
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
        geminiUsed,
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
      const dongKey = (dongFilter || '').replace(/동$/, '');
      const matched = itemList.find((item: any) => {
        const itemDong = (item.dongNm || '').replace(/동$/, '');
        if (itemDong === dongKey) return true;
        // 정규화 매칭: "주동1" ↔ "101동" 등
        const itemNum = (item.dongNm || '').match(/(\d+)/);
        const filterNum = dongFilter.match(/(\d+)/);
        if (itemNum && filterNum) {
          if (filterNum[1].endsWith(itemNum[1]) || itemNum[1].endsWith(filterNum[1])) return true;
        }
        return false;
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

      // 동 매칭 실패: dongFilter가 있을 때는 null 반환하여 다른 bun/ji로 재시도 유도
      if (dongFilter) {
        const allDongs = itemList.map((item: any) => item.dongNm || '(없음)');
        console.warn(`  동 매칭 실패: "${dongFilter}" (검색결과 동: ${allDongs.join(', ')}) → null 반환 (재시도 유도)`);
        return null;
      }

      // dongFilter 없으면 첫 번째 표제부 사용
      console.warn(`  동 필터 없음 → 첫 번째 표제부 사용`);
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
  /**
   * @param ledgerType '전유부' | '표제부' — 전유부: 동/호 매칭(RegstrKindCd=4), 표제부: 건물 전체(RegstrKindCd=1,2)
   */
  async searchBuildingDetail(
    bldRgstSeqno: string,
    untClsfCd: string,
    bldMnnm: string = '',
    bldSlno: string = '',
    dongFilter: string = '',
    hoFilter: string = '',
    ledgerType: '전유부' | '표제부' = '전유부'
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
    geminiUsed?: boolean;
  } | null> {
    console.log('건축물 상세 조회 시작 (Tilko BldRgstDtl)');
    console.log('  건축물등록번호:', bldRgstSeqno);
    console.log('  유닛클래스코드:', untClsfCd);
    console.log('  동 필터:', dongFilter || '없음');
    console.log('  호 필터:', hoFilter || '없음');

    if (!this.apiKey || !this.eaisUserId || !this.eaisPassword) {
      throw new Error('Tilko API 키 또는 세움터 로그인 정보가 설정되지 않았습니다.');
    }

    // 세움터 서버 간헐적 장애 대비 최대 3회 재시도
    let result: any = null;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= 3; attempt++) {
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

        console.log(`BldRgstDtl API 호출 중... (시도 ${attempt}/3)`);

        const response = await this.apiClient.post('/api/v2.0/EaisIdLogin/BldRgstDtl', requestData, {
          headers: { 'ENC-KEY': encKey }
        });

        result = response.data;

        if (result.ErrorCode && result.ErrorCode !== 0 && result.ErrorCode !== '0') {
          const errMsg = result.Message || result.ErrorCode;
          // 서버 통신 오류는 재시도 대상
          if (String(errMsg).includes('통신') && attempt < 3) {
            console.warn(`  ⚠️ 서버 통신 오류 (시도 ${attempt}/3) → ${5 * attempt}초 후 재시도...`);
            await new Promise(r => setTimeout(r, 5000 * attempt));
            continue;
          }
          throw new Error(`BldRgstDtl 에러: ${errMsg}`);
        }

        break; // 성공 시 루프 탈출
      } catch (error: any) {
        lastError = error;
        if (attempt < 3 && (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT' || String(error.message).includes('통신'))) {
          console.warn(`  ⚠️ 네트워크 오류 (시도 ${attempt}/3) → ${5 * attempt}초 후 재시도...`);
          await new Promise(r => setTimeout(r, 5000 * attempt));
          continue;
        }
        console.error('BldRgstDtl 조회 실패:', error.message);
        if (error.response) {
          console.error('응답 상태:', error.response.status);
          console.error('응답 데이터:', JSON.stringify(error.response.data, null, 2));
        }
        return null;
      }
    }

    if (!result) {
      console.error('BldRgstDtl 최대 재시도 초과:', lastError?.message);
      return null;
    }

    try {
      const resultList = result.Result;
      if (!resultList || resultList.length === 0) {
        console.warn('건축물 상세 정보를 찾을 수 없습니다.');
        return null;
      }

      console.log(`  전체 결과 수: ${resultList.length}건`);
      console.log(`  조회 유형: ${ledgerType}`);

      const extractKey = (s: string): string =>
        (s || '').trim().replace(/^제/, '').replace(/^\d+층\s*/, '').replace(/[동호]$/, '').replace(/^0+/, '') || '0';

      const normalizeDong = (apiDong: string | null | undefined, userDong: string): boolean => {
        const apiKey = extractKey(apiDong || '');
        const userKey = extractKey(userDong);
        if (apiKey === userKey) return true;
        const apiNumMatch = (apiDong || '').match(/(\d+)/);
        const userNumMatch = (userDong || '').match(/(\d+)/);
        if (apiNumMatch && userNumMatch) {
          if (userNumMatch[1].endsWith(apiNumMatch[1]) || apiNumMatch[1].endsWith(userNumMatch[1])) return true;
        }
        return false;
      };

      let matchedItem = resultList[0];

      if (ledgerType === '표제부') {
        // ── 표제부: RegstrKindCd '1' 또는 '2' ──
        const pyojeItems = resultList.filter((item: any) =>
          item.RegstrKindCd === '1' || item.RegstrKindCd === '2'
        );
        console.log(`  표제부(1,2) 건수: ${pyojeItems.length}건`);

        if (pyojeItems.length === 0) {
          console.warn('  표제부 항목이 없습니다.');
          return null;
        }

        if (dongFilter) {
          const dongMatched = pyojeItems.find((item: any) => normalizeDong(item.DongNm, dongFilter));
          if (dongMatched) {
            matchedItem = dongMatched;
            console.log(`  표제부 동 매칭: ${dongMatched.DongNm} (${dongMatched.RegstrKindNm})`);
          } else {
            const chonggwal = pyojeItems.find((item: any) => item.RegstrKindCd === '2');
            matchedItem = chonggwal || pyojeItems[0];
            console.log(`  표제부 동 매칭 실패 → ${matchedItem.RegstrKindNm || (matchedItem.RegstrKindCd === '2' ? '총괄표제부' : '일반표제부')} 사용`);
          }
        } else {
          const chonggwal = pyojeItems.find((item: any) => item.RegstrKindCd === '2');
          matchedItem = chonggwal || pyojeItems[0];
          console.log(`  표제부 선택: ${matchedItem.RegstrKindNm || (matchedItem.RegstrKindCd === '2' ? '총괄표제부' : '일반표제부')}`);
        }

      } else if (dongFilter || hoFilter) {
        // ── 전유부: RegstrKindCd '4', 동/호 매칭 ──
        const dongKey = extractKey(dongFilter);
        const hoKey = extractKey(hoFilter);

        const found = resultList.find((item: any) => {
          const dongMatch = !dongFilter || normalizeDong(item.DongNm, dongFilter);
          const hoMatch = !hoFilter || extractKey(item.HoNm) === hoKey;
          return dongMatch && hoMatch && item.RegstrKindCd === '4';
        });

        let geminiUsedForDong = false;

        if (found) {
          matchedItem = found;
          console.log(`  매칭 성공: ${found.DongNm} ${found.HoNm}`);
        } else {
          const allDongs = [...new Set(resultList.map((item: any) => item.DongNm))];
          const kindCodes = [...new Set(resultList.map((item: any) => item.RegstrKindCd))];
          const jeonyu = resultList.filter((item: any) => item.RegstrKindCd === '4');
          const dongMatched = resultList.filter((item: any) => extractKey(item.DongNm) === dongKey);
          const dongMatchedSample = dongMatched.slice(0, 5).map((item: any) =>
            `${item.DongNm}/${item.HoNm}(종류:${item.RegstrKindCd})`);
          console.warn(`  매칭 실패: ${dongFilter} ${hoFilter} (추출: dong=${dongKey}, ho=${hoKey})`);
          console.warn(`  전체 동 목록:`, allDongs);
          console.warn(`  RegstrKindCd 종류:`, kindCodes);
          console.warn(`  전유부(4) 건수: ${jeonyu.length}건`);
          console.warn(`  동(${dongKey}) 매칭 건수: ${dongMatched.length}건, 샘플:`, dongMatchedSample);

          if (this.geminiService && dongFilter && jeonyu.length > 0) {
            const uniqueDongs = [...new Set(jeonyu.map((item: any) => item.DongNm).filter(Boolean))] as string[];
            if (uniqueDongs.length > 0) {
              const geminiMatch = await this.geminiService.matchDongName(dongFilter, uniqueDongs);
              if (geminiMatch && geminiMatch.matchedDong) {
                const geminiFound = resultList.find((item: any) =>
                  item.DongNm === geminiMatch.matchedDong &&
                  (!hoFilter || extractKey(item.HoNm) === hoKey) &&
                  item.RegstrKindCd === '4'
                );
                if (geminiFound) {
                  matchedItem = geminiFound;
                  geminiUsedForDong = true;
                  console.log(`  Gemini 동 매칭 성공: ${geminiFound.DongNm} ${geminiFound.HoNm} (${geminiMatch.reason})`);
                }
              }
            }
          }

          if (!geminiUsedForDong) {
            return null;
          }
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
        details: resultList,
      };

    } catch (error: any) {
      console.error('BldRgstDtl 결과 처리 실패:', error.message);
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

  /**
   * 도로명 주소 → 지번 주소 변환 (JUSO API)
   * BldRgstMst 도로명 검색 실패 시 지번으로 재검색하기 위해 사용
   */
  async convertRoadToLotAddress(address: ParsedAddress): Promise<ParsedAddress | null> {
    const jusoApiKey = process.env.JUSO_API_KEY;
    if (!jusoApiKey) {
      console.warn('JUSO_API_KEY가 설정되지 않았습니다.');
      return null;
    }

    const keyword = [address.sido, address.sigungu, address.eupmyeondong, address.jibun]
      .filter(Boolean).join(' ');

    console.log('  도로명 → 지번 변환 (JUSO API):', keyword);

    try {
      const response = await axios.get('https://business.juso.go.kr/addrlink/addrLinkApi.do', {
        params: {
          confmKey: jusoApiKey,
          currentPage: 1,
          countPerPage: 5,
          keyword,
          resultType: 'json',
        },
        timeout: 10000,
      });

      const results = response.data?.results?.juso;
      if (!results || results.length === 0) {
        console.warn('  JUSO API에서 결과를 찾을 수 없습니다.');
        return null;
      }

      const juso = results[0];
      const jibunAddr = juso.jibunAddr || '';
      console.log(`  JUSO 지번주소: ${jibunAddr}`);
      console.log(`  JUSO 도로명주소: ${juso.roadAddr || ''}`);
      console.log(`  JUSO 건물명: ${juso.bdNm || ''}`);

      // 지번주소에서 읍면동과 번지 추출
      // "서울특별시 송파구 잠실동 22" → eupmyeondong="잠실동", jibun="22"
      if (!jibunAddr) return null;

      const parts = jibunAddr.trim().split(/\s+/);
      // 뒤에서부터 번지, 읍면동 추출
      let lotJibun = '';
      let lotEmd = '';
      for (let i = parts.length - 1; i >= 0; i--) {
        if (/^\d+(-\d+)?$/.test(parts[i]) && !lotJibun) {
          lotJibun = parts[i];
        } else if (/[동읍면리가]$/.test(parts[i]) && !lotEmd) {
          lotEmd = parts[i];
          break;
        }
      }

      if (!lotEmd || !lotJibun) {
        console.warn(`  지번 파싱 실패: emd=${lotEmd}, jibun=${lotJibun}`);
        return null;
      }

      console.log(`  → 변환: ${lotEmd} ${lotJibun} (isRoadAddress=false)`);

      return {
        ...address,
        eupmyeondong: lotEmd,
        jibun: lotJibun,
        isRoadAddress: false,
        buildingName: juso.bdNm || address.buildingName,
        fullAddress: address.fullAddress,
      };
    } catch (error: any) {
      console.error('  JUSO API 호출 실패:', error.message);
      return null;
    }
  }

  /**
   * 주소 유효성 사전 검증 (JUSO API, 무료)
   * Tilko API(유료) 호출 전에 주소가 실제로 존재하는지 확인
   *
   * @returns 유효한 주소면 JUSO API 응답 데이터, 아니면 null
   */
  async validateAddress(address: ParsedAddress): Promise<{
    valid: boolean;
    roadAddr?: string;
    jibunAddr?: string;
    bdNm?: string;
    errorReason?: string;
  }> {
    const jusoApiKey = process.env.JUSO_API_KEY;
    if (!jusoApiKey) {
      // API 키가 없으면 검증 스킵 (기존 동작 유지)
      console.warn('JUSO_API_KEY 미설정 → 주소 검증 스킵');
      return { valid: true };
    }

    const keyword = [address.sido, address.sigungu, address.eupmyeondong, address.jibun]
      .filter(Boolean).join(' ');

    console.log('주소 유효성 검증 (JUSO API):', keyword);

    try {
      const response = await axios.get('https://business.juso.go.kr/addrlink/addrLinkApi.do', {
        params: {
          confmKey: jusoApiKey,
          currentPage: 1,
          countPerPage: 10,
          keyword,
          resultType: 'json',
        },
        timeout: 10000,
      });

      const common = response.data?.results?.common;
      const results = response.data?.results?.juso;

      // API 에러 체크
      if (common?.errorCode !== '0') {
        console.warn(`  JUSO API 에러: ${common?.errorMessage || '알 수 없는 에러'}`);
        return { valid: true }; // API 에러 시 검증 스킵
      }

      if (!results || results.length === 0) {
        const reason = address.isRoadAddress
          ? `도로명 주소 "${address.eupmyeondong} ${address.jibun}"을(를) 찾을 수 없습니다.`
          : `지번 주소 "${address.eupmyeondong} ${address.jibun}"을(를) 찾을 수 없습니다.`;
        console.warn(`  ❌ 주소 검증 실패: ${reason}`);
        return { valid: false, errorReason: reason };
      }

      const juso = results[0];
      console.log(`  ✅ 주소 검증 성공: ${juso.roadAddr || juso.jibunAddr}`);
      if (juso.bdNm) console.log(`  건물명: ${juso.bdNm}`);

      return {
        valid: true,
        roadAddr: juso.roadAddr,
        jibunAddr: juso.jibunAddr,
        bdNm: juso.bdNm,
      };
    } catch (error: any) {
      console.warn('  주소 검증 API 호출 실패 → 검증 스킵:', error.message);
      return { valid: true }; // 네트워크 에러 시 검증 스킵
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
