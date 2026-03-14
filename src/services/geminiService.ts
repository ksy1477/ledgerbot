import axios from 'axios';
import { ParsedAddress } from '../types';

/**
 * Gemini API 서비스 - 건축물 주소 매칭 폴백
 *
 * 기존 정규식/스코어링 로직이 실패할 때만 호출
 * - BldRgstMst 결과 중 정확한 건물 선택
 * - BldRgstDtl 동 이름 매칭
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
}
