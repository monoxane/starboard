/*
 * Starboard discord bot written in nodejs: react to posts and have it post to a pin
 * channel after a configurable threshhold. originally meant for moonmoon_ow discord server.
 * Developed by Rushnett and Keiaxx.
 */

// discord init
const Discord = require('discord.js')
const client = new Discord.Client({
  partials: Object.values(Discord.Constants.PartialTypes),
  intents: ['GUILDS', 'GUILD_MESSAGES', 'GUILD_MESSAGE_REACTIONS']
})

let settings = {
  serverID: process.env.SERVER || undefined,
  channelID: process.env.CHANNEL || undefined,
  reactionEmoji: process.env.EMOJI || "⭐",
  embedEmoji: process.env.EMOJI || "⭐",
  threshold: Number(process.env.THRESHOLD) || 15,
  hexcolor: process.env.COLOR || "00AE86",
  dateCutoff: Number(process.env.CUTOFF) || 3,
  fetchLimit: Number(process.env.LIMIT) || 100,
}

let db
let guildID = ''
let smugboardID = ''
let messagePosted = {}
let loading = true

function setup () {
  console.log(`Server ID: ${settings.serverID}`)
  console.log(`Channel ID: ${settings.channelID}`)
  console.log(`Reaction Emoji: ${settings.reactionEmoji}`)
  console.log(`Embed Emoji: ${settings.embedEmoji}`)
  console.log(`Threshold: ${settings.threshold}`)
  console.log(`Colour: ${settings.hexcolor}`)
  console.log(`Date Cutoff: ${settings.dateCutoff}`)
  console.log(`Fetch Limit: ${settings.fetchLimit}`)

  // login to discord
  if (process.env.TOKEN) {
    console.log('Logging In')
    client.login(process.env.TOKEN)
  } else {
    console.log('No Token Provided')
  }
}


async function * messagesIterator (channel, messagesLeft) {
  let before = null
  let done = false
  while (messagesLeft > 0) {
    process.stdout.write(".")
    const messages = await channel.messages.fetch({ limit: 100, before })
    if (messages.size > 0) {
      before = messages.lastKey()
      messagesLeft = messagesLeft - 100
      yield messages
    } else break
  }
}

async function * loadMessages (channel, amount) {
  for await (const messages of messagesIterator(channel, amount)) {
    for (const message of messages.values()) yield message
  }
}

// load old messages into memory
async function loadIntoMemory () {
  const channel = client.guilds.cache.get(guildID).channels.cache.get(smugboardID)
  let amount = settings.fetchLimit
  console.log(`Fetching the last ${amount} messages...`)

  // iterate through all messages as they're pulled
  for await (const message of loadMessages(channel, amount)) {
    // verify footer exists and grab original message ID
    if (message.embeds.length > 0 && message.embeds[0].footer) {
      const footerID = String(message.embeds[0].footer.text).match(/\((\d{18})\)/)
      if (footerID) {
        // save post to memory
        messagePosted[footerID[1]] = message.id // starboard msg id
      }
    }
  }
  loading = false
  console.log(`\nLoaded ${Object.keys(messagePosted).length} previous posts in ${settings.reactionEmoji} channel!`)
}

// manage the message board on reaction add/remove
function manageBoard (reaction_orig) {

  const msg = reaction_orig.message
  const postChannel = client.guilds.cache.get(guildID).channels.cache.get(smugboardID)

  msg.channel.messages.fetch(msg.id).then((msg) => {
    // if message is older than set amount
    const dateDiff = (new Date()) - reaction_orig.message.createdAt
    const dateCutoff = 1000 * 60 * 60 * 24
    if (Math.floor(dateDiff / dateCutoff) >= settings.dateCutoff) {
      console.log(`a message older than ${settings.dateCutoff} days was reacted to, ignoring`)
      return
    }

    // retrieve MessageReaction object from map
    // needed because cached messages have count missing
    let reaction = msg.reactions.cache.filter(reaction => reaction.emoji.name === settings.reactionEmoji)
    reaction = reaction.get([... reaction.keys()][0])
    // if cant find reaction (result of cached reaction reaching 0)
    if (!reaction) {
      deletePost(msg)
      return
    }

    console.log(`message ${settings.reactionEmoji}'d! (${msg.id}) in #${msg.channel.name} total: ${reaction.count}`)

    // did message reach threshold
    if (reaction.count >= settings.threshold) {
      // if message is already posted
      if (messagePosted[msg.id]) {
        const editableMessageID = messagePosted[msg.id]
        if (editableMessageID === true) return // message not yet posted (too fast)

        console.log(`updating count of message with ID ${editableMessageID}. reaction count: ${reaction.count}`)
        const messageFooter = `${reaction.count} ${settings.embedEmoji} (${msg.id})`
        postChannel.messages.fetch(editableMessageID).then(message => {
          message.embeds[0].setFooter(messageFooter)
          message.edit({ embeds: [message.embeds[0]] })
        }).catch(err => {
          console.error(`error updating post: ${editableMessageID}\noriginal message: ${msg.id}\n${err}`)
        })
      } else {
        console.log(`posting message with content ID ${msg.id}. reaction count: ${reaction.count}`)

        // add message to ongoing object in memory
        messagePosted[msg.id] = true

        // create content data
        const data = {
          content: (msg.content.length < 3920) ? msg.content : `${msg.content.substring(0, 3920)} **[ ... ]**`,
          avatarURL: `https://cdn.discordapp.com/avatars/${msg.author.id}/${msg.author.avatar}.jpg`,
          imageURL: '',
          footer: `${reaction.count} ${settings.embedEmoji} (${msg.id})`
        }

        // add msg origin info to content prop
        const msgLink = `https://discordapp.com/channels/${msg.guild.id}/${msg.channel.id}/${msg.id}`
        const channelLink = (msg.channel.type.includes('THREAD')) ? `<#${msg.channel.parent.id}>/<#${msg.channel.id}>` : `<#${msg.channel.id}>`
        data.content += `\n\n→ [original message](${msgLink}) in ${channelLink}`

        // resolve any images
        if (msg.embeds.length) {
          const imgs = msg.embeds
            .filter(embed => embed.thumbnail || embed.image)
            .map(embed => (embed.thumbnail) ? embed.thumbnail.url : embed.image.url)
          data.imageURL = imgs[0]

          // twitch clip check
          const videoEmbed = msg.embeds.filter(embed => embed.type === 'video')[0]
          if (videoEmbed && videoEmbed.video.url.includes("clips.twitch.tv")) {
            data.content += `\n⬇️ [download clip](${videoEmbed.thumbnail.url.replace("-social-preview.jpg", ".mp4")})`
          }

        } else if (msg.attachments.size) {
          data.imageURL = msg.attachments.first().url
          data.content += `\n📎 [${msg.attachments.first().name}](${msg.attachments.first().proxyURL})`
        }

        const embed = new Discord.MessageEmbed()
          .setAuthor(msg.author.username, data.avatarURL)
          .setColor(settings.hexcolor)
          .setDescription(data.content)
          .setImage(data.imageURL)
          .setTimestamp(new Date())
          .setFooter(data.footer)
        postChannel.send({ embeds: [embed] }).then(starMessage => {
          messagePosted[msg.id] = starMessage.id
        })
      }
    }
  })
}

// delete a post
function deletePost (msg) {
  const postChannel = client.guilds.cache.get(guildID).channels.cache.get(smugboardID)
  // if posted to channel board before
  if (messagePosted[msg.id]) {
    const editableMessageID = messagePosted[msg.id]
    postChannel.messages.fetch(editableMessageID).then((message) => {
      delete messagePosted[msg.id]
      message.delete()
        .then(msg => console.log(`Removed message with ID ${editableMessageID}. Reaction count reached 0.`))
        .catch(console.error)
    })
  }
}

// ON READY
client.on('ready', () => {
  console.log(`Logged in as ${client.user.username}!`)
  guildID = settings.serverID
  smugboardID = settings.channelID
  // fetch existing posts
  loadIntoMemory()
})

// ON REACTION ADD
client.on('messageReactionAdd', (reaction_orig, user) => {
  if (loading) return
  // if channel is posting channel
  if (reaction_orig.message.channel.id == smugboardID) return
  // if reaction is not desired emoji
  if (reaction_orig.emoji.name !== settings.reactionEmoji) return

  manageBoard(reaction_orig)
})

// ON REACTION REMOVE
client.on('messageReactionRemove', (reaction, user) => {
  if (loading) return
  // if channel is posting channel
  if (reaction.message.channel.id == smugboardID) return
  // if reaction is not desired emoji
  if (reaction.emoji.name !== settings.reactionEmoji) return


  // if reactions reach 0
  if (reaction.count === 0)
    return deletePost(reaction.message)
  else
    manageBoard(reaction)
})

// ON REACTION PURGE
client.on('messageReactionRemoveAll', (msg) => {
  deletePost(msg)
})

// if post is deleted (db only)
client.on('messageDelete', (msg) => {
  if (db && msg.channel.id === smugboardID)
    db.setDeleted(msg.id)
})

// if embed was deleted (db only)
client.on('messageUpdate', (oldMsg, newMsg) => {
  if (db && oldMsg.channel.id === smugboardID && oldMsg.embeds.length && !newMsg.embeds.length)
    db.setDeleted(newMsg.id)
})

setup()