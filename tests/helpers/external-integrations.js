function isolateExternalIntegrations(env = process.env) {
  env.FEISHU_APP_ID = '';
  env.FEISHU_APP_SECRET = '';
  env.FEISHU_CONNECTION_MODE = 'webhook';
}

module.exports = {
  isolateExternalIntegrations,
};
