// Explicit test entry point, not an environment-selected production bypass.
// Retain the real startup/proxy/shutdown path while keeping credentials in RAM.
const { main } = require('../../build/lib/app-server');
const { createTestPlannerCredential } = require('./server-app');
void main({ plannerCredential: createTestPlannerCredential() }).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
