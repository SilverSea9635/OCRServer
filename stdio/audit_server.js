import {
  auditProject,
  cleanWorkDir,
  createWorkDir,
  parseProject,
  writePackageJson,
  writePackageLockAndExecuteNpmAudit
} from './Utils.js';

export const audit = async (projectRoot, savePath) => {
  const workPath = await createWorkDir();
  const pkg = await parseProject(projectRoot);
  await writePackageJson(workPath, pkg);
  await writePackageLockAndExecuteNpmAudit(workPath, pkg);
  const resultPath = await auditProject(workPath, savePath);
  await cleanWorkDir(workPath);
  return resultPath;
}