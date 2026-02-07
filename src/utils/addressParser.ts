import { ParsedAddress } from '../types';

/**
 * 자연어 주소를 파싱하여 구조화된 주소 정보로 변환
 * 예: "서울시 중랑구 중화동 450 중화한신아파트 103동 904호"
 */
export function parseAddress(rawAddress: string): ParsedAddress | null {
  try {
    // 공백 기준으로 분리
    const parts = rawAddress.trim().split(/\s+/);

    if (parts.length < 3) {
      return null;
    }

    // 기본 파싱 (MVP용 간단한 구현)
    const sido = parts[0].replace(/(특별시|광역시|시|도)$/, '$&');
    const sigungu = parts[1];
    const eupmyeondong = parts[2];
    const jibun = parts[3] || '';

    // 건물명, 동, 호 추출 (선택적)
    let buildingName: string | undefined;
    let dong: string | undefined;
    let ho: string | undefined;

    for (let i = 4; i < parts.length; i++) {
      const part = parts[i];
      if (part.match(/\d+동$/)) {
        dong = part;
      } else if (part.match(/\d+호$/)) {
        ho = part;
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
