const { randomBytes } = require('node:crypto');
const { createServerApp } = require('../../build/server/app/create-server');
const { createInMemoryPlannerCredential } = require('../../build/server/domain/security/planner-credential');

function createTestPlannerCredential() {
  return createInMemoryPlannerCredential({ token: randomBytes(32).toString('base64url'), plannerName: 'Isolated Test Planner' });
}
function createTestServerApp(options = {}) {
  // Non-P2 tests must never discover/probe the user's real Claude installation.
  // P2 fixtures override this with an isolated fake CLI (including flag tests).
  return createServerApp({ plannerCredential: createTestPlannerCredential(), embeddedPlanner: { enabled: false }, ...options });
}
module.exports = { createTestServerApp, createTestPlannerCredential };
