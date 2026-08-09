// BUILD PROVENANCE — identifies which deployment and which code produced a
// result, so a change can be traced to its effect.
//
// Railway injects these at RUNTIME (not build time, and they do NOT appear in
// the Variables tab — they're only visible from inside the process). Several
// are reported missing in the wild depending on how a service was deployed,
// so every field falls back rather than assuming presence.
//
// Locally there is no Railway env at all, so we read git directly. That means
// results simulated on your laptop are labelled with the same commit SHA they
// would carry on Railway — the two are comparable.

import { execSync } from "node:child_process";

function gitLocal(args) {
  try {
    return execSync(`git ${args}`, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return null;
  }
}

let cached = null;

export function buildInfo() {
  if (cached) return cached;

  const env = process.env;
  const commitSha =
    env.RAILWAY_GIT_COMMIT_SHA
    || gitLocal("rev-parse HEAD")
    || "unknown";

  // RAILWAY_DEPLOYMENT_ID is documented as always present but is missing on
  // some deploy paths; snapshot id is the next-best per-deploy identifier,
  // then the commit, then a local marker.
  const deploymentId =
    env.RAILWAY_DEPLOYMENT_ID
    || env.RAILWAY_SNAPSHOT_ID
    || (env.RAILWAY_GIT_COMMIT_SHA ? `commit-${env.RAILWAY_GIT_COMMIT_SHA.slice(0, 12)}` : null)
    || `local-${commitSha.slice(0, 12)}`;

  const isRailway = Boolean(env.RAILWAY_ENVIRONMENT_NAME || env.RAILWAY_GIT_COMMIT_SHA || env.RAILWAY_DEPLOYMENT_ID);
  const dirty = !isRailway && Boolean(gitLocal("status --porcelain"));

  cached = {
    deploymentId,
    commitSha,
    // The ANALYSIS KEY. Uncommitted local edits get a "-dirty" suffix so a
    // half-finished experiment can never be mistaken for the committed code
    // it was based on.
    codeVersion: commitSha.slice(0, 12) + (dirty ? "-dirty" : ""),
    commitShort: commitSha.slice(0, 7),
    branch: env.RAILWAY_GIT_BRANCH || gitLocal("rev-parse --abbrev-ref HEAD") || null,
    commitMessage: env.RAILWAY_GIT_COMMIT_MESSAGE || gitLocal("log -1 --pretty=%s") || null,
    environment: env.RAILWAY_ENVIRONMENT_NAME || (isRailway ? "railway" : "local"),
    serviceName: env.RAILWAY_SERVICE_NAME || null,
    isRailway,
    dirty,
  };
  return cached;
}
