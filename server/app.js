import express from "express"
import fs from "fs"
import http from "http"
import path from "path"
import { Server } from "socket.io"
import { fileURLToPath } from "url"
import { GoogleGenerativeAI } from "@google/generative-ai"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.join(__dirname, "..")
const envPath = path.join(projectRoot, ".env")
const clientDistPath = path.join(projectRoot, "client", "dist")

if (fs.existsSync(envPath)) {
  const envLines = fs.readFileSync(envPath, "utf8").split(/\r?\n/)
  for (const line of envLines) {
    const trimmedLine = line.trim()
    if (!trimmedLine || trimmedLine.startsWith("#")) continue
    const separatorIndex = trimmedLine.indexOf("=")
    if (separatorIndex === -1) continue
    const key = trimmedLine.slice(0, separatorIndex).trim()
    const value = trimmedLine.slice(separatorIndex + 1).trim().replace(/^['"]|['"]$/g, "")
    if (key && !process.env[key]) process.env[key] = value
  }
}

const app = express()
const server = http.createServer(app)
const io = new Server(server, { cors: { origin: "*" } })

const apiKey = process.env.GEMINI_API_KEY
const modelName = process.env.GEMINI_MODEL || "gemini-2.5-flash"
const port = Number(process.env.PORT || 3001)
const teacherUsername = process.env.TEACHER_USERNAME || "docent"
const teacherPassword = process.env.TEACHER_PASSWORD || "les1234"
const genAI = apiKey ? new GoogleGenerativeAI(apiKey) : null

const TEAM_COLORS = ["#ff8c42", "#3dd6d0", "#8f7cff", "#ff5d8f"]
const DEFAULT_TEAMS = ["Team Zon", "Team Oceaan"]
const ROOM_HOST_GRACE_MS = 2 * 60 * 1000
const hostSocketIds = new Set()
const socketToRoom = new Map()
const rooms = new Map()

function generateRoomCode() {
  let code = ""
  do {
    code = Math.random().toString(36).slice(2, 7).toUpperCase()
  } while (rooms.has(code))
  return code
}

function escapeSvgText(value, maxLength = 160) {
  return String(value || "")
    .slice(0, maxLength)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

function wrapSvgText(value, maxChars = 26, maxLines = 3) {
  const words = String(value || "").trim().split(/\s+/).filter(Boolean)
  const lines = []
  let current = ""

  for (const word of words) {
    const next = current ? `${current} ${word}` : word
    if (next.length <= maxChars) {
      current = next
      continue
    }
    if (current) lines.push(current)
    current = word
    if (lines.length === maxLines - 1) break
  }

  if (lines.length < maxLines && current) lines.push(current)
  return lines.slice(0, maxLines).map((line, index) => ({ line: escapeSvgText(line, 60), index }))
}

function isIslamicTopic(prompt, category) {
  return /(islam|koran|moskee|profeet|ramadan|hadith|dua|salah|gebed)/.test(`${prompt} ${category}`.toLowerCase())
}

function pickVisualTheme(prompt, category) {
  const source = `${prompt} ${category}`.toLowerCase()

  if (/(breuk|procent|reken|wiskund|math|getal)/.test(source)) {
    return {
      gradient: ["#13293d", "#005f73", "#ee9b00"],
      accent: "#ffd166",
      icon: "pie",
      label: "Rekenen",
    }
  }
  if (/(aardrijkskunde|kaart|land|wereld|europa|planeet|geografie)/.test(source)) {
    return {
      gradient: ["#0b132b", "#1c2541", "#5bc0be"],
      accent: "#9bf6ff",
      icon: "globe",
      label: "Aardrijkskunde",
    }
  }
  if (/(geschiedenis|vroeger|romein|middeleeuw|oorlog|histor)/.test(source)) {
    return {
      gradient: ["#2d1e2f", "#5a3d2b", "#d98e04"],
      accent: "#ffd08a",
      icon: "column",
      label: "Geschiedenis",
    }
  }
  if (/(islam|koran|moskee|profeet|ramadan)/.test(source)) {
    return {
      gradient: ["#081c15", "#1b4332", "#2d6a4f"],
      accent: "#d8f3dc",
      icon: "crescent",
      label: "Islamitische kennis",
    }
  }
  if (/(engels|woord|taal|spelling|nederlands|grammatica)/.test(source)) {
    return {
      gradient: ["#1d3557", "#457b9d", "#a8dadc"],
      accent: "#f1faee",
      icon: "letters",
      label: "Taal",
    }
  }

  return {
    gradient: ["#10223b", "#0d3b66", "#ff7a59"],
    accent: "#ffd49e",
    icon: "spark",
    label: escapeSvgText(category || "Quiz", 40) || "Quiz",
  }
}

function buildIconMarkup(icon, accent) {
  switch (icon) {
    case "pie":
      return `
  <circle cx="930" cy="288" r="120" fill="#ffffff12" stroke="${accent}" stroke-width="8"/>
  <path d="M930 288 L930 168 A120 120 0 0 1 1034 348 Z" fill="${accent}" opacity="0.95"/>
  <circle cx="930" cy="288" r="52" fill="#0a1524"/>`
    case "globe":
      return `
  <circle cx="930" cy="288" r="124" fill="#ffffff10" stroke="${accent}" stroke-width="8"/>
  <ellipse cx="930" cy="288" rx="76" ry="124" fill="none" stroke="${accent}" stroke-width="6" opacity="0.75"/>
  <ellipse cx="930" cy="288" rx="124" ry="52" fill="none" stroke="${accent}" stroke-width="6" opacity="0.75"/>
  <path d="M808 288h244M930 164v248" stroke="${accent}" stroke-width="6" opacity="0.7"/>`
    case "column":
      return `
  <rect x="830" y="180" width="200" height="40" rx="12" fill="${accent}" opacity="0.92"/>
  <rect x="850" y="220" width="36" height="180" rx="10" fill="#ffffffd9"/>
  <rect x="912" y="220" width="36" height="180" rx="10" fill="#ffffffd9"/>
  <rect x="974" y="220" width="36" height="180" rx="10" fill="#ffffffd9"/>
  <rect x="820" y="400" width="220" height="34" rx="12" fill="${accent}" opacity="0.88"/>`
    case "crescent":
      return `
  <circle cx="930" cy="272" r="118" fill="${accent}" opacity="0.92"/>
  <circle cx="968" cy="252" r="108" fill="#0b1f17"/>
  <circle cx="1018" cy="340" r="14" fill="${accent}"/>
  <circle cx="995" cy="372" r="10" fill="${accent}" opacity="0.8"/>
  <circle cx="1042" cy="302" r="8" fill="${accent}" opacity="0.7"/>`
    case "letters":
      return `
  <rect x="806" y="154" width="248" height="268" rx="32" fill="#ffffff12" stroke="${accent}" stroke-width="6"/>
  <text x="850" y="262" fill="${accent}" font-size="110" font-family="Arial, Helvetica, sans-serif" font-weight="800">A</text>
  <text x="948" y="332" fill="#ffffff" font-size="120" font-family="Arial, Helvetica, sans-serif" font-weight="800">B</text>
  <text x="870" y="404" fill="${accent}" font-size="84" font-family="Arial, Helvetica, sans-serif" font-weight="700">C</text>`
    default:
      return `
  <circle cx="930" cy="288" r="120" fill="#ffffff10"/>
  <path d="M930 178l27 72 78 4-61 49 21 76-65-43-65 43 21-76-61-49 78-4z" fill="${accent}" opacity="0.95"/>`
  }
}

function buildQuestionSvg({ prompt, category }) {
  const theme = pickVisualTheme(prompt, category)
  const lines = wrapSvgText(prompt, 28, 3)
  const safeCategory = escapeSvgText(isIslamicTopic(prompt, category) ? "Islamitische kennis" : theme.label, 40)

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="720" viewBox="0 0 1200 720">
  <defs>
    <linearGradient id="bg" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0%" stop-color="${theme.gradient[0]}"/>
      <stop offset="52%" stop-color="${theme.gradient[1]}"/>
      <stop offset="100%" stop-color="${theme.gradient[2]}"/>
    </linearGradient>
    <linearGradient id="card" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0%" stop-color="#07111fdc"/>
      <stop offset="100%" stop-color="#0d1728a6"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="720" rx="36" fill="url(#bg)"/>
  <circle cx="210" cy="610" r="158" fill="#ffffff10"/>
  <circle cx="1080" cy="120" r="96" fill="#ffffff12"/>
  <rect x="72" y="72" width="1056" height="576" rx="34" fill="url(#card)" stroke="#ffffff20"/>
  <rect x="116" y="116" width="228" height="58" rx="29" fill="#ffffff10"/>
  <text x="148" y="153" fill="${theme.accent}" font-size="30" font-family="Arial, Helvetica, sans-serif" font-weight="700">${safeCategory}</text>
  <text x="118" y="236" fill="#ffffff" font-size="54" font-family="Arial, Helvetica, sans-serif" font-weight="800">Illustratie bij de vraag</text>
  ${lines
    .map(
      ({ line, index }) =>
        `<text x="118" y="${320 + index * 56}" fill="#dcecff" font-size="38" font-family="Arial, Helvetica, sans-serif" font-weight="600">${line}</text>`
    )
    .join("\n  ")}
  <rect x="118" y="476" width="268" height="104" rx="28" fill="#ffffff10"/>
  <rect x="410" y="476" width="204" height="104" rx="28" fill="#ffffff0d"/>
  <rect x="638" y="476" width="168" height="104" rx="28" fill="#ffffff08"/>
  ${buildIconMarkup(theme.icon, theme.accent)}
</svg>`
}

function createTeams(teamNames = DEFAULT_TEAMS) {
  const cleanedNames = teamNames.map((name) => String(name).trim()).filter(Boolean).slice(0, 4)
  const uniqueNames = [...new Set(cleanedNames.length ? cleanedNames : DEFAULT_TEAMS)]
  return uniqueNames.map((name, index) => ({
    id: `team-${index + 1}`,
    name,
    color: TEAM_COLORS[index % TEAM_COLORS.length],
    score: 0,
  }))
}

function createRoom(hostSocketId) {
  const roomCode = generateRoomCode()
  const room = {
    code: roomCode,
    hostSocketId,
    hostOnline: true,
    players: [],
    teams: createTeams(),
    questions: [],
    currentQuestionIndex: -1,
    answeredPlayers: new Set(),
    closingTimeout: null,
    game: {
      topic: "",
      audience: "vmbo",
      questionCount: 12,
      questionDurationSec: 20,
      questionStartedAt: null,
      status: "idle",
      generatedAt: null,
    },
  }
  rooms.set(roomCode, room)
  socketToRoom.set(hostSocketId, roomCode)
  return room
}

function getRoomBySocketId(socketId) {
  const roomCode = socketToRoom.get(socketId)
  return roomCode ? rooms.get(roomCode) ?? null : null
}

function requireHostRoom(socket) {
  if (!hostSocketIds.has(socket.id)) {
    socket.emit("host:error", { message: "Log eerst in als docent." })
    return null
  }
  let room = getRoomBySocketId(socket.id)
  if (!room) room = createRoom(socket.id)
  return room
}

function currentQuestion(room) {
  return room.currentQuestionIndex >= 0 ? room.questions[room.currentQuestionIndex] ?? null : null
}

function sanitizeQuestion(question) {
  if (!question) return null
  return {
    id: question.id,
    prompt: question.prompt,
    options: question.options,
    explanation: question.explanation,
    category: question.category,
    imagePrompt: question.imagePrompt,
    imageAlt: question.imageAlt || question.prompt,
  }
}

function syncTeamScores(room) {
  room.teams = room.teams.map((team) => ({
    ...team,
    score: room.players.filter((player) => player.teamId === team.id).reduce((sum, player) => sum + player.score, 0),
  }))
}

function leaderboard(room) {
  return [...room.players].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
}

function reassignPlayersToExistingTeams(room) {
  const fallbackTeamId = room.teams[0]?.id ?? "team-1"
  room.players = room.players.map((player) => ({
    ...player,
    teamId: room.teams.some((team) => team.id === player.teamId) ? player.teamId : fallbackTeamId,
  }))
}

function buildStatePayload(room) {
  syncTeamScores(room)
  return {
    players: room.players,
    teams: room.teams,
    leaderboard: leaderboard(room),
    game: {
      ...room.game,
      currentQuestionIndex: room.currentQuestionIndex,
      totalQuestions: room.questions.length,
      roomCodeActive: true,
      question: sanitizeQuestion(currentQuestion(room)),
    },
  }
}

function emitStateToRoom(room) {
  const payload = buildStatePayload(room)
  const recipients = [room.hostSocketId, ...room.players.map((player) => player.id)]
  for (const recipient of recipients) {
    io.to(recipient).emit("players:update", payload.players)
    io.to(recipient).emit("teams:update", payload.teams)
    io.to(recipient).emit("leaderboard:update", payload.leaderboard)
    io.to(recipient).emit("game:update", payload.game)
  }
}

function emitStateToSocket(socket, room) {
  const payload = room
    ? buildStatePayload(room)
    : {
        players: [],
        teams: createTeams(),
        leaderboard: [],
        game: {
          topic: "",
          audience: "vmbo",
          questionCount: 12,
          questionDurationSec: 20,
          questionStartedAt: null,
          status: "idle",
          generatedAt: null,
          currentQuestionIndex: -1,
          totalQuestions: 0,
          roomCodeActive: false,
          question: null,
        },
      }
  socket.emit("state:init", payload)
}

function stampQuestionStart(room) {
  room.game = { ...room.game, questionStartedAt: new Date().toISOString() }
}

function clearRoomClosingTimeout(room) {
  if (!room?.closingTimeout) return
  clearTimeout(room.closingTimeout)
  room.closingTimeout = null
}

function scheduleRoomClosure(room) {
  clearRoomClosingTimeout(room)
  room.hostOnline = false
  room.closingTimeout = setTimeout(() => {
    for (const player of room.players) {
      socketToRoom.delete(player.id)
      io.to(player.id).emit("player:error", { message: "Deze room is gesloten door de docent." })
    }
    rooms.delete(room.code)
  }, ROOM_HOST_GRACE_MS)
}

function claimRoomForHost(room, socketId) {
  clearRoomClosingTimeout(room)
  hostSocketIds.add(socketId)
  socketToRoom.set(socketId, room.code)
  room.hostSocketId = socketId
  room.hostOnline = true
}

function extractJsonArray(text) {
  const cleaned = text.replace(/```json|```/gi, "").trim()
  const start = cleaned.indexOf("[")
  const end = cleaned.lastIndexOf("]")
  if (start === -1 || end === -1 || end <= start) throw new Error("AI antwoord bevat geen geldige JSON-array.")
  return cleaned.slice(start, end + 1)
}

function normalizeQuestions(rawQuestions) {
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) throw new Error("AI gaf geen bruikbare vragen terug.")
  return rawQuestions
    .map((question, index) => ({
      id: `q-${index + 1}`,
      prompt: String(question?.prompt ?? "").trim(),
      options: Array.isArray(question?.options) ? question.options.map((option) => String(option).trim()).slice(0, 4) : [],
      correctIndex: Number(question?.correctIndex),
      explanation: String(question?.explanation ?? "").trim(),
      category: String(question?.category ?? "").trim() || "Quiz",
      imagePrompt: String(question?.imagePrompt ?? "").trim(),
      imageAlt: String(question?.imageAlt ?? "").trim(),
    }))
    .filter((question) => question.prompt && question.options.length === 4 && question.options.every(Boolean) && Number.isInteger(question.correctIndex) && question.correctIndex >= 0 && question.correctIndex < 4)
}

function shuffleArray(items) {
  const copy = [...items]
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1))
    ;[copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]]
  }
  return copy
}

function hasRecentPattern(sequence, candidate) {
  const recent = sequence.slice(-2)
  if (recent.length === 2 && recent[0] === recent[1] && recent[1] === candidate) return true
  if (sequence.length >= 3) {
    const lastThree = sequence.slice(-3)
    const withCandidate = [...lastThree, candidate]
    if (withCandidate[0] === withCandidate[2] && withCandidate[1] === withCandidate[3]) return true
  }
  return false
}

function rebalanceQuestions(questionList) {
  const targetCounts = questionList.reduce((counts, _, index) => {
    counts[index % 4] += 1
    return counts
  }, [0, 0, 0, 0])

  const usageCounts = [0, 0, 0, 0]
  const chosenSequence = []

  return questionList.map((question) => {
    const correctAnswer = question.options[question.correctIndex]
    const wrongAnswers = question.options.filter((_, index) => index !== question.correctIndex)
    const candidateIndices = shuffleArray([0, 1, 2, 3]).sort((left, right) => (usageCounts[left] - targetCounts[left]) - (usageCounts[right] - targetCounts[right]))
    const chosenIndex =
      candidateIndices.find((candidate) => usageCounts[candidate] < targetCounts[candidate] && !hasRecentPattern(chosenSequence, candidate)) ??
      candidateIndices.find((candidate) => !hasRecentPattern(chosenSequence, candidate)) ??
      candidateIndices[0]
    const wrongQueue = shuffleArray(wrongAnswers)
    const nextOptions = Array.from({ length: 4 }, (_, optionIndex) => (optionIndex === chosenIndex ? correctAnswer : wrongQueue.shift()))
    usageCounts[chosenIndex] += 1
    chosenSequence.push(chosenIndex)
    return { ...question, options: nextOptions, correctIndex: chosenIndex }
  })
}

function buildFallbackQuestions({ topic, questionCount }) {
  const base = [
    ["Wat is de grootste planeet van ons zonnestelsel?", ["Mars", "Aarde", "Jupiter", "Venus"], 2, "Jupiter is de grootste planeet van ons zonnestelsel."],
    ["Welke kleur krijg je door rood en geel te mengen?", ["Groen", "Oranje", "Paars", "Blauw"], 1, "Rood en geel samen geven oranje."],
    ["Hoeveel minuten zitten er in een uur?", ["30", "45", "60", "100"], 2, "Een uur heeft 60 minuten."],
    ["Welke breuk is gelijk aan 50%?", ["1/4", "1/2", "2/3", "3/4"], 1, "50% is hetzelfde als 1/2."],
    ["Hoe heet het heilige boek van de islam?", ["Bijbel", "Thora", "Koran", "Psalmen"], 2, "De Koran is het heilige boek van de islam."],
    ["Welke hoofdstad hoort bij Frankrijk?", ["Madrid", "Parijs", "Rome", "Berlijn"], 1, "Parijs is de hoofdstad van Frankrijk."],
  ]

  const safeQuestionCount = Math.max(6, Math.min(24, Number(questionCount) || 12))
  const questions = Array.from({ length: safeQuestionCount }, (_, index) => {
    const [prompt, options, correctIndex, explanation] = base[index % base.length]
    return {
      id: `fallback-${index + 1}`,
      prompt,
      options,
      correctIndex,
      explanation,
      category: String(topic || "Quiz"),
      imagePrompt: `engaging classroom poster about ${topic || "general knowledge"}, educational quiz illustration, vibrant lighting`,
      imageAlt: `Illustratie bij ${topic || "de quiz"}`,
    }
  })

  return rebalanceQuestions(questions)
}

async function withTimeout(promise, ms) {
  let timeoutId
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error("AI-generatie duurt te lang.")), ms)
  })

  try {
    return await Promise.race([promise, timeoutPromise])
  } finally {
    clearTimeout(timeoutId)
  }
}

async function fetchWithTimeout(url, options, ms) {
  return withTimeout(fetch(url, options), ms)
}

async function generateQuestions({ topic, audience, questionCount }) {
  if (!genAI) throw new Error("GEMINI_API_KEY ontbreekt in de serveromgeving.")
  if (!topic?.trim()) throw new Error("Voer eerst een onderwerp of thema in.")

  const safeQuestionCount = Math.max(6, Math.min(24, Number(questionCount) || 12))
  const targetAudience = audience?.trim() || "vmbo"
  const model = genAI.getGenerativeModel({ model: modelName })
  const prompt = `
Maak precies ${safeQuestionCount} quizvragen in het Nederlands voor ${targetAudience}.
Onderwerp:
${topic.trim()}

Regels:
- Respectvol en feitelijk.
- 4 antwoordopties per vraag.
- Korte uitleg per vraag.
- Voeg "category", "imagePrompt" en "imageAlt" toe.
- Bij islamitische kennis: geen gezichten, personen, profeten of levende wezens afbeelden; kies abstracte, objectgerichte of symbolische visuals.
- Geen markdown, alleen geldige JSON.

Formaat:
[
  {
    "prompt": "vraag",
    "options": ["a", "b", "c", "d"],
    "correctIndex": 0,
    "explanation": "korte uitleg",
    "category": "categorie",
    "imagePrompt": "english image prompt",
    "imageAlt": "nederlandse alt"
  }
]
`

  const result = await model.generateContent(prompt)
  const parsed = JSON.parse(extractJsonArray(result.response.text()))
  const normalized = normalizeQuestions(parsed)
  if (normalized.length === 0) throw new Error("AI output kon niet worden omgezet naar geldige vragen.")
  return rebalanceQuestions(normalized)
}

app.get("/api/question-image", async (req, res) => {
  const prompt = String(req.query.prompt ?? "").trim()
  const category = String(req.query.category ?? "").trim()
  if (!prompt) {
    res.status(400).json({ error: "prompt is verplicht" })
    return
  }
  res.setHeader("Content-Type", "image/svg+xml; charset=utf-8")
  res.setHeader("Cache-Control", "public, max-age=3600")
  res.status(200).send(buildQuestionSvg({ prompt, category }))
})

if (fs.existsSync(clientDistPath)) {
  app.use(express.static(clientDistPath))
  app.get(/.*/, (req, res, next) => {
    if (req.path.startsWith("/socket.io")) {
      next()
      return
    }
    res.sendFile(path.join(clientDistPath, "index.html"))
  })
}

io.on("connection", (socket) => {
  emitStateToSocket(socket, getRoomBySocketId(socket.id))

  socket.on("host:login", ({ username, password, roomCode }) => {
    if (String(username ?? "").trim() !== teacherUsername || String(password ?? "") !== teacherPassword) {
      socket.emit("host:error", { message: "Onjuiste docentgegevens." })
      return
    }

    const requestedCode = String(roomCode ?? "").trim().toUpperCase()
    const reclaimableRoom = requestedCode ? rooms.get(requestedCode) : null
    const room = reclaimableRoom ?? getRoomBySocketId(socket.id) ?? createRoom(socket.id)
    claimRoomForHost(room, socket.id)
    socket.emit("host:login:success", { username: teacherUsername, roomCode: room.code })
    socket.emit("host:room:update", { roomCode: room.code })
    socket.emit("host:generate:success", { count: room.questions.length })
    emitStateToRoom(room)
    emitStateToSocket(socket, room)
  })

  socket.on("player:lookup-room", ({ roomCode }) => {
    const room = rooms.get(String(roomCode ?? "").trim().toUpperCase())
    if (!room) {
      socket.emit("player:room:preview", { valid: false })
      return
    }

    socket.emit("player:room:preview", {
      valid: true,
      roomCode: room.code,
      teams: room.teams,
      status: room.game.status,
    })
  })

  socket.on("host:configure", ({ teamNames }) => {
    const room = requireHostRoom(socket)
    if (!room) return
    room.teams = createTeams(Array.isArray(teamNames) ? teamNames : DEFAULT_TEAMS)
    reassignPlayersToExistingTeams(room)
    emitStateToRoom(room)
  })

  socket.on("host:room:refresh", () => {
    const room = requireHostRoom(socket)
    if (!room) return

    clearRoomClosingTimeout(room)
    rooms.delete(room.code)
    room.code = generateRoomCode()
    rooms.set(room.code, room)
    socketToRoom.set(room.hostSocketId, room.code)

    for (const player of room.players) {
      socketToRoom.delete(player.id)
      io.to(player.id).emit("player:error", { message: "De spelcode is vernieuwd. Voer de nieuwe code in." })
    }

    room.players = []
    room.answeredPlayers = new Set()
    socket.emit("host:room:update", { roomCode: room.code })
    emitStateToRoom(room)
  })

  socket.on("host:generate", async ({ topic, audience, questionCount, teamNames, questionDurationSec }) => {
    const room = requireHostRoom(socket)
    if (!room) return

    const safeDuration = Math.max(8, Math.min(60, Number(questionDurationSec) || 20))
    socket.emit("host:generate:started", { message: "AI is bezig met de ronde..." })

    if (Array.isArray(teamNames) && teamNames.length > 0) {
      room.teams = createTeams(teamNames)
      reassignPlayersToExistingTeams(room)
    }

    try {
      room.questions = await withTimeout(generateQuestions({ topic, audience, questionCount }), 25000)
    } catch (aiError) {
      const fallbackMessage = aiError instanceof Error ? aiError.message : "AI-fout"
      room.questions = buildFallbackQuestions({ topic, questionCount })
      socket.emit("host:error", { message: `AI-generatie lukte niet direct. Er is een reservequiz gestart. Details: ${fallbackMessage}` })
    }

    room.currentQuestionIndex = 0
    room.answeredPlayers = new Set()
    room.game = {
      topic: String(topic ?? "").trim(),
      audience: audience?.trim() || "vmbo",
      questionCount: room.questions.length,
      questionDurationSec: safeDuration,
      questionStartedAt: new Date().toISOString(),
      status: "live",
      generatedAt: new Date().toISOString(),
    }

    emitStateToRoom(room)
    socket.emit("host:generate:success", { count: room.questions.length })
  })

  socket.on("host:next", () => {
    const room = requireHostRoom(socket)
    if (!room) return

    if (room.currentQuestionIndex + 1 >= room.questions.length) {
      room.currentQuestionIndex = -1
      room.answeredPlayers = new Set()
      room.game = { ...room.game, status: room.questions.length ? "finished" : "idle", questionStartedAt: null }
      emitStateToRoom(room)
      return
    }

    room.currentQuestionIndex += 1
    room.answeredPlayers = new Set()
    stampQuestionStart(room)
    emitStateToRoom(room)
  })

  socket.on("host:reset", () => {
    const room = requireHostRoom(socket)
    if (!room) return

    room.players = room.players.map((player) => ({ ...player, score: 0 }))
    room.questions = []
    room.currentQuestionIndex = -1
    room.answeredPlayers = new Set()
    room.game = {
      topic: "",
      audience: "vmbo",
      questionCount: 12,
      questionDurationSec: 20,
      questionStartedAt: null,
      status: "idle",
      generatedAt: null,
    }
    emitStateToRoom(room)
  })

  socket.on("player:join", ({ name, teamId, roomCode }) => {
    const room = rooms.get(String(roomCode ?? "").trim().toUpperCase())
    if (!room) {
      socket.emit("player:error", { message: "De spelcode klopt niet." })
      return
    }
    if (!room.hostOnline) {
      socket.emit("player:error", { message: "De docent is tijdelijk offline. Probeer over een paar seconden opnieuw." })
      return
    }

    const trimmedName = String(name ?? "").trim()
    const selectedTeamId = room.teams.some((team) => team.id === teamId) ? teamId : room.teams[0]?.id
    if (!trimmedName || !selectedTeamId) {
      socket.emit("player:error", { message: "Vul een naam in en kies een team." })
      return
    }

    const previousRoomCode = socketToRoom.get(socket.id)
    if (previousRoomCode && previousRoomCode !== room.code) {
      const previousRoom = rooms.get(previousRoomCode)
      if (previousRoom) {
        previousRoom.players = previousRoom.players.filter((player) => player.id !== socket.id)
        previousRoom.answeredPlayers.delete(socket.id)
        emitStateToRoom(previousRoom)
      }
    }

    socketToRoom.set(socket.id, room.code)
    const existingPlayer = room.players.find((player) => player.id === socket.id)
    if (existingPlayer) {
      existingPlayer.name = trimmedName
      existingPlayer.teamId = selectedTeamId
    } else {
      room.players.push({ id: socket.id, name: trimmedName, teamId: selectedTeamId, score: 0 })
    }

    socket.emit("player:joined", { playerId: socket.id, teamId: selectedTeamId, roomCode: room.code })
    emitStateToSocket(socket, room)
    emitStateToRoom(room)
  })

  socket.on("player:answer", ({ answer }) => {
    const room = getRoomBySocketId(socket.id)
    if (!room) return
    const question = currentQuestion(room)
    const player = room.players.find((entry) => entry.id === socket.id)
    if (!question || !player || room.answeredPlayers.has(socket.id)) return

    const startTime = room.game.questionStartedAt ? new Date(room.game.questionStartedAt).getTime() : 0
    const withinAnswerWindow = startTime && Date.now() <= startTime + room.game.questionDurationSec * 1000
    if (!withinAnswerWindow) return

    room.answeredPlayers.add(socket.id)
    const isCorrect = answer === question.correctIndex
    if (isCorrect) player.score += 100

    syncTeamScores(room)
    socket.emit("player:answer:result", {
      correct: isCorrect,
      correctIndex: question.correctIndex,
      explanation: question.explanation,
      playerScore: player.score,
      teamScore: room.teams.find((team) => team.id === player.teamId)?.score ?? 0,
    })
    emitStateToRoom(room)
  })

  socket.on("disconnect", () => {
    const room = getRoomBySocketId(socket.id)
    hostSocketIds.delete(socket.id)
    socketToRoom.delete(socket.id)
    if (!room) return

    if (room.hostSocketId === socket.id) {
      scheduleRoomClosure(room)
      emitStateToRoom(room)
      return
    }

    room.players = room.players.filter((player) => player.id !== socket.id)
    room.answeredPlayers.delete(socket.id)
    emitStateToRoom(room)
  })
})

server.listen(port, () => {
  console.log(`server draait op http://localhost:${port}`)
})
