import fs from 'fs';
import path, { join } from 'path';
import { randomUUID } from 'crypto';
import { execSync } from 'child_process';

function ensureNumber(value, fieldName) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new Error(`${fieldName} 必须是有效数字`);
  }
}

function ensureNonEmptyString(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${fieldName} 不能为空`);
  }
}

export function addNumbers(a, b) {
  ensureNumber(a, 'a');
  ensureNumber(b, 'b');

  return a + b;
}

export async function createFileInDirectory(directoryPath, fileName, content = '') {
  ensureNonEmptyString(directoryPath, 'directoryPath');
  ensureNonEmptyString(fileName, 'fileName');

  if (path.basename(fileName) !== fileName) {
    throw new Error('fileName 不能包含目录层级');
  }

  if (typeof content !== 'string') {
    throw new Error('content 必须是字符串');
  }

  const resolvedDirectory = path.resolve(directoryPath);
  const filePath = path.join(resolvedDirectory, fileName);

  await fs.mkdir(resolvedDirectory, { recursive: true });
  await fs.writeFile(filePath, content, 'utf8');

  return {
    filePath,
    contentLength: Buffer.byteLength(content, 'utf8'),
  };
}

export async function createWorkDir() {
  const __dirname = import.meta.dirname.split('/').slice(0, -1).join('/');
  const workPath = join(__dirname, `work_${randomUUID()}`);
  await fs.promises.mkdir(workPath, { recursive: true });
  return workPath;
}


export async function parseProject(root) {
  if ( root.startsWith('http://') || root.startsWith('https://') ) {
    return await parseRemoteProject(root)
  }
  return parseLocalProject(root)
}

const parseRemoteProject = async (root) => {
  // https://github.com/owner/repo -> owner/repo
  const match = root.match(/github\.com\/([^/]+\/[^/.]+?)(?:\.git)?$/);
  if (!match) throw new Error(`Invalid GitHub URL: ${root}`);
  const repoPath = match[1];

  // 通过 API 获取默认分支名
  const repoRes = await fetch(`https://api.github.com/repos/${repoPath}`);
  if (!repoRes.ok) throw new Error(`Cannot fetch repo info: ${root}`);
  const { default_branch } = await repoRes.json();
  // 用默认分支名拼接 raw 地址（通过镜像代理加速访问）
  const rawUrl = `https://raw.githubusercontent.com/${repoPath}/${default_branch}/package.json`;
  const mirrors = [
    `https://ghfast.top/${rawUrl}`,
    rawUrl,
  ];
  for (const url of mirrors) {
    try {
      const pkgRes = await fetch(url);
      if (pkgRes.ok) return pkgRes.json();
    } catch {}
  }
  throw new Error(`Cannot fetch package.json from ${root}`);
}

const parseLocalProject = async (root) => {
  const packageJson = path.join(root, 'package.json');
  const json = await fs.promises.readFile(packageJson, 'utf-8');
  return JSON.parse(json)
}

export async function writePackageJson(root, pkg) {
  const packageJson = path.join(root, 'package.json');
  await fs.promises.writeFile(packageJson, JSON.stringify(pkg, null, 2));
}

export async function writePackageLockAndExecuteNpmAudit(workPath) {
  // 执行 npm i --package-lock-only
  execSync('npm i --package-lock-only', { cwd: workPath, stdio: 'inherit' });

  return join(workPath, 'package-lock.json');
}

export async function auditProject(workDir, savePath) {
  // 执行 pnpm audit 获取 JSON 格式结果
  let auditData;
  try {
    const output = execSync('pnpm audit --json', { cwd: workDir, encoding: 'utf-8' });
    auditData = JSON.parse(output);
  } catch (e) {
    // pnpm audit 有漏洞时会以非零状态退出，但输出仍是合法 JSON
    if (e.stdout) {
      auditData = JSON.parse(e.stdout);
    } else {
      throw e;
    }
  }

  // 解析漏洞数据并生成 markdown
  const advisories = auditData.advisories ?? {};
  const vulnerabilities = auditData.vulnerabilities ?? {};
  const metadata = auditData.metadata ?? {};

  const total = metadata.vulnerabilities
    ? Object.values(metadata.vulnerabilities).reduce((sum, v) => sum + v, 0)
    : Object.keys(vulnerabilities).length;

  let md = `# Security Audit Report\n\n`;
  md += `- **Total vulnerabilities**: ${total}\n`;

  if (metadata.vulnerabilities) {
    const levels = metadata.vulnerabilities;
    md += `- **Critical**: ${levels.critical ?? 0} | **High**: ${levels.high ?? 0} | **Moderate**: ${levels.moderate ?? 0} | **Low**: ${levels.low ?? 0}\n`;
  }
  md += `\n`;

  // 优先用 vulnerabilities（pnpm v9+ 格式）
  if (Object.keys(vulnerabilities).length > 0) {
    md += `## Vulnerabilities\n\n`;
    md += `| Package | Severity | Via | Fix Available |\n`;
    md += `| --- | --- | --- | --- |\n`;
    for (const [name, info] of Object.entries(vulnerabilities)) {
      const severity = info.severity ?? 'unknown';
      const via = Array.isArray(info.via)
        ? info.via.map(v => typeof v === 'string' ? v : v.title ?? v.name ?? '').join(', ')
        : String(info.via ?? '');
      const fix = info.fixAvailable ? 'Yes' : 'No';
      md += `| ${name} | ${severity} | ${via} | ${fix} |\n`;
    }
  }

  // 兼容旧格式 advisories
  if (Object.keys(advisories).length > 0) {
    md += `## Advisories\n\n`;
    md += `| Package | Severity | Title | Patched Versions |\n`;
    md += `| --- | --- | --- | --- |\n`;
    for (const [, adv] of Object.entries(advisories)) {
      const severity = adv.severity ?? 'unknown';
      const title = adv.title ?? '';
      const patched = adv.patched_versions ?? 'None';
      md += `| ${adv.module_name} | ${severity} | ${title} | ${patched} |\n`;
    }
  }

  if (total === 0) {
    md += `No known vulnerabilities found.\n`;
  }

  // 写入 auditResult.md 到指定目录
  await fs.promises.mkdir(savePath, { recursive: true });
  const resultPath = join(savePath, 'auditResult.md');
  await fs.promises.writeFile(resultPath, md);

  return resultPath;
}

export async function cleanWorkDir(workDir) {
  const files = ['package.json', 'package-lock.json'];
  for (const file of files) {
    const filePath = join(workDir, file);
    try {
      await fs.promises.unlink(filePath);
    } catch {}
  }
}


