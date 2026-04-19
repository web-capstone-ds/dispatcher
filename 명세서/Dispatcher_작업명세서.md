# Dispatcher 서버 작업명세서
## DS 비전 검사 장비 모바일 모니터링 프로젝트

> **레포지토리**: `web-capstone-ds / Dispatcher`
> **작성일**: 2026-04-19
> **작업 범위**: Dispatcher 서버 전체 (D1 ~ D5)
> **플랫폼**: Node.js 20 LTS / TypeScript 5.4 / strict mode
> **상태**: ✅ 완료

---

## 1. 개요

Local Area(공장 내부망)의 TimescaleDB에서 LOT 단위로 데이터를 **read-only 조회** → **비식별화 처리** → Online Area AI 서버로 **단방향 Push**하는 보안 데이터 게이트웨이 서버.

### 시스템에서의 위치

```
[Local Area — 공장 내부망]              [보안 경계]     [Online Area]
                                              │
 MQTT Broker                                  │
      ↓                                       │
 Historian 서버                               │
 (TimescaleDB 적재)                           │
      ↓                                       │
 Dispatcher 서버 ───── 단방향 Push ──────────▶│──▶ AI 서버
 (read-only 조회)                             │    (RAG/벡터DB)
                                              │
                              역방향 통신 절대 금지
```

### 핵심 설계 원칙

- **보안 경계 유지**: `historian_read` 계정 read-only 전용. 역방향 통신 금지
- **비식별화 필수**: 모든 식별자는 외부 전송 전 HMAC-SHA256 해시 또는 제거
- **LOT 단위 배치**: 실시간 스트리밍 없음. 1 LOT = 1 배치
- **데이터 병목 방지**: cursor 페이지네이션 500건/회, 지수 백오프 재시도

---

## 2. 프로젝트 구조

```
dispatcher/
├── src/
│   ├── anonymizer/
│   │   ├── config.ts          ← 비식별화 규칙 외부화
│   │   └── anonymizer.ts      ← HMAC-SHA256, operator_id 제거, 순번 대체
│   ├── db/
│   │   ├── pool.ts            ← pg-pool read-only 커넥션
│   │   └── queries.ts         ← LOT cursor 페이지네이션, 파일 기반 발송 추적
│   ├── push/
│   │   ├── aiClient.ts        ← undici 기반 AI Push + 백오프 재시도
│   │   └── deadLetter.ts      ← 6회 실패 시 dead_letter.jsonl 기록
│   ├── scheduler/
│   │   └── lotScheduler.ts    ← node-cron 1분 주기, 6단계 파이프라인
│   ├── types/
│   │   └── index.ts           ← 전체 TypeScript 인터페이스
│   ├── utils/
│   │   └── logger.ts          ← pino 구조적 로깅
│   └── index.ts               ← 진입점 (환경변수 검증 → DB → 스케줄러)
├── tests/
│   └── anonymizer.test.ts     ← vitest 단위 테스트 7개
├── package.json
├── tsconfig.json
├── .env.example
├── sent_lots.jsonl            ← 발송 완료 LOT 추적 파일 (런타임 생성)
└── dead_letter.jsonl          ← Push 실패 LOT 기록 파일 (런타임 생성)
```

---

## 3. 기술 스택

| 패키지 | 버전 | 용도 |
| :--- | :--- | :--- |
| `pg` | ^8.11.5 | PostgreSQL / TimescaleDB 클라이언트 |
| `undici` | ^6.13.0 | HTTP 클라이언트 (AbortController 내장) |
| `node-cron` | ^3.0.3 | LOT 배치 스케줄러 |
| `pino` | ^9.1.0 | 구조적 JSON 로깅 |
| `dotenv` | ^16.4.5 | 환경변수 로드 |
| `typescript` | ^5.4.5 | strict mode 컴파일러 |
| `vitest` | ^1.5.0 | 단위 테스트 |
| `tsx` | ^4.7.2 | 개발 실행 |

---

## 4. 환경변수 명세 (.env.example)

| 환경변수 | 기본값 | 필수 | 설명 |
| :--- | :--- | :--- | :--- |
| `DB_HOST` | localhost | ✅ | TimescaleDB 호스트 |
| `DB_PORT` | 5432 | | DB 포트 |
| `DB_NAME` | historian | | DB 이름 |
| `DB_USER` | historian_read | ✅ | **read-only 계정 필수** |
| `DB_PASSWORD` | — | ✅ | DB 비밀번호 |
| `DB_STATEMENT_TIMEOUT_MS` | 30000 | | 쿼리 타임아웃 (ms) |
| `DB_POOL_MAX` | 5 | | 최대 커넥션 수 |
| `AI_SERVER_URL` | — | ✅ | AI 서버 Push 엔드포인트 |
| `AI_SERVER_API_KEY` | — | | API 인증키 |
| `AI_REQUEST_TIMEOUT_MS` | 10000 | | HTTP 요청 타임아웃 (ms) |
| `HMAC_SECRET` | — | ✅ | 비식별화 HMAC 키 (32자 이상 권장) |
| `DEAD_LETTER_PATH` | ./dead_letter.jsonl | | Push 실패 기록 파일 경로 |
| `SENT_LOTS_PATH` | ./sent_lots.jsonl | | 발송 완료 추적 파일 경로 |
| `BATCH_PAGE_SIZE` | 500 | | cursor 페이지 크기 |
| `BACKOFF_STEPS_SEC` | 1,2,5,15,30,60 | | 백오프 수열 (초, 쉼표 구분) |
| `BACKOFF_MAX_ATTEMPTS` | 6 | | 최대 재시도 횟수 |
| `LOG_LEVEL` | info | | 로그 레벨 |

---

## 5. 컴포넌트별 구현 명세

### 5.1 anonymizer (D2) — 보안 핵심 컴포넌트

이 모듈을 통과하지 않은 데이터는 AI 서버로 전송되지 않는다.

**비식별화 4규칙** (`anonymizer/config.ts`)

| 필드 | 처리 방식 | 결과 |
| :--- | :--- | :--- |
| `equipment_id` | HMAC-SHA256 해시 | `equipmentHash` 필드로 치환 |
| `operator_id` | 완전 제거 | 키 자체 `delete` — null 치환 금지 |
| `lot_id` | HMAC-SHA256 해시 | `lotHash` 필드로 치환 |
| `strip_id` | LOT 내 순번 대체 | 1, 2, 3... (Map 기반 일관성 보장) |
| `unit_id` | LOT 내 순번 대체 | 1, 2, 3... (Map 기반 일관성 보장) |

**구현 특이사항**

- `HMAC_SECRET`은 **모듈 로드 시점**에 검증. 미설정 시 서버 시작 자체 실패
- 같은 `lot_id` → 항상 같은 해시 보장 (참조 무결성 유지)
- `vi.hoisted()`로 테스트 환경 환경변수 선행 설정 처리

**테스트 케이스 (vitest 7개)**

```
✅ operator_id 필드가 결과 객체에 존재하지 않아야 한다
✅ 동일 equipment_id는 동일 해시를 반환해야 한다
✅ 동일 lot_id는 동일 해시를 반환해야 한다
✅ strip_id는 LOT 내 순번(1부터)으로 대체되어야 한다
✅ unit_id는 LOT 내 순번(1부터)으로 대체되어야 한다
✅ HMAC_SECRET 미설정 시 즉시 에러를 던져야 한다
✅ 원본 lot_id와 해시된 lot_id가 다른지 확인
```

---

### 5.2 db/pool.ts (D3) — read-only 커넥션 풀

| 설정 항목 | 값 | 목적 |
| :--- | :--- | :--- |
| `options` | `--default_transaction_read_only=on` | DB 레벨에서 쓰기 트랜잭션 차단 |
| `statement_timeout` | 30,000ms | 장시간 쿼리 방지 |
| `pool.on('error')` | 핸들러 등록 | 미처리 예외 방지 |
| `validateConnection()` | 시작 시 `SELECT 1` | 연결 상태 사전 검증 |

---

### 5.3 db/queries.ts (D3) — LOT 조회 + 발송 추적

**cursor 페이지네이션**

```
1 LOT 최대 2,792건 → 500건/회 분할 조회
AsyncGenerator 패턴 → 메모리 효율적 스트리밍
connect() → 루프 전체에 1개 커넥션 유지 → finally에서 release()
```

**파일 기반 발송 추적** (`sent_lots.jsonl`)

DB read-only 제약으로 `dispatch_log` UPDATE 불가 → 로컬 파일로 대체.

```jsonl
{"lotHash":"abc123...","dispatchedAt":"2026-04-19T10:00:00.000Z"}
{"lotHash":"def456...","dispatchedAt":"2026-04-19T10:01:00.000Z"}
```

`fetchPendingLots()` 흐름:
1. `sent_lots.jsonl`에서 발송 완료 `lotHash` Set 로드
2. `lot_end` 테이블 전체 조회 (`ORDER BY created_at ASC`)
3. `hmacSha256(lot_id)` 해시가 Set에 없는 항목만 반환

---

### 5.4 push/aiClient.ts (D4) — AI 서버 Push + 백오프

**재시도 백오프 수열** (GEMINI.md §1.2 기준)

| 시도 | 대기 시간 | Jitter |
| :--- | :--- | :--- |
| 1회 | 1s | ±20% |
| 2회 | 2s | ±20% |
| 3회 | 5s | ±20% |
| 4회 | 15s | ±20% |
| 5회 | 30s | ±20% |
| 6회 (최대) | 60s | ±20% |

**처리 규칙**

- `AbortController` + `setTimeout` 조합으로 HTTP 타임아웃 구현
- 성공·실패 모든 경로에서 `clearTimeout()` 호출
- **4xx 응답**: 재시도 없이 즉시 `PushResult` 반환 (클라이언트 오류)
- **5xx 응답**: 백오프 후 재시도
- **AI 응답 body 파싱 금지** — `res.ok` 상태코드 확인만 수행 (단방향 Push 원칙)

---

### 5.5 push/deadLetter.ts (D4) — Dead Letter 기록

6회 Push 실패 시 `dead_letter.jsonl`에 JSONL 형식으로 append.

```jsonl
{
  "failedAt": "2026-04-19T10:05:00.000Z",
  "batchId": "uuid-v4",
  "lotHash": "abc123...",     ← 원본 lot_id 없음
  "attempts": 6,
  "lastError": "Max retry attempts exceeded",
  "payload": { ... }          ← 비식별화된 DispatchBatch
}
```

---

### 5.6 scheduler/lotScheduler.ts (D5) — 6단계 파이프라인

node-cron 1분 주기로 미발송 LOT를 감지하여 아래 파이프라인 실행.

```
1. fetchPendingLots()          ← sent_lots.jsonl 필터링 후 미발송 목록 조회
2. fetchLotRecordsCursor()     ← cursor 페이지네이션으로 전체 레코드 수집
3. fetchLotSummary()           ← LOT 요약 정보 조회
4. anonymizeBatch()            ← 비식별화 (HMAC, 제거, 순번)
5. pushBatch()                 ← AI 서버 Push + 백오프 재시도
6. markLotDispatched()         ← sent_lots.jsonl 기록
   또는 writeDeadLetter()      ← 6회 실패 시 dead_letter.jsonl 기록
```

**장애 격리**: 개별 LOT `try/catch` 분리 → 한 LOT 실패가 다음 LOT 처리 중단시키지 않음

---

### 5.7 index.ts (D5) — 진입점

**시작 순서**

```
1. dotenv/config 로드 (import 최상단)
2. validateEnv()   ← 필수 환경변수 5종 검증 (없으면 process.exit(1))
3. validateConnection() ← DB SELECT 1 연결 확인
4. startScheduler() ← node-cron 1분 주기 시작
```

**필수 환경변수 5종**: `HMAC_SECRET`, `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `AI_SERVER_URL`

**Graceful Shutdown**: `SIGTERM` + `SIGINT` 모두 등록 → `pool.end()` 후 `process.exit(0)`

---

## 6. 타입 인터페이스 명세

| 인터페이스 | 용도 | 주요 특징 |
| :--- | :--- | :--- |
| `RawLotRecord` | DB 조회 원본 | `operator_id?: string` 포함. index signature 없음 |
| `AnonymizedLotRecord` | 비식별화 완료 LOT 요약 | `operator_id` 필드 없음 |
| `AnonymizedInspectionRecord` | 비식별화 완료 단건 | `strip_id`, `unit_id`가 `number` (순번) |
| `DispatchBatch` | AI 서버 전송 단위 | `lotHash`, `equipmentHash` 포함. `batchId` UUID v4 |
| `PushResult` | Push 결과 | `success`, `attempt`, `statusCode?`, `error?` |
| `DeadLetterEntry` | Dead letter 기록 | `lotHash` 사용 (원본 `lot_id` 없음) |

---

## 7. 보안 체크리스트 (전체 통과)

| 항목 | 결과 |
| :--- | :--- |
| `any` 타입 0건 (strict mode) | ✅ |
| `operator_id` 완전 제거 (`delete` 사용) | ✅ |
| 로그에 원본 식별자 미출력 | ✅ |
| DB read-only 강제 (`--default_transaction_read_only=on`) | ✅ |
| DB 쓰기 코드 없음 | ✅ |
| AI 응답 body 파싱 없음 (단방향 보장) | ✅ |
| `HMAC_SECRET` 모듈 로드 시점 검증 | ✅ |
| Dead letter에 `lotHash`만 기록 (원본 `lot_id` 없음) | ✅ |
| `SENT_LOTS_PATH` 환경변수 외부화 | ✅ |
| `AI_SERVER_URL` 미설정 시 throw | ✅ |

---

## 8. 실행 방법

```bash
# 1. 환경변수 설정
cp .env.example .env
# .env 파일에서 DB_PASSWORD, HMAC_SECRET, AI_SERVER_URL 변경

# 2. 의존성 설치
npm install

# 3. 개발 실행
npm run dev

# 4. 빌드 후 실행
npm run build && npm start

# 5. 테스트
npm test
```

---

## 9. 검증 명령어 (보안 자동 점검)

```bash
# any 타입 잔존 여부
grep -rn ": any\|as any\|<any>" src/ && echo "❌" || echo "✅ any 없음"

# operator_id 원본 유출 여부
grep -rn "operator_id" src/ | grep -v "config\.ts\|types/index\.ts\|delete\|//"

# 로그 원본 식별자 출력 여부
grep -rn "logger\." src/ | grep -E "lot_id|equipment_id" | grep -v "Hash\|hash"

# DB 쓰기 코드 여부
grep -rn "INSERT\|UPDATE\|DELETE" src/db/

# AI 응답 body 파싱 여부
grep -rn "res\.json\|res\.text\|res\.body" src/push/aiClient.ts

# 단위 테스트 실행
npm test
```

---

## 10. 다음 단계 개발 대상

| 컴포넌트 | 우선순위 | 설명 |
| :--- | :--- | :--- |
| AI 서버 (Python) | P0 | RAG 파이프라인. `/api/ingest` 엔드포인트 구현 |
| Historian 서버 (Node.js) | P0 | TimescaleDB에 MQTT 데이터 적재 |
| dead_letter 재발송 유틸리티 | P1 | `dead_letter.jsonl` 수동 재처리 스크립트 |
| 스케줄러 동시 실행 방지 | P2 | 처리 시간이 1분 초과 시 중복 실행 방지 락 추가 |
| `fetchPendingLots` 쿼리 최적화 | P2 | LOT 수 증가 시 전체 조회 → 점진적 조회로 개선 |
