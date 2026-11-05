// One lexical grammar for host and container replay paths. Never normalize or
// repair names: accepted Unicode (including BOM/U+FFFD) must remain byte-exact.
// Distribution-only namespaces are explicit; captured workfiles use defaults.
export function isSafeRelativePath(value: unknown, options: { allowGit?: boolean; allowNodeModules?: boolean } = {}): value is string {
  if (typeof value !== 'string' || !value || /[\\<>:"|?*\x00-\x1f\x7f-\x9f]/.test(value)
    || Buffer.from(value, 'utf8').toString('utf8') !== value) return false;
  return value.split('/').every(part => part && part !== '.' && part !== '..' && !/[ .]$/.test(part)
    && (options.allowGit === true || part.toLowerCase() !== '.git')
    && (options.allowNodeModules === true || part.toLowerCase() !== 'node_modules')
    && !/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)(?:[ .]|$)/i.test(part));
}
// Trusted static package/transport inventory only, NOT a captured file bypass.
export function isSafeDistributionPath(value: unknown): value is string {
  return isSafeRelativePath(value, { allowGit: true, allowNodeModules: true });
}
