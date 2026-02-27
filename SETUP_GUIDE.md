# 슬랙 앱 설정 가이드

슬랙 봇을 실행하기 위해 필요한 슬랙 앱 설정 방법을 단계별로 안내합니다.

## 1. 슬랙 앱 생성

1. [Slack API 사이트](https://api.slack.com/apps)에 접속
2. **"Create New App"** 클릭
3. **"From scratch"** 선택
4. 앱 이름 입력 (예: "부동산 조회 봇")
5. 워크스페이스 선택
6. **"Create App"** 클릭

## 2. Socket Mode 활성화

Socket Mode를 사용하면 외부 서버 없이 로컬에서 봇을 테스트할 수 있습니다.

1. 좌측 메뉴에서 **"Socket Mode"** 클릭
2. **"Enable Socket Mode"** 토글 켜기
3. 토큰 이름 입력 (예: "app-token")
4. **"Generate"** 클릭
5. 생성된 `xapp-...` 토큰 복사 → `.env` 파일의 `SLACK_APP_TOKEN`에 저장

## 3. Bot Token 권한 설정

1. 좌측 메뉴에서 **"OAuth & Permissions"** 클릭
2. **"Scopes"** → **"Bot Token Scopes"** 섹션으로 이동
3. 다음 권한 추가:
   - `commands` - 슬래시 명령어 사용
   - `chat:write` - 메시지 전송
   - `files:write` - 파일 업로드
   - `channels:read` - 채널 정보 읽기 (선택)
   - `groups:read` - 비공개 채널 정보 읽기 (선택)

## 4. 워크스페이스에 앱 설치

1. **"OAuth & Permissions"** 페이지 상단에서
2. **"Install to Workspace"** 클릭
3. 권한 확인 후 **"허용"** 클릭
4. 생성된 `xoxb-...` 토큰 복사 → `.env` 파일의 `SLACK_BOT_TOKEN`에 저장

## 5. Slash Commands 생성

1. 좌측 메뉴에서 **"Slash Commands"** 클릭
2. **"Create New Command"** 클릭

### `/등기` 명령어 생성

- **Command**: `/등기`
- **Request URL**: `https://slack.com` (Socket Mode에서는 무시됨)
- **Short Description**: `등기부등본 조회`
- **Usage Hint**: `[주소]`
- **"Save"** 클릭

### `/건축물` 명령어 생성

- **Command**: `/건축물`
- **Request URL**: `https://slack.com`
- **Short Description**: `건축물대장 조회`
- **Usage Hint**: `[주소]`
- **"Save"** 클릭

### `/전체` 명령어 생성

- **Command**: `/전체`
- **Request URL**: `https://slack.com`
- **Short Description**: `등기부등본 + 건축물대장 동시 조회`
- **Usage Hint**: `[주소]`
- **"Save"** 클릭

## 6. Signing Secret 확인

1. 좌측 메뉴에서 **"Basic Information"** 클릭
2. **"App Credentials"** 섹션에서
3. **"Signing Secret"** 값 복사 → `.env` 파일의 `SLACK_SIGNING_SECRET`에 저장

## 7. 환경 변수 최종 확인

`.env` 파일이 다음과 같이 설정되어 있는지 확인:

```env
SLACK_BOT_TOKEN=<your-bot-token>
SLACK_SIGNING_SECRET=<your-signing-secret>
SLACK_APP_TOKEN=<your-app-token>
PORT=3000
NODE_ENV=development
```

## 8. 봇 테스트

1. 터미널에서 `npm run dev` 실행
2. 슬랙 워크스페이스에서 봇을 채널에 추가:
   - 채널에서 `@부동산 조회 봇` 멘션
   - 또는 채널 설정 → "통합" → 봇 추가
3. 테스트 명령어 입력:
   ```
   /등기 서울시 중랑구 중화동 450 중화한신아파트 103동 904호
   ```
4. 봇이 "🔍 조회 중입니다..." 메시지와 함께 파일을 업로드하는지 확인

## 문제 해결

### "dispatch_failed" 에러

- Socket Mode가 활성화되어 있는지 확인
- `SLACK_APP_TOKEN`이 올바르게 설정되어 있는지 확인

### "not_authed" 에러

- `SLACK_BOT_TOKEN`이 올바른지 확인
- 앱이 워크스페이스에 설치되어 있는지 확인

### 명령어가 나타나지 않음

- Slash Commands가 생성되어 있는지 확인
- 앱을 재설치해보기

### 파일 업로드 실패

- Bot Token Scopes에 `files:write` 권한이 있는지 확인
- 봇이 해당 채널에 추가되어 있는지 확인

## 프로덕션 배포 시

프로덕션 환경에서는 Socket Mode 대신 HTTP 방식을 권장합니다:

1. **Socket Mode 비활성화**
2. **Request URL** 설정 (실제 서버 엔드포인트)
3. `src/app.ts`에서 `socketMode: false` 설정
4. 방화벽 및 HTTPS 인증서 설정

---

설정 완료 후 본격적인 개발을 시작하세요! 🚀
