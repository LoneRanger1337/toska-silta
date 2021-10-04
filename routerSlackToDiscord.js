const router = require('koa-router')()
const axios = require('axios')
const FormData = require('form-data')
const DISCORD_HOOK = process.env.DISCORD_HOOK || ''
const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID || ''
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || ''
const NodeCache = require('node-cache')
const { client } = require('./discordClient')
const { getInfoForSlackUser, removeShitFromSlackMessage, getNameForSlackChannel } = require('./shared')
const sentMessageCache = new NodeCache({ stdTTL: 130 })
const sentFileCache = new NodeCache({ stdTTL: 130 })

const sendFileToDiscord = async (url, userInfo, webhook) => {
  if (sentFileCache.has(url)) return
  sentFileCache.set(url, true)
  const { data } = await axios.get(url, { responseType: 'stream', headers: { 'Authorization': `Bearer ${SLACK_BOT_TOKEN}` } })
  const form = new FormData()
  form.append('username', userInfo.username)
  form.append('avatar_url', userInfo.avatar_url)
  form.append('file', data)
  form.submit(webhook.url)
}

const sendMessageToDiscord = async (content, username, avatarURL, webhook) => {
  if (sentMessageCache.has(`${content}-${username}`)) return
  sentMessageCache.set(`${content}-${username}`)
  await webhook.send({
    content,
    username,
    avatarURL
  })
}

const handleMessage = async (ctx, event, webhook) => {
  const { user, text, subtype } = event
  if (subtype === 'bot_message') return ctx.status = 200
  if (!user) return ctx.status = 200
  if (!text) return ctx.status = 200

  const { username, avatar_url } = await getInfoForSlackUser(user)
  if (username.includes('toska')) return ctx.status = 200
  const content = await removeShitFromSlackMessage(`${text}`)
  await sendMessageToDiscord(content, username, avatar_url, webhook)
  ctx.status = 200
}

const handleSlackFile = async (ctx, event, webhook) => {
  const { user_id, file_id } = event
  const fileInfoUrl = `https://slack.com/api/files.info?token=${SLACK_BOT_TOKEN}&file=${file_id}`

  const { data: fileData } = await axios.get(fileInfoUrl)
  const userInfo = await getInfoForSlackUser(user_id)
  const actualFileUrl = fileData.file.url_private_download
  await sendFileToDiscord(actualFileUrl, userInfo, webhook)

  ctx.status = 200
}

const handleFileShare = async (ctx, event, webhook) => {
  const userInfo = await getInfoForSlackUser(event.user)
  await Promise.all(event.files.map(file => {
    console.log('file', file)
    const url = file.url_private_download
    return sendFileToDiscord(url, userInfo, webhook)
  }))
  ctx.status = 200
}

const getChannelWebhook = async (channelId) => {
  const slackChannelName = await getNameForSlackChannel(channelId)
  const guild = await client.guilds.fetch(DISCORD_GUILD_ID)
  const discordChannel = guild.channels.cache.find(c => c.name === slackChannelName)

  if(!discordChannel) return null

  const webhooks = await discordChannel.fetchWebhooks()

  const webhook = webhooks.size === 0
    ? await discordChannel.createWebhook(slackChannelName, { avatar: "https://cdn.discordapp.com/embed/avatars/1.png" }).catch(console.error)
    : webhooks.first()

  return webhook
}

router.post('/slack/event', async ctx => {
  if (ctx.request.body.challenge) {
    ctx.body = ctx.request.body.challenge
    return
  }
  const eventBody = ctx.request.body
  const { channel, type, subtype } = eventBody.event

  const webhook = await getChannelWebhook(channel)

  if (!webhook) return ctx.status = 200
  if (type === 'file_created') return handleSlackFile(ctx, eventBody.event, webhook)
  if (type !== 'message') return ctx.status = 200
  if (subtype === 'file_share') return handleFileShare(ctx, eventBody.event, webhook)

  await handleMessage(ctx, eventBody.event, webhook)
})

module.exports = router
