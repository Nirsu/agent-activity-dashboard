// Shared by server-side code retrieval and the portable working-copy capture helper.
const sensitivePath =
  /(^|\/)(\.git|\.env[^/]*|\.npmrc|\.yarnrc(?:\.yml)?|\.pypirc|\.?netrc|_netrc|\.git-credentials|\.gitconfig|\.ssh|\.aws|\.azure|\.kube|\.gnupg|\.docker|\.codex|[^/]*(?:secret|credential|private[-_]?key)[^/]*|node_modules|dist|build|coverage|target|\.next|\.nuxt|\.turbo|\.venv|venv|__pycache__|\.pytest_cache)(\/|$)|\.(pem|key|p12|pfx)$/i;

function isSensitivePath(path) {
  return sensitivePath.test(path);
}

module.exports = { isSensitivePath };
