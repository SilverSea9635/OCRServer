#!/usr/bin/env bash
# 由 GitHub Actions 通过 SSH stdin 执行，也可在 ECS 上手动运行。
set -euo pipefail

app_dir=${1:?Missing application directory}
deploy_sha=${2:?Missing commit SHA}
node_major=${3:-22}
pnpm_version=${4:-10.32.1}
node_bin=${5:-}

fail() { printf '%s\n' "$*" >&2; exit 1; }

[[ "$app_dir" == /* && "$app_dir" != / ]] || fail 'Application directory must be an absolute project path.'
[[ "$deploy_sha" =~ ^[0-9a-f]{40}$ ]] || fail 'Expected a full commit SHA.'
if [[ -n "$node_bin" ]]; then
  [[ "$node_bin" == /* && -d "$node_bin" ]] || fail 'ECS_NODE_BIN must be an existing absolute directory.'
  export PATH="$node_bin:$PATH"
fi
export CI=true GIT_TERMINAL_PROMPT=0
export GIT_SSH_COMMAND='ssh -o BatchMode=yes -o StrictHostKeyChecking=yes'

for command in git node pnpm pm2 curl flock; do
  command -v "$command" >/dev/null || fail "Missing $command. Install it for the SSH user; set ECS_NODE_BIN if needed."
done
[[ "$(node -p 'process.versions.node.split(".")[0]')" == "$node_major" ]] || fail "Install Node.js $node_major on ECS to match CI."
[[ "$(pnpm --version)" == "$pnpm_version" ]] || fail "Install pnpm $pnpm_version on ECS to match CI."

cd -P -- "$app_dir"
[[ "$(git rev-parse --show-toplevel)" == "$PWD" ]] || fail 'ECS_APP_DIR must be the root of a cloned Git repository.'
[[ "$(git branch --show-current)" == main ]] || fail 'The ECS checkout must be on branch main.'
[[ -s .env.production ]] || fail 'Create .env.production on ECS before deployment.'
if [[ -n "$(git ls-files -- '.env' '.env.*')" ]]; then
  fail 'Environment files must not be tracked in Git. Remove them from the repository before deploying.'
fi

# 同时阻止手动部署和其他工作流修改同一个目录。
exec 9>"$(git rev-parse --git-path ocrserver-deploy.lock)"
flock -n 9 || fail 'Another deployment is already using this checkout.'
git diff --quiet && git diff --cached --quiet || fail 'ECS has uncommitted tracked changes. Reconcile them before deployment.'
git fetch --no-tags origin refs/heads/main:refs/remotes/origin/main
[[ "$(git rev-parse refs/remotes/origin/main)" == "$deploy_sha" ]] || fail 'This run is stale: main has moved. Deploy the workflow for the latest commit.'
git merge-base --is-ancestor HEAD "$deploy_sha" || fail 'ECS history has diverged from main. Reconcile it before deployment.'
while IFS= read -r -d '' path; do
  case "$path" in
    .env|.env.*) fail 'The incoming commit contains environment files; refusing to overwrite server configuration.' ;;
  esac
done < <(git ls-tree -z --name-only "$deploy_sha")

# 更新到经过测试的确切提交；不强制覆盖本地修改，也不执行数据库迁移。
git merge --ff-only "$deploy_sha"
pnpm install --prod --frozen-lockfile
node --input-type=module -e 'await import("sharp");'

health_url=$(node --input-type=module <<'NODE'
import dotenv from 'dotenv';
dotenv.config({ path: '.env.production', quiet: true });
let host = process.env.MCP_HOST || '127.0.0.1';
if (host === '0.0.0.0') host = '127.0.0.1';
if (host === '::') host = '::1';
if (host.includes(':') && !host.startsWith('[')) host = `[${host}]`;
const port = Number(process.env.MCP_PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid MCP_PORT');
console.log(new URL(`http://${host}:${port}/`).href);
NODE
)

pm2 startOrRestart ecosystem.config.cjs --env production --update-env
sleep 2
for attempt in {1..12}; do
  if curl --fail --silent --show-error --connect-timeout 3 --max-time 5 "$health_url" \
    | node --input-type=module -e '
      let text = "";
      for await (const chunk of process.stdin) text += chunk;
      if (JSON.parse(text).name !== "ocr-server") process.exit(1);
    '; then
    # 同时确认目标 PM2 进程在运行，避免把其他占用端口的服务当作部署成功。
    if pm2 jlist | node --input-type=module -e '
      let text = "";
      for await (const chunk of process.stdin) text += chunk;
      const app = JSON.parse(text).find(app => app.name === "snap-ui-server");
      if (!app || app.pm2_env.status !== "online" || app.pm2_env.pm_cwd !== process.cwd()) process.exit(1);
    '; then
      pm2 save
      printf 'Deployed %s successfully.\n' "$deploy_sha"
      exit 0
    fi
  fi
  sleep 2
done
fail 'Service check failed. Inspect pm2 status and pm2 logs snap-ui-server on ECS. No automatic rollback was performed.'
