# 틸코(Tilko) API 연동 가이드

## 📋 개요

틸코는 대법원 인터넷등기소 데이터를 API로 제공하는 서비스입니다.
포인트 선불 충전 방식으로 사용한 만큼만 결제하며, 초기 비용이 없습니다.

## 1️⃣ 회원가입 및 API 키 발급

### 단계별 가이드

1. **[틸코 홈페이지](https://tilko.net/) 접속**

2. **회원가입**
   - 우측 상단 "회원가입" 클릭
   - 필요 정보 입력
   - **가입 즉시 10,000 포인트 무료 제공** 🎉

3. **로그인**

4. **API 키 발급**
   - 마이페이지 → API 관리
   - 새 API 키 생성
   - API-KEY 복사하여 안전하게 보관

5. **포인트 충전** (필요 시)
   - 50만원 충전 → 5% 추가 포인트
   - 500만원 충전 → 10% 추가 포인트

## 2️⃣ 프로젝트 설정

### 환경 변수 설정

`.env` 파일을 열고 다음 항목을 업데이트하세요:

```env
# Tilko API 설정
TILKO_API_KEY=여기에-발급받은-API-키-입력
TILKO_AES_KEY=abcdef0123456789  # 16자리 임의의 문자열
TILKO_AES_IV=0123456789abcdef   # 16자리 임의의 문자열
USE_MOCK_API=false               # false로 변경하여 실제 API 사용
```

**보안 주의:**
- `TILKO_AES_KEY`와 `TILKO_AES_IV`는 16자리 임의의 문자열을 사용하세요
- 절대 GitHub 등에 올리지 마세요 (`.gitignore`에 `.env` 포함되어 있음)

### API 모드 전환

- `USE_MOCK_API=true` → 🧪 Mock 데이터 (테스트용)
- `USE_MOCK_API=false` → 🔗 Tilko 실제 API (포인트 차감)

## 3️⃣ API 사용 방법

### 등기부등본 조회 프로세스

1. **주소로 부동산 검색** → 고유번호(UniqueNo) 획득
2. **고유번호로 등기부등본 조회** → TransactionKey 획득
3. **TransactionKey로 PDF 발급** (1시간 이내)

### API 엔드포인트

| 기능 | 엔드포인트 | 메소드 |
|------|-----------|--------|
| 주소 검색 | `/api/v1.0/iros/risusearch` | POST |
| 등기부등본 조회 | `/api/v1.0/iros/risuretrieve` | POST |
| PDF 발급 | `/api/v1.0/iros/getpdffile` | POST |

**Base URL**: `https://api.tilko.net`

## 4️⃣ 보안 및 암호화

### AES-CBC-128 암호화

모든 요청 데이터는 AES-CBC-128로 암호화해야 합니다.

```javascript
// 예시 (코드에 이미 구현되어 있음)
const cipher = crypto.createCipheriv('aes-128-cbc', aesKey, aesIv);
let encrypted = cipher.update(plaintext, 'utf8', 'base64');
encrypted += cipher.final('base64');
```

### RSA 키 교환

- AES 키를 틸코의 공개키로 RSA 암호화
- `ENC-KEY` 헤더에 포함하여 전송

**TODO**: 틸코로부터 RSA 공개키를 받아야 합니다.

## 5️⃣ 가격 정보

### 포인트 시스템

- **건당 차감 방식** (성공한 조회에만 포인트 차감)
- 초기 비용 없음
- 유지보수 비용 없음

### 충전 혜택

| 충전 금액 | 추가 포인트 |
|----------|-----------|
| 50만원 | +5% |
| 500만원 | +10% |

**참고**: 구체적인 건당 요금은 [help@tilko.net](mailto:help@tilko.net)으로 문의하세요.

## 6️⃣ 구현 체크리스트

### 완료 ✅
- [x] Tilko API 서비스 클래스 생성
- [x] AES 암호화/복호화 구현
- [x] Mock/실제 API 전환 시스템
- [x] 기본 에러 핸들링

### 작업 필요 🔲
- [ ] 틸코 회원가입 및 API 키 발급
- [ ] 틸코로부터 RSA 공개키 받기
- [ ] RSA 암호화 구현 완성
- [ ] 실제 API 요청/응답 포맷 확인
- [ ] `searchProperty()` 실제 구현
- [ ] `retrieveRegistry()` 실제 구현
- [ ] `getPdf()` 실제 구현
- [ ] 실제 API 테스트
- [ ] 에러 케이스 처리 (잔액 부족, 검색 실패 등)

## 7️⃣ 테스트 방법

### Mock API 테스트 (현재)

```bash
# .env에서 USE_MOCK_API=true 확인
npm run dev
```

슬랙에서:
```
/등기 서울시 중랑구 중화동 450
```

### 실제 Tilko API 테스트

1. ✅ 틸코 회원가입 완료
2. ✅ API 키 발급
3. ✅ `.env`에 키 설정
4. ✅ RSA 공개키 구현
5. ✅ `USE_MOCK_API=false` 설정
6. 🚀 봇 재시작 후 테스트

## 8️⃣ API 문서 및 지원

### 공식 문서

- **API 문서**: [Tilko API 가이드](https://tilko.net/Help/Api/POST-api-apiVersion-Iros-RISURetrieve)
- **PDF 발급**: [GetPdfFile API](https://tilko.net/Help/Api/POST-api-apiVersion-Iros-GetPdfFile)

### 기술 지원

- **이메일**: help@tilko.net
- **홈페이지**: https://tilko.net

### 필요한 정보

API 키 발급 후 틸코에 문의할 사항:
1. RSA 공개키 (.pem 파일)
2. API 개발 가이드 문서
3. 샘플 코드 (Node.js)
4. 건당 요금 정보

## 9️⃣ 다음 단계

### 즉시 진행 가능

1. **[틸코 홈페이지](https://tilko.net/)에 회원가입**
2. **API 키 발급**
3. **`.env` 파일에 키 입력**
4. **help@tilko.net에 개발자 가이드 요청**

### 개발 완료 후

1. 실제 API 테스트
2. 에러 케이스 처리
3. 로깅 및 모니터링
4. 포인트 잔액 알림 기능

## 🆘 문제 해결

### API 키 에러

```
Error: Tilko API 키가 설정되지 않았습니다.
```

→ `.env` 파일의 `TILKO_API_KEY` 확인

### 암호화 에러

```
Error: Invalid key length
```

→ `TILKO_AES_KEY`와 `TILKO_AES_IV`가 정확히 16자인지 확인

### 포인트 부족

→ 틸코 홈페이지에서 포인트 충전

---

**업데이트**: 2025-02-07

**Sources:**
- [Tilko 등기부등본 조회 API](https://tilko.net/Help/Api/POST-api-apiVersion-Iros-RISURetrieve)
- [Tilko 가격 정책](https://tilko.net/Support/Detail/90)
- [Tilko 홈페이지](https://tilko.net/)
