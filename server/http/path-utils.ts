import path from 'node:path';

/**
 * Resolve an absolute tool script path to a portable relative path suitable
 * for shell invocation from any working directory.
 */
export function resolveToolRelativePath(toolPath: string) {
  const cwd = process.cwd();
  const absolutePath = path.resolve(String(toolPath || ''));
  const relativePath = path.relative(cwd, absolutePath) || path.basename(absolutePath);
  const portablePath = relativePath.replace(/\\/g, '/');
  if (portablePath.startsWith('.') || portablePath.startsWith('/')) {
    return portablePath;
  }
  if (/^[A-Za-z]:\//.test(portablePath)) {
    return portablePath;
  }
  return `./${portablePath}`;
}
