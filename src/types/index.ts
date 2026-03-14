/**
 * 문서 타입
 */
export enum DocumentType {
  REGISTRY = '등기부등본',
  BUILDING = '건축물대장',
  ALL = '전체'
}

/**
 * 요청 상태
 */
export enum QueryStatus {
  PENDING = 'pending',
  PROCESSING = 'processing',
  COMPLETED = 'completed',
  FAILED = 'failed'
}

/**
 * 파싱된 주소 정보
 */
export interface ParsedAddress {
  sido: string;        // 시/도
  sigungu: string;     // 시/군/구
  eupmyeondong: string; // 읍/면/동 (도로명일 경우 도로명)
  jibun: string;       // 번지 (도로명일 경우 건물번호)
  isRoadAddress: boolean; // 도로명주소 여부
  buildingName?: string; // 건물명
  dong?: string;       // 동
  ho?: string;         // 호
  fullAddress: string; // 전체 주소
}

/**
 * 조회 요청
 */
export interface QueryRequest {
  id: string;
  slackUserId: string;
  slackChannelId: string;
  rawInput: string;
  parsedAddress?: ParsedAddress;
  docType: DocumentType;
  status: QueryStatus;
  fileUrls: string[];
  cost: number;
  createdAt: Date;
  completedAt?: Date;
  errorMessage?: string;
}
