import { ParsedAddress } from '../types';

/**
 * 시도 약칭 → 표준 명칭 매핑
 */
const SIDO_ALIASES: { [key: string]: string } = {
  '서울': '서울시', '서울특별시': '서울시',
  '부산': '부산시', '부산광역시': '부산시',
  '대구': '대구시', '대구광역시': '대구시',
  '인천': '인천시', '인천광역시': '인천시',
  '광주': '광주시', '광주광역시': '광주시',
  '대전': '대전시', '대전광역시': '대전시',
  '울산': '울산시', '울산광역시': '울산시',
  '세종': '세종시', '세종특별자치시': '세종시',
  '경기': '경기도',
  '강원': '강원도', '강원특별자치도': '강원도',
  '충북': '충청북도', '충북도': '충청북도',
  '충남': '충청남도', '충남도': '충청남도',
  '전북': '전라북도', '전북도': '전라북도', '전북특별자치도': '전라북도',
  '전남': '전라남도', '전남도': '전라남도',
  '경북': '경상북도', '경북도': '경상북도',
  '경남': '경상남도', '경남도': '경상남도',
  '제주': '제주도', '제주특별자치도': '제주도',
};

/**
 * 시도로 인식 가능한 모든 토큰 집합 (빠른 lookup)
 */
const SIDO_TOKENS = new Set([
  ...Object.keys(SIDO_ALIASES),
  // 이미 표준형인 것도 포함
  '서울시', '부산시', '대구시', '인천시', '광주시', '대전시', '울산시', '세종시',
  '경기도', '강원도', '충청북도', '충청남도', '전라북도', '전라남도', '경상북도', '경상남도', '제주도',
]);

/** 시도 정규화: 약칭 → 표준형 */
function normalizeSido(token: string): string | null {
  if (SIDO_ALIASES[token]) return SIDO_ALIASES[token];
  if (SIDO_TOKENS.has(token)) return token;
  return null;
}

/** 시군구 접미사 패턴 */
const SIGUNGU_SUFFIX = /[시군구]$/;

/** 읍면동 접미사 패턴 (한글 + 동/읍/면/리/가, "만리동2가" "충무로3가" 등 숫자가 포함된 경우도 허용) */
const EMD_PATTERN = /^[가-힣]+\d*[동읍면리가]$/;

/** 도로명 패턴 (한글 + 로/길, "봉은사로", "봉은사로114길", "테헤란로7길" 등) */
const ROAD_PATTERN = /^[가-힣]+\d*[로길](\d+[번]?길)?$/;

/** 지번 패턴: 숫자, 숫자-숫자 */
const JIBUN_PATTERN = /^\d+(-\d+)?$/;

/** 건물 동 패턴: "103동", "제103동", "B동", "가동" */
const BUILDING_DONG_PATTERN = /^(?:제?\d+|[A-Za-z]|[가-힣])동$/;

/** 호 패턴: "904호" */
const HO_PATTERN = /^\d+호$/;

/**
 * 입력 문자열 전처리
 *
 * 붙어쓰기, 접두/접미 정리 등을 통해 토큰 분리가 쉽도록 정규화
 */
function preprocess(input: string): string {
  let s = input.trim();

  // 1) 쉼표·중점·마침표 → 공백
  s = s.replace(/[,·.]/g, ' ');

  // 2) "450번지" → "450"
  s = s.replace(/(\d+(?:-\d+)?)번지/g, '$1');

  // 3) 지번 뒤 "외", "외 N필지" 등 부가 정보 제거: "55-1외 5필지" → "55-1"
  s = s.replace(/(\d+(?:-\d+)?)외/g, '$1');
  s = s.replace(/\d+필지/g, '');

  // 4) "제103동" → "103동", "제1702호" → "1702호"
  s = s.replace(/제(\d+동)/g, '$1');
  s = s.replace(/제(\d+호)/g, '$1');

  // 5) "제17층", "17층" 등 층 정보 제거 (동/호 매칭에 불필요)
  s = s.replace(/제?\d+층/g, '');

  // 6) 건물명+동 붙어쓰기 분리: "한신아파트103동" → "한신아파트 103동"
  //    단, "중화동" 같은 읍면동은 분리하지 않음 (한글 1자 + 동은 읍면동일 수 있음)
  s = s.replace(/([가-힣]{2,})((\d+)동)/g, (_, name, dong) => {
    return `${name} ${dong}`;
  });

  // 7) 동호 붙어쓰기 분리: "103동904호" → "103동 904호"
  s = s.replace(/(\d+동)(\d+호)/g, '$1 $2');

  // 8) 연속 공백 정리
  s = s.replace(/\s+/g, ' ').trim();

  return s;
}

/**
 * 자연어 주소를 파싱하여 구조화된 주소 정보로 변환
 *
 * 지원 패턴 (대강 적어도 인식):
 *   "서울시 중랑구 중화동 450 103동 904호"
 *   "서울 중랑구 중화동 450 103동904호"          (시도 약칭, 붙어쓰기)
 *   "경기도 수원시 영통구 망포동 686 108동 1305호" (시군구 2단계)
 *   "충남 천안시 서북구 쌍용동 100"
 *   "서울시 중랑구 중화동 450번지 제103동 904호"  (번지, 제 접두어)
 *   "서울시 중랑구 중화동 450 103-904"            (동-호 축약)
 *   "서울시 중랑구 중화동 450 B동 904호"          (영문 동)
 *   "중랑구 중화동 450 103동 904호"               (시도 생략)
 */
export function parseAddress(rawAddress: string): ParsedAddress | null {
  try {
    const input = preprocess(rawAddress);
    const parts = input.split(' ');

    if (parts.length < 2) {
      return null;
    }

    let idx = 0;

    // ── 1. 시도 ──
    let sido = '';
    const normalizedSido = normalizeSido(parts[idx]);
    if (normalizedSido) {
      sido = normalizedSido;
      idx++;
    }
    // 시도 없이 시군구부터 시작하는 경우도 허용 (예: "중랑구 중화동 450")

    if (idx >= parts.length) return null;

    // ── 2. 시군구 ──
    let sigungu = '';

    // 시도 없이 첫 토큰이 읍면동 패턴이면 시군구 건너뜀
    // 예: "중계동 502-1 108동 401호" → "중계동"은 읍면동
    const firstToken = parts[idx];
    const isFirstTokenEmd = EMD_PATTERN.test(firstToken) && !SIGUNGU_SUFFIX.test(firstToken);
    // "~동"이 시군구인 경우도 있음: "강동구" → 구로 끝남. "중계동" → 동으로 끝나고 구/시/군 아님
    // 단, 시도가 있으면 다음은 당연히 시군구
    if (!sido && isFirstTokenEmd) {
      // 시도도 없고 첫 토큰이 읍면동 → 시군구 생략된 것
      sigungu = '';
    } else {
      sigungu = parts[idx++];

      // "수원시 영통구", "천안시 서북구", "성남시 분당구" 등 시+구/군 합치기
      if (idx < parts.length && /시$/.test(sigungu) && /[구군]$/.test(parts[idx])) {
        sigungu += ' ' + parts[idx++];
      }

      // 시군구에 접미사 없이 축약된 경우 보정: "중랑" → "중랑구"
      // 다음 토큰이 읍면동(한글+동/읍/면 등)이면 현재 토큰은 시군구로 간주
      if (
        idx < parts.length &&
        !SIGUNGU_SUFFIX.test(sigungu) &&
        (EMD_PATTERN.test(parts[idx]) || ROAD_PATTERN.test(parts[idx]))
      ) {
        sigungu += '구';
      }
    }

    if (idx >= parts.length) return null;

    // ── 3. 읍면동 / 도로명 ──
    let eupmyeondong = '';
    let isRoadAddress = false;
    if (idx < parts.length) {
      const token = parts[idx];

      if (EMD_PATTERN.test(token)) {
        // 표준 읍면동
        eupmyeondong = token;
        idx++;
      } else if (ROAD_PATTERN.test(token)) {
        // 도로명 (예: "봉은사로", "귀인로")
        eupmyeondong = token;
        isRoadAddress = true;
        idx++;
        // 복합 도로명 처리: "귀인로" + "79번길" → "귀인로79번길"
        if (idx < parts.length && /^\d+번?길$/.test(parts[idx])) {
          eupmyeondong += parts[idx];
          idx++;
        }
      } else if (/^\d+동$/.test(token)) {
        // "103동" 같은 건물 동 → 읍면동이 아님, 건너뜀
      } else if (/^[가-힣]+$/.test(token) && !JIBUN_PATTERN.test(token)) {
        // 접미사 없는 한글 토큰 → 읍면동 축약으로 추정 (예: "중화")
        eupmyeondong = token;
        idx++;
      }
    }

    // 중복 읍면동 스킵 (예: "철산동 철산동 55-1")
    if (eupmyeondong && idx < parts.length && parts[idx] === eupmyeondong) {
      idx++;
    }

    // ── 4. 지번 ──
    let jibun = '';
    if (idx < parts.length && JIBUN_PATTERN.test(parts[idx])) {
      jibun = parts[idx++];
    }

    // ── 5. 나머지에서 건물명, 동, 호 추출 ──
    let buildingName: string | undefined;
    let dong: string | undefined;
    let ho: string | undefined;

    for (let i = idx; i < parts.length; i++) {
      const part = parts[i];

      if (BUILDING_DONG_PATTERN.test(part)) {
        // 건물 동: "103동", "B동", "가동"
        dong = part;
      } else if (HO_PATTERN.test(part)) {
        // 호: "904호"
        ho = part;
      } else if (jibun && /^\d+-\d+$/.test(part)) {
        // 동-호 축약: "103-904" (지번이 이미 잡힌 뒤에만)
        const [d, h] = part.split('-');
        dong = d + '동';
        ho = h + '호';
      } else if (!jibun && JIBUN_PATTERN.test(part)) {
        // 늦게 나타난 지번
        jibun = part;
      } else if (!buildingName) {
        buildingName = part;
      } else {
        // 건물명 복수 토큰 합치기: "중화 한신 아파트" → "중화한신아파트"
        buildingName += part;
      }
    }

    // ── 6. 폴백: 전체 문자열에서 동/호 정규식으로 재추출 ──
    // 토큰 기반으로 놓친 경우를 대비
    if (!dong) {
      const dongMatch = input.match(/(\d+)\s*동(?!\s*[가-힣])/);
      if (dongMatch) {
        dong = dongMatch[1] + '동';
      }
    }
    if (!ho) {
      const hoMatch = input.match(/(\d+)\s*호/);
      if (hoMatch) {
        ho = hoMatch[1] + '호';
      }
    }

    // ── 7. 최소 유효성 검증 ──
    // 시군구 또는 읍면동 중 하나는 있어야 유효한 주소
    if (!sigungu && !eupmyeondong) {
      return null;
    }

    return {
      sido,
      sigungu,
      eupmyeondong,
      jibun,
      isRoadAddress,
      buildingName,
      dong,
      ho,
      fullAddress: rawAddress.trim(),
    };
  } catch (error) {
    console.error('주소 파싱 실패:', error);
    return null;
  }
}

/**
 * 파싱 결과를 사람이 읽기 쉬운 형태로 요약
 * (에러 메시지에서 "이만큼 인식했다"를 보여줄 때 사용)
 */
export function summarizeParsed(parsed: ParsedAddress): string {
  const parts: string[] = [];
  if (parsed.sido) parts.push(`시도: ${parsed.sido}`);
  if (parsed.sigungu) parts.push(`시군구: ${parsed.sigungu}`);
  if (parsed.eupmyeondong) parts.push(`읍면동: ${parsed.eupmyeondong}`);
  if (parsed.jibun) parts.push(`지번: ${parsed.jibun}`);
  if (parsed.buildingName) parts.push(`건물명: ${parsed.buildingName}`);
  if (parsed.dong) parts.push(`동: ${parsed.dong}`);
  if (parsed.ho) parts.push(`호: ${parsed.ho}`);
  return parts.join(', ');
}

/**
 * 파일명 생성
 * 예: "등기부등본_중화동450_103동904호_20250207_143022.pdf"
 */
export function generateFileName(
  docType: string,
  address: ParsedAddress,
  timestamp: Date = new Date()
): string {
  const dateStr = timestamp.toISOString()
    .replace(/[-:]/g, '')
    .replace('T', '_')
    .split('.')[0];

  let addressPart = `${address.eupmyeondong}${address.jibun}`;
  if (address.dong && address.ho) {
    addressPart += `_${address.dong}${address.ho}`;
  } else if (address.buildingName) {
    addressPart += `_${address.buildingName}`;
  }

  return `${docType}_${addressPart}_${dateStr}.pdf`;
}
