/**
 * Options Rebound: dependable update trigger (Google Apps Script).
 *
 * GitHub's own schedule is "best effort" and can run late or not at all. This script, on a 5-minute
 * Apps Script timer, asks GitHub to run the "Update data and site" workflow during US market hours
 * (9:25 AM–4:20 PM Eastern, Monday–Friday). Outside those hours it does nothing.
 *
 * Setup (once, about 5 minutes):
 *  1. GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token
 *       Resource owner: Options-Rebound · Repository access: Only select repositories → options-rebound.github.io
 *       Permissions → Repository → Actions: Read and write (nothing else) · Expiration: 1 year
 *  2. script.google.com → New project → paste this file.
 *  3. Project Settings (gear) → Script properties → Add: GITHUB_TOKEN = the token from step 1.
 *  4. Run `install` once from the editor (it asks for permission to make web requests) → done.
 *     `check` sends one update right away so you can confirm it works (Actions tab on GitHub).
 *
 * The token can only start this repo's workflows. Anyone holding it could at most run the update more often.
 */
const REPO = "Options-Rebound/options-rebound.github.io";
const WORKFLOW = "update.yml";

function tick() {
  const now = new Date();
  const day = Number(Utilities.formatDate(now, "America/New_York", "u"));      // 1 = Monday … 7 = Sunday
  const hm = Number(Utilities.formatDate(now, "America/New_York", "HHmm"));
  if (day > 5 || hm < 925 || hm > 1620) return;                                 // market closed: nothing to do
  dispatch_();
}

function dispatch_() {
  const token = PropertiesService.getScriptProperties().getProperty("GITHUB_TOKEN");
  if (!token) throw new Error("Add GITHUB_TOKEN under Project Settings → Script properties.");
  const r = UrlFetchApp.fetch(`https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`, {
    method: "post", contentType: "application/json", muteHttpExceptions: true,
    headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    payload: JSON.stringify({ ref: "main" }),
  });
  if (r.getResponseCode() !== 204) throw new Error("GitHub said " + r.getResponseCode() + ": " + r.getContentText().slice(0, 200));
}

function install() {
  ScriptApp.getProjectTriggers().forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger("tick").timeBased().everyMinutes(5).create();
}

function check() { dispatch_(); }
