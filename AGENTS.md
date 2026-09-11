# AGENTS.md — 유튜브 채널 평균 조회수 로컬 도구 (운영 매뉴얼)

이 저장소의 목적·약속·주의사항을 기록한 핸드오버 문서다. 코드를 고치기 전에 여기를 먼저 읽는다.

## 1. 목적
유튜브 채널의 **롱폼 영상 평균 조회수**를 저비용으로 조회하는 개인/로컬 전용 도구.
AliExpress Korea 유튜브 서브채널·KOL 리서치용으로, 채널의 "일반 콘텐츠 vs 광고(협찬) 콘텐츠"
평균 조회수를 비교하는 것이 핵심 사용 사례다. BI 보고에 쓸 수 있도록 근거(영상별 분류)를 남긴다.

## 2. 구성 (의존성 0, Node 18+ 내장 fetch만 사용)
- `server.mjs` — `127.0.0.1` 전용 로컬 HTTP 서버. `index.html` 서빙 + YouTube Data API v3 **프록시**(`POST /api/yt`) + 업데이트 검사(`GET /version`).
- `index.html` — 단일 파일 웹 화면(흰 배경, 장식 최소화). 채널주소→UC/UU 변환 + 평균 조회수 분석.
- `cli.mjs` — 동일 로직의 터미널 버전. 다중 채널/배치·CSV·`--selftest` 지원.
- `README.md` — 사용자 안내(로컬 pull→실행, API 키 발급, 사용법, 쿼터, 문제해결).
- `AGENTS.md`(본 문서) — 운영 규칙, `plan.md` — 기획/의사결정 과정, `design.md` — Airbnb 디자인 토큰 명세.
- `.gitignore` — `*.csv`, `.DS_Store`, `node_modules/`, `.env` 제외.

## 3. 실행
```bash
cd channel-analysis
node server.mjs                 # → http://127.0.0.1:8787
PORT=9000 node server.mjs       # 포트 변경
YOUTUBE_API_KEY=AIza... node server.mjs   # 키를 서버 env로 주입(화면 입력 생략 가능)
```
CLI: `node cli.mjs @핸들1 UC... --mode=both --csv=out.csv` / 자가검증: `node cli.mjs --selftest`

## 4. 핵심 데이터 규칙 (반드시 유지)
- **조회 전략**: `search.list`(100유닛)를 쓰지 않는다. 대신 업로드 플레이리스트(채널ID `UC`→`UU`)
  + `playlistItems.list`(1유닛, 50개/페이지, 최신순) + `videos.list`(1유닛/50개 배치). 채널당 대략 3~20유닛.
- **롱폼 정의**: `contentDetails.duration` > `SHORT_MAX_SECONDS`(=180초). 쇼츠(≤3분)는 분석에서 제외.
- **기간 창**: `RECENT_N`=최근 10개 롱폼, `RECENT_DAYS`=90일(최근 3개월). 모드 `both|10|3m`.
  - 수집은 최신순 페이지 순회. `3m`은 날짜 cutoff로 조기중단, `10`은 롱폼 10개 확보 시 조기중단,
    `both`는 cutoff 도달 **그리고** 롱폼 10개 확보 시 중단(저빈도 채널은 3개월 밖까지 소급).
- **광고 분류**: 유튜브 API는 "유료광고 여부"를 공개 필드로 주지 않는다. 따라서 `AD_PATTERNS`
  키워드 휴리스틱(제목/설명/태그: 광고·협찬·유료광고·스폰서·체험단·sponsored·#ad 등)으로 판별한다.
  - 100%가 아니므로 **영상별 표에 판별 근거 키워드를 노출**해 눈검증 가능하게 한다.
  - 오탐 방지: `DOWNLOAD`, `ADVENTURE` 등 `\bAD\b` 류 오탐은 차단(자가검증에 케이스 포함).
  - 일반 제휴링크(쿠팡파트너스 등)는 기본값에서 제외 — 광고(협찬)와 개념이 다르므로 함부로 넣지 않는다.
- **광고는 "제거"하지 않는다**: 전체 평균에 포함시키되, 일반/광고를 **각각 별도 필드로 집계·비교**한다.
  출력 카드: 전체 평균 · 일반 평균(n) · 광고 평균(n) · 광고÷일반 배율.
- **댓글 분석 (영상별 자세히)**: `commentThreads`로 최상위 댓글 **최대 500개**(5페이지=영상당 최대 5유닛,
  `order=relevance`) 수집 + 세션 캐시(재전개 시 재수집 없음). 답글(replies)은 제외.
  - **5버킷**: 상품 / 인물(크리에이터) / 콘텐츠 / 광고 인지 / 기타. **중복 허용**(한 댓글이 여러 버킷 동시 집계
    → 비중 합 100% 초과 가능, 예: "광고인건 알지만 그래도 샀어요"=상품+광고인지). 버킷 내에선 1회만.
  - **인터렉션 rate = (좋아요 + 댓글) ÷ 조회수 × 100**. 참고 카드로 조회수÷구독자 배율 병기.
  - 커스텀 키워드(상품·브랜드명)는 상품 버킷으로 취급, 캐시에서 즉시 재집계(추가 쿼터 0).
  - 키워드 라벨 휴리스틱이므로 **근거(라벨+건수)와 샘플 댓글을 노출**해 눈검증 가능하게(광고 분류와 동일 철학).

## 5. 쿼터 / API 키
- 기본 한도 **10,000 유닛/일/프로젝트**. 리셋은 한국 자정이 아니라 **태평양 시간 자정**
  (9월 PDT 기준 KST 오후 4시, 겨울 PST엔 오후 5시).
- 키 제한은 **HTTP referrer 제한을 걸지 않는다**(호출이 브라우저가 아니라 로컬 서버에서 나가므로).
  대신 **API 제한 → YouTube Data API v3만 허용**을 권장.
- 키는 화면 입력(localStorage 저장 옵션) 또는 서버 env `YOUTUBE_API_KEY`. 코드/저장소에 키를 커밋하지 않는다.

## 6. 보안 / 접근
- 서버는 `127.0.0.1`에만 바인딩(로컬 밖 접근 불가). `/api/yt`는 `channels·playlistItems·videos·search·commentThreads`만 허용.
- 개인용·로컬 전용 전제. 사내/회사 인프라와 분리해 운영한다(개인 클라우드·VPS에 회사 데이터 태우지 않음).

## 7. UI 약속
- 디자인 시스템 = `design.md`(Airbnb 토큰). 흰 캔버스 + Rausch(#ff385c) 단일 악센트, ink(#222) 텍스트,
  소프트 라운딩(버튼 8px·카드 14px·pill full), hairline(#ddd) 보더, 단일 섀도 티어, Cereal→Inter→system 폰트 스택.
  primary CTA(분석)만 Rausch, 나머지(변환/CSV)는 white+ink outline secondary.
- 평균 숫자 **옆에 개별 복사 버튼**(쉼표 없는 원본 숫자, 예 `123456`; 배율은 `2.00`). 숫자 카드는 hover 시 섀도 float.
- 영상별 분류 표: 게시일·조회수·분류(광고=Rausch tint pill / 일반=neutral pill)·길이·제목·광고 근거·상세.
  제목은 영상 링크(`watch?v=`), 마지막 칼럼 연회색 "자세히" pill → **단일 아코디언** 패널(다른 row 전개 시 기존 자동 접기).
  패널 = 인터렉션 카드 + 5버킷 구성 바(상품만 Rausch, 나머지는 그레이 음영) + 근거/샘플 댓글 + 커스텀 키워드 입력.
- CSV 다운로드(BOM 포함, 영상별 원본 데이터).
- **줄바꿈 방지**: 컨테이너/topnav/legal 최대폭 1200px(양옆 공간 활용). 형식이 고정된 짧은 요소
  (숫자+복사버튼 쌍, 표의 게시일·조회수·분류·길이 셀)는 `nowrap` + flex 고정(`flex:0 0 auto`)으로 한 줄 유지.
  늘어나는 건 제목 같은 유연한 칼럼뿐. 천만 단위 숫자에서도 접히지 않음.
- **업데이트 알림**: 서버 `GET /version` = 로컬 `git rev-parse HEAD` vs `git ls-remote origin refs/heads/main`
  (5분 캐시, `GIT_TERMINAL_PROMPT=0` → 자격증명 없으면 즉시 실패·스킵). 기계 키체인의 git 자격증명을 쓰므로
  **비공개 repo에서도 동작**(GitHub API/토 불필요). 뒤처리면 화면 상단 배너("git pull 후 새로고침"),
  푸터엔 로컬 빌드 해시(문제 리포트 시 버전 특정용). git 저장소 아니면 자동 스킵.
- 디자인 토큰은 `index.html` 상단 `:root` CSS 변수로 관리 — 색/라운딩 변경은 그곳만 수정.

## 8. Git / 배포 주의
- Mac 사내 보안 에이전트(AliEntSafe/CloudShell/AliLang)가 HTTPS `git push`를 **출력 없이 exit 128**로 막을 수 있다.
  진단: exit 128 + 무출력 + `git fetch`는 성공 = 보안 에이전트(인증/네트워크 아님). 재시도 loop 금지, 예외 요청 후 동일 push 재시도.
- 원격 저장소: `https://github.com/aliexpresskorea2023-lgtm/channel-analysis.git` (브랜치 `main`).

## 9. 검증
- `cli.mjs --selftest`: duration 파싱(경계 179s/181s 포함) + 광고 분류(협찬/sponsored/#ad/오탐방지) 13케이스.
- 서버 기동 시 `/`(HTML), `/config`(hasEnvKey), `/api/yt`(무키 400·허용외 path 400) 확인.
- `/version`: 로컬=원격이면 `behind:false`. git 저장소 아니면 `local:null`·배너 없음.
- 댓글 분석: 목업 댓글 주입 데모에서 버킷 비중·중복 집계(합 100% 초과)·근거 라벨·아코디언 단일 전개 확인.
- 한글 퍼센트인코딩 핸들 URL 디코딩 확인(예: `@%EB%B0%9C...` → `@발품파는남자`).

## 10. 보류 / 다음 작업
- `design.md`(Airbnb) 반영 완료 → `index.html` 스타일 최신화됨.
- (제안, 미확정) 한 화면에 채널 다중 입력 + 누적 유닛 사용량 표시.
- (미확정) Cereal/Inter 웹폰트 실제 로드(현재는 시스템 폴백) — 오프라인·무의존성 정책과 트레이드오프.
