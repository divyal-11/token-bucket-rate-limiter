import autocannon from "autocannon";

// ─── Config ──────────────────────────────────────────────────────────────────

const SERVER = "http://localhost:3000";
const CLIENT_KEY = "load-test";
const DURATION = 5;       // seconds to run the test
const CONNECTIONS = 10;   // parallel connections (concurrent request streams)

// ─── Helper: set admin config via the API ────────────────────────────────────

async function setConfig(config: Record<string, unknown>) {
  const res = await fetch(`${SERVER}/admin/limits`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientKey: CLIENT_KEY, ...config }),
  });
  const data = await res.json() as Record<string, unknown>;
  console.log("  Config set:", data);
}

// ─── Helper: run autocannon and print a summary ───────────────────────────────

async function runTest(label: string): Promise<void> {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`  ${label}`);
  console.log(`${"─".repeat(60)}`);
  console.log(`  Firing ${CONNECTIONS} connections for ${DURATION}s...\n`);

  const result = await autocannon({
    url: `${SERVER}/check?clientKey=${CLIENT_KEY}`,
    connections: CONNECTIONS,
    duration: DURATION,
  });

  const totalRequests = result.requests.total;
  const allowCount    = result["2xx"];       // HTTP 200 = ALLOW
  const denyCount     = result.non2xx;       // HTTP 429 = DENY
  const allowPct      = ((allowCount / totalRequests) * 100).toFixed(1);
  const denyPct       = ((denyCount  / totalRequests) * 100).toFixed(1);

  console.log(`  Total requests : ${totalRequests}`);
  console.log(`  ALLOW (200)    : ${allowCount} (${allowPct}%)`);
  console.log(`  DENY  (429)    : ${denyCount} (${denyPct}%)`);
  console.log(`  Throughput     : ${result.requests.average.toFixed(0)} req/s`);
  console.log(`  Latency avg    : ${result.latency.mean.toFixed(2)} ms`);
  console.log(`  Latency p99    : ${result.latency.p99} ms`);
}

// ─── Main test sequence ───────────────────────────────────────────────────────

async function main() {
  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║           Token Bucket Rate Limiter — Load Test          ║");
  console.log("╚══════════════════════════════════════════════════════════╝");

  // ── Test A: Token Bucket mode ───────────────────────────────────────────
  // capacity=10, refillRate=5/sec → 5 tokens added per second
  // Under 10 connections firing continuously, most will be denied
  // but the bucket should keep refilling and allowing ~5/sec
  console.log("\n[A] Setting up: TOKEN BUCKET mode (capacity=10, refillRate=5/sec)");
  await setConfig({ capacity: 10, refillRatePerSec: 5, mode: "token-bucket" });
  await runTest("Token Bucket — capacity=10, refillRate=5/sec");

  // ── Test B: Sliding Window mode ─────────────────────────────────────────
  // Same logical rate: 10 requests per 2 seconds (=5/sec)
  // Sliding window is stricter — once window fills, no more ALLOWs until it slides
  console.log("\n[B] Setting up: SLIDING WINDOW mode (limit=10 per 2000ms)");
  await setConfig({
    capacity: 10,
    refillRatePerSec: 5,
    mode: "sliding-window",
    windowSizeMs: 2000,
    windowLimit: 10,
  });
  await runTest("Sliding Window — limit=10 per 2000ms");

  // ── Test C: High-concurrency atomicity verification ─────────────────────
  console.log("\n[C] Verifying atomicity under 100 simultaneous requests (capacity=1)...");
  await setConfig({ capacity: 1, refillRatePerSec: 1, mode: "token-bucket" });
  const promises = [];
  for (let i = 0; i < 100; i++) {
    promises.push(fetch(`${SERVER}/check?clientKey=${CLIENT_KEY}`).then(r => r.json() as Promise<{ result: string }>));
  }
  const results = await Promise.all(promises);
  const allowCount = results.filter(r => r.result === "ALLOW").length;
  const denyCount  = results.filter(r => r.result === "DENY").length;
  console.log(`  Results: ALLOW: ${allowCount}, DENY: ${denyCount}`);
  if (allowCount === 1) {
    console.log("  ✅ ATOMICITY CONFIRMED: Exactly 1 request allowed out of 100 simultaneous requests!");
  } else {
    console.log(`  ❌ RACE CONDITION DETECTED: ${allowCount} requests allowed!`);
  }

  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║                    Load Test Complete                    ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");
}

main().catch(console.error);
