// Operator-owned WikiSkill storage selection; never project/HTTP/model input.
// Explicit migration sources opt out so configuring a destination cannot make
// the migration read its own output. Unset preserves existing options verbatim.
import path from 'node:path';
const fail = () => Object.assign(Error('wiki_data_dir_invalid'), { code: 'wiki_data_dir_invalid' });
export function resolveWikiDataDirectory(agentDir: string, env: NodeJS.ProcessEnv = process.env) {
  const value = env.CAFF_WIKISKILL_DATA_DIR;
  if (value === undefined) return agentDir;
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) throw fail();
  return path.resolve(value);
}
export function resolveWikiStorageOptions(options: any, env: NodeJS.ProcessEnv = process.env) {
  if (options?.globalRoot === undefined || options.useConfiguredWikiDataDir === false || env.CAFF_WIKISKILL_DATA_DIR === undefined) return options;
  return { ...options, globalRoot: path.join(resolveWikiDataDirectory('', env), 'badcase-global') };
}
export function resolveWikiInstanceCaptureRoot(options: any, env: NodeJS.ProcessEnv = process.env) {
  if (options.instanceCaptureRoot !== undefined) {
    if (typeof options.instanceCaptureRoot !== 'string' || !path.isAbsolute(options.instanceCaptureRoot) || options.instanceCaptureRoot.includes('\0')) throw fail();
    return path.resolve(options.instanceCaptureRoot);
  }
  if (env.CAFF_WIKISKILL_DATA_DIR === undefined || options.useConfiguredWikiDataDir === false) return path.resolve(options.globalRoot, '..', 'badcase-capture');
  // Use the same default as the server; CLI operators must supply the instance's
  // PI_CODING_AGENT_DIR when it differs. Never infer it from an imported root.
  const agentDir = env.PI_CODING_AGENT_DIR || require('../../../../lib/minimal-pi').DEFAULT_AGENT_DIR;
  return path.resolve(agentDir, 'badcase-capture');
}
