import axios from 'axios';
import { ParsedAddress } from '../types';

/**
 * Gemini API 서비스 - AI 기반 주소 매칭 보정
 *
 * 기존 정규식/스코어링 로직이 실패할 때만 호출
 * - BldRgstMst 결과 중 정확한 건물 선택
 * - BldRgstDtl 동 이름 매칭
 * - 등기부등본 PIN 검색 최적화 (검색어 추천, 결과 선택)
 */
export class GeminiService {
  private apiKey: string;
  private model: string;
  private baseUrl: string;

  constructor() {
    this.apiKey = process.env.GEMINI_API_KEY || '';
    this.model = 'gemini-2.5-flash';
    this.baseUrl = 'https://generativelanguage.googleapis.com/v1beta';
  }

  private async generateJson(systemInstruction: string, userPrompt: string): Promise<any> {
    if (!this.apiKey) return null;

    try {
      const response = await axios.post(
        `${this.baseUrl}/models/${this.model}:generateContent?key=${this.apiKey}`,
        {
          system_instruction: { parts: [{ text: systemInstruction }] },
          contents: [{ parts: [{ text: userPrompt }] }],
          generationConfig: {
            responseMimeType: 'application/json',
            temperature: 0.1,
          },
        },
        { timeout: 15000 }
      );

      const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) return null;

      return JSON.parse(text);
    } catch (error: any) {
      console.warn('Gemini API 호출 실패:', error.message);
      return null;
    }
  }

  /**
   * BldRgstMst 결과 목록에서 사용자 주소와 가장 일치하는 건물 선택
   */
  async selectBuildingFromResults(
    address: ParsedAddress,
    resultList: any[]
  ): Promise<{ selectedIndex: number; reason: string } | null> {
    console.log('  [Gemini] 건물 선택 요청...');

    const simplifiedResults = resultList.map((item: any, i: number) => ({
      index: i,
      pk: String(item.BldRgstSeqNumber),
      isNumericPk: !String(item.BldRgstSeqNumber).includes('_'),
      jibunAddr: item.JibunAddr || '',
      roadAddr: item.RoadAddr || '',
    }));

    const systemInstruction = `You are a Korean building address matching expert.
Given a user's address query and building search results from the Korean government API, select the result that best matches the user's intended building.

Rules:
- Match the 읍면동(eupmyeondong) name exactly when possible
- Match the 지번(jibun/lot number) or 건물번호(building number for road addresses) precisely
- Prefer results with numeric PK (isNumericPk=true) as they work better with subsequent API calls
- If the user searches by road name (isRoadAddress=true), match the road name and building number in roadAddr
- If the user searches by lot address (isRoadAddress=false), match eupmyeondong and jibun in jibunAddr
- Return JSON: { "selectedIndex": <number>, "reason": "<brief Korean explanation>" }
- If no result matches well, return { "selectedIndex": -1, "reason": "매칭 결과 없음" }`;

    const userPrompt = JSON.stringify({
      userQuery: {
        sido: address.sido,
        sigungu: address.sigungu,
        eupmyeondong: address.eupmyeondong,
        jibun: address.jibun,
        isRoadAddress: address.isRoadAddress,
        fullAddress: address.fullAddress,
      },
      results: simplifiedResults,
    });

    const result = await this.generateJson(systemInstruction, userPrompt);

    if (result && typeof result.selectedIndex === 'number') {
      console.log(`  [Gemini] 선택: index=${result.selectedIndex}, 이유: ${result.reason}`);
      return result;
    }

    return null;
  }

  /**
   * BldRgstDtl 동 이름 매칭 (사용자 동 ↔ API 동 이름 매핑)
   */
  async matchDongName(
    userDong: string,
    apiDongList: string[]
  ): Promise<{ matchedDong: string; reason: string } | null> {
    console.log(`  [Gemini] 동 매칭 요청: "${userDong}" vs [${apiDongList.join(', ')}]`);

    const systemInstruction = `You are a Korean building dong (동) name matching expert.
Korean apartment complexes use various naming conventions for dong:
- Numeric: "101동", "102동", "103동"
- Named: "주동1", "주동2" (where 주동1 = 101동, 주동2 = 102동)
- Letter-based: "A동", "B동"
- Named buildings: "상가동", "관리동"

Match the user's dong input to the most likely API dong name.
Return JSON: { "matchedDong": "<exact API dong name>", "reason": "<brief Korean explanation>" }
If no match is possible, return { "matchedDong": "", "reason": "매칭 불가" }`;

    const userPrompt = JSON.stringify({
      userDong,
      apiDongNames: apiDongList.filter(Boolean),
    });

    const result = await this.generateJson(systemInstruction, userPrompt);

    if (result && result.matchedDong) {
      console.log(`  [Gemini] 동 매칭: "${result.matchedDong}" (${result.reason})`);
      return result;
    }

    return null;
  }

  /**
   * 등기부등본 PIN 검색 최적화:
   * 검색 결과 1페이지와 사용자 주소를 보고, 최적의 재검색어를 추천
   *
   * 사용 시점: 직접검색(건물명+동+호, 지번+동+호) 실패 후
   * 결과가 너무 많거나(100+페이지) 매칭이 안 될 때
   */
  async suggestBetterSearchTerm(
    address: ParsedAddress,
    currentSearchTerm: string,
    firstPageResults: any[],
    totalPages: number
  ): Promise<{ searchTerm: string; reason: string } | null> {
    console.log(`  [Gemini] 검색어 최적화 요청 (현재: "${currentSearchTerm}", ${totalPages}페이지)...`);

    const simplifiedResults = firstPageResults.slice(0, 5).map((item: any) => ({
      name: item.buld_name || '',
      dong: item.buld_no_buld || '',
      room: item.buld_no_room || '',
      type: item.real_cls_cd || '',
      address: (item.real_indi_cont || '').replace(/<[^>]+>/g, '').substring(0, 80),
    }));

    const systemInstruction = `You are a Korean real estate registry search expert.
The user is searching for a specific apartment unit's registry PIN using the Korean internet registry (인터넷등기소) search API.

The current search returned too many results (${totalPages} pages) or wrong results.
Analyze the first page results and suggest a better, more specific search term.

Key strategies:
- If building name is visible in results, use: "건물명 동 호" (e.g., "삼성래미안 118동 1502호")
- If road address is visible, use: "도로명 동 호" (e.g., "관악대로 135 118동 1502호")
- Include dong(동) and ho(호) in search for precise matching
- The search API accepts Korean building names, road addresses, and unit numbers

Return JSON: { "searchTerm": "<optimized search term>", "reason": "<brief Korean explanation>" }
If no improvement is possible, return { "searchTerm": "", "reason": "개선 불가" }`;

    const userPrompt = JSON.stringify({
      userAddress: {
        fullAddress: address.fullAddress,
        dong: address.dong || '',
        ho: address.ho || '',
        buildingName: (address as any).buildingName || '',
      },
      currentSearch: currentSearchTerm,
      totalPages,
      firstPageSamples: simplifiedResults,
    });

    const result = await this.generateJson(systemInstruction, userPrompt);

    if (result?.searchTerm) {
      console.log(`  [Gemini] 추천 검색어: "${result.searchTerm}" (${result.reason})`);
      return result;
    }

    return null;
  }

  /**
   * 등기부등본 PIN 검색 결과에서 최적 매칭 선택
   *
   * 사용 시점: 동/호 정규식 매칭 실패 후, 1페이지 결과 중에서 AI로 최적 선택
   */
  async selectRegistryPin(
    address: ParsedAddress,
    resultList: any[]
  ): Promise<{ selectedIndex: number; pin: string; reason: string } | null> {
    console.log(`  [Gemini] 등기 PIN 선택 요청 (${resultList.length}건)...`);

    const simplifiedResults = resultList.slice(0, 10).map((item: any, i: number) => ({
      index: i,
      pin: item.pin || '',
      name: item.buld_name || '',
      dong: item.buld_no_buld || '',
      room: item.buld_no_room || '',
      type: item.real_cls_cd || '',
      address: (item.real_indi_cont || '').replace(/<[^>]+>/g, '').substring(0, 80),
    }));

    const systemInstruction = `You are a Korean real estate registry matching expert.
The user wants a specific apartment unit's registry. Select the most accurate match from the search results.

Matching rules:
- Match 동(dong) number exactly: user's "106동" should match dong="106"
- Match 호(ho/room) number exactly: user's "1506호" should match room="1506"
- Prefer type="집합건물" (apartment unit) over "토지"(land) or "건물"(building)
- If the user specified a building name, match it too

Return JSON: { "selectedIndex": <number>, "pin": "<pin value>", "reason": "<brief Korean explanation>" }
If no match, return { "selectedIndex": -1, "pin": "", "reason": "매칭 불가" }`;

    const userPrompt = JSON.stringify({
      userAddress: {
        fullAddress: address.fullAddress,
        dong: address.dong || '',
        ho: address.ho || '',
        buildingName: (address as any).buildingName || '',
      },
      results: simplifiedResults,
    });

    const result = await this.generateJson(systemInstruction, userPrompt);

    if (result && typeof result.selectedIndex === 'number' && result.selectedIndex >= 0) {
      console.log(`  [Gemini] PIN 선택: [${result.selectedIndex}] ${result.pin} (${result.reason})`);
      return result;
    }

    return null;
  }
}
