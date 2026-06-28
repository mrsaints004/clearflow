console.log("=".repeat(60));
console.log("ClearFlow Test Suite");
console.log("=".repeat(60));

async function runAll() {
  let totalPassed = 0;
  let totalFailed = 0;

  const suites = [
    { name: "Ledger", module: () => import("./ledger.test") },
    { name: "Disputes", module: () => import("./disputes.test") },
    { name: "Portfolio", module: () => import("./portfolio.test") },
    { name: "Agent", module: () => import("./agent.test") },
    { name: "Risk", module: () => import("./risk.test") },
    { name: "Crypto", module: () => import("./crypto.test") },
    { name: "Validation", module: () => import("./validation.test") },
    { name: "Agent Learning", module: () => import("./agent-learning.test") },
  ];

  for (const suite of suites) {
    console.log(`\n${"─".repeat(60)}`);
    console.log(`Running: ${suite.name}`);
    console.log("─".repeat(60));
    try {
      const result = await suite.module();
      totalPassed += result.passed || 0;
      totalFailed += result.failed || 0;
    } catch (e: any) {
      console.error(`Suite ${suite.name} failed to load: ${e.message}`);
      totalFailed++;
    }
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`TOTAL: ${totalPassed} passed, ${totalFailed} failed, ${totalPassed + totalFailed} total`);
  console.log("=".repeat(60));

  if (totalFailed > 0) {
    process.exit(1);
  }
}

runAll();
