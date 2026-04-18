# GEMINI.md — DS 비전 검사 장비 모바일 모니터링 프로젝트
# 작업 범위: Dispatcher 서버 (Node.js / TypeScript)

> **작성자**: 수석 아키텍트
> **수신자**: Gemini CLI
> **버전**: v1.0 (2026-04-18)
> **작업 성격**: 코드 작성 전용 (문서 수정 없음)

---

## 0. 프로젝트 컨텍스트

### 0.1 너의 역할

너는 15년 차 경력의 제조 IT(MES/스마트 팩토리) 도메인 전문 프로젝트 매니저(PM)이자 수석 아키텍트다.
Node.js/TypeScript 기반 데이터 게이트웨이 서버 구현에 특화되어 있으며, 망 분리 산업 현장의 보안 경계 설계와 시계열 데이터 파이프라인 구축 경험을 보유하고 있다.
이번 작업에서는 **Dispatcher 서버** 전체를 구현한다.

### 0.2 프로젝트 본질

- 망 분리된 반도체 후공정 공장 현장에서 N대의 비전 검사 장비(EAP) 상태를 모바일로 모니터링하는 Edge 기반 N:1 관제 시스템
- Dispatcher는 **Local Area(공장 내부망) ↔ Online Area(외부 AI 서버) 사이의 유일한 보안 게이트웨이**
- 핵심 흐름: `TimescaleDB(read-only)` → `비식별화` → `AI 서버 단방향 Push`
- 최우선 가치: **보안 경계 유지** + **데이터 병목 없는 파이프라인**

### 0.3 이번 작업 범위 (Scope)

| 구성 요소 | 언어 / 플랫폼 | 핵심 역할 |
| :--- | :--- | :--- |
| **Dispatcher 서버** | Node.js 20 LTS / TypeScript 5.x | TimescaleDB read-only 조회 → 비식별화 → AI 서버 Push |

> **범위 외**: Historian 서버 (TSDB 적재), AI 서버 (RAG 분석), Oracle 서버 (2차 검증), MES 서버, MQTT Broker

### 0.4 시스템에서 Dispatcher의 위치

```
[Local Area — 공장 내부망]          [보안 경계]     [Online Area]
                                         │
 MQTT Broker                             │
      ↓                                  │
 Historian 서버                          │
 (TimescaleDB 적재)                      │
      ↓                                  │
 Dispatcher 서버  ───── 단방향 Push ────▶│──▶  AI 서버
 (read-only 조회)                        │     (RAG/벡터DB)
                                         │
                            역방향 통신 절대 금지
```

### 0.5 저장소 구조 (산출물)

```
dispatcher/
├── src/
│   ├── anonymizer/
│   │   ├── config.ts          ← 비식별화 규칙 외부화 (하드코딩 금지)
│   │   └── anonymizer.ts      ← HMAC-SHA256 해시, operator_id 제거 등
│   ├── db/
│   │   ├── pool.ts            ← pg-pool read-only 커넥션 (historian_read 계정)
│   │   └── queries.ts         ← LOT 단위 cursor 페이지네이션 쿼리
│   ├── push/
│   │   ├── aiClient.ts        ← undici 기반 AI 서버 Push + 백오프 재시도
│   │   └── deadLetter.ts      ← 6회 실패 시 dead_letter.jsonl 기록
│   ├── scheduler/
│   │   └── lotScheduler.ts    ← node-cron + LOT_END 이벤트 트리거
│   ├── types/
│   │   └── index.ts           ← 전체 TypeScript 인터페이스 정의
│   └── index.ts               ← 진입점
├── tests/
│   └── anonymizer.test.ts     ← vitest 단위 테스트
├── package.json
├── tsconfig.json
└── .env.example
```

### 0.6 작업 시작 전 필독 문서

아래를 순서대로 읽고 컨텍스트를 적재한 뒤 코드를 작성한다.

1. `문서/기획안.md` — Dispatcher 서버 역할 및 데이터 흐름 확인 (필독: "Dispatcher 서버" 섹션)
2. `명세서/DS_EAP_MQTT_API_명세서.md` — §5 LOT_END 페이로드 구조 확인
3. `EAP_mock_data/09_lot_end_normal.json` — LOT_END 실측 페이로드 구조 확인
4. `EAP_mock_data/04_inspection_pass.json` — INSPECTION_RESULT 실측 구조 확인

---

## 1. 작업 원칙 (공통)

### 1.1 절대 금지

- ❌ **DB 쓰기 금지** — `historian_read` 계정은 SELECT 전용. INSERT/UPDATE/DELETE 코드 작성 금지
- ❌ **역방향 통신 금지** — AI 서버로부터 데이터를 받는 코드 일체 금지. `undici` 응답은 상태코드 확인만
- ❌ **원본 식별자 로그 출력 금지** — `equipment_id`, `operator_id`, `lot_id` 원본값을 `console.log` / logger에 출력 금지. 해시값만 허용
- ❌ **비식별화 규칙 하드코딩 금지** — 모든 규칙은 `anonymizer/config.ts`에서 관리
- ❌ **`any` 타입 사용 금지** — `unknown` + 타입 가드 패턴 사용. `as any` 캐스팅 금지
- ❌ **실시간 스트리밍 금지** — 1 LOT = 1 배치 단위. MQTT 직접 구독 금지
- ❌ **환경변수 하드코딩 금지** — DB 접속정보, AI 서버 URL, HMAC 키 전부 `.env`로 외부화

### 1.2 필수 준수

- ✅ **TypeScript strict mode** — `tsconfig.json`에 `"strict": true` 필수
- ✅ **read-only 커넥션 풀** — `pg-pool` 생성 시 `statement_timeout` 설정 (30초)
- ✅ **cursor 페이지네이션** — 1 LOT 최대 2,792건. 500건/회 cursor 방식으로 분할 조회
- ✅ **지수 백오프** — AI Push 실패 시 `1s→2s→5s→15s→30s`, max 60s, jitter ±20%
- ✅ **dead letter** — 6회 연속 실패 시 `dead_letter.jsonl`에 LOT 단위로 기록
- ✅ **AbortController 타임아웃** — 모든 HTTP 요청에 타임아웃 필수 (기본 10초)
- ✅ **비식별화 4규칙** 반드시 준수:
  - `equipment_id` → HMAC-SHA256 해시
  - `operator_id` → 필드 완전 제거 (null 치환 금지, 키 자체 삭제)
  - `lot_id` → HMAC-SHA256 해시
  - `strip_id` / `unit_id` → LOT 내 순번(1, 2, 3...)으로 대체

### 1.3 답변 출력 형식

- 표와 불릿 포인트 우선. 산문 나열 금지
- 코드 제공 시 반드시 포함:
  - DB 연결 실패 / 쿼리 타임아웃 대응
  - HTTP 백오프 재시도 (수치 명시)
  - `AbortController` 타임아웃
  - `unknown` + 타입 가드
- 모호한 요청은 추측하지 않고 **기획안 또는 명세서 해당 절을 인용**하여 먼저 확인

---

## 2. Task D1 — 프로젝트 초기화 및 타입 정의

### 2.1 배경

TypeScript strict mode 기반 프로젝트 골격을 잡는다. 이후 모든 Task가 여기서 정의한 인터페이스를 공유하므로 **타입 정의가 가장 먼저 확정되어야 한다.**

### 2.2 산출물

```
dispatcher/
├── package.json
├── tsconfig.json
├── .env.example
└── src/types/index.ts
```

### 2.3 `package.json` 의존성

| 패키지 | 버전 | 용도 |
| :--- | :--- | :--- |
| `pg` | ^8.x | PostgreSQL 클라이언트 |
| `node-cron` | ^3.x | LOT 배치 스케줄러 |
| `undici` | ^6.x | HTTP 클라이언트 (AbortController 내장) |
| `dotenv` | ^16.x | 환경변수 로드 |
| `pino` | ^9.x | 구조적 로깅 (JSON 출력) |
| `vitest` | ^1.x | 단위 테스트 |
| `typescript` | ^5.x | 컴파일러 |
| `tsx` | ^4.x | 개발 실행 |

### 2.4 `tsconfig.json` 필수 설정

```json
{
  "compilerOptions": {
    "strict": true,
    "noImplicitAny": true,
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "./dist",
    "rootDir": "./src"
  }
}
```

### 2.5 `src/types/index.ts` 정의 요구사항

EAP_mock_data의 실측 페이로드를 기준으로 역산하여 아래 인터페이스를 정의한다.

```typescript
// DB에서 읽어온 원본 LOT 레코드 (비식별화 전)
interface RawLotRecord { ... }

// 비식별화 완료된 전송용 페이로드 (operator_id 필드 없음)
interface AnonymizedLotRecord { ... }

// 비식별화 완료된 INSPECTION_RESULT 단건
interface AnonymizedInspectionRecord { ... }

// AI 서버로 전송하는 배치 단위
interface DispatchBatch {
  batchId: string;          // UUID v4
  dispatchedAt: string;     // ISO 8601 UTC
  lotHash: string;          // lot_id HMAC 해시
  equipmentHash: string;    // equipment_id HMAC 해시
  totalRecords: number;
  records: AnonymizedInspectionRecord[];
  lotSummary: AnonymizedLotRecord;
}

// Push 결과
interface PushResult {
  success: boolean;
  attempt: number;
  statusCode?: number;
  error?: string;
}

// Dead letter 레코드
interface DeadLetterEntry {
  failedAt: string;
  batchId: string;
  lotHash: string;
  attempts: number;
  lastError: string;
  payload: DispatchBatch;
}
```

### 2.6 `.env.example`

```env
# DB — read-only 계정만 허용
DB_HOST=localhost
DB_PORT=5432
DB_NAME=historian
DB_USER=historian_read
DB_PASSWORD=CHANGE_ME
DB_STATEMENT_TIMEOUT_MS=30000
DB_POOL_MAX=5

# AI 서버 — 단방향 Push 전용
AI_SERVER_URL=http://ai-server:8000/api/ingest
AI_SERVER_API_KEY=CHANGE_ME
AI_REQUEST_TIMEOUT_MS=10000

# 비식별화
HMAC_SECRET=CHANGE_ME_32_CHARS_MIN

# Dead letter
DEAD_LETTER_PATH=./dead_letter.jsonl

# 배치 설정
BATCH_PAGE_SIZE=500
BACKOFF_STEPS_SEC=1,2,5,15,30,60
BACKOFF_MAX_ATTEMPTS=6
```

### 2.7 검증 체크리스트

- [ ] `tsconfig.json` `"strict": true` 확인
- [ ] `any` 타입이 `src/types/index.ts`에 단 한 곳도 없음
- [ ] `operator_id` 필드가 `AnonymizedLotRecord`에 존재하지 않음 (완전 제거)
- [ ] `DispatchBatch`에 `lotHash`, `equipmentHash` 필드 존재
- [ ] `.env.example`에 DB_USER가 `historian_read`로 명시

### 2.8 Git 커밋 메시지

```
feat(dispatcher): 프로젝트 초기화 + 타입 정의 (D1)

- package.json: pg, undici, node-cron, pino, vitest 의존성
- tsconfig.json: strict mode, Node16 모듈
- src/types/index.ts: RawLotRecord, AnonymizedLotRecord, DispatchBatch 등
- .env.example: DB/AI/HMAC/배치 설정 전체

operator_id 완전 제거, lot_id/equipment_id HMAC 해시 타입 구조 확정.
```

---

## 3. Task D2 — 비식별화 모듈 (anonymizer)

### 3.1 배경

Dispatcher의 보안 핵심 컴포넌트. **이 모듈을 통과하지 않은 데이터는 AI 서버로 절대 전송되지 않는다.** 비식별화 규칙은 코드 안에 하드코딩하지 않고 `config.ts`에서 관리한다.

### 3.2 산출물

```
src/anonymizer/
├── config.ts      ← 규칙 정의 (필드명, 처리방식 매핑)
└── anonymizer.ts  ← 실제 변환 로직
```

### 3.3 `anonymizer/config.ts` 구조

```typescript
export type AnonymizeRule =
  | { action: 'hmac' }       // HMAC-SHA256 해시로 치환
  | { action: 'remove' }     // 필드 키 자체 삭제
  | { action: 'sequence' }   // LOT 내 순번(1,2,3...)으로 대체

export const ANONYMIZE_RULES: Record<string, AnonymizeRule> = {
  equipment_id: { action: 'hmac' },
  operator_id:  { action: 'remove' },   // ← 완전 제거. null 치환 금지
  lot_id:       { action: 'hmac' },
  strip_id:     { action: 'sequence' },
  unit_id:      { action: 'sequence' },
};
```

### 3.4 `anonymizer.ts` 구현 요구사항

```typescript
// HMAC 키는 환경변수에서만 읽음
const HMAC_KEY = process.env.HMAC_SECRET ?? (() => {
  throw new Error('HMAC_SECRET 환경변수가 설정되지 않았습니다');
})();

// 동일 입력 → 동일 해시 보장 (참조 무결성 유지)
function hmacSha256(value: string): string { ... }

// 단건 레코드 비식별화
function anonymizeRecord(
  raw: RawLotRecord,
  sequenceMap: Map<string, number>  // strip_id/unit_id 순번 관리
): AnonymizedInspectionRecord { ... }

// LOT 전체 배치 비식별화
export function anonymizeBatch(
  lotId: string,
  equipmentId: string,
  records: RawLotRecord[]
): DispatchBatch { ... }
```

**중요 구현 규칙:**
- `operator_id`는 `undefined`나 `null`로 치환하지 않고 **객체에서 키 자체를 삭제** (`delete obj.operator_id`)
- `lot_id`와 `equipment_id`의 HMAC 해시는 배치 전체에서 **일관성 유지** (같은 값 → 같은 해시)
- 로그에 원본값 출력 금지 — 해시값만 출력

### 3.5 `tests/anonymizer.test.ts` 필수 테스트 케이스

```typescript
describe('anonymizer', () => {
  it('operator_id 필드가 결과 객체에 존재하지 않아야 한다')
  it('동일 equipment_id는 동일 해시를 반환해야 한다')
  it('동일 lot_id는 동일 해시를 반환해야 한다')
  it('strip_id는 LOT 내 순번(1부터)으로 대체되어야 한다')
  it('unit_id는 LOT 내 순번(1부터)으로 대체되어야 한다')
  it('HMAC_SECRET 미설정 시 즉시 에러를 던져야 한다')
  it('원본 lot_id와 해시된 lot_id가 다른지 확인')
})
```

### 3.6 검증 체크리스트

- [ ] `operator_id` 키가 결과 객체에서 완전히 사라짐 (`'operator_id' in result === false`)
- [ ] HMAC_SECRET 미설정 시 서버 시작 단계에서 즉시 throw
- [ ] 테스트 7개 모두 통과 (`vitest run`)
- [ ] `anonymizer.ts`에 `any` 타입 없음
- [ ] 로그 출력 시 원본 `lot_id`, `equipment_id` 값 미포함 확인

### 3.7 Git 커밋 메시지

```
feat(dispatcher): 비식별화 모듈 구현 (D2)

- anonymizer/config.ts: ANONYMIZE_RULES 외부화 (hmac/remove/sequence)
- anonymizer/anonymizer.ts: HMAC-SHA256, operator_id 완전 제거, 순번 대체
- tests/anonymizer.test.ts: 7개 테스트 케이스 전체 통과

보안 핵심 컴포넌트. 이 모듈 통과 전 데이터는 외부 전송 불가.
```

---

## 4. Task D3 — DB 커넥션 풀 + LOT 쿼리 (read-only)

### 4.1 배경

TimescaleDB에서 LOT 단위로 데이터를 조회한다. **읽기 전용 계정(`historian_read`)** 만 사용하며, 1 LOT 최대 2,792건을 한 번에 조회하지 않고 **cursor 페이지네이션(500건/회)** 으로 분할한다.

### 4.2 산출물

```
src/db/
├── pool.ts    ← pg-pool 초기화 (read-only 설정)
└── queries.ts ← LOT 단위 cursor 페이지네이션 쿼리
```

### 4.3 `db/pool.ts` 구현 요구사항

```typescript
import { Pool } from 'pg';

// read-only 커넥션 풀 — 쓰기 연산 방어
export const pool = new Pool({
  host:     process.env.DB_HOST,
  port:     Number(process.env.DB_PORT ?? 5432),
  database: process.env.DB_NAME,
  user:     process.env.DB_USER,      // 반드시 historian_read
  password: process.env.DB_PASSWORD,
  max:      Number(process.env.DB_POOL_MAX ?? 5),
  statement_timeout: Number(process.env.DB_STATEMENT_TIMEOUT_MS ?? 30000),
  // read-only 트랜잭션 강제
  options:  '--default_transaction_read_only=on',
});

// 연결 검증 — 시작 시 SELECT 1 실행
export async function validateConnection(): Promise<void> { ... }
```

**반드시 포함:**
- 커넥션 풀 `error` 이벤트 핸들러 (미처리 예외 방지)
- `--default_transaction_read_only=on` 옵션 (DB 레벨 쓰기 차단)
- 시작 시 `validateConnection()` 호출

### 4.4 `db/queries.ts` 구현 요구사항

**cursor 페이지네이션 패턴:**

```typescript
const PAGE_SIZE = Number(process.env.BATCH_PAGE_SIZE ?? 500);

// LOT_END 이벤트 수신 후 해당 lot_id의 INSPECTION_RESULT 전체 조회
// cursor 방식: 마지막 조회 row의 id를 기준으로 다음 페이지 조회
export async function* fetchLotRecordsCursor(
  lotId: string
): AsyncGenerator<RawLotRecord[], void, unknown> {
  let lastId = 0;
  while (true) {
    const rows = await fetchPage(lotId, lastId, PAGE_SIZE);
    if (rows.length === 0) break;
    yield rows;
    if (rows.length < PAGE_SIZE) break;
    lastId = rows[rows.length - 1].id;
  }
}

// LOT 요약 정보 조회 (lot_end 테이블)
export async function fetchLotSummary(lotId: string): Promise<RawLotRecord | null> { ... }
```

**반드시 포함:**
- 쿼리 파라미터는 반드시 `$1`, `$2` 플레이스홀더 사용 (SQL Injection 방지)
- `try/finally`로 커넥션 반환 보장
- 쿼리 실행 시간 로깅 (원본 lotId 제외, 해시값만)

### 4.5 검증 체크리스트

- [ ] `pool.ts`에 `--default_transaction_read_only=on` 설정 확인
- [ ] `fetchLotRecordsCursor`가 AsyncGenerator로 구현됨
- [ ] SQL에 파라미터 플레이스홀더(`$1`, `$2`) 사용 확인
- [ ] `finally`로 커넥션 반환 보장
- [ ] DB_USER 환경변수 미설정 시 즉시 에러
- [ ] `any` 타입 없음

### 4.6 Git 커밋 메시지

```
feat(dispatcher): DB 커넥션 풀 + LOT cursor 쿼리 (D3)

- db/pool.ts: historian_read 전용, read-only 트랜잭션 강제, statement_timeout
- db/queries.ts: AsyncGenerator cursor 페이지네이션 (500건/회)
- SQL Injection 방지: 플레이스홀더 파라미터 사용

1 LOT 최대 2,792건 분할 조회. 단일 대용량 쿼리 병목 방지.
```

---

## 5. Task D4 — AI 서버 Push 클라이언트 + Dead Letter

### 5.1 배경

비식별화된 배치를 AI 서버로 단방향 Push한다. **실패 시 지수 백오프로 재시도**, 6회 실패 시 `dead_letter.jsonl`에 기록하고 다음 LOT으로 넘어간다. AI 서버로부터 데이터를 받는 코드는 작성하지 않는다.

### 5.2 산출물

```
src/push/
├── aiClient.ts    ← undici 기반 Push + 백오프 재시도
└── deadLetter.ts  ← dead_letter.jsonl 기록
```

### 5.3 `push/aiClient.ts` 구현 요구사항

```typescript
import { fetch } from 'undici';

// 백오프 수열 — 환경변수에서 읽되 기본값 보장
const BACKOFF_STEPS = (process.env.BACKOFF_STEPS_SEC ?? '1,2,5,15,30,60')
  .split(',').map(Number);
const MAX_ATTEMPTS = Number(process.env.BACKOFF_MAX_ATTEMPTS ?? 6);

// jitter ±20%
function getBackoffDelay(attempt: number): number {
  const base = BACKOFF_STEPS[Math.min(attempt, BACKOFF_STEPS.length - 1)] * 1000;
  const jitter = base * (0.8 + Math.random() * 0.4);
  return Math.round(jitter);
}

export async function pushBatch(batch: DispatchBatch): Promise<PushResult> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(
        () => controller.abort(),
        Number(process.env.AI_REQUEST_TIMEOUT_MS ?? 10000)
      );

      const res = await fetch(process.env.AI_SERVER_URL!, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Api-Key': process.env.AI_SERVER_API_KEY ?? '',
        },
        body: JSON.stringify(batch),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (res.ok) return { success: true, attempt, statusCode: res.status };

      // 4xx는 재시도 불필요 (클라이언트 오류)
      if (res.status >= 400 && res.status < 500) {
        return { success: false, attempt, statusCode: res.status,
                 error: `Client error: ${res.status}` };
      }
    } catch (err: unknown) {
      // AbortController timeout 포함
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ attempt, batchId: batch.batchId }, `Push attempt ${attempt + 1} failed: ${message}`);
    }

    if (attempt < MAX_ATTEMPTS - 1) {
      await new Promise(resolve => setTimeout(resolve, getBackoffDelay(attempt)));
    }
  }
  return { success: false, attempt: MAX_ATTEMPTS, error: 'Max attempts exceeded' };
}
```

**반드시 포함:**
- `AbortController` + `setTimeout` 타임아웃 조합
- 4xx 응답은 재시도 없이 즉시 실패 처리
- 응답 body를 파싱하거나 저장하는 코드 금지 (단방향 Push)

### 5.4 `push/deadLetter.ts` 구현 요구사항

```typescript
// 6회 실패 시 LOT 배치 전체를 JSONL 파일에 추가 기록
export async function writeDeadLetter(
  batch: DispatchBatch,
  lastError: string
): Promise<void> {
  const entry: DeadLetterEntry = {
    failedAt: new Date().toISOString(),
    batchId: batch.batchId,
    lotHash: batch.lotHash,       // 원본 lot_id 아님
    attempts: MAX_ATTEMPTS,
    lastError,
    payload: batch,
  };
  // 파일에 JSONL 형식으로 append
  await fs.appendFile(
    process.env.DEAD_LETTER_PATH ?? './dead_letter.jsonl',
    JSON.stringify(entry) + '\n',
    'utf-8'
  );
  logger.error({ batchId: batch.batchId, lotHash: batch.lotHash },
    'Dead letter recorded after max attempts');
}
```

### 5.5 검증 체크리스트

- [ ] 백오프 수열 `[1,2,5,15,30,60]` 초 단위 확인
- [ ] jitter ±20% 적용 확인
- [ ] `AbortController` 타임아웃 적용 확인
- [ ] 4xx 응답 시 재시도 없이 즉시 반환 확인
- [ ] AI 서버 응답 body 파싱/저장 코드 없음
- [ ] dead letter에 원본 `lot_id` 대신 `lotHash` 기록
- [ ] `any` 타입 없음

### 5.6 Git 커밋 메시지

```
feat(dispatcher): AI Push 클라이언트 + Dead Letter (D4)

- push/aiClient.ts: undici, 백오프 1s→2s→5s→15s→30s jitter±20%
- push/aiClient.ts: AbortController 타임아웃, 4xx 즉시 실패
- push/deadLetter.ts: 6회 실패 시 JSONL 기록 (lotHash만, 원본 lot_id 없음)

단방향 Push 보장. AI 서버로부터 데이터 수신 코드 없음.
```

---

## 6. Task D5 — 스케줄러 + 진입점 통합

### 6.1 배경

LOT_END 이벤트를 감지하면 D3(DB 조회) → D2(비식별화) → D4(Push) 파이프라인을 순서대로 실행한다. LOT_END는 MQTT를 직접 구독하지 않고 **Historian DB의 lot_end 테이블을 폴링**하거나 **node-cron으로 주기 실행**한다.

### 6.2 `scheduler/lotScheduler.ts` 구현 요구사항

```typescript
// 미발송 LOT 감지 → 배치 실행 파이프라인
export async function processUnsentLots(): Promise<void> {
  // 1. dispatch_log 테이블에서 미발송 LOT 목록 조회
  const pendingLots = await fetchPendingLots();

  for (const lot of pendingLots) {
    try {
      // 2. cursor 페이지네이션으로 전체 레코드 수집
      const allRecords: RawLotRecord[] = [];
      for await (const page of fetchLotRecordsCursor(lot.lotId)) {
        allRecords.push(...page);
      }

      // 3. LOT 요약 조회
      const summary = await fetchLotSummary(lot.lotId);
      if (!summary) continue;

      // 4. 비식별화
      const batch = anonymizeBatch(lot.lotId, lot.equipmentId, allRecords);

      // 5. Push
      const result = await pushBatch(batch);

      // 6. 결과 기록
      if (result.success) {
        await markLotDispatched(lot.lotId);
        logger.info({ batchId: batch.batchId, lotHash: batch.lotHash },
          `Batch dispatched successfully`);
      } else {
        await writeDeadLetter(batch, result.error ?? 'unknown');
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ lotHash: hmacSha256(lot.lotId) }, `Pipeline error: ${message}`);
    }
  }
}

// node-cron: 1분마다 미발송 LOT 확인
export function startScheduler(): void {
  cron.schedule('* * * * *', () => {
    processUnsentLots().catch(err => {
      logger.error(err, 'Scheduler error');
    });
  });
}
```

### 6.3 `src/index.ts` 진입점 요구사항

```typescript
// 시작 순서:
// 1. 환경변수 검증 (HMAC_SECRET, DB_*, AI_SERVER_URL 필수값 확인)
// 2. DB 연결 검증 (validateConnection)
// 3. 스케줄러 시작 (startScheduler)
// 4. SIGTERM/SIGINT 핸들러 등록 (graceful shutdown)
```

**Graceful Shutdown 필수:**
```typescript
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received. Shutting down gracefully...');
  // 진행 중인 배치 완료 대기 (최대 30초)
  await pool.end();
  process.exit(0);
});
```

### 6.4 검증 체크리스트

- [ ] 파이프라인 6단계 순서 정확 (조회→수집→요약→비식별화→Push→기록)
- [ ] 개별 LOT 실패가 다음 LOT 처리를 중단시키지 않음 (try/catch per lot)
- [ ] 로그에 원본 `lotId`, `equipmentId` 미출력 (해시값만)
- [ ] `SIGTERM` graceful shutdown 구현
- [ ] 환경변수 필수값 시작 시 검증
- [ ] `any` 타입 없음

### 6.5 Git 커밋 메시지

```
feat(dispatcher): 스케줄러 + 파이프라인 통합 (D5)

- scheduler/lotScheduler.ts: node-cron 1분 주기, 6단계 파이프라인
- src/index.ts: 환경변수 검증, DB 연결 확인, graceful shutdown
- 개별 LOT 예외 격리 (다른 LOT 처리 영향 없음)

D1~D4 모듈 통합 완성. 전체 파이프라인 구동 가능.
```

---

## 7. Task 실행 순서

| 순서 | Task | 제목 | 우선순위 | 의존성 |
| :--- | :--- | :--- | :--- | :--- |
| 1 | D1 | 프로젝트 초기화 + 타입 정의 | P0 | 없음 |
| 2 | D2 | 비식별화 모듈 | P0 | D1 (타입) |
| 3 | D3 | DB 커넥션 + LOT 쿼리 | P0 | D1 (타입) |
| 4 | D4 | AI Push + Dead Letter | P1 | D1, D2 |
| 5 | D5 | 스케줄러 + 진입점 통합 | P1 | D2, D3, D4 |

> D2와 D3은 D1 완료 후 **병렬 작업 가능**

---

## 8. 통합 검증 (전 Task 완료 후)

### 8.1 자동 검증 명령어

```bash
# 1. TypeScript 컴파일 오류 없음 확인
npx tsc --noEmit

# 2. any 타입 잔존 여부 검사
grep -rn ": any\|as any\|<any>" src/ && echo "❌ any 타입 발견" || echo "✅ any 타입 없음"

# 3. operator_id 원본 유출 검사
grep -rn "operator_id" src/ | grep -v "config.ts\|types/index.ts" && \
  echo "❌ operator_id 유출 가능성" || echo "✅ operator_id 안전"

# 4. 로그에 원본 식별자 출력 검사
grep -rn "equipment_id\|lot_id\|operator_id" src/ | grep "logger\|console" | \
  grep -v "Hash\|hash" && echo "❌ 원본값 로그 유출 가능성" || echo "✅ 로그 안전"

# 5. 단위 테스트 전체 실행
npx vitest run

# 6. DB 쓰기 코드 잔존 검사
grep -rn "INSERT\|UPDATE\|DELETE\|CREATE\|DROP" src/db/ && \
  echo "❌ DB 쓰기 코드 발견" || echo "✅ DB read-only 확인"
```

### 8.2 교차 참조 체크리스트

| 체크 항목 | 기준 | 확인 위치 |
| :--- | :--- | :--- |
| 비식별화 4규칙 모두 구현 | 지침 §3 제약 | `anonymizer/config.ts` |
| 백오프 수열 `[1,2,5,15,30,60]` | 지침 §3 제약 | `push/aiClient.ts` |
| cursor 페이지네이션 500건/회 | 지침 §3 제약 | `db/queries.ts` |
| dead letter 6회 실패 후 기록 | 지침 §3 제약 | `push/deadLetter.ts` |
| DB read-only 강제 | 지침 §1.1 | `db/pool.ts` |
| AbortController 타임아웃 | 지침 §1.2 | `push/aiClient.ts` |
| `any` 타입 0개 | 지침 §1.1 | 전체 `src/` |
| `operator_id` 완전 제거 | 지침 §1.2 | `anonymizer/config.ts` |

### 8.3 최종 보고 형식

```
## Dispatcher 서버 구현 완료 보고

### 변경 통계
- 신규 파일: N개
- 추가 라인: +X

### Task 완료 현황
- [x] D1 프로젝트 초기화 + 타입 정의 (P0)
- [x] D2 비식별화 모듈 (P0)
- [x] D3 DB 커넥션 + LOT 쿼리 (P0)
- [x] D4 AI Push + Dead Letter (P1)
- [x] D5 스케줄러 + 진입점 통합 (P1)

### 자동 검증 결과
- TypeScript 컴파일: PASS
- any 타입 검사: PASS (0건)
- operator_id 유출 검사: PASS
- 로그 원본 식별자 검사: PASS
- 단위 테스트: PASS (N/N)
- DB 쓰기 코드 검사: PASS (0건)

### 다음 단계 권고
1. Historian 서버와 연동 테스트 (TimescaleDB 실 데이터)
2. AI 서버 엔드포인트 연동 테스트
3. dead_letter.jsonl 재발송 유틸리티 구현
```

---

## 9. 주의사항

### 9.1 자주 하는 실수

| 실수 | 방지책 |
| :--- | :--- |
| `operator_id: null`로 치환 | `delete obj.operator_id`로 키 자체 삭제 |
| `any` 타입으로 DB 행 처리 | `unknown` 캐스팅 후 타입 가드 작성 |
| AI 응답 body 파싱 | `res.ok` 확인만, body는 무시 |
| 로그에 `lot_id` 원본 출력 | `hmacSha256(lotId)` 해시값만 출력 |
| AbortController 없이 fetch | timeout 없으면 무한 대기 가능 |
| AsyncGenerator 오류 시 무한 루프 | `try/catch` + `break` 조합 필수 |

### 9.2 막혔을 때

- **DB 스키마 불명확** → `기획안.md` Historian 서버 섹션의 TSDB 구조 참조
- **비식별화 규칙 추가 여부** → `anonymizer/config.ts`에만 추가. 코드 수정 없이 반영
- **AI 서버 API 스펙 불명확** → `기획안.md` AI 서버 섹션 인용 후 확인 요청
- **두 가지 해석 가능** → **보안 경계 유지**가 더 중요한 원칙. 더 제한적인 쪽 선택

---

**End of GEMINI.md**