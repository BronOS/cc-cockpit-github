'use strict'
// bronos.github: the person's GitHub work (review requests, their PRs, issues, failed runs) as lanes, an Inbox
// feed (inbox-feed v2) and an item overlay. Signs in through the `gh` CLI's login; the token stays in this
// process's memory. Wiring only: the logic lives in lib/.

module.exports = {
  async activate(ctx) {
    ctx.log.info('github: started')
  },
  async deactivate() {},
}
