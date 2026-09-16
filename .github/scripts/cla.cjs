'use strict';
const { isDeepStrictEqual: equal } = require('node:util');
const LEDGER = 'CLA-SIGNATURES.json';
const ACCEPT = 'I have read the Singhouse Contributor License Agreement and I hereby agree to it.';
const fail = message => { throw new Error(message); };
const id = value => Number.isSafeInteger(value) && value > 0;

function validateLedger(ledger) {
  if (ledger.version !== 1 || !ledger.cla_version ||
      !Array.isArray(ledger.owners) || !Array.isArray(ledger.signatures) ||
      !Array.isArray(ledger.corporate)) fail('Invalid ledger schema.');
  for (const owner of ledger.owners) if (!id(owner.id)) fail('Verify owner numeric account IDs before activation.');
  for (const s of ledger.signatures) if (!id(s.id) || !s.cla_version) fail('Invalid individual record.');
  for (const c of ledger.corporate) {
    if (!c.cla_version || !Array.isArray(c.designated_contributors)) fail('Invalid corporate record.');
    for (const d of c.designated_contributors) if (!id(d.id)) fail('Invalid corporate account ID.');
  }
}

function check({ ledger, proposed, pr, files, commits }) {
  validateLedger(ledger);
  if (!commits.length || commits.length !== pr.commits || commits.length > 250)
    fail('Incomplete commit list or unsupported PR size; split the PR.');
  if (commits.at(-1).sha !== pr.head.sha) fail('Commit list does not end at the evaluated head SHA.');
  if (files.length !== pr.changed_files || files.length >= 3000)
    fail('Incomplete file list or unsupported PR size; split the PR.');
  const owners = new Set(ledger.owners.map(o => o.id));
  const touchesLedger = files.some(f => f.filename === LEDGER || f.previous_filename === LEDGER);
  if (touchesLedger) {
    if (files.length !== 1 || files[0].filename !== LEDGER || files[0].status !== 'modified' || files[0].previous_filename)
      fail('Ledger changes must be a separate, modified-ledger-only PR.');
    validateLedger(proposed);
    // PR creator is authenticated by GitHub; a commit's author field alone is not.
    if (owners.has(pr.user.id) && pr.head.repo.id === pr.base.repo.id) {
      return 'Company representative ledger maintenance: Owner review required before merge.';
    }
    if (!id(pr.user.id) || commits.length !== 1 || commits[0].author?.id !== pr.user.id ||
        commits[0].commit.message !== ACCEPT) fail('Signature needs one acceptance commit by the PR author.');
    const before = { ...ledger, signatures: [] };
    const after = { ...proposed, signatures: [] };
    if (!equal(before, after) || proposed.signatures.length !== ledger.signatures.length + 1 ||
        !equal(proposed.signatures.slice(0, -1), ledger.signatures)) fail('Only append your own signature; existing data must remain unchanged.');
    const s = proposed.signatures.at(-1);
    const required = ['login', 'id', 'name', 'email', 'cla_version', 'signed_at', 'reference'];
    if (required.some(k => !Object.hasOwn(s, k)) ||
        Object.keys(s).some(k => ![...required, 'employer'].includes(k)) ||
        s.id !== pr.user.id || s.login !== pr.user.login || s.cla_version !== ledger.cla_version ||
        ![s.name, s.email].every(v => typeof v === 'string' && v.trim()) ||
        !/^\d{4}-\d{2}-\d{2}$/.test(s.signed_at) ||
        new Date(s.signed_at).toISOString().slice(0, 10) !== s.signed_at ||
        s.reference !== '' || (s.employer !== undefined && (typeof s.employer !== 'string' || !s.employer.trim())) ||
        ledger.signatures.some(old => old.id === s.id && old.cla_version === s.cla_version))
      fail('Invalid signature entry or duplicate current acceptance.');
    return 'Valid signature proposal; acceptance takes effect only when the Owner merges it.';
  }
  const covered = new Set(ledger.signatures.filter(s => s.cla_version === ledger.cla_version).map(s => s.id));
  for (const c of ledger.corporate) if (c.cla_version === ledger.cla_version)
    for (const d of c.designated_contributors) covered.add(d.id);
  if (!owners.has(pr.user.id) && !covered.has(pr.user.id))
    fail('The authenticated PR creator must also have current CLA coverage.');
  for (const c of commits) {
    if (/^\s*Co-authored-by\s*:/im.test(c.commit.message)) fail('Co-authors require individual verification; this check cannot resolve trailers.');
    if (!id(c.author?.id)) fail('Unresolved commit author; link the author email to a GitHub account.');
    // No username-suffix, bot, or web-flow exemptions. Explicit trusted coverage only.
    if (!owners.has(c.author.id) && !covered.has(c.author.id)) fail(`Commit ${c.sha} has an uncovered author (account ${c.author.id}).`);
  }
  return `All commit authors are covered for CLA ${ledger.cla_version}.`;
}

async function run({ github, context, core }) {
  const fs = require('node:fs');
  const { owner, repo } = context.repo;
  const pull_number = context.payload.pull_request.number;
  const { data: pr } = await github.rest.pulls.get({ owner, repo, pull_number });
  if (pr.base.ref !== 'main') fail('CLA gate supports only pull requests targeting main.');
  if (pr.head.sha !== context.payload.pull_request.head.sha || pr.base.sha !== context.payload.pull_request.base.sha)
    fail('PR changed since this run was queued; update and rerun.');
  const [files, commits] = await Promise.all([
    github.paginate(github.rest.pulls.listFiles, { owner, repo, pull_number, per_page: 100 }),
    github.paginate(github.rest.pulls.listCommits, { owner, repo, pull_number, per_page: 100 }),
  ]);
  const ledger = JSON.parse(fs.readFileSync(LEDGER, 'utf8'));
  let proposed;
  if (files.some(f => f.filename === LEDGER)) {
    const headRepo = { owner: pr.head.repo.owner.login, repo: pr.head.repo.name };
    const { data: headCommit } = await github.rest.repos.getCommit({ ...headRepo, ref: pr.head.sha });
    if (headCommit.sha !== pr.head.sha) fail('Head commit did not resolve exactly.');
    const { data: tree } = await github.rest.git.getTree({ ...headRepo, tree_sha: headCommit.commit.tree.sha });
    const entry = tree.tree.find(item => item.path === LEDGER);
    if (tree.truncated || !entry || entry.type !== 'blob' || entry.mode !== '100644')
      fail('Ledger must be a regular non-executable file, not a symlink.');
    const { data } = await github.rest.repos.getContent({ owner: pr.head.repo.owner.login,
      repo: pr.head.repo.name, path: LEDGER, ref: pr.head.sha });
    if (data.sha !== entry.sha || data.type !== 'file' || data.encoding !== 'base64' || data.size > 1024 * 1024)
      fail('Ledger must be a regular JSON file of at most 1 MiB.');
    proposed = JSON.parse(Buffer.from(data.content, 'base64').toString('utf8'));
  }
  const result = check({ ledger, proposed, pr, files, commits });
  const { data: latest } = await github.rest.pulls.get({ owner, repo, pull_number });
  if (latest.head.sha !== pr.head.sha || latest.base.sha !== pr.base.sha)
    fail('PR changed during verification; update and rerun.');
  core.info(result);
}
module.exports = { check, run, ACCEPT };
