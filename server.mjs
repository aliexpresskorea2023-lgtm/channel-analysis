// server.mjs — 유튜브 평균조회수 로컬 웹앱 서버 (의존성 0, Node 18+)
//
// 실행:
//   node server.mjs                 → http://127.0.0.1:8787
//   PORT=9000 node server.mjs       → 포트 변경
//   YOUTUBE_API_KEY=AIza... node server.mjs  → 키를 서버 환경변수로 주입(화면 입력 생략 가능)
//
// 역할:
//   1) index.html 을 서빙
//   2) POST /api/yt 로 받은 YouTube Data API v3 요청을 서버가 대신 호출(프록시)해서 반환
//      → 브라우저 CORS / API키 referrer 제한 문제를 피함. 127.0.0.1 바인딩이라 로컬 전용.

import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const HOST = "127.0.0.1"; // 로컬 전용
const ENV_KEY = process.env.YOUTUBE_API_KEY || "";
const YT_BASE = "https://www.googleapis.com/youtube/v3";
const ALLOWED = new Set(["channels", "playlistItems", "videos", "search"]);

function sendJson(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && (u.pathname === "/" || u.pathname === "/index.html")) {
      const html = await readFile(path.join(__dirname, "index.html"));
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(html);
    }

    if (req.method === "GET" && u.pathname === "/config") {
      return sendJson(res, 200, { hasEnvKey: !!ENV_KEY });
    }

    if (req.method === "POST" && u.pathname === "/api/yt") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch {}
      const { path: ytPath, params = {}, key } = body;

      if (!ALLOWED.has(ytPath)) return sendJson(res, 400, { error: { message: `허용되지 않은 API path: ${ytPath}` } });
      const useKey = (key || ENV_KEY || "").trim();
      if (!useKey) return sendJson(res, 400, { error: { message: "API 키가 없습니다. 화면에 입력하거나 서버를 YOUTUBE_API_KEY와 함께 실행하세요." } });

      const target = new URL(`${YT_BASE}/${ytPath}`);
      for (const [k, v] of Object.entries(params)) if (v != null && v !== "") target.searchParams.set(k, String(v));
      target.searchParams.set("key", useKey);

      const upstream = await fetch(target.toString());
      const text = await upstream.text();
      res.writeHead(upstream.status, { "content-type": "application/json; charset=utf-8" });
      return res.end(text);
    }

    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("404 Not Found");
  } catch (e) {
    sendJson(res, 500, { error: { message: String(e && e.message || e) } });
  }
});

server.listen(PORT, HOST, () => {
  console.log("");
  console.log("  유튜브 평균조회수 · 로컬 웹앱 서버 실행 중");
  console.log("  ─────────────────────────────────────────────");
  console.log(`  브라우저에서 열기 → http://${HOST}:${PORT}`);
  console.log(`  API 키 상태      → ${ENV_KEY ? "환경변수(YOUTUBE_API_KEY) 로드됨" : "미설정 (웹 화면에서 입력)"}`);
  console.log("  중지             → Ctrl+C");
  console.log("");
});
