const { randomBytes } = require('node:crypto');
const { createServerApp } = require('../../build/server/app/create-server');
const { createInMemoryPlannerCredential } = require('../../build/server/domain/security/planner-credential');

function createTestPlannerCredential() {
  return createInMemoryPlannerCredential({ token: randomBytes(32).toString('base64url'), plannerName: 'Isolated Test Planner' });
}
function createTestServerApp(options = {}) {
  return createServerApp({ plannerCredential: createTestPlannerCredential(), ...options });
}
module.exports = { createTestServerApp, createTestPlannerCredential };
