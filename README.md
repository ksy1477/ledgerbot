# 슬랙 연동 등기부등본·건축물대장 자동출력 도구

공인중개사를 위한 슬랙 봇 - 명령어 한 줄로 등기부등본과 건축물대장을 자동 조회·출력합니다.

## 📋 프로젝트 개요

슬랙 채널에서 간단한 명령어로 부동산 문서를 즉시 조회할 수 있는 자동화 도구입니다.
- **목표**: 문서 조회 시간을 3~5분에서 30초 이내로 단축
- **대상 사용자**: 슬랙을 사용하는 공인중개사 및 중개보조원

## 🚀 현재 개발 상태

**Phase 1 (MVP)** - 진행 중
- ✅ 프로젝트 초기 설정 완료
- ✅ 슬랙 봇 기본 구조
- ✅ 주소 파싱 기능
- ✅ `/등기` 명령어 (Mock)
- 🔲 실제 등기소 API 연동
- 🔲 에러 핸들링 강화

**Phase 2** - 예정
- 🔲 건축물대장 조회
- 🔲 `/전체` 명령어 (동시 조회)
- 🔲 조회 이력 관리

## 🛠️ 기술 스택

- **언어**: TypeScript
- **프레임워크**: Node.js
- **슬랙 SDK**: @slack/bolt
- **기타**: dotenv, axios, uuid

## 📦 설치 방법

### 1. 의존성 설치

```bash
npm install
```

### 2. 환경 변수 설정

`.env.example` 파일을 복사하여 `.env` 파일을 생성합니다:

```bash
cp .env.example .env
```

`.env` 파일에 슬랙 앱 정보를 입력합니다:

```env
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_SIGNING_SECRET=your-signing-secret
SLACK_APP_TOKEN=xapp-your-app-token
PORT=3000
```

### 3. 슬랙 앱 설정

1. [Slack API 사이트](https://api.slack.com/apps)에서 새 앱 생성
2. **Socket Mode** 활성화
3. **Bot Token Scopes** 권한 추가:
   - `commands` - 슬래시 명령어 사용
   - `chat:write` - 메시지 전송
   - `files:write` - 파일 업로드
4. **Slash Commands** 생성:
   - `/등기`
   - `/건축물`
   - `/전체`
5. 워크스페이스에 앱 설치
6. 토큰 정보를 `.env`에 입력

## 🏃 실행 방법

### 개발 모드 (hot reload)

```bash
npm run dev
```

### 프로덕션 빌드 및 실행

```bash
npm run build
npm start
```

## 📖 사용법

슬랙 채널에서 다음 명령어를 사용합니다:

### 등기부등본 조회

```
/등기 서울시 중랑구 중화동 450 중화한신아파트 103동 904호
```

### 건축물대장 조회 (Phase 2 예정)

```
/건축물 서울시 중랑구 중화동 450 중화한신아파트 103동 904호
```

### 전체 조회 (Phase 2 예정)

```
/전체 서울시 중랑구 중화동 450 중화한신아파트 103동 904호
```

## 📁 프로젝트 구조

```
slack-realestate-bot/
├── src/
│   ├── app.ts              # 앱 진입점
│   ├── handlers/           # 명령어 핸들러
│   │   └── commandHandler.ts
│   ├── services/           # 비즈니스 로직
│   │   └── registryService.ts
│   ├── utils/              # 유틸리티 함수
│   │   └── addressParser.ts
│   └── types/              # TypeScript 타입 정의
│       └── index.ts
├── temp/                   # 임시 PDF 파일 저장소
├── .env                    # 환경 변수 (git 제외)
├── .env.example            # 환경 변수 템플릿
├── tsconfig.json           # TypeScript 설정
└── package.json            # 프로젝트 메타데이터

```

## 🔧 다음 단계

### MVP 완성을 위한 작업

1. **실제 등기소 API 연동**
   - 대법원 인터넷등기소 API 또는 서드파티 API (틸로, 바로빌) 연동
   - API 키 발급 및 테스트

2. **주소 파싱 개선**
   - 도로명 주소 지원
   - Juso API 연동 고려

3. **에러 핸들링 강화**
   - 다양한 예외 상황 처리
   - 사용자 친화적인 에러 메시지

4. **로깅 및 모니터링**
   - 조회 이력 로깅
   - 성공/실패 통계

## ⚠️ 주의사항

- **현재 버전은 MVP 개발 단계**로, Mock 데이터를 사용합니다.
- 실제 등기소 API 연동 전까지는 테스트용 파일만 생성됩니다.
- 개인정보 보호를 위해 지정된 채널에서만 사용하도록 설정하세요.

## 📄 라이선스

ISC

## 👥 문의

프로젝트 관련 문의사항이 있으시면 이슈를 등록해주세요.
