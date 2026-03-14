# 대법원 인터넷등기소 Open API 연동 가이드

## 📋 개요

이 문서는 대법원 인터넷등기소 Open API를 연동하는 방법을 안내합니다.

## 1️⃣ API 인증키 발급

### 단계별 가이드

1. **[등기정보광장](https://data.iros.go.kr/) 접속**

2. **회원가입**
   - 우측 상단 "회원가입" 클릭
   - 개인/법인 선택
   - 필요 정보 입력 및 인증

3. **로그인**

4. **Open API 신청**
   - 상단 메뉴 → "Open API" → "Open API 안내" 클릭
   - 또는 직접 [Open API 안내 페이지](https://data.iros.go.kr/rp/oa/openOapiIntro.do) 접속

5. **인증키 발급**
   - "Open API 신청 목록" 페이지로 이동
   - 필요한 API 서비스 선택
   - 인증키는 **별도 승인 절차 없이 즉시 발급**됩니다

6. **인증키 확인**
   - 마이페이지 → "Open API 이용내역"에서 확인
   - 인증키를 복사해두세요

## 2️⃣ 프로젝트 설정

### 환경 변수 설정

`.env` 파일을 열고 다음 항목을 업데이트하세요:

```env
# IROS API 설정
IROS_API_KEY=your-iros-api-key-here    # 발급받은 인증키 입력
IROS_API_URL=https://data.iros.go.kr
USE_MOCK_API=false                      # true → Mock, false → 실제 API
```

### API 모드 전환

- **Mock 모드** (`USE_MOCK_API=true`): 테스트용 가짜 데이터 사용
- **실제 API 모드** (`USE_MOCK_API=false`): 대법원 API 실제 호출

## 3️⃣ API 이용 제한

| 항목 | 제한 |
|------|------|
| **일일 호출 횟수** | 최대 1,000건 |
| **인증키 유효기간** | 24개월 |
| **자동 삭제 조건** | 3개월간 미사용 시 |

## 4️⃣ API 엔드포인트

### 등기부등본 조회 API

현재 `src/services/irosApiService.ts` 파일에 기본 구조가 구현되어 있습니다.

**TODO: 실제 API 엔드포인트 확인 필요**

대법원 등기정보광장의 API 문서를 참고하여 다음 정보를 확인해야 합니다:

1. **주소 검색 API**
   - 엔드포인트: `/api/search` (예시)
   - 파라미터: 시/도, 시/군/구, 읍/면/동, 번지
   - 응답: 부동산 고유번호(PNU)

2. **등기부등본 조회 API**
   - 엔드포인트: `/api/registry` (예시)
   - 파라미터: PNU, 문서 유형
   - 응답: 등기부등본 데이터 (XML/JSON)

3. **PDF 발급 API** (있다면)
   - 엔드포인트: `/api/pdf` (예시)
   - 파라미터: PNU
   - 응답: PDF 파일

## 5️⃣ 구현 체크리스트

### 완료 ✅
- [x] IROS API 서비스 클래스 생성
- [x] Mock/실제 API 전환 로직
- [x] 환경 변수 설정
- [x] 에러 핸들링 기본 구조

### 작업 필요 🔲
- [ ] 대법원 API 문서 확인
- [ ] 실제 엔드포인트 URL 확인
- [ ] 요청/응답 데이터 형식 확인
- [ ] `searchPropertyByAddress()` 함수 구현
- [ ] `getRegistryData()` 함수 구현
- [ ] PDF 생성 라이브러리 선택 및 구현
  - 옵션 1: `pdfkit` (Node.js PDF 생성)
  - 옵션 2: `puppeteer` (HTML → PDF 변환)
  - 옵션 3: API에서 PDF 직접 제공 시 다운로드
- [ ] 실제 API 테스트
- [ ] 에러 케이스 처리

## 6️⃣ 테스트 방법

### Mock API 테스트 (현재 상태)

```bash
# .env에서 USE_MOCK_API=true 확인
npm run dev
```

슬랙에서 테스트:
```
/등기 서울시 중랑구 중화동 450
```

### 실제 API 테스트

1. IROS API 키 발급 완료
2. `.env`에 키 입력
3. `USE_MOCK_API=false` 설정
4. 봇 재시작
5. 슬랙에서 테스트

## 7️⃣ 다음 단계

### API 문서 확인 후 작업

1. **등기정보광장 개발자 문서 읽기**
   - API 명세서 다운로드
   - 샘플 코드 확인

2. **실제 엔드포인트 구현**
   - `irosApiService.ts`의 TODO 부분 완성
   - 실제 API 호출 코드 작성

3. **응답 데이터 파싱**
   - XML/JSON 파싱
   - 필요한 정보 추출

4. **PDF 생성**
   - 적절한 라이브러리 선택
   - 템플릿 디자인

## 📚 참고 링크

- [등기정보광장](https://data.iros.go.kr/)
- [Open API 안내](https://data.iros.go.kr/rp/oa/openOapiIntro.do)
- [Open API 신청](https://data.iros.go.kr/rp/oa/openOapiAppl.do)

## 🆘 문제 해결

### 인증 실패

```
Error: IROS API 키가 설정되지 않았습니다.
```

→ `.env` 파일의 `IROS_API_KEY` 확인

### API 호출 실패

- 인증키가 유효한지 확인
- 하루 1,000건 한도 초과 여부 확인
- 네트워크 연결 확인

---

**업데이트**: 2025-02-07
