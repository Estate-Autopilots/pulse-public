// CHAT-V6: the emoji picker's set: categories, each emoji with the words it is found by (English, with the Indian words
// people type for a few: "namaste", "chai", "diya"). Kept here, small and plain, instead of a 1 MB package.

const RAW = [
  ["smileys", "Smileys", "😀", `
😀 grinning smile happy
😃 smiley happy joy
😄 smile happy laugh
😁 grin beaming teeth
😆 laughing satisfied
😅 sweat smile relief phew
🤣 rofl rolling floor laughing
😂 joy tears laughing lol
🙂 slightly smiling ok
🙃 upside down silly
😉 wink
😊 blush smiling happy
😇 innocent halo angel
🥰 love hearts adore
😍 love heart eyes
🤩 star struck wow excited
😘 kiss blow
😗 kissing
😚 kissing closed eyes
😙 kissing smiling
🥲 smiling tear grateful
😋 yum delicious tasty
😛 tongue
😜 winking tongue crazy
🤪 zany crazy goofy
😝 squinting tongue
🤑 money mouth rich
🤗 hug hugging
🤭 hand over mouth oops giggle
🤫 shush quiet secret
🤔 thinking hmm think
🤐 zipper mouth secret
🤨 raised eyebrow doubt
😐 neutral meh
😑 expressionless blank
😶 no mouth speechless
😏 smirk
😒 unamused
🙄 eye roll rolling eyes
😬 grimace awkward
😮‍💨 exhale sigh relief
🤥 lying pinocchio
😌 relieved calm
😔 pensive sad
😪 sleepy
🤤 drooling
😴 sleeping zzz tired
😷 mask sick
🤒 thermometer sick fever
🤕 bandage hurt
🤢 nauseated sick
🤮 vomiting
🤧 sneezing cold
🥵 hot sweating
🥶 cold freezing
🥴 woozy dizzy
😵 dizzy
🤯 mind blown exploding head shocked
🤠 cowboy
🥳 party celebrate birthday
🥸 disguise
😎 cool sunglasses
🤓 nerd geek
🧐 monocle inspect
😕 confused
😟 worried
🙁 frowning sad
😮 open mouth surprised wow
😯 hushed surprised
😲 astonished shocked
😳 flushed embarrassed
🥺 pleading puppy eyes please
😦 frowning open mouth
😧 anguished
😨 fearful scared
😰 anxious sweat
😥 sad relieved
😢 crying sad tear
😭 sobbing crying loudly
😱 scream fear shocked
😖 confounded
😣 persevering
😞 disappointed
😓 downcast sweat
😩 weary tired
😫 tired exhausted
🥱 yawning bored tired
😤 triumph huff
😡 angry rage pouting
😠 angry mad
🤬 cursing swearing
😈 smiling devil
👿 angry devil
💀 skull dead
💩 poop
🤡 clown
👻 ghost
👽 alien
🤖 robot bot ai
😺 cat smile
😹 cat joy
😻 cat heart eyes
🙈 see no evil monkey
🙉 hear no evil monkey
🙊 speak no evil monkey`],
  ["people", "People and hands", "👍", `
👍 thumbs up like yes ok approve
👎 thumbs down dislike no
👌 ok perfect
🤌 pinched fingers
🤏 pinching small
✌️ victory peace
🤞 crossed fingers luck hope
🤟 love you gesture
🤘 rock horns
🤙 call me hang loose
👈 point left
👉 point right
👆 point up
👇 point down
☝️ index up one
✋ raised hand stop high five
🤚 raised back of hand
🖐️ hand fingers splayed
🖖 vulcan
👋 wave hello hi bye
👏 clap applause bravo
🙌 raised hands celebrate hooray
👐 open hands
🤲 palms up
🙏 folded hands please thanks namaste pray
🤝 handshake deal agreement
💪 muscle strong flex
✍️ writing
💅 nail polish
🫶 hands heart love
🫡 salute respect yes sir
👀 eyes look see watching
👁️ eye
🧠 brain smart
👶 baby
🧒 child kid
👦 boy
👧 girl
🧑 person
👨 man
👩 woman
🧓 older person
👴 old man grandfather
👵 old woman grandmother
🙋 raising hand question me
🙅 no gesture
🙆 ok gesture
💁 tipping hand info
🤷 shrug dunno
🤦 facepalm
🙇 bowing sorry
🧑‍💻 technologist coder developer laptop
🧑‍💼 office worker manager
🧑‍🎨 artist designer
🧑‍🏫 teacher
🧑‍🔧 mechanic repair
🧑‍🍳 cook chef
👷 construction worker builder site
👮 police
🕵️ detective
💃 dancing woman
🕺 dancing man
🏃 running
🚶 walking
👪 family
💑 couple
🗣️ speaking
👥 people group team`],
  ["hearts", "Hearts and symbols", "❤️", `
❤️ heart red love
🧡 orange heart
💛 yellow heart
💚 green heart
💙 blue heart
💜 purple heart
🖤 black heart
🤍 white heart
🤎 brown heart
💔 broken heart
❣️ heart exclamation
💕 two hearts
💞 revolving hearts
💓 beating heart
💗 growing heart
💖 sparkling heart
💘 heart arrow cupid
💝 heart ribbon gift
✨ sparkles magic new shine
⭐ star favourite
🌟 glowing star
💫 dizzy star
🔥 fire hot lit trending
💯 hundred perfect score
✅ check done yes tick complete
☑️ ballot check
✔️ check mark
❌ cross no wrong cancel
❎ cross button
⚠️ warning caution alert
❗ exclamation important
❓ question
❔ white question
‼️ double exclamation
⁉️ exclamation question
🚫 prohibited forbidden no
⛔ no entry stop
🆗 ok button
🆕 new
🆓 free
🔝 top
🔜 soon
🔴 red circle
🟠 orange circle
🟡 yellow circle
🟢 green circle
🔵 blue circle
🟣 purple circle
⚫ black circle
⚪ white circle
➕ plus add
➖ minus
✖️ multiply
➗ divide
♾️ infinity
💲 dollar
©️ copyright
®️ registered
™️ trademark
🔁 repeat
🔄 refresh sync
⏩ fast forward
⏪ rewind
▶️ play
⏸️ pause
⏹️ stop
🔔 bell notification
🔕 bell off mute
📣 megaphone announce
📢 loudspeaker announcement
💬 speech bubble chat message
💭 thought bubble
🗯️ anger bubble
♻️ recycle
🕉️ om
🪔 diya lamp diwali deepavali`],
  ["nature", "Animals and nature", "🌿", `
🐶 dog puppy
🐱 cat kitten
🐭 mouse
🐰 rabbit bunny
🦊 fox
🐻 bear
🐼 panda
🐨 koala
🐯 tiger
🦁 lion
🐮 cow
🐷 pig
🐸 frog
🐵 monkey
🐔 chicken
🐧 penguin
🐦 bird
🦅 eagle
🦉 owl
🦋 butterfly
🐝 bee busy
🐞 ladybug
🐢 turtle slow
🐍 snake
🐘 elephant
🦒 giraffe
🐎 horse
🐄 cow
🐟 fish
🐬 dolphin
🐳 whale
🦈 shark
🌸 cherry blossom flower
🌺 hibiscus flower
🌻 sunflower
🌹 rose
🌷 tulip
💐 bouquet flowers
🌱 seedling grow sprout
🌿 herb leaf
🍀 four leaf clover luck
🌴 palm tree beach
🌳 tree
🌵 cactus
🍁 maple leaf autumn
🍂 fallen leaves
🌍 earth globe world
🌎 earth americas
🌏 earth asia
🌙 moon night
☀️ sun sunny
⛅ sun behind cloud
☁️ cloud
🌧️ rain monsoon
⛈️ storm thunder
🌩️ lightning
❄️ snowflake cold
🌈 rainbow
🌊 wave sea ocean
💧 droplet water
⚡ lightning fast power
🌪️ tornado
🔆 bright`],
  ["food", "Food and drink", "☕", `
☕ coffee chai tea hot
🍵 tea green
🧋 bubble tea
🥤 soft drink cup
🧃 juice box
🥛 milk
🍺 beer
🍻 cheers beers
🥂 clinking glasses cheers toast
🍷 wine
🍹 cocktail
🍕 pizza
🍔 burger hamburger
🍟 fries
🌭 hot dog
🥪 sandwich
🌮 taco
🌯 burrito wrap
🍝 pasta spaghetti
🍜 noodles ramen
🍛 curry rice
🍚 rice
🍱 bento lunch box tiffin
🥘 paella pan food
🍲 pot stew
🥗 salad
🍿 popcorn
🍩 doughnut donut
🍪 cookie biscuit
🎂 birthday cake
🍰 cake slice
🧁 cupcake
🍫 chocolate
🍬 candy sweet
🍭 lollipop
🍦 ice cream
🍎 apple
🍌 banana
🍉 watermelon
🍇 grapes
🍓 strawberry
🥭 mango
🍍 pineapple
🥥 coconut
🥑 avocado
🌶️ chilli pepper spicy
🥕 carrot
🌽 corn
🥔 potato
🍳 cooking egg
🥞 pancakes
🧀 cheese
🥐 croissant
🍞 bread
🥟 dumpling momo`],
  ["activity", "Activities and celebrations", "🎉", `
🎉 party popper celebrate congrats tada
🎊 confetti
🎈 balloon birthday
🎁 gift present
🎀 ribbon
🎂 birthday cake
🪅 pinata
🎆 fireworks diwali
🎇 sparkler
🏆 trophy winner award
🥇 gold medal first
🥈 silver medal second
🥉 bronze medal third
🏅 medal
🎖️ military medal
⚽ football soccer
🏏 cricket bat ball
🏀 basketball
🏸 badminton
🎾 tennis
🏐 volleyball
🏓 ping pong table tennis
🏋️ weight lifting gym
🧘 yoga meditation
🚴 cycling bike
🏊 swimming
⛳ golf
🎯 target goal bullseye direct hit
🎮 video game
🎲 dice game
🧩 puzzle
♟️ chess
🎨 art palette design
🎬 clapper film shoot action
🎤 microphone sing
🎧 headphones music
🎵 music note
🎶 music notes
🎸 guitar
🥁 drum
🎹 piano keyboard
🎭 theatre drama
📸 camera flash photo shoot
🎥 movie camera video`],
  ["travel", "Travel and places", "🏠", `
🏠 house home
🏡 house garden home
🏢 office building
🏬 department store mall
🏗️ construction building site
🏘️ houses neighbourhood
🏚️ old house
🏛️ classical building
🏦 bank
🏨 hotel
🏪 shop store
🏫 school
🏥 hospital
🛕 temple mandir
🕌 mosque
⛪ church
🏰 castle
🗼 tower
🌉 bridge
🏙️ city skyline
🌆 city dusk
🌃 night city
🏖️ beach umbrella
🏝️ island
⛰️ mountain
🏔️ snow mountain
🏕️ camping
🗺️ map
📍 pin location place
🧭 compass
🚗 car drive
🚕 taxi cab
🛺 auto rickshaw
🚌 bus
🚆 train
🚇 metro
🚲 bicycle
🛵 scooter
🏍️ motorcycle bike
🚚 truck delivery
✈️ airplane flight travel
🛫 departure
🛬 arrival
🚀 rocket launch ship fast
🛳️ ship
⛽ fuel petrol
🚦 traffic light
🚧 construction barrier work in progress
⏰ alarm clock reminder
⌛ hourglass wait
⏳ hourglass flowing waiting
🕐 one o'clock time`],
  ["work", "Work and objects", "💼", `
💼 briefcase work job business
📁 folder files
📂 open folder
🗂️ dividers index
📄 page document
📃 page curl
📑 bookmark tabs
📝 memo note write
✏️ pencil edit
🖊️ pen
🖋️ fountain pen sign
📌 pushpin pin
📎 paperclip attach attachment
✂️ scissors cut
📏 ruler
📐 triangle ruler
📅 calendar date
📆 tear off calendar
🗓️ spiral calendar plan schedule
📊 bar chart report stats
📈 chart up growth increase
📉 chart down decrease
📋 clipboard checklist
🗒️ notepad
📒 ledger
📓 notebook
📚 books
📖 open book read
🔖 bookmark
🏷️ label tag
💰 money bag
💵 banknote cash
💳 credit card payment
🧾 receipt invoice bill
💸 money flying spend
🪙 coin
📧 email mail
📨 incoming envelope
📩 envelope arrow
📤 outbox send
📥 inbox
📦 package parcel box delivery
📮 postbox
📞 telephone phone call
☎️ phone
📱 mobile phone
💻 laptop computer
🖥️ desktop computer
⌨️ keyboard
🖱️ mouse
🖨️ printer print
💾 save disk
💿 disc
📷 camera photo
📹 video camera
📺 tv television
📡 satellite
🔋 battery
🔌 plug
💡 bulb idea
🔦 torch flashlight
🔍 search magnify find
🔎 search right
🔒 locked secure private
🔓 unlocked
🔑 key access
🗝️ old key
🔨 hammer build
🛠️ tools fix
🔧 wrench fix
⚙️ gear settings
🧰 toolbox
🧲 magnet
⚖️ balance law justice
🔗 link chain
🧪 test tube experiment
🛒 shopping cart
🎟️ ticket
🪪 id card
🗳️ ballot vote poll
📜 scroll contract
🖼️ picture frame
🗑️ wastebasket delete trash bin`],
];

/** [{ key, label, icon, items: [{ e, words }] }] */
export const EMOJI_GROUPS = RAW.map(([key, label, icon, text]) => ({
  key, label, icon,
  items: text.trim().split("\n").map((line) => { const at = line.indexOf(" "); return { e: line.slice(0, at), words: line.slice(at + 1).trim().toLowerCase() }; }),
}));

const ALL = (() => { const seen = new Set(), out = []; for (const g of EMOJI_GROUPS) for (const it of g.items) if (!seen.has(it.e)) { seen.add(it.e); out.push(it); } return out; })();

/** Emoji whose words start with the letters typed (any word), best first: a whole-word match, then the first word. */
export function searchEmoji(query, limit = 80) {
  const q = String(query ?? "").trim().toLowerCase(); if (!q) return [];
  const parts = q.split(/\s+/).filter(Boolean);
  const scored = [];
  for (const it of ALL) {
    const words = it.words.split(" ");
    let score = 0, ok = true;
    for (const p of parts) {
      const i = words.findIndex((w) => w.startsWith(p));
      if (i < 0) { ok = false; break; }
      score += (words[i] === p ? 3 : 1) + (i === 0 ? 2 : 0);
    }
    if (ok || it.e === q) scored.push([it, ok ? score : 10]);
  }
  return scored.sort((a, b) => b[1] - a[1]).slice(0, limit).map(([it]) => it.e);
}

/** The words an emoji is found by (its label in the picker and to screen readers). */
export function emojiName(e) { return ALL.find((x) => x.e === e)?.words.split(" ")[0] ?? ""; }
