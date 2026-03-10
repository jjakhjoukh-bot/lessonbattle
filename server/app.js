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

function buildFallbackSvg(prompt) {
  const safePrompt = String(prompt || "Lesson Battle")
    .slice(0, 90)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="720" viewBox="0 0 1200 720">
  <defs>
    <linearGradient id="bg" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0%" stop-color="#10223b"/>
      <stop offset="50%" stop-color="#0d3b66"/>
      <stop offset="100%" stop-color="#ff7a59"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="720" rx="36" fill="url(#bg)"/>
  <circle cx="930" cy="160" r="110" fill="#ffffff12"/>
  <circle cx="220" cy="580" r="150" fill="#ffffff10"/>
  <rect x="90" y="90" width="1020" height="540" rx="28" fill="#07111fcc" stroke="#ffffff22"/>
  <text x="120" y="180" fill="#ffd49e" font-size="30" font-family="Arial, Helvetica, sans-serif" font-weight="700">Lesson Battle Visual</text>
  <text x="120" y="270" fill="#ffffff" font-size="50" font-family="Arial, Helvetica, sans-serif" font-weight="700">Illustratie bij de vraag</text>
  <text x="120" y="360" fill="#d8e8ff" font-size="34" font-family="Arial, Helvetica, sans-serif">${safePrompt}</text>
  <rect x="120" y="430" width="260" height="120" rx="20" fill="#ffffff10"/>
  <rect x="410" y="430" width="320" height="120" rx="20" fill="#ffffff0d"/>
  <rect x="760" y="430" width="230" height="120" rx="20" fill="#ffffff08"/>
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
  if (!prompt) {
    res.status(400).json({ error: "prompt is verplicht" })
    return
  }

  const searchParams = new URLSearchParams({ width: "1200", height: "720", model: "flux", nologo: "true", enhance: "true" })
  const imageUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?${searchParams.toString()}`

  try {
    const response = await fetchWithTimeout(imageUrl, { headers: { Accept: "image/*" } }, 3500)
    if (!response.ok) throw new Error(`Afbeelding ophalen mislukt met status ${response.status}`)
    const contentType = response.headers.get("content-type") || ""
    if (!contentType.startsWith("image/")) throw new Error("Onverwacht content-type voor afbeelding")
    const isSvgLike = contentType.includes("svg") || contentType.includes("xml")

    if (isSvgLike) {
      const svgText = await response.text()
      const lowerSvg = svgText.toLowerCase()
      const looksBroken =
        lowerSvg.includes("temporarily not available") ||
        lowerSvg.includes("failed to generate") ||
        lowerSvg.includes("error") ||
        lowerSvg.includes("blocked") ||
        lowerSvg.includes("quota")

      if (looksBroken) throw new Error("Externe afbeeldingsdienst gaf een fout-SVG terug")

      res.setHeader("Content-Type", contentType)
      res.setHeader("Cache-Control", "public, max-age=1800")
      res.status(200).send(svgText)
      return
    }

    const arrayBuffer = await response.arrayBuffer()
    res.setHeader("Content-Type", contentType)
    res.setHeader("Cache-Control", "public, max-age=3600")
    res.send(Buffer.from(arrayBuffer))
  } catch (error) {
    console.error("Fout bij afbeelding proxy:", error instanceof Error ? error.message : "Onbekende image-fout")
    res.setHeader("Content-Type", "image/svg+xml; charset=utf-8")
    res.setHeader("Cache-Control", "public, max-age=300")
    res.status(200).send(buildFallbackSvg(prompt))
  }
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
