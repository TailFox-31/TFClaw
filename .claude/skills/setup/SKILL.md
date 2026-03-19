---
name: setup
description: Run initial NanoClaw setup for the current Discord-only, host-process architecture.
---

# NanoClaw Setup

설치는 `bash setup.sh`로 부트스트랩하고, 나머지는 `npm run setup -- --step <name>`으로 진행합니다. 현재 기준 채널은 디스코드만 지원합니다.

## 1. 부트스트랩

```bash
bash setup.sh
```

- Node 20 이상과 의존성이 준비되어야 합니다.
- 실패하면 `logs/setup.log`를 먼저 봅니다.

## 2. 현재 상태 확인

```bash
npm run setup -- --step environment
```

여기서 확인할 것:

- `.env` 존재 여부
- 기존 등록 그룹 존재 여부
- 이미 초기화된 설치인지 여부

## 3. 필수 환경 변수

`.env`에 최소한 아래 값이 있어야 합니다.

```bash
DISCORD_BOT_TOKEN=...
CLAUDE_CODE_OAUTH_TOKEN=...   # 또는 ANTHROPIC_API_KEY=...
```

선택:

```bash
OPENAI_API_KEY=...            # Codex 사용 시
CODEX_OPENAI_API_KEY=...      # Codex 전용 키를 따로 쓸 때
GROQ_API_KEY=...              # Discord 음성 전사
```

## 4. 러너 빌드

```bash
npm run setup -- --step runners
```

이 단계는 아래 두 러너를 빌드합니다.

- `runners/agent-runner`
- `runners/codex-runner`

실패하면 보통 `npm run build:runners` 출력과 각 러너의 `package.json` 의존성을 같이 보면 됩니다.

## 5. 디스코드 채널 등록

먼저 디스코드에서 개발자 모드를 켜고 채널 ID를 복사합니다. 등록 JID는 `dc:<channel_id>` 형식입니다.

메인 채널 예시:

```bash
npm run setup -- --step register -- \
  --jid dc:123456789012345678 \
  --name "My Server #general" \
  --folder discord_main \
  --trigger @Andy \
  --is-main \
  --no-trigger-required
```

보조 채널 예시:

```bash
npm run setup -- --step register -- \
  --jid dc:123456789012345678 \
  --name "My Server #ops" \
  --folder discord_ops \
  --trigger @Andy
```

## 6. 서비스 시작

```bash
npm run setup -- --step service
```

- macOS는 `launchd`
- Linux는 `systemd` 또는 fallback wrapper

## 7. 최종 검증

```bash
npm run setup -- --step verify
```

성공 기준:

- 서비스가 running
- Claude 인증이 configured
- `CHANNEL_AUTH`에 `discord`
- 등록 그룹 수가 1 이상

## 빠른 문제 해결

- 빌드 문제: `npm run typecheck`, `npm test`, `npm run build:runners`
- 서비스 문제: `logs/nanoclaw.error.log`
- 디스코드 연결 문제: `.env`의 `DISCORD_BOT_TOKEN`과 등록된 `dc:*` JID 확인
- 응답 문제: `tail -f logs/nanoclaw.log`
