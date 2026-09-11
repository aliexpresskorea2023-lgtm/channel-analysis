#!/usr/bin/env node
/**
 * yt-avg-views.mjs — 유튜브 채널 "롱폼" 영상 평균 조회수 계산기
 *
 * 무엇을 하나
 *  - 채널의 최근 업로드를 최신순으로 가져와서
 *  - 쇼츠(3분 이하)는 제외한 "롱폼"만 대상으로
 *  - 각 영상을 [일반] / [광고(협찬)] 로 분류하고
 *  - "최근 10개" 와 "최근 3개월" 두 기준의 평균 조회수를 각각 출력한다.
 *  - 광고는 걸러내지 않고, 일반 vs 광고 평균을 나란히 비교할 수 있게 보여준다.
 *
 * 왜 저렴한가 (YouTube Data API v3 쿼터)
 *  - search.list(100유닛)를 쓰지 않고,
 *    업로드 플레이리스트(채널ID의 UC→UU) + playlistItems.list(1유닛) + videos.list(1유닛/50개) 조합.
 *  - 채널 1개당 보통 2~10유닛. 기본 일일 쿼터 10,000유닛이면 하루 수백 개 채널 가능.
 *
 * 준비물
 *  - Node 18+ (내장 fetch 사용, npm install 불필요)
 *  - YouTube Data API v3 키. 환경변수 YOUTUBE_API_KEY 또는 --key=XXXX 로 전달.
 *
 * 사용법
 *  export YOUTUBE_API_KEY="AIza..."
 *  node yt-avg-views.mjs UCxxxxxxxxxxxxxxxxxxxxxx
 *  node yt-avg-views.mjs @handle
 *  node yt-avg-views.mjs UCxxxx UCyyyy --mode=3m       # 최근 3개월만
 *  node yt-avg-views.mjs UCxxxx --mode=10              # 최근 10개만
 *  node yt-avg-views.mjs UCxxxx --csv=report.csv       # 영상별 상세 CSV 저장
 *  node yt-avg-views.mjs UCxxxx --json                 # 기계판독용 JSON 출력
 *  node yt-avg-views.mjs --selftest                    # 네트워크 없이 분류/파싱 로직만 검증
 *
 * ⚠️ 광고 분류는 "키워드 휴리스틱"입니다. 유튜브 API는 '유료광고 여부'를 공개 필드로 주지
 *    않으므로, 제목/설명/태그의 협찬·광고 문구를 보고 판단합니다. --csv 또는 상세 로그로
 *    어떤 키워드에 걸렸는지 확인하고, 아래 AD_PATTERNS 를 직접 수정해 정밀도를 올리세요.
 */

const API_BASE = "https://www.googleapis.com/youtube/v3";

// ─────────────────────────────────────────────────────────────
// 설정 (필요하면 직접 수정)
// ─────────────────────────────────────────────────────────────
const SHORT_MAX_SECONDS = 180;      // 이 이하(=3분)이면 쇼츠로 간주하고 제외
const RECENT_DAYS = 90;             // "최근 3개월" = 90일
const RECENT_N = 10;                // "최근 10개"
const MAX_PAGES = 20;               // 채널당 최대 페이지(=최대 1000개 영상) 안전장치

// 광고(협찬/스폰서) 판별 키워드. 대소문자 구분 없음.
// 오탐을 줄이려 일반 제휴링크(쿠팡파트너스 등)는 기본값에서 뺐습니다. 필요하면 추가하세요.
const AD_PATTERNS = [
  /광고/, /협찬/, /유료광고/, /유료\s*광고/, /스폰서/, /체험단/, /원고료/,
  /대가성?/, /제휴\s*광고/, /지원받아/, /제공받아/, /무상제공/, /증정받/,
  /\bsponsored?\b/i, /\bsponsorship\b/i, /\bbrand\s*deal\b/i,
  /\bpaid\s+(?:promotion|partnership|ad)\b/i, /\b#?ad\b/i, /\badvertorial\b/i,
  /\bpromo\s*code\b/i, /includes?\s+paid/i,
];

// ─────────────────────────────────────────────────────────────
// 헬퍼
// ─────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { positional: [], mode: "both", csv: null, json: false, key: null, selftest: false };
  for (const a of argv) {
    if (a === "--selftest") args.selftest = true;
    else if (a === "--json") args.json = true;
    else if (a.startsWith("--mode=")) args.mode = a.slice(7);
    else if (a.startsWith("--csv=")) args.csv = a.slice(6);
    else if (a.startsWith("--key=")) args.key = a.slice(6);
    else if (a.startsWith("--")) throw new Error(`알 수 없는 옵션: ${a}`);
    else args.positional.push(a);
  }
  if (!["both", "10", "3m"].includes(args.mode)) throw new Error(`--mode 는 both|10|3m 만 가능 (받은값: ${args.mode})`);
  return args;
}

// ISO8601 duration("PT1H2M3S") → 초
function parseDuration(iso) {
  if (!iso) return 0;
  const m = String(iso).match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!m) return 0;
  const [, d, h, mi, s] = m;
  return Number(d || 0) * 86400 + Number(h || 0) * 3600 + Number(mi || 0) * 60 + Number(s || 0);
}

// 채널 입력(UC…, @handle, /channel/UC…, /@handle URL) → 정규화
function parseChannelInput(input) {
  const s = input.trim();
  let m;
  if ((m = s.match(/\/channel\/(UC[\w-]{22})/))) return { type: "id", value: m[1] };
  if ((m = s.match(/^UC[\w-]{22}$/))) return { type: "id", value: s };
  if ((m = s.match(/\/@([\w.\-]+)/))) return { type: "handle", value: "@" + m[1] };
  if ((m = s.match(/^@[\w.\-]+$/))) return { type: "handle", value: s };
  return { type: "handle", value: s.startsWith("@") ? s : "@" + s };
}

// 제목/설명/태그에서 광고 문구 매칭 → { isAd, matched: [...] , where }
function classifyAd(snippet) {
  const title = snippet?.title || "";
  const desc = snippet?.description || "";
  const tags = snippet?.tags || [];
  const matched = [];
  let where = null;
  const test = (text, label) => {
    for (const re of AD_PATTERNS) {
      if (re.test(text)) {
        matched.push(`${label}:${re.source.replace(/\\b|\b|\\s\*\??/g, "").slice(0, 18)}`);
        if (!where) where = label;
      }
    }
  };
  test(title, "title");
  test(desc, "desc");
  test(tags.join(" "), "tag");
  return { isAd: matched.length > 0, matched: [...new Set(matched)], where };
}

const nf = (n) => (n == null ? "—" : Math.round(n).toLocaleString("ko-KR"));

function summarize(videos) {
  const all = videos;
  const ads = videos.filter((v) => v.isAd);
  const normal = videos.filter((v) => !v.isAd);
  const avg = (arr) => (arr.length ? arr.reduce((s, v) => s + v.views, 0) / arr.length : null);
  return {
    n: all.length, avgAll: avg(all),
    nNormal: normal.length, avgNormal: avg(normal),
    nAd: ads.length, avgAd: avg(ads),
  };
}

// ─────────────────────────────────────────────────────────────
// YouTube Data API 호출
// ─────────────────────────────────────────────────────────────
async function ytGet(path, params, key) {
  const url = new URL(`${API_BASE}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  url.searchParams.set("key", key);
  const res = await fetch(url.toString());
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`YouTube API ${res.status} ${path}: ${body.slice(0, 400)}`);
  }
  return res.json();
}

async function resolveChannel(input, key) {
  const parsed = parseChannelInput(input);
  const params = parsed.type === "id"
    ? { part: "snippet,contentDetails", id: parsed.value }
    : { part: "snippet,contentDetails", forHandle: parsed.value.replace(/^@/, "") };
  const j = await ytGet("channels", params, key);
  if (!j.items || !j.items.length) throw new Error(`채널을 찾을 수 없음: ${input}`);
  const ch = j.items[0];
  const uploads = ch.contentDetails?.relatedPlaylists?.uploads
    || ch.id.replace(/^UC/, "UU");
  return { id: ch.id, title: ch.snippet?.title || ch.id, uploads };
}

// 업로드 플레이리스트를 최신순으로 페이지 순회. {videoId, publishedAt} 배열 반환.
async function fetchUploadIds(uploads, key, { since, stopAtLong }) {
  const ids = [];
  let pageToken = "";
  let pages = 0;
  let reachedCutoff = false;
  do {
    pages++;
    const j = await ytGet("playlistItems", {
      part: "contentDetails", maxResults: 50, playlistId: uploads,
      ...(pageToken ? { pageToken } : {}),
    }, key);
    for (const it of j.items || []) {
      const vid = it.contentDetails?.videoId;
      const pub = it.contentDetails?.videoPublishedAt;
      if (!vid) continue;
      if (since && pub && new Date(pub) < since) { reachedCutoff = true; continue; }
      ids.push({ videoId: vid, publishedAt: pub });
    }
    pageToken = j.nextPageToken || "";
    if (reachedCutoff) break;
    // stopAtLong 콜백: 지금까지 모은 영상으로 충분하면 조기 중단
    if (stopAtLong && await stopAtLong(ids)) break;
  } while (pageToken && pages < MAX_PAGES);
  return ids;
}

async function fetchVideoDetails(videoIds, key) {
  const out = new Map();
  for (let i = 0; i < videoIds.length; i += 50) {
    const batch = videoIds.slice(i, i + 50);
    const j = await ytGet("videos", {
      part: "snippet,contentDetails,statistics", id: batch.join(","),
    }, key);
    for (const v of j.items || []) {
      const dur = parseDuration(v.contentDetails?.duration);
      out.set(v.id, {
        id: v.id,
        title: v.snippet?.title || "",
        publishedAt: v.snippet?.publishedAt || "",
        durationSec: dur,
        isShort: dur > 0 && dur <= SHORT_MAX_SECONDS,
        views: Number(v.statistics?.viewCount || 0),
        ...classifyAd(v.snippet),
      });
    }
  }
  return out;
}

async function analyzeChannel(input, key, mode) {
  const ch = await resolveChannel(input, key);
  const since = mode === "10" ? null : new Date(Date.now() - RECENT_DAYS * 86400000);

  // mode=10 은 "롱폼 10개"가 모이면 조기 중단 (쇼츠 때문에 페이지가 더 필요할 수 있음)
  // 이미 조회한 id는 다시 API를 부르지 않도록 processedIdx로 신규분만 처리한다.
  let longSeen = 0;
  let processedIdx = 0;
  const stopAtLong = mode === "10"
    ? async (idsSoFar) => {
        const fresh = idsSoFar.slice(processedIdx).map((x) => x.videoId);
        processedIdx = idsSoFar.length;
        if (fresh.length) {
          const details = await fetchVideoDetails(fresh, key);
          longSeen += [...details.values()].filter((v) => !v.isShort).length;
        }
        return longSeen >= RECENT_N;
      }
    : null;

  const ids = await fetchUploadIds(ch.uploads, key, { since, stopAtLong });
  const details = await fetchVideoDetails(ids.map((x) => x.videoId), key);

  // 최신순 정렬 + 롱폼만
  let vids = [...details.values()]
    .filter((v) => !v.isShort)
    .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

  const results = { channel: ch, windows: {} };

  if (mode === "10" || mode === "both") {
    results.windows.recent10 = { label: `최근 ${RECENT_N}개 롱폼`, videos: vids.slice(0, RECENT_N) };
  }
  if (mode === "3m" || mode === "both") {
    const cutoff = new Date(Date.now() - RECENT_DAYS * 86400000);
    const in3m = vids.filter((v) => new Date(v.publishedAt) >= cutoff);
    results.windows.recent3m = { label: `최근 ${RECENT_DAYS}일(3개월) 롱폼`, videos: in3m };
  }
  for (const w of Object.values(results.windows)) w.stats = summarize(w.videos);
  return results;
}

// ─────────────────────────────────────────────────────────────
// 출력
// ─────────────────────────────────────────────────────────────
function printText(r) {
  console.log(`\n══ 채널: ${r.channel.title}  (${r.channel.id}) ══`);
  for (const w of Object.values(r.windows)) {
    const s = w.stats;
    console.log(`\n[${w.label}]  분석 영상 ${s.n}개`);
    console.log(`  전체 평균 : ${nf(s.avgAll)}회`);
    console.log(`  일반 평균 : ${nf(s.avgNormal)}회  (n=${s.nNormal})`);
    console.log(`  광고 평균 : ${nf(s.avgAd)}회  (n=${s.nAd})`);
    if (s.nAd && s.nNormal && s.avgNormal) {
      const ratio = s.avgAd / s.avgNormal;
      console.log(`  → 광고가 일반의 ${ratio.toFixed(2)}배`);
    }
  }
  // 영상별 상세 (광고 분류 검증용)
  const allVids = Object.values(r.windows).flatMap((w) => w.videos);
  const seen = new Set();
  const rows = allVids.filter((v) => (seen.has(v.id) ? false : seen.add(v.id)));
  console.log(`\n[영상별 분류] (총 ${rows.length}개, 광고 판별 근거 포함)`);
  console.log("  날짜        조회수      분류  제목 / 근거");
  for (const v of rows) {
    const d = v.publishedAt.slice(0, 10);
    const tag = v.isAd ? `광고` : `일반`;
    const why = v.isAd ? `  ⟵ ${v.matched.join(", ")}` : "";
    console.log(`  ${d}  ${String(nf(v.views)).padStart(10)}  ${tag}  ${v.title.slice(0, 42)}${why}`);
  }
}

const CSV_HEADER = ["channelId", "videoId", "publishedAt", "views", "durationSec", "class", "adKeywords", "title"];

// 영상별 상세 행(CSV body)만 반환. 헤더는 호출부가 한 번만 붙인다.
function csvRows(r) {
  const seen = new Set();
  const rows = Object.values(r.windows).flatMap((w) => w.videos).filter((v) => (seen.has(v.id) ? false : seen.add(v.id)));
  return rows.map((v) => [
    r.channel.id, v.id, v.publishedAt, v.views, v.durationSec,
    v.isAd ? "ad" : "normal", `"${v.matched.join(";")}"`, `"${(v.title || "").replace(/"/g, '""')}"`,
  ].join(","));
}

// ─────────────────────────────────────────────────────────────
// 자가검증 (네트워크 불필요)
// ─────────────────────────────────────────────────────────────
function selftest() {
  let pass = 0, fail = 0;
  const eq = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
    ok ? pass++ : fail++;
  };
  // duration 파싱
  eq("dur PT1H2M3S", parseDuration("PT1H2M3S"), 3723);
  eq("dur PT5M", parseDuration("PT5M"), 300);
  eq("dur PT30S", parseDuration("PT30S"), 30);
  eq("dur PT2M59S(롱폼경계)", parseDuration("PT2M59S"), 179);
  eq("dur PT3M1S", parseDuration("PT3M1S"), 181);
  // 쇼츠 판별 경계
  eq("179s → 쇼츠", parseDuration("PT2M59S") <= SHORT_MAX_SECONDS, true);
  eq("181s → 롱폼", parseDuration("PT3M1S") <= SHORT_MAX_SECONDS, false);
  // 광고 분류
  eq("협찬 → 광고", classifyAd({ title: "이번 영상은 OO브랜드 협찬입니다" }).isAd, true);
  eq("sponsored → 광고", classifyAd({ description: "This video is sponsored by X" }).isAd, true);
  eq("#ad 태그 → 광고", classifyAd({ tags: ["#ad"] }).isAd, true);
  eq("일반 영상 → 일반", classifyAd({ title: "아이폰 17 개봉기", description: "그냥 리뷰" }).isAd, false);
  eq("DOWNLOAD 오탐 방지", classifyAd({ title: "DOWNLOAD the app now" }).isAd, false);
  eq("ADVENTURE 오탐 방지", classifyAd({ title: "My ADVENTURE in Seoul" }).isAd, false);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

// ─────────────────────────────────────────────────────────────
// 메인
// ─────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selftest) return selftest();

  const key = args.key || process.env.YOUTUBE_API_KEY;
  if (!key) {
    console.error("❌ YouTube API 키가 없습니다. export YOUTUBE_API_KEY=\"AIza...\" 또는 --key=AIza... 로 전달하세요.");
    console.error("   (발급: https://console.cloud.google.com → YouTube Data API v3 활성화 → 사용자 인증 정보 → API 키)");
    process.exit(2);
  }
  if (!args.positional.length) {
    console.error("❌ 채널 ID(UC…), 핸들(@…), 또는 채널 URL을 인자로 주세요. 예: node yt-avg-views.mjs @handle");
    process.exit(2);
  }

  const all = [];
  const csvBody = [];
  for (const input of args.positional) {
    try {
      const r = await analyzeChannel(input, key, args.mode);
      all.push(r);
      if (!args.json) printText(r);
      if (args.csv) csvBody.push(...csvRows(r));
    } catch (e) {
      console.error(`\n⚠️ ${input} 처리 실패: ${e.message}`);
    }
  }

  if (args.json) console.log(JSON.stringify(all, null, 2));
  if (args.csv) {
    const fs = await import("node:fs");
    fs.writeFileSync(args.csv, [CSV_HEADER.join(","), ...csvBody].join("\n") + "\n");
    console.log(`\n💾 CSV 저장됨: ${args.csv}  (${csvBody.length}행)`);
  }
}

main().catch((e) => { console.error("치명적 오류:", e.message); process.exit(1); });
