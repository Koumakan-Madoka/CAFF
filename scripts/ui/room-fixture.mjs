export async function resolveVerificationRoomContext(baseUrl) {
  const [projectsResponse, bootstrapResponse] = await Promise.all([
    fetch(`${baseUrl}api/projects`),
    fetch(`${baseUrl}api/bootstrap`),
  ]);
  if (!projectsResponse.ok) {
    throw new Error(`failed to list verification projects: ${projectsResponse.status}`);
  }
  if (!bootstrapResponse.ok) {
    throw new Error(`failed to load verification modes: ${bootstrapResponse.status}`);
  }
  const projectsPayload = await projectsResponse.json();
  const bootstrapPayload = await bootstrapResponse.json();
  const projects = Array.isArray(projectsPayload.projects) ? projectsPayload.projects : [];
  const modes = Array.isArray(bootstrapPayload.modes) ? bootstrapPayload.modes : [];
  const project = projects.find((item) => item && item.active) || projects[0] || null;
  const mode = modes[0] || null;
  const projectScopeId = String(project && project.id || '').trim();
  const modeId = String(mode && mode.id || '').trim();
  if (!projectScopeId || !modeId) {
    throw new Error('isolated UI verification requires one configured Project and Mode');
  }
  return { projectScopeId, modeId };
}
