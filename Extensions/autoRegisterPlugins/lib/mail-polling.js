(function attachMailPollingApi(globalScope) {
  const MAIL_POLL_INTERVAL_MS = 3000;
  const MAIL_POLL_ATTEMPTS_PER_ROUND = 10;
  const MAIL_POLL_TOTAL_ROUNDS = 5;

  function getMailPollConfig() {
    return {
      intervalMs: MAIL_POLL_INTERVAL_MS,
      maxAttempts: MAIL_POLL_ATTEMPTS_PER_ROUND,
      totalRounds: MAIL_POLL_TOTAL_ROUNDS,
    };
  }

  function shouldRetryMailPollRound(round, totalRounds = MAIL_POLL_TOTAL_ROUNDS) {
    return Number(round) < Number(totalRounds);
  }

  function formatMailPollingLog(step, mailboxLabel, round, config = getMailPollConfig()) {
    const intervalSeconds = Number(config.intervalMs) / 1000;
    return `Step ${step}: Polling ${mailboxLabel} (${round}/${config.totalRounds}, ${config.maxAttempts} checks x ${intervalSeconds}s)...`;
  }

  const api = {
    MAIL_POLL_INTERVAL_MS,
    MAIL_POLL_ATTEMPTS_PER_ROUND,
    MAIL_POLL_TOTAL_ROUNDS,
    getMailPollConfig,
    shouldRetryMailPollRound,
    formatMailPollingLog,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }

  Object.assign(globalScope, api);
})(typeof globalThis !== 'undefined' ? globalThis : self);
