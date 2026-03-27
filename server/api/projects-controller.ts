import type { IncomingMessage, ServerResponse } from 'node:http';
import type { URL } from 'node:url';

import type { RouteHandler } from '../http/router';
import { createHttpError } from '../http/http-errors';
import { readRequestJson } from '../http/request-body';
import { sendJson } from '../http/response';

type ApiContext = {
  req: IncomingMessage;
  res: ServerResponse;
  pathname: string;
  requestUrl: URL;
};

function normalizeProjectPayload(project: any, activeProjectId: string) {
  if (!project || typeof project !== 'object') {
    return null;
  }

  return {
    id: String(project.id || '').trim(),
    name: String(project.name || '').trim(),
    path: String(project.path || '').trim(),
    createdAt: String(project.createdAt || '').trim(),
    updatedAt: String(project.updatedAt || '').trim(),
    lastOpenedAt: String(project.lastOpenedAt || '').trim(),
    active: Boolean(project.id && String(project.id) === activeProjectId),
  };
}

export function createProjectsController(options: any = {}): RouteHandler<ApiContext> {
  const projectManager = options.projectManager;
  const syncActiveProject = typeof options.syncActiveProject === 'function' ? options.syncActiveProject : () => {};

  if (!projectManager) {
    return async function handleMissingProjectsController(context) {
      const { req, pathname } = context;

      if (pathname.startsWith('/api/projects') && req.method) {
        throw createHttpError(501, 'Project manager is not configured');
      }

      return false;
    };
  }

  function buildResponse() {
    const projects = projectManager.listProjects();
    const activeProjectId = projectManager.getActiveProjectId();

    return {
      activeProjectId,
      activeProject: projectManager.getActiveProject(),
      projects: projects.map((project: any) => normalizeProjectPayload(project, activeProjectId)).filter(Boolean),
    };
  }

  return async function handleProjectsRequest(context) {
    const { req, res, pathname } = context;

    if (req.method === 'GET' && pathname === '/api/projects') {
      sendJson(res, 200, buildResponse());
      return true;
    }

    if (req.method === 'POST' && pathname === '/api/projects') {
      const body = await readRequestJson(req);
      const projectPath = String(body && body.path ? body.path : '').trim();

      if (!projectPath) {
        throw createHttpError(400, 'path is required');
      }

      const project = projectManager.ensureProject({
        path: projectPath,
        name: body && body.name,
      });

      if (!project) {
        throw createHttpError(400, 'path is required');
      }
      if (project && project.id) {
        projectManager.setActiveProject(project.id);
      }
      syncActiveProject();
      sendJson(res, 201, buildResponse());
      return true;
    }

    if (req.method === 'PUT' && pathname === '/api/projects/active') {
      const body = await readRequestJson(req);
      const projectId = String(body && body.projectId ? body.projectId : '').trim();

      if (!projectId) {
        throw createHttpError(400, 'projectId is required');
      }

      projectManager.setActiveProject(projectId);
      syncActiveProject();
      sendJson(res, 200, buildResponse());
      return true;
    }

    const projectMatch = pathname.match(/^\/api\/projects\/([^/]+)$/);

    if (projectMatch && req.method === 'DELETE') {
      const projectId = decodeURIComponent(projectMatch[1]);
      projectManager.removeProject(projectId);
      syncActiveProject();
      sendJson(res, 200, buildResponse());
      return true;
    }

    return false;
  };
}
