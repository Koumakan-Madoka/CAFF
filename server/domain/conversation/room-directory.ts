import { createHttpError } from '../../http/http-errors';

export function validateListRoomsArguments(input: unknown = {}) {
  const invalid = (message: string): never => {
    throw createHttpError(400, message, { code: 'pi_capability_invalid_arguments' });
  };
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return invalid('list_rooms arguments must be an object');
  }
  const args = input as Record<string, unknown>;
  if (Object.keys(args).some(key => key !== 'scope' && key !== 'limit')) {
    return invalid('list_rooms accepts only scope and limit');
  }
  const scope = args.scope === undefined ? 'same_project' : args.scope;
  const limit = args.limit === undefined ? 10 : args.limit;
  if (scope !== 'same_project' && scope !== 'all_projects') {
    return invalid('scope must be same_project or all_projects');
  }
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 30) {
    return invalid('limit must be an integer between 1 and 30');
  }
  return { scope, limit };
}
