# Ledgerbot 업데이트 내역

> 다른 프로젝트에도 적용 가능한 패턴과 솔루션 정리

---

## 1. JUSO API 주소 유효성 사전 검증 (포인트 낭비 방지)

**문제**: 사용자가 존재하지 않는 주소를 입력하면 유료 API(Tilko)가 호출되어 포인트가 낭비됨

**해결**: 유료 API 호출 전에 JUSO API(무료)로 주소가 실제 존재하는지 사전 검증

**적용 위치**: `commandHandler.ts` (등기/건축물/전체 핸들러 공통), `unifiedBuildingService.ts`

```typescript
// commandHandler.ts — 공통 검증 함수
async function validateAddressWithJuso(address: ParsedAddress): Promise<{
  valid: boolean;
  errorReason?: string;
}> {
  const jusoApiKey = process.env.JUSO_API_KEY;
  if (!jusoApiKey) return { valid: true }; // 키 없으면 검증 스킵

  const keyword = [address.sido, address.sigungu, address.eupmyeondong, address.jibun]
    .filter(Boolean).join(' ');

  const response = await axios.get('https://business.juso.go.kr/addrlink/addrLinkApi.do', {
    params: { confmKey: jusoApiKey, currentPage: 1, countPerPage: 10, keyword, resultType: 'json' },
    timeout: 10000,
  });

  const results = response.data?.results?.juso;
  if (!results || results.length === 0) {
    return { valid: false, errorReason: `"${keyword}" 주소를 찾을 수 없습니다.` };
  }
  return { valid: true };
}

// 핸들러에서 사용
const validation = await validateAddressWithJuso(parsedAddress);
if (!validation.valid) {
  await replyError(`❌ 유효하지 않은 주소입니다.\n${validation.errorReason}`);
  return;
}
```

**핵심 원칙**:
- API 키 미설정 / API 에러 / 네트워크 장애 시에는 검증을 **스킵** (기존 동작 유지)
- 검증 실패 시에만 차단 → 유료 API 호출 안 함

---

## 2. 도로명 주소 지원 (지번/도로명 양방향)

**문제**: 기존에는 지번 주소만 지원. 도로명 주소 입력 시 검색 실패

**해결**: 3단계 접근

### 2-1. 주소 파서에서 도로명 감지

```typescript
// addressParser.ts
const ROAD_PATTERN = /^[가-힣]+\d*[로길](\d+[번]?길)?$/;

// 파싱 시 도로명/지번 구분
if (EMD_PATTERN.test(token)) {
  eupmyeondong = token; // 지번
} else if (ROAD_PATTERN.test(token)) {
  eupmyeondong = token;
  isRoadAddress = true; // 도로명
  // 복합 도로명: "귀인로" + "79번길" → "귀인로79번길"
  if (idx < parts.length && /^\d+번?길$/.test(parts[idx])) {
    eupmyeondong += parts[idx]; idx++;
  }
}
```

### 2-2. API 호출 시 AddressType 전환

```typescript
// tilkoBuildingService.ts — BldRgstMst 호출
const requestData = {
  AddressType: address.isRoadAddress ? '1' : '0',  // 0=지번, 1=도로명
  QueryAddress: searchAddress
};
```

### 2-3. 도로명 검색 실패 시 JUSO API로 지번 변환 후 재검색

```typescript
// unifiedBuildingService.ts
if (!searchResult && address.isRoadAddress) {
  const lotAddress = await this.tilkoBuildingService.convertRoadToLotAddress(address);
  if (lotAddress) {
    searchResult = await this.tilkoBuildingService.searchBuildingInfo(lotAddress);
  }
}
```

```typescript
// tilkoBuildingService.ts — JUSO API로 도로명→지번 변환
async convertRoadToLotAddress(address: ParsedAddress): Promise<ParsedAddress | null> {
  // JUSO API 호출 → jibunAddr에서 읍면동 + 번지 추출
  // isRoadAddress: false로 변환하여 반환
}
```

---

## 3. Gemini AI Fallback (지능형 결과 선택)

**문제**: API가 여러 건물을 반환할 때 단순 스코어링으로는 정확한 건물 선택이 어려움

**해결**: Gemini API를 fallback으로 사용하여 지능적 선택

### 3-1. Gemini 서비스 구현

```typescript
// geminiService.ts
export class GeminiService {
  // REST API 직접 호출 (SDK 불필요), gemini-2.5-flash 모델
  // JSON mode (responseMimeType: "application/json"), temperature: 0.1
  // 15초 타임아웃, 실패 시 null 반환 (graceful degradation)

  async selectBuildingFromResults(address, resultList)
    → { selectedIndex: number; reason: string } | null

  async matchDongName(userDong, apiDongList)
    → { matchedDong: string; reason: string } | null
}
```

### 3-2. 적용 조건 (비용 효율)

```typescript
// Gemini는 무조건 호출하지 않음 — 스코어링 실패 시에만 사용
if (topScore < 20 && resultList.length > 1 && this.geminiService) {
  const geminiResult = await this.geminiService.selectBuildingFromResults(address, resultList);
  // geminiResult.selectedIndex === -1 이면 "해당 없음" → 기존 로직 유지
}
```

### 3-3. 결과에 Gemini 사용 표시

```typescript
// commandHandler.ts — Slack 메시지에 표시
const geminiText = result.geminiUsed
  ? '\n🤖 AI 보정을 통해 올바른 결과물이 추출되었습니다.' : '';
initial_comment: `✅ 건축물대장 발급 완료${geminiText}${balanceText}${userTag}`
```

---

## 4. 동 이름 정규화 매칭

**문제**: API 응답의 동 이름과 사용자 입력이 다른 형식 (예: "주동1" vs "101동")

**해결**: 다단계 정규화 비교

```typescript
const normalizeDong = (apiDong: string | null | undefined, userDong: string): boolean => {
  const apiKey = extractKey(apiDong || '');  // null 안전 처리
  const userKey = extractKey(userDong);

  if (apiKey === userKey) return true;

  // 숫자 suffix 비교: "주동1"(→1) ↔ "101동"(→101) — endsWith 매칭
  const apiNum = (apiDong || '').match(/(\d+)/);
  const userNum = userDong.match(/(\d+)/);
  if (apiNum && userNum) {
    if (userNum[1].endsWith(apiNum[1]) || apiNum[1].endsWith(userNum[1])) return true;
  }

  return false;
};
```

**주의**: `apiDong`이 `null`일 수 있음 → `(apiDong || '')` null guard 필수

---

## 5. Paramiko SSH 배포 (sshpass 대안)

**문제**: macOS에서 sshpass가 비밀번호 전달에 실패하는 경우

**해결**: Python paramiko 사용

```python
# deploy.py
import paramiko

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, username=USER, password=PASSWORD)

sftp = ssh.open_sftp()
for f in FILES:
    sftp.put(local_path, remote_path)
sftp.close()

stdin, stdout, stderr = ssh.exec_command('pm2 restart appname')
ssh.close()
```

---

## 6. 공공데이터 API 주소코드 → 동별 PK 변환

**문제**: BldRgstMst가 숫자 PK 대신 주소코드(예: `11530_10700_0_0481_0000`)를 반환하면 BldRgstDtl 직접 호출 불가

**해결**: 공공데이터 API(무료)로 주소코드에서 sigunguCd/bjdongCd 추출 → 동별 표제부 PK 조회

```
BldRgstMst → 주소코드 (11530_10700_0_0481_0000)
  ↓ 파싱: sigunguCd=11530, bjdongCd=10700, bun=0481, ji=0000
공공데이터 API → 동별 표제부 PK (무료)
  ↓
BldRgstDtl → 동/호 매칭 (20pt)
```

---

## 적용 파일 요약

| 파일 | 역할 |
|------|------|
| `src/utils/addressParser.ts` | 도로명/지번 파싱, isRoadAddress 플래그 |
| `src/services/geminiService.ts` | Gemini AI 결과 선택 / 동 매칭 |
| `src/services/tilkoBuildingService.ts` | 핵심 API 호출, 스코어링, 정규화, 검증 |
| `src/services/unifiedBuildingService.ts` | 오케스트레이션, fallback 체인 |
| `src/handlers/commandHandler.ts` | Slack 핸들러, 주소 사전 검증, 결과 표시 |
| `src/types/index.ts` | ParsedAddress 인터페이스 (isRoadAddress 포함) |
| `deploy.py` | Paramiko SSH 배포 스크립트 |

---

## 환경 변수

```env
# 필수
TILKO_API_KEY=         # Tilko API 키
TILKO_AES_KEY=         # Tilko AES 암호화 키 (16자)
EAIS_USER_ID=          # 세움터 아이디
EAIS_USER_PASSWORD=    # 세움터 비밀번호

# 무료 API (강력 권장)
JUSO_API_KEY=          # 주소정보 API 키 (주소 검증 + 도로명→지번 변환)
PUBLIC_DATA_API_KEY=   # 공공데이터 API 키 (주소코드→PK 변환)

# 선택
GEMINI_API_KEY=        # Gemini AI fallback (없으면 스코어링만 사용)
```
