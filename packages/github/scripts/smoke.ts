import { github } from "../src/index.js";

async function main(): Promise<void> {
  console.log("=== checkInstalled ===");
  const installed = await github.checkInstalled();
  console.log(JSON.stringify(installed, null, 2));
  if (!installed.installed) {
    console.error("\n`gh` is not installed. Install via `brew install gh` and try again.");
    process.exit(1);
  }

  console.log("\n=== checkAuthenticated ===");
  const authed = await github.checkAuthenticated();
  console.log(JSON.stringify(authed, null, 2));
  if (!authed.authenticated) {
    console.error("\n`gh` is installed but not signed in. Run `gh auth login` and try again.");
    process.exit(1);
  }

  console.log("\nSmoke OK. The library is wired to a working `gh` install.");
}

main().catch((err) => {
  console.error("Smoke failed:", err);
  process.exit(1);
});
