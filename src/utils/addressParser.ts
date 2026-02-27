import { ParsedAddress } from '../types';

/**
 * 자연어 주소를 파싱하여 구조화된 주소 정보로 변환
 *
 * 지원 패턴:
 *   "서울시 중랑구 중화동 450 103동 904호"         → 시도(1) 시군구(1) 읍면동 지번
 *   "경기도 수원시 영통구 망포동 686 108동 1305호"  → 시도(1) 시군구(2) 읍면동 지번
 *   "충남 천안시 서북구 쌍용동 100"                 → 시도(1) 시군구(2) 읍면동 지번
 */
export function parseAddress(rawAddress: string): ParsedAddress | null {
  try {
    const parts = rawAddress.trim().split(/\s+/);

    if (parts.length < 3) {
      return null;
    }

    let idx = 0;

    // 1) 시도
    const sido = parts[idx++];

    // 2) 시군구: "수원시 영통구", "성남시 분당구" 등 시+구 패턴 처리
    let sigungu = parts[idx++];
    // 다음 파트가 "~구"이고 현재 시군구가 "~시"로 끝나면 합치기
    if (idx < parts.length && /구$/.test(parts[idx]) && /시$/.test(sigungu)) {
      sigungu += ' ' + parts[idx++];
    }

    // 3) 읍면동
    const eupmyeondong = parts[idx++] || '';

    // 3-1) 중복 읍면동 스킵 (예: "철산동 철산동 55-1")
    if (idx < parts.length && parts[idx] === eupmyeondong) {
      idx++;
    }

    // 4) 지번 (숫자 또는 숫자-숫자 패턴)
    let jibun = '';
    if (idx < parts.length && /^\d+(-\d+)?$/.test(parts[idx])) {
      jibun = parts[idx++];
    }

    // 5) 나머지에서 건물명, 동, 호 추출
    let buildingName: string | undefined;
    let dong: string | undefined;
    let ho: string | undefined;

    for (let i = idx; i < parts.length; i++) {
      const part = parts[i];
      if (part.match(/\d+동$/)) {
        dong = part;
      } else if (part.match(/\d+호$/)) {
        ho = part;
      } else if (!jibun && /^\d+(-\d+)?$/.test(part)) {
        jibun = part;
      } else if (!buildingName) {
        buildingName = part;
      }
    }

    return {
      sido,
      sigungu,
      eupmyeondong,
      jibun,
      buildingName,
      dong,
      ho,
      fullAddress: rawAddress.trim()
    };
  } catch (error) {
    console.error('주소 파싱 실패:', error);
    return null;
  }
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
