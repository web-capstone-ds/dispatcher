# CLAUDE.md — DS 비전 검사 장비 모바일 모니터링 프로젝트 지시 명세서

> **작성자**: 수석 아키텍트  
> **수신자**: Claude Code  
> **버전**: v2.0 (2026-04-17)  
> **작업 성격**: Dispatcher 서버 구현 (Node.js / TypeScript)

---

## 0. 프로젝트 컨텍스트

### 0.1 너의 역할
너는 15년 차 제조 IT(MES/스마트 팩토리) 도메인의 수석 아키텍트로서, 디에스(DS) 주식회사 비전 검사 장비 모바일 모니터링 시스템의 **Dispatcher 서버**를 구현한다.

### 0.2 프로젝트의 본질
- 망 분리된 반도체 후공정 공장 현장에서, N대의 비전 검사 장비(EAP)를 한 대의 모바일 앱에서 모니터링
- 통신: MQTT (Eclipse Mosquitto) over Local Wi-Fi
- **Dispatcher 역할**: Local Area의 Historian TSDB에서 데이터를 read-only 조회 → 비식별화 처리 → Online Area의 AI 서버로 단방향 Push
- 핵심 가치: 데이터 병목 없는 파이프라인 + Local/Online Area 간 보안 경계 유지

### 0.3 Dispatcher 서버의 책임 (기획안 §필요한 서버 종류 인용)
```
- Local Area의 TSDB에서 read-only로 데이터를 조회
- 데이터를 비식별화 처리하여 Online Area의 AI 서버로 단방향 Push
- AI 서버가 TSDB에 직접 접근하면 Local Area 핵심 자산이 노출되므로 중간 게이트웨이 역할
- TSDB에 read-only 권한만 보유 → 최소 권한 원칙 준수
- 배치 단위 부하 격리 → AI 서버의 불필요한 폴링 방지
```

### 0.4 작업 대상 저장소 구조
```
.
├── CLAUDE.md                              ← 이 파일
├── dispatcher/                            ← 메인 작업 디렉토리
│   ├── src/
│   │   ├── config/
│   │   ├── db/                            ← TimescaleDB 연결 및 쿼리
│   │   ├── anonymizer/                    ← 비식별화 모듈
│   │   ├── pusher/                        ← AI 서버 Push 모듈
│   │   ├── scheduler/                     ← 배치 스케줄러
│   │   └── index.ts
│   ├── tests/
│   ├── package.json
│   └── tsconfig.json
├── EAP_mock_data/                         ← 참조용 (수정 금지)
├── 명세서/
│   ├── DS_EAP_MQTT_API_명세서.md          ← v3.4 (통신 규약 진실의 원천)
│   └── DS_이벤트정의서.md                  ← Rule R01~R38c
└── 문서/
    ├── 기획안.md                           ← Dispatcher 설계 근거
    ├── 기업소개 및 요구사항.md
    └── 오라클 2차 검증 기획안.md
```

### 0.5 작업 시작 전 필독 문서
작업 전 반드시 아래 순서대로 읽는다:

1. `문서/기획안.md` — Dispatcher 서버 섹션 (데이터 흐름, 보안 경계)
2. `명세서/DS_EAP_MQTT_API_명세서.md` — §4 INSPECTION_RESULT, §5 LOT_END 페이로드 구조
3. `문서/오라클 2차 검증 기획안.md` — AI 서버가 기대하는 데이터 형식 파악

---

## 1. 작업 원칙 (모든 Task 공통)

### 1.1 절대 금지 사항
- ❌ **TSDB 쓰기 연결 금지** — Dispatcher는 read-only 접속만 허용. INSERT/UPDATE/DELETE 쿼리 절대 금지.
- ❌ **원본 equipment_id / operator_id / lot_id 직접 전송 금지** — 비식별화 없이 Online Area로 전송 불가.
- ❌ **AI 서버 → Dispatcher 역방향 통신 금지** — 단방향 Push 구조. AI 서버가 Dispatcher에 쿼리하는 엔드포인트 만들지 말 것.
- ❌ **EAP_mock_data 내 파일 수정 금지** — 참조 전용.
- ❌ **any 타입 사용 금지** — TypeScript strict mode 준수. 모든 페이로드는 명시적 인터페이스 정의.

### 1.2 필수 준수 사항
- ✅ **TimescaleDB 연결은 읽기 전용 계정(historian_read)**으로만 접속.
- ✅ **비식별화 규칙은 config로 외부화** — 하드코딩 금지. `anonymizer/config.ts`에서 관리.
- ✅ **배치 처리 단위** — LOT_END 이벤트 기준으로 1 LOT = 1 배치. 실시간 스트리밍 금지.
- ✅ **재시도 로직** — AI 서버 Push 실패 시 지수 백오프 (1s→2s→5s→15s→30s, max 60s, jitter ±20%) 적용.
- ✅ **CancellationToken** — 모든 비동기 DB 쿼리 및 HTTP Push에 AbortController/AbortSignal 전파.
- ✅ **구조화 로그** — pino 또는 winston 사용. JSON 포맷. `lot_id_hash` 기준으로 트레이서빌리티 유지.

### 1.3 기술 스택
| 항목 | 선택 | 이유 |
| :--- | :--- | :--- |
| Runtime | Node.js 20 LTS | 기획안 명시 |
| Language | TypeScript 5.x (strict) | 타입 안전성 |
| DB Client | `pg` + `pg-pool` | TimescaleDB(PostgreSQL 호환) |
| HTTP Client | `undici` (Node 내장 fetch) | 경량, AbortController 지원 |
| Scheduler | `node-cron` | LOT_END 트리거 + 시간 기반 배치 |
| Test | `vitest` | ESM 호환, 빠른 실행 |
| Lint | ESLint + prettier | |

### 1.4 검증 체크포인트
각 Task 끝에 자기 검증 체크리스트가 있다. 한 Task의 체크리스트를 모두 통과하지 못한 채로 다음 Task로 넘어가지 말 것.

---

## 2. 데이터 흐름 및 보안 경계

```
┌─────────────────────────────────────────────────────────────────┐
│                        LOCAL AREA                               │
│                                                                 │
│  TimescaleDB (TSDB)                                             │
│  ┌─────────────────┐    read-only     ┌────────────────────┐   │
│  │  inspection_    │ ────────────────▶│                    │   │
│  │  results (시계열) │                  │  Dispatcher        │   │
│  │  lot_summary    │                  │  Server            │   │
│  │  alarm_history  │                  │  (Node.js/TS)      │   │
│  └─────────────────┘                  └────────┬───────────┘   │
│                                                │               │
└────────────────────────────────────────────────│───────────────┘
                                                 │ 단방향 Push
                                                 │ (비식별화 후)
                                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│                       ONLINE AREA (DMZ)                         │
│                                                                 │
│                        ┌──────────────────┐                     │
│                        │   AI 서버         │                     │
│                        │   (Python/RAG)   │                     │
│                        └──────────────────┘                     │
└─────────────────────────────────────────────────────────────────┘
```

### 2.1 비식별화 규칙 (필수 적용 필드)

| 원본 필드 | 비식별화 방법 | 전송 필드명 | 비고 |
| :--- | :--- | :--- | :--- |
| `equipment_id` (DS-VIS-001) | HMAC-SHA256 → 앞 12자리 | `equipment_hash` | 동일 장비는 동일 해시 |
| `lot_id` (LOT-20260122-001) | HMAC-SHA256 → 앞 12자리 | `lot_hash` | LOT 연속성 추적 가능 |
| `operator_id` (ENG-KIM) | 제거 | — | AI 분석에 불필요 |
| `strip_id` / `unit_id` | 순번(1, 2, 3...) 으로 대체 | `seq` | 절대 경로 제거 |
| `timestamp` | 유지 (분석 필수) | `timestamp` | |
| `recipe_id` | 유지 (레시피별 학습 필수) | `recipe_id` | |
| 수치 데이터 (yield, offset 등) | 유지 | 원본 필드명 | |

---

## 3. Task 실행 순서 (D1 → D2 → D3 → D4 → D5)

| 순서 | Task ID | 제목 | 우선순위 | 예상 |
| :--- | :--- | :--- | :--- | :--- |
| 1 | D1 | 프로젝트 초기화 및 DB 연결 레이어 | P0 | 0.5일 |
| 2 | D2 | 비식별화 모듈 구현 | P0 | 0.5일 |
| 3 | D3 | TSDB 쿼리 레이어 (LOT 기준 배치 조회) | P0 | 1일 |
| 4 | D4 | AI 서버 Push 모듈 (HTTP + 재시도) | P1 | 0.5일 |
| 5 | D5 | 배치 스케줄러 + 통합 테스트 | P1 | 1일 |

---

## 4. Task D1 — 프로젝트 초기화 및 DB 연결 레이어

### 4.1 작업 항목
- `dispatcher/` 디렉토리 초기화 (`package.json`, `tsconfig.json`)
- `src/config/index.ts` — 환경변수 기반 설정 (DB URL, AI 서버 URL, 비식별화 HMAC 키)
- `src/db/pool.ts` — `pg-pool` read-only 연결. 최대 커넥션 5개. idle timeout 10s.
- `src/db/healthCheck.ts` — 연결 확인 쿼리 (`SELECT 1`)

### 4.2 환경변수 목록
```
TSDB_READ_URL=postgres://historian_read:***@localhost:5432/ds_historian
AI_SERVER_URL=https://ai.ds-internal.com/ingest
ANONYMIZER_HMAC_KEY=***  (32바이트 이상 랜덤값)
BATCH_CRON=0 * * * *     (기본: 매시 정각)
LOG_LEVEL=info
```

### 4.3 검증 체크리스트
- [ ] `npm run build` 에러 없음
- [ ] `tsconfig.json`에 `"strict": true` 확인
- [ ] DB 풀이 read-only 계정(`historian_read`) 사용
- [ ] 환경변수 미설정 시 프로세스 시작 전 명확한 오류 메시지 출력

---

## 5. Task D2 — 비식별화 모듈 구현

### 5.1 작업 항목
- `src/anonymizer/config.ts` — 비식별화 규칙 테이블 (§2.1 기준)
- `src/anonymizer/index.ts` — `anonymize(payload: RawLotPayload): AnonymizedLotPayload` 함수
- 단위 테스트: `tests/anonymizer.test.ts`

### 5.2 인터페이스 정의 (명세서 §4, §5 기준)

```typescript
// 원본 (TSDB에서 조회한 데이터)
interface RawInspectionResult {
  equipment_id: string;   // DS-VIS-001
  lot_id: string;         // LOT-20260122-001
  strip_id: string;
  unit_id: string;
  operator_id: string;
  recipe_id: string;
  timestamp: string;
  overall_result: 'PASS' | 'FAIL';
  fail_count: number;
  yield_pct?: number;
  // ... 수치 필드
}

// 비식별화 후 (AI 서버로 전송)
interface AnonymizedInspectionResult {
  equipment_hash: string;  // HMAC 앞 12자리
  lot_hash: string;
  seq: number;             // strip/unit 순번
  recipe_id: string;       // 유지
  timestamp: string;       // 유지
  overall_result: 'PASS' | 'FAIL';
  fail_count: number;
  yield_pct?: number;
  // operator_id 없음
}
```

### 5.3 검증 체크리스트
- [ ] 동일 `equipment_id` 입력 → 항상 동일 `equipment_hash` 출력 (결정론적)
- [ ] 다른 `equipment_id` 입력 → 다른 `equipment_hash` 출력
- [ ] 출력 페이로드에 `operator_id`, `strip_id`, `unit_id` 원본값 없음
- [ ] HMAC 키 변경 시 해시값 변경 확인 (테스트)

---

## 6. Task D3 — TSDB 쿼리 레이어

### 6.1 작업 항목
- `src/db/queries.ts` — LOT 기준 배치 조회 쿼리
- 조회 범위: LOT_END 이벤트가 발생한 LOT의 INSPECTION_RESULT 전체
- TimescaleDB 시간 범위 쿼리 최적화 (`WHERE time BETWEEN lot_start AND lot_end`)

### 6.2 쿼리 설계 원칙
- **페이지네이션 필수**: 1 LOT = 최대 2,792건 (실측). 한 번에 500건씩 cursor 방식으로 조회.
- **타임아웃 설정**: 쿼리당 30초 AbortSignal.
- **인덱스 활용**: `lot_id` + `timestamp` 복합 인덱스 가정.

### 6.3 검증 체크리스트
- [ ] 쿼리에 INSERT/UPDATE/DELETE 없음 (테스트에서 확인)
- [ ] 500건 페이지네이션 동작 확인
- [ ] DB 연결 끊김 시 자동 재시도 (pg-pool 기본 동작 확인)
- [ ] `AbortSignal` 전달 시 쿼리 취소 동작

---

## 7. Task D4 — AI 서버 Push 모듈

### 7.1 작업 항목
- `src/pusher/index.ts` — 비식별화된 배치 데이터를 AI 서버 REST API로 POST
- 재시도 로직: 지수 백오프 (1s→2s→5s→15s→30s, max 60s, jitter ±20%)
- `src/pusher/retry.ts` — 백오프 유틸리티

### 7.2 Push 페이로드 구조

```typescript
interface AiServerBatchPayload {
  batch_id: string;          // UUID v4
  lot_hash: string;
  equipment_hash: string;
  recipe_id: string;
  lot_end_timestamp: string;
  total_units: number;
  yield_pct: number;
  inspections: AnonymizedInspectionResult[];
}
```

### 7.3 재시도 규격

| 재시도 | 대기 (jitter ±20%) | 포기 조건 |
| :--- | :--- | :--- |
| 1회 | 1s | — |
| 2회 | 2s | — |
| 3회 | 5s | — |
| 4회 | 15s | — |
| 5회 | 30s | — |
| 6회 이상 | max 60s | 6회 실패 시 Dead Letter Queue 기록 후 포기 |

### 7.4 검증 체크리스트
- [ ] 5xx 응답 시 재시도, 4xx 응답 시 즉시 포기 (재시도 불필요)
- [ ] `AbortController`로 타임아웃 (30초) 적용
- [ ] 6회 실패 시 `dead_letter.jsonl`에 배치 메타 기록
- [ ] 성공 로그에 `lot_hash`, `batch_id`, `duration_ms` 포함

---

## 8. Task D5 — 배치 스케줄러 + 통합 테스트

### 8.1 트리거 방식 (2가지)

| 트리거 | 방식 | 설명 |
| :--- | :--- | :--- |
| LOT_END 이벤트 | MQTT 구독 또는 DB 폴링 | LOT 완료 즉시 배치 시작. 지연 최소화 |
| 시간 기반 | `node-cron` (매시 정각) | LOT_END 누락 방지용 보조 트리거 |

### 8.2 중복 처리 방지
- 처리 완료된 `lot_id`를 로컬 SQLite 또는 in-memory Set에 기록
- 동일 LOT 재처리 방지 (idempotent)

### 8.3 통합 테스트 시나리오

| 시나리오 | 입력 | 기대 결과 |
| :--- | :--- | :--- |
| 정상 LOT | Mock `09_lot_end_normal.json` 기준 2792건 | AI 서버 Push 성공, 비식별화 확인 |
| ABORTED LOT | Mock `10_lot_end_aborted.json` 기준 656건 | Push 성공, `lot_status=ABORTED` 포함 |
| AI 서버 다운 | 서버 Mock 500 응답 | 재시도 6회 후 dead letter 기록 |
| DB 연결 끊김 | pg-pool 강제 종료 | 재연결 후 배치 재시작 |

### 8.4 검증 체크리스트
- [ ] 동일 LOT 두 번 트리거 → 한 번만 Push
- [ ] `node-cron` 스케줄 설정 확인 (`BATCH_CRON` env 변수)
- [ ] 통합 테스트 4개 시나리오 모두 통과
- [ ] `npm run test` 전체 통과

---

## 9. 최종 통합 검증 (모든 Task 완료 후)

### 9.1 검증 명령어
```bash
# 1. 빌드 확인
npm run build

# 2. 전체 테스트
npm run test

# 3. 타입 체크
npx tsc --noEmit

# 4. 비식별화 검증 — operator_id, strip_id, unit_id 원본값 노출 확인
grep -r "ENG-KIM\|UNIT-\|STRIP-" dist/ || echo "비식별화 OK"

# 5. 쓰기 쿼리 부재 확인
grep -rE "INSERT|UPDATE|DELETE" src/db/ || echo "read-only OK"
```

### 9.2 교차 참조 무결성 체크

| 체크 항목 | 위치 1 | 위치 2 | 일치해야 함 |
| :--- | :--- | :--- | :--- |
| 비식별화 필드 목록 | §2.1 | `anonymizer/config.ts` | 필드명 |
| 배치 페이로드 구조 | §7.2 | `pusher/index.ts` | 인터페이스 |
| 재시도 수치 | §7.3 | `pusher/retry.ts` | 대기시간 |
| TSDB 쿼리 권한 | §0.3 | `db/pool.ts` 계정명 | historian_read |

### 9.3 최종 보고 형식
```
## DS 프로젝트 Dispatcher 서버 구현 완료 보고

### 구현 통계
- 소스 파일: N개
- 테스트 파일: M개
- 테스트 커버리지: X%

### Task 완료 현황
- [x] D1 프로젝트 초기화 및 DB 연결 레이어 (P0)
- [x] D2 비식별화 모듈 (P0)
- [x] D3 TSDB 쿼리 레이어 (P0)
- [x] D4 AI 서버 Push 모듈 (P1)
- [x] D5 배치 스케줄러 + 통합 테스트 (P1)

### 검증 결과
- 빌드: PASS
- 테스트: PASS (N/N)
- 비식별화: PASS (원본 PII 미노출)
- read-only 준수: PASS

### 다음 단계 권고
1. AI 서버(Python/FastAPI) 수신 엔드포인트 구현
2. Historian 서버의 TimescaleDB 스키마 확정 후 쿼리 최종화
3. 실제 TSDB에 Mock 데이터 시딩 후 E2E 테스트
```

---

## 10. 작업 시 주의사항

### 10.1 자주 하는 실수
- ❌ `any` 타입으로 pg 쿼리 결과 받기 → 명시적 Row 인터페이스 정의 필수
- ❌ 비식별화 전 데이터를 로그에 출력 → `lot_hash`, `equipment_hash`만 로그 허용
- ❌ AI 서버 Push를 동기 방식으로 구현 → 배치 처리는 항상 비동기 (Promise.all with limit)
- ❌ `node-cron`과 LOT_END 트리거 중복 실행 → 처리 중 플래그(mutex) 필수

### 10.2 막혔을 때
- 데이터 구조 모호 → `EAP_mock_data/`의 실측 JSON 파일 기준으로 인터페이스 역산
- AI 서버 엔드포인트 미확정 → `AI_SERVER_URL` env로 추상화하고 Mock 서버로 테스트
- TimescaleDB 스키마 미확정 → Historian 서버 스키마와 협의 후 쿼리 확정

---

**End of CLAUDE.md (Dispatcher v2.0)**